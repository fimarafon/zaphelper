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
 * Shared implementation for /statustoday and /statusweek — queries the lead
 * group messages in the time window, parses each, aggregates by poster and
 * source, and returns a formatted reply.
 */
export async function buildStatusReply(
  ctx: CommandContext,
  window: StatusWindow,
): Promise<CommandResult> {
  const { prisma, config, logger, incrementalSync } = ctx;
  const groupFilter = config.BE_HOME_LEADS_GROUP_NAME;

  // CRITICAL: force a fresh sync BEFORE querying the DB. This guarantees the
  // result reflects every message Evolution has received, even if the webhook
  // dropped some (restart, timeout, edit events, etc.). The sync is bounded
  // at 10 seconds; if Evolution is slow, we fall back to whatever we have.
  // This is what makes /status* commands trustworthy for real-time decisions.
  try {
    const syncResult = await incrementalSync.syncNowForCommand();
    logger.debug(
      { saved: syncResult.saved, durationMs: syncResult.durationMs, waited: syncResult.waited },
      "On-demand sync before status query",
    );
  } catch (err) {
    logger.warn({ err }, "On-demand sync failed, falling back to stored state");
  }

  const messages = await prisma.message.findMany({
    where: {
      isGroup: true,
      chatName: { contains: groupFilter, mode: "insensitive" },
      timestamp: { gte: window.start, lte: window.end },
      messageType: "TEXT",
    },
    orderBy: { timestamp: "asc" },
  });

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
