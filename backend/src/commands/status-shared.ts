import { parseLeadWithReason } from "../services/lead-parser.js";
import { formatInTz } from "../utils/dates.js";
import { aggregateLeads, formatStatusReply } from "../utils/format.js";
import type { CommandContext, CommandResult } from "./types.js";

export interface StatusWindow {
  label: string;
  start: Date;
  end: Date;
  /** Optional override for the "(MM/DD)" subtitle — defaults to today. */
  shortDate?: string;
}

/**
 * In-memory cache: group name → chatId. Persists for the lifetime of the
 * process. Looked up via three strategies in order:
 *   1. Any existing Message row whose chatName matches the filter
 *   2. Evolution's /group/fetchAllGroups endpoint (by subject match)
 *   3. Cache miss — fall back to chatName filter (imperfect but better than nothing)
 *
 * Cached indefinitely — group renames are rare, and on rename we'd just
 * need to restart the backend (or we can build invalidation later).
 */
const groupIdCache = new Map<string, string | null>();

/**
 * Resolve a group display name ("Be Home Leads Scheduled") to its chatId
 * ("120363396996770368"). Caches the result indefinitely.
 *
 * Strategy, fastest path first:
 *   1. In-memory cache
 *   2. Find any Message row whose chatName case-insensitively contains the filter
 *   3. Query Evolution /group/fetchAllGroups and look for subject match
 *
 * Returns null if no match is found; callers should fall back to chatName.
 */
async function resolveGroupChatId(
  ctx: CommandContext,
  filter: string,
): Promise<string | null> {
  if (groupIdCache.has(filter)) {
    return groupIdCache.get(filter) ?? null;
  }

  // Strategy 2: find it via an existing Message row with chatName set
  try {
    const sample = await ctx.prisma.message.findFirst({
      where: {
        isGroup: true,
        chatName: { contains: filter, mode: "insensitive" },
      },
      select: { chatId: true },
    });
    if (sample?.chatId) {
      groupIdCache.set(filter, sample.chatId);
      return sample.chatId;
    }
  } catch {
    // ignore
  }

  // Strategy 3: ask Evolution directly
  try {
    const groups = await ctx.evolution.fetchAllGroups(false);
    const lowerFilter = filter.toLowerCase();
    const match = groups.find((g) => g.subject.toLowerCase().includes(lowerFilter));
    if (match) {
      // Strip the @g.us suffix to match our chatId convention
      const chatId = match.id.replace(/@.*$/, "");
      groupIdCache.set(filter, chatId);
      return chatId;
    }
  } catch (err) {
    ctx.logger.warn({ err }, "resolveGroupChatId: fetchAllGroups failed");
  }

  groupIdCache.set(filter, null);
  return null;
}

/**
 * Shared implementation for /statustoday and /statusweek — queries the lead
 * group messages in the time window, parses each, aggregates by poster and
 * source, and returns a formatted reply.
 */
export async function buildStatusReply(
  ctx: CommandContext,
  window: StatusWindow,
): Promise<CommandResult> {
  const { prisma, evolution, config, logger, incrementalSync } = ctx;
  const groupFilter = config.BE_HOME_LEADS_GROUP_NAME;

  // Step 1: resolve the target group's chatId (fast — cached after first call,
  // and the fallback strategy uses an indexed DB lookup). We need this BEFORE
  // the sync so we can do a scoped sync that only fetches messages for this
  // one chat (dramatically faster than a full 2-page general sync).
  const chatId = await resolveGroupChatId(ctx, groupFilter);
  const chatJid = chatId ? `${chatId}@g.us` : null;

  // Step 2: scoped on-demand sync. Target latency 300-800ms. If Evolution is
  // slow, bounded at 8s; after that we fall back to whatever we already have
  // in the DB.
  try {
    const syncResult = await incrementalSync.syncNowForCommand(chatJid ?? undefined);
    logger.debug(
      {
        saved: syncResult.saved,
        updated: syncResult.updated,
        durationMs: syncResult.durationMs,
        waited: syncResult.waited,
      },
      "On-demand sync before status query",
    );
  } catch (err) {
    logger.warn({ err }, "On-demand sync failed, falling back to stored state");
  }

  // Step 3: opportunistic retrofit on chatName. Any rows with the right
  // chatId but null chatName get their chatName populated. Fast — indexed
  // update, usually zero rows, runs silently.
  if (chatId) {
    try {
      await prisma.message.updateMany({
        where: { chatId, chatName: null, isGroup: true },
        data: { chatName: groupFilter },
      });
    } catch (err) {
      logger.debug({ err }, "chatName retrofit failed");
    }
  }

  const messages = await prisma.message.findMany({
    where: {
      isGroup: true,
      ...(chatId
        ? { chatId }
        : { chatName: { contains: groupFilter, mode: "insensitive" } }),
      timestamp: { gte: window.start, lte: window.end },
      messageType: "TEXT",
    },
    orderBy: { timestamp: "asc" },
  });

  // Evolution webhook might deliver messages with chatName: null for groups.
  // The sync might not always run the fetchAllGroups call first. Ensure we
  // have `evolution` available here in case we need to resolve by subject.
  void evolution;

  logger.debug(
    { count: messages.length, groupFilter, from: window.start, to: window.end },
    "Status query loaded messages",
  );

  const shortDate = window.shortDate ?? formatInTz(ctx.now, config.TZ, "MM/dd");

  if (messages.length === 0) {
    return {
      success: true,
      reply: `📊 Scheduled Leads — ${window.label} (${shortDate}):\nNo leads in this period.\n\nCheck that the group "${groupFilter}" exists or adjust BE_HOME_LEADS_GROUP_NAME.`,
    };
  }

  const leads: Array<{ poster: string; parsed: NonNullable<ReturnType<typeof parseLeadWithReason>["lead"]> }> = [];
  const skippedByReason: Record<string, number> = {
    too_short: 0,
    no_signal: 0,
    empty: 0,
  };

  for (const msg of messages) {
    const result = parseLeadWithReason(msg.content);
    if (!result.lead) {
      skippedByReason[result.skipReason] =
        (skippedByReason[result.skipReason] ?? 0) + 1;
      continue;
    }
    const poster = msg.senderName?.trim() || msg.senderPhone || "Unknown";
    leads.push({ poster, parsed: result.lead });
  }

  const skipped =
    (skippedByReason.too_short ?? 0) +
    (skippedByReason.no_signal ?? 0) +
    (skippedByReason.empty ?? 0);

  if (leads.length === 0) {
    return {
      success: true,
      reply: `📊 Scheduled Leads — ${window.label} (${shortDate}):\nTotal: 0 leads (${messages.length} messages in the group, none recognized as a lead).`,
    };
  }

  const { byPerson, bySource } = aggregateLeads(
    leads.map((l) => ({ poster: l.poster, parsed: l.parsed })),
  );

  const reply = formatStatusReply(
    {
      label: window.label,
      rangeStart: window.start,
      rangeEnd: window.end,
      total: leads.length,
      byPerson,
      bySource,
      skipped,
      skippedByReason,
    },
    shortDate,
  );

  return { success: true, reply };
}
