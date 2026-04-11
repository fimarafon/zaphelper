import { parseLeadWithReason, type SkipReason } from "../services/lead-parser.js";
import {
  formatInTz,
  parseStatusRange,
  startOfWeekMondayInTz,
  endOfDayInTz,
} from "../utils/dates.js";
import type { Command } from "./types.js";

/**
 * /audit — lists messages that were NOT counted as leads, so the user can
 * verify the parser didn't miss anything. Defaults to "this week".
 *
 * Accepts the same date/range arguments as /status:
 *   /audit              → this week
 *   /audit04/09         → just April 9
 *   /audit04/03to04/09  → range
 */
export const auditCommand: Command = {
  name: "audit",
  description: "Show messages that were NOT counted as leads, for review.",
  usage: "/audit [date|range]",
  async execute(ctx) {
    const { prisma, config, now } = ctx;
    const input = ctx.rawInput.trim();

    let start: Date;
    let end: Date;
    let label: string;

    if (!input) {
      // Default: this week
      start = startOfWeekMondayInTz(now, config.TZ);
      end = now;
      label = "This week";
    } else {
      const range = parseStatusRange(input, config.TZ, now);
      if (!range) {
        return {
          success: false,
          reply:
            `❌ Could not parse "${input}".\n` +
            "Use the same formats as /status, e.g. `/audit04/09` or `/audit04/03to04/09`",
          error: "parse_failed",
        };
      }
      start = range.start;
      end = range.end;
      label = range.label;
    }

    const messages = await prisma.message.findMany({
      where: {
        isGroup: true,
        chatName: { contains: config.BE_HOME_LEADS_GROUP_NAME, mode: "insensitive" },
        timestamp: { gte: start, lte: end },
        messageType: "TEXT",
      },
      orderBy: { timestamp: "asc" },
    });

    const skipped: Array<{
      timestamp: Date;
      senderName: string | null;
      content: string;
      reason: SkipReason;
    }> = [];

    for (const m of messages) {
      const result = parseLeadWithReason(m.content);
      if (!result.lead) {
        skipped.push({
          timestamp: m.timestamp,
          senderName: m.senderName,
          content: m.content,
          reason: result.skipReason,
        });
      }
    }

    const header = `🔍 *Audit — ${label}*\nTotal msgs: ${messages.length} | Leads: ${messages.length - skipped.length} | Ignored: ${skipped.length}`;

    if (skipped.length === 0) {
      return {
        success: true,
        reply: `${header}\n\n✅ All messages in this window were counted as leads. Nothing ignored.`,
      };
    }

    // Show up to 15 skipped messages, with a truncated preview.
    // WhatsApp messages have a practical limit of ~4000 chars.
    const MAX_SHOWN = 15;
    const MAX_PREVIEW = 90;

    const lines: string[] = [header, ""];

    const shown = skipped.slice(0, MAX_SHOWN);
    for (const [i, s] of shown.entries()) {
      const when = formatInTz(s.timestamp, config.TZ, "MM/dd HH:mm");
      const sender = s.senderName?.trim() || "?";
      const preview = s.content
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_PREVIEW);
      const truncated = s.content.length > MAX_PREVIEW ? "…" : "";
      const reasonTag =
        s.reason === "too_short"
          ? "short"
          : s.reason === "no_signal"
            ? "no-signal"
            : "empty";
      lines.push(`${i + 1}. _${when}_ *${sender}* [${reasonTag}]`);
      lines.push(`    "${preview}${truncated}"`);
    }

    if (skipped.length > MAX_SHOWN) {
      lines.push("");
      lines.push(`_… and ${skipped.length - MAX_SHOWN} more. Narrow the range to see them._`);
    }

    lines.push("");
    lines.push("_Legend: *short*=1 line (chatter), *no-signal*=no name/phone/date, *empty*=empty or media._");

    return { success: true, reply: lines.join("\n") };
  },
};
