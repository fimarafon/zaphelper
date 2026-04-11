import type { PrismaClient } from "@prisma/client";
import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { MessageIngest } from "./message-ingest.js";

/**
 * Background service that periodically pulls new messages from Evolution's
 * database into ours. Acts as a safety net for the webhook:
 *
 * - Webhooks are fire-and-forget — Evolution doesn't retry on backend
 *   downtime, so any message arriving during a container restart is lost.
 * - This service polls Evolution every 5 minutes and ingests anything
 *   newer than our most recent stored message.
 * - It's idempotent: duplicates are caught by the waMessageId unique
 *   constraint, so running it over and over is safe.
 * - It also rebuilds the chat/group name maps on every run so new groups
 *   get their names resolved automatically.
 *
 * Behaviour:
 *   - Runs on boot once (delayed 30s to let everything initialize)
 *   - Then on a cron schedule (default: every 5 minutes)
 *   - Only looks at the LAST few pages of Evolution's findMessages list
 *     (default: 10 pages = 1000 most recent messages) to stay fast.
 *     A full backfill is still available via /api/instance/backfill.
 */
export class IncrementalSync {
  private cronJob: ScheduledTask | null = null;
  private running = false;
  private readonly logger: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly ingest: MessageIngest,
    private readonly config: AppConfig,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "incremental-sync" });
  }

  async start(): Promise<void> {
    // Initial run after 30s so the first sync catches anything that
    // arrived during startup/migration window.
    setTimeout(() => {
      void this.runSafely("boot");
    }, 30_000);

    // Recurring every 5 minutes.
    this.cronJob = cron.schedule(
      "*/5 * * * *",
      () => {
        void this.runSafely("cron");
      },
      { timezone: this.config.TZ },
    );

    this.logger.info("Incremental sync started (every 5 minutes)");
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * Run a sync cycle. Wrapped in a lock to prevent overlapping runs if
   * a previous sync takes longer than the interval.
   */
  async runSafely(trigger: "boot" | "cron" | "manual" | "on-demand"): Promise<void> {
    if (this.running) {
      this.logger.debug("Sync already in progress, skipping");
      return;
    }
    this.running = true;
    const started = Date.now();
    try {
      // On-demand runs (before a /status command) are latency-sensitive —
      // they only need to catch new messages, not rebuild the world, so we
      // walk just the first page.
      const maxPages = trigger === "on-demand" ? 2 : 10;
      const result = await this.syncRecent(maxPages);
      this.logger.info(
        {
          trigger,
          durationMs: Date.now() - started,
          ...result,
        },
        "Sync cycle complete",
      );
    } catch (err) {
      this.logger.error({ err, trigger }, "Sync cycle failed");
    } finally {
      this.running = false;
    }
  }

  /**
   * Fast-path sync for use right before a /status command runs.
   * - Only walks 2 pages (200 most recent Evolution records)
   * - Skips the group/contact map rebuild if we have no new records
   * - Hard timeout of 10 seconds so a slow Evolution doesn't block the command
   * - Concurrent calls coalesce: if a sync is already running, callers wait
   *   for it instead of starting a second one
   *
   * Returns when either (a) a fresh sync finished, or (b) timeout expired.
   */
  async syncNowForCommand(): Promise<{
    saved: number;
    updated: number;
    durationMs: number;
    waited: boolean;
  }> {
    const started = Date.now();

    // If a sync is already running (e.g. the 5-min cron just fired), wait
    // for it to finish instead of racing it.
    if (this.running) {
      const waitStart = Date.now();
      while (this.running && Date.now() - waitStart < 10_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { saved: 0, updated: 0, durationMs: Date.now() - started, waited: true };
    }

    this.running = true;
    try {
      const syncPromise = this.syncRecent(2);
      const timeoutPromise = new Promise<{ saved: 0; updated: 0 }>((resolve) =>
        setTimeout(() => resolve({ saved: 0, updated: 0 }), 10_000),
      );
      const result = await Promise.race([syncPromise, timeoutPromise]);
      this.logger.info(
        {
          trigger: "on-demand",
          durationMs: Date.now() - started,
          saved: result.saved,
          updated: result.updated,
        },
        "On-demand sync complete",
      );
      return {
        saved: result.saved,
        updated: result.updated,
        durationMs: Date.now() - started,
        waited: false,
      };
    } catch (err) {
      this.logger.warn({ err }, "On-demand sync failed");
      return { saved: 0, updated: 0, durationMs: Date.now() - started, waited: false };
    } finally {
      this.running = false;
    }
  }

  /**
   * Pull the N most recent pages from Evolution and ingest anything
   * we haven't seen. Uses the same ingestRaw path as the full backfill
   * but scoped to only recent messages.
   */
  private async syncRecent(maxPages = 10): Promise<{
    scanned: number;
    saved: number;
    updated: number;
    duplicate: number;
  }> {
    // Build the resolution maps so group chatName gets populated for
    // any new groups that appeared since the last sync.
    const chatNameMap = new Map<string, string>();
    const lidToPhone = new Map<string, string>();
    const phoneToName = new Map<string, string>();

    try {
      const groups = await this.evolution.fetchAllGroups(true);
      for (const g of groups) {
        chatNameMap.set(g.id, g.subject);
        for (const p of g.participants ?? []) {
          if (p.id && p.phoneNumber) {
            lidToPhone.set(p.id, p.phoneNumber);
          }
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "fetchAllGroups failed in sync");
    }

    try {
      const contacts = await this.evolution.fetchAllContacts();
      for (const c of contacts) {
        if (c.pushName && !/^\d+$/.test(c.pushName)) {
          phoneToName.set(c.remoteJid, c.pushName);
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "fetchAllContacts failed in sync");
    }

    const resolver = { chatNameMap, lidToPhone, phoneToName };

    let scanned = 0;
    let saved = 0;
    let updated = 0;
    let duplicate = 0;

    // Evolution returns messages in newest-first order on page 1, so walking
    // the first N pages catches recent activity.
    for (let page = 1; page <= maxPages; page++) {
      try {
        const pageData = await this.evolution.fetchMessagesPage(page, 100);
        if (!pageData.records || pageData.records.length === 0) break;

        let changesThisPage = 0;
        for (const record of pageData.records) {
          scanned += 1;
          try {
            const res = await this.ingest.ingestRaw(record, resolver);
            if (res.saved) {
              saved += 1;
              changesThisPage += 1;
            } else if (res.updated) {
              updated += 1;
              changesThisPage += 1;
            } else if (res.duplicate) {
              duplicate += 1;
            }
          } catch {
            // swallow individual errors — other records should keep processing
          }
        }

        // Optimization: if a whole page had zero new/updated messages, we've
        // caught up. Stop walking further pages.
        if (changesThisPage === 0 && page >= 2) break;

        if (page >= pageData.pages) break;
      } catch (err) {
        this.logger.warn({ err, page }, "Sync page fetch failed");
        break;
      }
    }

    return { scanned, saved, updated, duplicate };
  }
}
