import { formatInTz, startOfNDaysAgoInTz } from "../utils/dates.js";
import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";

export const status7DaysCommand: Command = {
  name: "status7days",
  aliases: ["7days", "last7days"],
  description: "Summary of scheduled leads from the last 7 days (rolling).",
  usage: "/status7days",
  async execute(ctx) {
    const tz = ctx.config.TZ;
    // 7 days ago means "6 days before today", so we get a 7-day window
    // including today.
    const start = startOfNDaysAgoInTz(ctx.now, tz, 6);
    return buildStatusReply(ctx, {
      label: "Last 7 days",
      start,
      end: ctx.now,
      shortDate: formatInTz(ctx.now, tz, "MM/dd"),
    });
  },
};
