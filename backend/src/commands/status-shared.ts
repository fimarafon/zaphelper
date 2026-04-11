import { parseLead } from "../services/lead-parser.js";
import { formatInTz } from "../utils/dates.js";
import { aggregateLeads, formatStatusReply } from "../utils/format.js";
import type { CommandContext, CommandResult } from "./types.js";

export interface StatusWindow {
  label: string;
  start: Date;
  end: Date;
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
  const { prisma, config, logger } = ctx;
  const groupFilter = config.BE_HOME_LEADS_GROUP_NAME;

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

  if (messages.length === 0) {
    const short = formatInTz(ctx.now, config.TZ, "MM/dd");
    return {
      success: true,
      reply: `📊 Scheduled Leads — ${window.label} (${short}):\nNo leads in this period.\n\nCheck that the group "${groupFilter}" exists or adjust BE_HOME_LEADS_GROUP_NAME.`,
    };
  }

  const leads: Array<{ poster: string; parsed: ReturnType<typeof parseLead> }> = [];
  let skipped = 0;

  for (const msg of messages) {
    const parsed = parseLead(msg.content);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    const poster = msg.senderName?.trim() || msg.senderPhone || "Unknown";
    leads.push({ poster, parsed });
  }

  if (leads.length === 0) {
    const short = formatInTz(ctx.now, config.TZ, "MM/dd");
    return {
      success: true,
      reply: `📊 Scheduled Leads — ${window.label} (${short}):\nTotal: 0 leads (${messages.length} messages in the group, none recognized as a lead).`,
    };
  }

  const { byPerson, bySource } = aggregateLeads(
    leads.map((l) => ({ poster: l.poster, parsed: l.parsed! })),
  );

  const short = formatInTz(ctx.now, config.TZ, "MM/dd");
  const reply = formatStatusReply(
    {
      label: window.label,
      rangeStart: window.start,
      rangeEnd: window.end,
      total: leads.length,
      byPerson,
      bySource,
      skipped,
    },
    short,
  );

  return { success: true, reply };
}
