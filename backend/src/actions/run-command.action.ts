import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  /** The full command to run, including the leading slash. e.g. "/statusweek". */
  command: z.string().min(1).refine((s) => s.startsWith("/"), {
    message: "command must start with /",
  }),
  /**
   * If true, the resulting reply is also sent to the user's self-chat.
   * Default: true — most of the time the user wants the report delivered.
   */
  deliverToSelf: z.boolean().optional().default(true),
});

export type RunCommandPayload = z.infer<typeof payloadSchema>;

/**
 * Runs an internal zaphelper command (like `/statusweek`) and optionally
 * delivers the result to the user's self-chat via Evolution.
 *
 * Use cases:
 *   - Schedule `/statusweek` every Monday 9am → weekly report lands in self-chat
 *   - Schedule `/statusmonth` on the 1st → monthly summary
 *   - Schedule `/statustoday` every day at 6pm → end-of-day snapshot
 */
export const runCommandAction: Action<RunCommandPayload> = {
  type: "runCommand",
  description:
    "Run an internal zaphelper command (e.g. /statusweek) and deliver the reply.",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: RunCommandPayload): Promise<ActionResult> {
    if (!ctx.runInlineCommand) {
      return {
        success: false,
        output: "",
        error: "runInlineCommand dispatcher not available",
      };
    }

    try {
      const result = await ctx.runInlineCommand(payload.command);

      // Deliver the reply to self-chat, unless explicitly disabled.
      if (payload.deliverToSelf !== false) {
        const selfPhone = ctx.selfIdentity.getPhone();
        if (selfPhone) {
          try {
            await ctx.evolution.sendText(selfPhone, result.reply);
          } catch (err) {
            ctx.logger.warn({ err }, "Failed to deliver command result to self");
          }
        }
      }

      return {
        success: result.success,
        output: `${payload.command} → ${result.reply.slice(0, 150)}${
          result.reply.length > 150 ? "…" : ""
        }`,
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};
