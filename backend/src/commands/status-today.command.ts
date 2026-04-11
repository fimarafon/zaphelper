import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";
import { startOfTodayInTz } from "../utils/dates.js";

export const statusTodayCommand: Command = {
  name: "statustoday",
  aliases: ["today"],
  description: "Summary of scheduled leads posted today in the Be Home group.",
  usage: "/statustoday",
  async execute(ctx) {
    const start = startOfTodayInTz(ctx.now, ctx.config.TZ);
    return buildStatusReply(ctx, { label: "Today", start, end: ctx.now });
  },
};
