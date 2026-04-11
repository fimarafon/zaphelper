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
  async runSafely(trigger: "boot" | "cron" | "manual"): Promise<void> {
    if (this.running) {
      this.logger.debug("Sync already in progress, skipping");
      return;
    }
    this.running = true;
    const started = Date.now();
    try {
      const result = await this.syncRecent();
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
   * Pull the N most recent pages from Evolution and ingest anything
   * we haven't seen. Uses the same ingestRaw path as the full backfill
   * but scoped to only recent messages.
   */
  private async syncRecent(maxPages = 10): Promise<{
    scanned: number;
    saved: number;
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
    let duplicate = 0;

    // Evolution returns messages in newest-first order on page 1, so walking
    // the first N pages catches recent activity.
    for (let page = 1; page <= maxPages; page++) {
      try {
        const pageData = await this.evolution.fetchMessagesPage(page, 100);
        if (!pageData.records || pageData.records.length === 0) break;

        let savedThisPage = 0;
        for (const record of pageData.records) {
          scanned += 1;
          try {
            const res = await this.ingest.ingestRaw(record, resolver);
            if (res.saved) {
              saved += 1;
              savedThisPage += 1;
            } else if (res.duplicate) {
              duplicate += 1;
            }
          } catch {
            // swallow individual errors — other records should keep processing
          }
        }

        // Optimization: if a whole page had zero new messages, we've caught up.
        // Stop walking further pages — older messages are already in our DB.
        if (savedThisPage === 0 && page >= 2) break;

        if (page >= pageData.pages) break;
      } catch (err) {
        this.logger.warn({ err, page }, "Sync page fetch failed");
        break;
      }
    }

    return { scanned, saved, duplicate };
  }
}
