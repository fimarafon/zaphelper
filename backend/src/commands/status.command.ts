import { parseStatusRange } from "../utils/dates.js";
import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";

export const statusCommand: Command = {
  name: "status",
  description: "Lead summary for a specific date or range.",
  usage:
    "/status <date | range>\n" +
    "  ex: /status04/09          → April 9\n" +
    "  ex: /status04/03to04/09   → Apr 3 to Apr 9\n" +
    "  ex: /status 2026-04-09    → same, ISO format",
  async execute(ctx) {
    const input = ctx.rawInput.trim();

    if (!input) {
      return {
        success: false,
        reply:
          "❌ Missing date.\n" +
          "Use one of:\n" +
          "  `/status04/09`            → specific day\n" +
          "  `/status04/03to04/09`     → date range\n" +
          "  `/status 2026-04-09`      → ISO single day\n\n" +
          "Or shortcuts: `/statustoday`, `/statusyesterday`, `/status7days`, `/statusweek`, `/statusmonth`",
        error: "missing_date",
      };
    }

    const range = parseStatusRange(input, ctx.config.TZ, ctx.now);
    if (!range) {
      return {
        success: false,
        reply:
          `❌ Could not parse "${input}".\n` +
          "Supported formats:\n" +
          "  `04/09`  `4/9`  `04/09/2026`  `2026-04-09`\n" +
          "  `04/03to04/09`  `04/03 to 04/09`  `04/03-04/09`",
        error: "parse_failed",
      };
    }

    return buildStatusReply(ctx, {
      label: range.label,
      start: range.start,
      end: range.end,
      shortDate: range.shortDate,
    });
  },
};
