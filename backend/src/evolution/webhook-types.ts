// Types for incoming Evolution API webhook payloads.
// Evolution ships different shapes depending on version and event type,
// so fields are intentionally permissive.

import { z } from "zod";

const keySchema = z.object({
  remoteJid: z.string(),
  fromMe: z.boolean().optional().default(false),
  id: z.string(),
  participant: z.string().optional(),
});

const messageBodySchema = z
  .object({
    conversation: z.string().optional(),
    extendedTextMessage: z
      .object({ text: z.string().optional() })
      .passthrough()
      .optional(),
    imageMessage: z
      .object({ caption: z.string().optional(), url: z.string().optional() })
      .passthrough()
      .optional(),
    audioMessage: z.object({ url: z.string().optional() }).passthrough().optional(),
    videoMessage: z
      .object({ caption: z.string().optional(), url: z.string().optional() })
      .passthrough()
      .optional(),
    documentMessage: z
      .object({ fileName: z.string().optional(), url: z.string().optional() })
      .passthrough()
      .optional(),
    stickerMessage: z.object({}).passthrough().optional(),
    contactMessage: z.object({ displayName: z.string().optional() }).passthrough().optional(),
    locationMessage: z.object({}).passthrough().optional(),
  })
  .passthrough();

const messagesUpsertDataSchema = z
  .object({
    key: keySchema,
    message: messageBodySchema.optional(),
    pushName: z.string().optional(),
    messageTimestamp: z.union([z.number(), z.string()]).optional(),
    messageType: z.string().optional(),
    groupMetadata: z.object({ subject: z.string().optional() }).passthrough().optional(),
    groupSubject: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const connectionUpdateDataSchema = z
  .object({
    state: z.string().optional(),
    statusReason: z.number().optional(),
  })
  .passthrough();

export const evolutionWebhookSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.union([messagesUpsertDataSchema, connectionUpdateDataSchema, z.record(z.unknown())]),
    destination: z.string().optional(),
    date_time: z.string().optional(),
    sender: z.string().optional(),
    server_url: z.string().optional(),
    apikey: z.string().optional(),
  })
  .passthrough();

export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookSchema>;
export type EvolutionMessageKey = z.infer<typeof keySchema>;
export type EvolutionMessageBody = z.infer<typeof messageBodySchema>;
export type EvolutionMessagesUpsertData = z.infer<typeof messagesUpsertDataSchema>;
export type EvolutionConnectionUpdateData = z.infer<typeof connectionUpdateDataSchema>;

// Narrow helpers — these use duck typing rather than discriminated unions because
// Evolution API doesn't always populate `event` the same way between versions.

export function isMessagesUpsert(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionMessagesUpsertData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const hasKey = typeof data.key === "object" && data.key !== null && "id" in (data.key as object);
  const ev = payload.event?.toLowerCase();
  // Upsert event or unlabeled event with a key — treat as upsert.
  return (
    hasKey &&
    (!ev ||
      ev.includes("messages.upsert") ||
      ev.includes("messages_upsert")) &&
    !ev?.includes("update") &&
    !ev?.includes("delete")
  );
}

/**
 * A message edit event. WhatsApp fires this when a sender edits a message
 * they previously sent (to correct a typo, add info, etc.). Critical for
 * lead tracking — someone may post an incomplete lead, then edit to add
 * the source or project details.
 *
 * Shape varies across Evolution versions; we duck-type on `key.id` being
 * present and the event name containing "update".
 */
export function isMessagesUpdate(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionMessagesUpsertData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const hasKey = typeof data.key === "object" && data.key !== null && "id" in (data.key as object);
  const ev = payload.event?.toLowerCase() ?? "";
  return hasKey && (ev.includes("messages.update") || ev.includes("messages_update"));
}

/**
 * A message deletion event. Baileys / Evolution can deliver this in THREE
 * shapes depending on version and whether it originated from "delete for
 * everyone" (revoke) or another mechanism:
 *
 *   a) `{ event: "messages.delete", data: { key: { id, ... } } }` — singular
 *   b) `{ event: "messages.delete", data: { keys: [{ id, ... }, ...] } }` — plural
 *   c) `{ event: "messages.delete", data: { id: "..." } }` — bare id
 *
 * Historically we only accepted (a), which is why revokes delivered as (b)
 * (the Baileys default) fell through to isMessagesUpsert → failed the key
 * check → got silently dropped. This now accepts all three.
 */
export function isMessagesDelete(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionMessagesUpsertData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const ev = payload.event?.toLowerCase() ?? "";
  const byEventName = ev.includes("messages.delete") || ev.includes("messages_delete");
  if (!byEventName) return false;

  // Shape (a): singular key.id
  if (
    typeof data.key === "object" &&
    data.key !== null &&
    "id" in (data.key as object)
  ) {
    return true;
  }
  // Shape (b): plural keys[] with at least one id
  if (Array.isArray(data.keys) && data.keys.length > 0) {
    const first = data.keys[0];
    if (first && typeof first === "object" && "id" in first) return true;
  }
  // Shape (c): bare id
  if (typeof data.id === "string" && data.id.length > 0) return true;

  return false;
}

/**
 * Extract all waMessageIds targeted by a delete event, regardless of shape.
 * Returns the list of ids to mark as deleted.
 */
export function extractDeleteKeys(
  data: Record<string, unknown>,
): Array<{ id: string; remoteJid?: string; fromMe?: boolean }> {
  const out: Array<{ id: string; remoteJid?: string; fromMe?: boolean }> = [];
  // Shape (a): singular key
  if (data.key && typeof data.key === "object") {
    const k = data.key as Record<string, unknown>;
    if (typeof k.id === "string") {
      out.push({
        id: k.id,
        remoteJid: typeof k.remoteJid === "string" ? k.remoteJid : undefined,
        fromMe: typeof k.fromMe === "boolean" ? k.fromMe : undefined,
      });
    }
  }
  // Shape (b): plural keys[]
  if (Array.isArray(data.keys)) {
    for (const k of data.keys) {
      if (k && typeof k === "object" && typeof (k as Record<string, unknown>).id === "string") {
        const kr = k as Record<string, unknown>;
        out.push({
          id: kr.id as string,
          remoteJid: typeof kr.remoteJid === "string" ? kr.remoteJid : undefined,
          fromMe: typeof kr.fromMe === "boolean" ? kr.fromMe : undefined,
        });
      }
    }
  }
  // Shape (c): bare id
  if (out.length === 0 && typeof data.id === "string") {
    out.push({ id: data.id });
  }
  return out;
}

export function isConnectionUpdate(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionConnectionUpdateData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const ev = payload.event?.toLowerCase() ?? "";
  return ev.includes("connection.update") || ev.includes("connection_update") || "state" in data;
}
