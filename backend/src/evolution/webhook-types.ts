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
 * A message deletion event. We mark the message as deleted (but don't
 * physically remove it — keeping history is more useful than strict DSR).
 */
export function isMessagesDelete(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionMessagesUpsertData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const hasKey = typeof data.key === "object" && data.key !== null && "id" in (data.key as object);
  const ev = payload.event?.toLowerCase() ?? "";
  return hasKey && (ev.includes("messages.delete") || ev.includes("messages_delete"));
}

export function isConnectionUpdate(
  payload: EvolutionWebhookPayload,
): payload is EvolutionWebhookPayload & { data: EvolutionConnectionUpdateData } {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const ev = payload.event?.toLowerCase() ?? "";
  return ev.includes("connection.update") || ev.includes("connection_update") || "state" in data;
}
