import type { DelegateService } from "../services/delegate-service.js";
import type { Command } from "./types.js";

/**
 * /delegate — manage who else can run commands by messaging you.
 *
 *   /delegate add <phone> <name>    — authorize a new delegate
 *   /delegate remove <phone>        — revoke authorization
 *   /delegate on <phone>            — re-enable a disabled delegate
 *   /delegate off <phone>           — disable without removing
 *   /delegate list                  — show all delegates
 *
 * Only the owner (self-chat) can run these. Delegates themselves cannot
 * manage other delegates.
 */
export function createDelegateCommand(
  delegateService: DelegateService,
): Command {
  return {
    name: "delegate",
    aliases: ["delegates"],
    description: "Manage who can run commands by messaging you.",
    usage:
      "/delegate add <phone> <name>\n" +
      "  /delegate remove <phone>\n" +
      "  /delegate on <phone>\n" +
      "  /delegate off <phone>\n" +
      "  /delegate list",
    async execute(ctx) {
      const { args } = ctx;
      const sub = (args[0] ?? "").toLowerCase();

      if (sub === "list" || sub === "" || !sub) {
        const all = await delegateService.list();
        if (all.length === 0) {
          return {
            success: true,
            reply:
              "📋 No delegates configured.\n\n" +
              "Add one with: `/delegate add 14255245126 Jack Be Home`",
          };
        }
        const lines = [`📋 *${all.length} delegate(s):*`, ""];
        all.forEach((d, i) => {
          const badge = d.enabled ? "✅" : "⏸️";
          const perms =
            d.allowedCommands.length > 0
              ? d.allowedCommands.join(", ")
              : "read-only (status/audit/help)";
          lines.push(
            `${i + 1}. ${badge} *${d.name}* (${d.phone})`,
          );
          lines.push(`   perms: ${perms}`);
        });
        lines.push("");
        lines.push(
          "_When enabled, they can DM you a /command and get the reply._",
        );
        return { success: true, reply: lines.join("\n") };
      }

      if (sub === "add") {
        const phone = args[1];
        const name = args.slice(2).join(" ");
        if (!phone || !name) {
          return {
            success: false,
            reply: "❌ Usage: `/delegate add <phone> <name>`\nExample: `/delegate add 14255245126 Jack Be Home`",
            error: "missing_args",
          };
        }
        const d = await delegateService.add(phone, name);
        return {
          success: true,
          reply: `✅ *${d.name}* (${d.phone}) added as a delegate.\nThey can now DM you /statustoday etc. and get the reply directly.`,
        };
      }

      if (sub === "remove" || sub === "delete") {
        const phone = args[1];
        if (!phone) {
          return {
            success: false,
            reply: "❌ Usage: `/delegate remove <phone>`",
            error: "missing_phone",
          };
        }
        await delegateService.remove(phone);
        return { success: true, reply: `🗑️ Delegate ${phone} removed.` };
      }

      if (sub === "on" || sub === "enable") {
        const phone = args[1];
        if (!phone) {
          return {
            success: false,
            reply: "❌ Usage: `/delegate on <phone>`",
            error: "missing_phone",
          };
        }
        const d = await delegateService.setEnabled(phone, true);
        if (!d) {
          return {
            success: false,
            reply: `❌ Delegate ${phone} not found. Use /delegate add first.`,
            error: "not_found",
          };
        }
        return { success: true, reply: `✅ *${d.name}* re-enabled.` };
      }

      if (sub === "off" || sub === "disable") {
        const phone = args[1];
        if (!phone) {
          return {
            success: false,
            reply: "❌ Usage: `/delegate off <phone>`",
            error: "missing_phone",
          };
        }
        const d = await delegateService.setEnabled(phone, false);
        if (!d) {
          return {
            success: false,
            reply: `❌ Delegate ${phone} not found.`,
            error: "not_found",
          };
        }
        return {
          success: true,
          reply: `⏸️ *${d.name}* disabled. Their commands will be ignored until you /delegate on.`,
        };
      }

      return {
        success: false,
        reply:
          "❌ Unknown sub-command. Options: add, remove, on, off, list",
        error: "unknown_sub",
      };
    },
  };
}
