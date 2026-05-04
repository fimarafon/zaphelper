import type { PrismaClient, Prisma } from "@prisma/client";
import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import {
  extractContent,
  isExcludedContent,
  type MessageIngest,
} from "./message-ingest.js";

interface ResolverCache {
  chatNameMap: Map<string, string>;
  lidToPhone: Map<string, string>;
  phoneToName: Map<string, string>;
  builtAt: number;
}

// Resolver TTL bumped to 60min — used to be 10min, but rebuilding triggers
// evolution.fetchAllGroups(true) which causes WhatsApp to fire "syncing"
// notifications on the user's linked devices. With v2.3.7 webhooks stable,
// the resolver doesn't need refreshing as often.
const RESOLVER_TTL_MS = 60 * 60 * 1000; // 60 minutes

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
  /** Separate mutex for fast chat syncs so they don't block on general sync. */
  private fastSyncInFlight = 0;
  /** Separate mutex so the resolver is rebuilt at most once concurrently. */
  private rebuildingResolver = false;
  private readonly logger: Logger;

  /**
   * Cached resolver maps. Rebuilt on first use and then every 10 minutes
   * (or when invalidate() is called). Without this cache, every on-demand
   * sync would burn ~1s rebuilding maps that rarely change.
   */
  private resolverCache: ResolverCache | null = null;

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
    // Cron interval bumped from 5min → 30min. Rationale: with Evolution v2.3.7
    // webhooks are stable (no more "Waiting for message" issues) so we don't
    // need 5-min compensation passes. Less frequent runs = fewer "syncing"
    // notifications on the user's linked WhatsApp devices.
    this.cronJob = cron.schedule(
      "*/30 * * * *",
      () => {
        void this.runSafely("cron");
      },
      { timezone: this.config.TZ },
    );

    this.logger.info("Incremental sync started (every 30 minutes)");
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
      // Cron runs walk 3 pages (300 newest records) — enough to catch any
      // gap from webhook drops during a restart, but short enough to
      // complete in under 1s once the DB is caught up (the page-level
      // short-circuit stops as soon as a page has zero new records).
      const maxPages = trigger === "on-demand" ? 2 : 3;
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
  /**
   * Fast-path sync before a /status* command runs.
   *
   * When `chatJid` is provided, the sync is scoped to that one chat —
   * a single Evolution API call + a single SQL dedupe query + a few
   * inserts. Target latency: 300-800ms.
   *
   * When `chatJid` is omitted, falls back to the general 2-page sync
   * (slower but covers all chats).
   *
   * Concurrent calls coalesce: if another sync is in flight, we wait
   * for it (up to 5 seconds) instead of starting a second one.
   */
  async syncNowForCommand(chatJid?: string): Promise<{
    saved: number;
    updated: number;
    durationMs: number;
    waited: boolean;
  }> {
    const started = Date.now();

    // FAST PATH: scoped chat sync. Never blocks on the general sync lock —
    // they hit different data paths and Postgres uniqueness handles any
    // rare race. Capped at 3 seconds so a slow Evolution never hurts UX.
    if (chatJid) {
      this.fastSyncInFlight += 1;
      try {
        const result = await Promise.race([
          this.fastChatSync(chatJid),
          new Promise<{ saved: 0; updated: 0; duplicate: 0 }>((resolve) =>
            setTimeout(() => resolve({ saved: 0, updated: 0, duplicate: 0 }), 3_000),
          ),
        ]);
        this.logger.info(
          {
            trigger: "on-demand-fast",
            chatJid,
            durationMs: Date.now() - started,
            saved: result.saved,
            updated: result.updated,
          },
          "Fast chat sync complete",
        );
        return {
          saved: result.saved,
          updated: result.updated,
          durationMs: Date.now() - started,
          waited: false,
        };
      } catch (err) {
        this.logger.warn({ err, chatJid }, "Fast chat sync failed");
        return { saved: 0, updated: 0, durationMs: Date.now() - started, waited: false };
      } finally {
        this.fastSyncInFlight -= 1;
      }
    }

    // SLOW PATH: general sync (walks 2 pages of all chats). Coalesces with
    // running background syncs to prevent resource contention.
    if (this.running) {
      const waitStart = Date.now();
      while (this.running && Date.now() - waitStart < 3_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { saved: 0, updated: 0, durationMs: Date.now() - started, waited: true };
    }

    this.running = true;
    try {
      const result = await Promise.race([
        this.syncRecent(2),
        new Promise<{ saved: 0; updated: 0; scanned: 0; duplicate: 0 }>((resolve) =>
          setTimeout(() => resolve({ saved: 0, updated: 0, scanned: 0, duplicate: 0 }), 5_000),
        ),
      ]);
      this.logger.info(
        {
          trigger: "on-demand-general",
          durationMs: Date.now() - started,
          saved: result.saved,
          updated: result.updated,
        },
        "General on-demand sync complete",
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
   * Fast-path: fetch the most recent messages for a specific chat and
   * ingest anything new. Designed to run in under 1 second.
   *
   * Shape:
   *   1. Fetch 50 newest messages for the chat from Evolution (1 API call)
   *   2. SELECT IN (...) our existing waMessageIds + content (1 SQL query)
   *   3. For each record:
   *      - If new: insert via MessageIngest.ingestRaw (uses cached resolver)
   *      - If existing with different content: update in place (edit detected)
   *      - If existing and same: skip
   *   4. Return counts
   */
  private async fastChatSync(chatJid: string): Promise<{
    saved: number;
    updated: number;
    duplicate: number;
  }> {
    const records = await this.evolution.fetchMessagesForChat(chatJid, 50);
    if (records.length === 0) return { saved: 0, updated: 0, duplicate: 0 };

    // Single SELECT with IN clause to check which ones we already have.
    const ids: string[] = [];
    for (const r of records) {
      const key = r.key as { id?: string } | undefined;
      if (key?.id) ids.push(key.id);
    }
    if (ids.length === 0) return { saved: 0, updated: 0, duplicate: 0 };

    const existing = await this.prisma.message.findMany({
      where: { waMessageId: { in: ids } },
      select: { waMessageId: true, content: true },
    });
    const existingMap = new Map(
      existing.map((e) => [e.waMessageId, e.content] as const),
    );

    // Non-blocking resolver — returns stale or empty cache instantly.
    // Background rebuild is kicked off if the cache is stale.
    const resolver = this.getResolverFast();

    let saved = 0;
    let updated = 0;
    let duplicate = 0;

    for (const record of records) {
      const key = record.key as { id?: string } | undefined;
      if (!key?.id) continue;

      const existingContent = existingMap.get(key.id);
      if (existingContent !== undefined) {
        // Already have it — check for edits. BUT: if the existing content is
        // a manual exclusion sentinel ("[excluded]" / "[deleted]"), do NOT
        // overwrite it. Evolution still holds the pre-exclusion payload, so
        // without this guard every sync tick would resurrect the content.
        if (isExcludedContent(existingContent)) {
          duplicate += 1;
          continue;
        }
        const { content, messageType } = extractContent(
          (record.message ?? {}) as Parameters<typeof extractContent>[0],
        );
        if (
          content &&
          content !== "[Unsupported message]" &&
          content !== existingContent
        ) {
          await this.prisma.message.update({
            where: { waMessageId: key.id },
            data: {
              content,
              messageType,
              rawMessage: record as unknown as Prisma.InputJsonValue,
            },
          });
          updated += 1;
        } else {
          duplicate += 1;
        }
        continue;
      }

      // New message — ingest with full resolution.
      try {
        const res = await this.ingest.ingestRaw(record, resolver);
        if (res.saved) saved += 1;
        else if (res.updated) updated += 1;
        else duplicate += 1;
      } catch (err) {
        this.logger.debug({ err, waMessageId: key.id }, "fastChatSync ingestRaw failed");
      }
    }

    return { saved, updated, duplicate };
  }

  /**
   * Pull the N most recent pages from Evolution and ingest anything
   * we haven't seen. Uses the same ingestRaw path as the full backfill
   * but scoped to only recent messages.
   */
  /**
   * Returns a resolver immediately, WITHOUT blocking to rebuild.
   *
   * - If the cache is fresh, returns it directly.
   * - If the cache exists but is stale, returns the stale copy AND
   *   triggers a background rebuild (fire-and-forget). The next call
   *   will get the fresh copy once the background rebuild finishes.
   * - If the cache is completely missing (cold start), returns an empty
   *   resolver so the caller can still do something useful, and triggers
   *   a background rebuild.
   *
   * This is the right function for hot paths (`fastChatSync`) — we never
   * want to block the user's /status command on a resolver rebuild.
   */
  private getResolverFast(): ResolverCache {
    if (this.resolverCache) {
      if (Date.now() - this.resolverCache.builtAt > RESOLVER_TTL_MS) {
        // Stale — kick off background rebuild, return stale copy.
        void this.rebuildResolverInBackground();
      }
      return this.resolverCache;
    }
    // Cold cache — return empty, rebuild in background.
    void this.rebuildResolverInBackground();
    return {
      chatNameMap: new Map(),
      lidToPhone: new Map(),
      phoneToName: new Map(),
      builtAt: 0,
    };
  }

  private async rebuildResolverInBackground(): Promise<void> {
    if (this.rebuildingResolver) return;
    this.rebuildingResolver = true;
    try {
      await this.getResolver(true);
    } catch (err) {
      this.logger.debug({ err }, "Background resolver rebuild failed");
    } finally {
      this.rebuildingResolver = false;
    }
  }

  /**
   * Returns the resolver maps, rebuilding them if the cache is missing
   * or stale. Rebuilding does 2 Evolution API calls (~800ms total) and
   * processes a few hundred rows, so we want to avoid doing it on every
   * hot-path sync.
   */
  private async getResolver(forceRefresh = false): Promise<ResolverCache> {
    if (
      !forceRefresh &&
      this.resolverCache &&
      Date.now() - this.resolverCache.builtAt < RESOLVER_TTL_MS
    ) {
      return this.resolverCache;
    }

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
      this.logger.debug({ err }, "fetchAllGroups failed in resolver rebuild");
    }

    try {
      const contacts = await this.evolution.fetchAllContacts();
      for (const c of contacts) {
        if (c.pushName && !/^\d+$/.test(c.pushName)) {
          phoneToName.set(c.remoteJid, c.pushName);
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "fetchAllContacts failed in resolver rebuild");
    }

    this.resolverCache = {
      chatNameMap,
      lidToPhone,
      phoneToName,
      builtAt: Date.now(),
    };
    this.logger.debug(
      {
        groups: chatNameMap.size,
        lids: lidToPhone.size,
        contacts: phoneToName.size,
      },
      "Resolver rebuilt",
    );
    return this.resolverCache;
  }

  /** Invalidate the resolver cache — forces a rebuild on next use. */
  invalidateResolver(): void {
    this.resolverCache = null;
  }

  private async syncRecent(maxPages = 10): Promise<{
    scanned: number;
    saved: number;
    updated: number;
    duplicate: number;
  }> {
    const resolver = await this.getResolver();

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
