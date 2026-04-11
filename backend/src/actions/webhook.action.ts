import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  /** Target URL. Must be https. */
  url: z.string().url(),
  /** HTTP method. Default POST. */
  method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional().default("POST"),
  /** JSON body to send (for POST/PUT/PATCH). Stringified automatically. */
  body: z.unknown().optional(),
  /** Additional headers to send (e.g. Authorization). */
  headers: z.record(z.string()).optional(),
  /**
   * If true, the response body is sent back to the user's self-chat.
   * Default: false — most webhooks are fire-and-forget.
   */
  deliverResponse: z.boolean().optional().default(false),
});

export type WebhookPayload = z.infer<typeof payloadSchema>;

/**
 * Fires an HTTP request to an external URL. Designed to integrate with
 * n8n, Zapier, Make, or any internal API that needs to be poked on a
 * schedule.
 *
 * Use cases:
 *   - Trigger a Zapier flow every Friday
 *   - Ping a CRM webhook daily
 *   - Call an internal API that runs a cleanup job
 */
export const webhookAction: Action<WebhookPayload> = {
  type: "webhook",
  description:
    "Fire an HTTP request to an external URL (POST/GET/PUT/PATCH + JSON body).",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: WebhookPayload): Promise<ActionResult> {
    const method = payload.method ?? "POST";
    const headers: Record<string, string> = {
      "User-Agent": "zaphelper/1.0",
      ...(payload.headers ?? {}),
    };
    if (payload.body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const res = await fetch(payload.url, {
        method,
        headers,
        body: payload.body !== undefined ? JSON.stringify(payload.body) : undefined,
      });

      const responseText = await res.text();
      const summary = `${method} ${payload.url} → ${res.status}`;

      // Optionally deliver response to self.
      if (payload.deliverResponse && ctx.selfIdentity.getPhone()) {
        try {
          await ctx.evolution.sendText(
            ctx.selfIdentity.getPhone()!,
            `🌐 *Webhook ${summary}*\n\`\`\`\n${responseText.slice(0, 1500)}\n\`\`\``,
          );
        } catch (err) {
          ctx.logger.warn({ err }, "Failed to deliver webhook response to self");
        }
      }

      if (!res.ok) {
        return {
          success: false,
          output: summary,
          error: `HTTP ${res.status}: ${responseText.slice(0, 200)}`,
        };
      }

      return {
        success: true,
        output: `${summary} | ${responseText.slice(0, 150)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};
