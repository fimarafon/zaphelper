import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  /** Phone number or "self". */
  to: z.string().min(1),
  /** Text to synthesize with ElevenLabs. */
  text: z.string().min(1).max(5000),
  /**
   * ElevenLabs voice ID. Default is "Rachel" (21m00Tcm4TlvDq8ikWAM).
   * See https://elevenlabs.io/docs/voices/voice-lab.
   */
  voiceId: z.string().optional().default("21m00Tcm4TlvDq8ikWAM"),
  /** Model: eleven_turbo_v2_5 (faster) or eleven_multilingual_v2 (multilingual). */
  modelId: z
    .enum(["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_monolingual_v1"])
    .optional()
    .default("eleven_turbo_v2_5"),
});

export type SendVoicePayload = z.infer<typeof payloadSchema>;

/**
 * Synthesizes text to speech via ElevenLabs and sends it as a WhatsApp
 * voice message via Evolution API.
 *
 * Requires ELEVENLABS_API_KEY env var.
 *
 * NOTE: Evolution API's sendMedia endpoint needs a publicly accessible URL
 * or a base64 data string. This action uploads the audio as base64 via
 * Evolution's `audioBase64` variant. If your Evolution build doesn't
 * support base64 uploads, you'll need a public storage bucket.
 */
export const sendVoiceAction: Action<SendVoicePayload> = {
  type: "sendVoice",
  description: "Synthesize text with ElevenLabs and send as a WhatsApp voice note.",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: SendVoicePayload): Promise<ActionResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        output: "",
        error:
          "ELEVENLABS_API_KEY not configured in environment. Set it in EasyPanel and redeploy.",
      };
    }

    const target =
      payload.to === "self"
        ? ctx.selfIdentity.getPhone()
        : payload.to.replace(/\D/g, "");

    if (!target) {
      return { success: false, output: "", error: "No target phone" };
    }

    try {
      // Step 1: synthesize speech via ElevenLabs
      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${payload.voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: payload.text,
            model_id: payload.modelId ?? "eleven_turbo_v2_5",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        },
      );

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        return {
          success: false,
          output: "",
          error: `ElevenLabs HTTP ${ttsRes.status}: ${errText.slice(0, 300)}`,
        };
      }

      // Get audio as base64 data URI
      const audioBuffer = await ttsRes.arrayBuffer();
      const base64 = Buffer.from(audioBuffer).toString("base64");
      const dataUri = `data:audio/mpeg;base64,${base64}`;

      // Step 2: send via Evolution sendMedia (audio variant)
      await ctx.evolution.sendMedia(target, dataUri, "audio");

      return {
        success: true,
        output: `Sent voice to ${target}: "${payload.text.slice(0, 100)}${
          payload.text.length > 100 ? "…" : ""
        }"`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};
