import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  /**
   * Destination:
   *   - "self"          → the connected account's own chat
   *   - "group"         → the group/chat where the trigger fired (event automations only)
   *   - "<id>@g.us"     → an explicit group JID
   *   - "<digits>"      → a phone number
   */
  to: z.string().min(1),
  /** Message text. Supports WhatsApp markdown (*bold*, _italic_). */
  text: z.string().min(1),
});

export type SendTextPayload = z.infer<typeof payloadSchema>;

/**
 * Sends a plain text WhatsApp message via Evolution API. Used by both
 * time-based ScheduledTasks and event-based Automations.
 *
 * Special `to` values:
 *   - "self"  → the connected account's phone
 *   - "group" → the chat where the triggering event happened (ctx.trigger.chatId);
 *               only meaningful for event automations (reaction/lead triggers)
 */
export const sendTextAction: Action<SendTextPayload> = {
  type: "sendText",
  description: "Send a WhatsApp text message to a number, a group, or 'self'/'group'.",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: SendTextPayload): Promise<ActionResult> {
    try {
      // "group" → the chat the trigger fired in (e.g. post back into the lead group).
      if (payload.to === "group") {
        const chatId = ctx.trigger?.chatId;
        if (!chatId) {
          return { success: false, output: "", error: "to:'group' requires an event trigger with a chat" };
        }
        await ctx.evolution.sendToChat(chatId, payload.text);
        return { success: true, output: `Sent to group ${chatId}: ${preview(payload.text)}` };
      }

      // Explicit group JID.
      if (payload.to.endsWith("@g.us")) {
        await ctx.evolution.sendToChat(payload.to, payload.text);
        return { success: true, output: `Sent to group ${payload.to}: ${preview(payload.text)}` };
      }

      // "self" or a phone number.
      const target = payload.to === "self" ? ctx.selfIdentity.getPhone() : payload.to.replace(/\D/g, "");
      if (!target) {
        return { success: false, output: "", error: "No target phone (self identity not known)" };
      }
      await ctx.evolution.sendText(target, payload.text);
      return { success: true, output: `Sent to ${target}: ${preview(payload.text)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};

function preview(text: string): string {
  return `${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`;
}
