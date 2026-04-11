import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  /** Phone number (digits only) or "self" to send to the user's own chat. */
  to: z.string().min(1),
  /** Message text. Supports WhatsApp markdown (*bold*, _italic_). */
  text: z.string().min(1),
});

export type SendTextPayload = z.infer<typeof payloadSchema>;

/**
 * Sends a plain text WhatsApp message via Evolution API. The most common
 * action — used for weekly reports, reminders with custom recipients, etc.
 *
 * Special value: `to: "self"` resolves to the connected account's phone.
 */
export const sendTextAction: Action<SendTextPayload> = {
  type: "sendText",
  description: "Send a WhatsApp text message to a number or 'self'.",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: SendTextPayload): Promise<ActionResult> {
    const target =
      payload.to === "self"
        ? ctx.selfIdentity.getPhone()
        : payload.to.replace(/\D/g, "");

    if (!target) {
      return {
        success: false,
        output: "",
        error: "No target phone (self identity not known)",
      };
    }

    try {
      await ctx.evolution.sendText(target, payload.text);
      return {
        success: true,
        output: `Sent to ${target}: ${payload.text.slice(0, 100)}${
          payload.text.length > 100 ? "…" : ""
        }`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};
