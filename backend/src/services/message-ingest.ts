import { type MessageType, type PrismaClient, Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type {
  EvolutionMessageBody,
  EvolutionMessagesUpsertData,
} from "../evolution/webhook-types.js";
import { isGroupJid, jidToChatId } from "../utils/phone.js";
import type { SelfIdentity } from "./self-identity.js";

export interface IngestedMessage {
  id: string;
  waMessageId: string;
  chatId: string;
  chatName: string | null;
  senderPhone: string | null;
  senderName: string | null;
  content: string;
  messageType: MessageType;
  isGroup: boolean;
  isFromMe: boolean;
  isSelfChat: boolean;
  timestamp: Date;
}

export interface IngestResult {
  saved: IngestedMessage | null;
  duplicate: boolean;
  isSelfCommand: boolean; // fromMe + selfChat + starts with "/"
}

/**
 * Extracts a message from an Evolution webhook payload, dedupes it, and
 * writes it to the database. Returns whether the caller should dispatch a
 * command based on the saved message.
 */
export class MessageIngest {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly selfIdentity: SelfIdentity,
    private readonly logger: Logger,
  ) {}

  /**
   * Backfill ingest — takes a raw Evolution record (from /chat/findMessages)
   * and stores it. Different from `ingest()` which receives webhook payloads.
   *
   * Evolution API's /chat/findMessages returns records with this shape:
   *   { id, key, pushName, messageType, message, messageTimestamp, instanceId, ... }
   *
   * The `resolver` is optional — when provided, it resolves LIDs and phone
   * numbers into real display names using maps built from group participants
   * and contacts. This is critical for group messages where WhatsApp's multi-
   * device protocol only gives us opaque `@lid` identifiers.
   */
  async ingestRaw(
    record: Record<string, unknown>,
    resolver: {
      chatNameMap: Map<string, string>;
      lidToPhone: Map<string, string>;
      phoneToName: Map<string, string>;
    },
  ): Promise<{ saved: boolean; duplicate: boolean }> {
    const key = record.key as
      | { id?: string; fromMe?: boolean; remoteJid?: string; participant?: string }
      | undefined;
    if (!key?.id || !key?.remoteJid) {
      return { saved: false, duplicate: false };
    }

    // Normalize the message body: Evolution's record.message is the raw Baileys
    // body, which matches what the webhook handler already knows how to parse.
    const messageBody = (record.message ?? {}) as EvolutionMessageBody;

    const rawTs = record.messageTimestamp as number | string | undefined;
    const timestamp = resolveTimestamp(rawTs);

    const fromMe = Boolean(key.fromMe);
    const isGroup = isGroupJid(key.remoteJid);
    const chatId = jidToChatId(key.remoteJid);

    // Resolve sender. For groups, key.participant is usually an LID like
    // "87909424230589@lid". We map LID -> phone -> display name.
    let senderPhone: string | null = null;
    let senderName: string | null = null;

    const rawSenderJid = isGroup ? key.participant : key.remoteJid;
    if (rawSenderJid) {
      const resolvedPhoneJid = resolver.lidToPhone.get(rawSenderJid) ?? rawSenderJid;
      senderPhone = jidToChatId(resolvedPhoneJid);

      // Display name priority:
      //   1. phoneNumber -> pushName from contacts (real name)
      //   2. original record.pushName IF it's not just digits (unresolved LID)
      //   3. null
      const nameFromContacts = resolver.phoneToName.get(resolvedPhoneJid);
      if (nameFromContacts) {
        senderName = nameFromContacts;
      } else {
        const recordPushName = record.pushName as string | undefined;
        if (recordPushName && !/^\d+$/.test(recordPushName)) {
          senderName = recordPushName;
        }
      }
    }

    // Chat name: groups have a subject from fetchAllGroups; DMs fall back to pushName.
    const chatName =
      resolver.chatNameMap.get(key.remoteJid) ??
      (record.pushName as string | undefined) ??
      null;

    const { content, messageType } = extractContent(messageBody);

    const selfJid = this.selfIdentity.getJid();
    const isSelfChat = fromMe && selfJid !== null && key.remoteJid === selfJid;

    try {
      await this.prisma.message.create({
        data: {
          waMessageId: key.id,
          chatId,
          chatName,
          senderPhone,
          senderName,
          content,
          rawMessage: record as unknown as Prisma.InputJsonValue,
          messageType,
          isGroup,
          isFromMe: fromMe,
          isSelfChat,
          timestamp,
        },
      });
      return { saved: true, duplicate: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return { saved: false, duplicate: true };
      }
      throw err;
    }
  }

  async ingest(data: EvolutionMessagesUpsertData): Promise<IngestResult> {
    const key = data.key;
    if (!key?.id) {
      this.logger.debug("Webhook message missing key.id — skipping");
      return { saved: null, duplicate: false, isSelfCommand: false };
    }

    const remoteJid = key.remoteJid;
    const isGroup = isGroupJid(remoteJid);
    const fromMe = Boolean(key.fromMe);

    const { content, messageType } = extractContent(data.message ?? {});

    const chatId = jidToChatId(remoteJid);
    const senderJidRaw = isGroup ? key.participant : remoteJid;
    const senderPhone = senderJidRaw ? jidToChatId(senderJidRaw) : null;

    // chatName heuristic — prefer explicit group subject, else pushName, else null.
    const chatName = resolveChatName(data, isGroup);

    const timestamp = resolveTimestamp(data.messageTimestamp);

    const selfJid = this.selfIdentity.getJid();
    const isSelfChat = fromMe && selfJid !== null && remoteJid === selfJid;

    try {
      const saved = await this.prisma.message.create({
        data: {
          waMessageId: key.id,
          chatId,
          chatName,
          senderPhone,
          senderName: data.pushName ?? null,
          content,
          rawMessage: data as unknown as Prisma.InputJsonValue,
          messageType,
          isGroup,
          isFromMe: fromMe,
          isSelfChat,
          timestamp,
        },
      });

      const isSelfCommand = isSelfChat && content.trim().startsWith("/");

      return {
        saved: {
          id: saved.id,
          waMessageId: saved.waMessageId,
          chatId: saved.chatId,
          chatName: saved.chatName,
          senderPhone: saved.senderPhone,
          senderName: saved.senderName,
          content: saved.content,
          messageType: saved.messageType,
          isGroup: saved.isGroup,
          isFromMe: saved.isFromMe,
          isSelfChat: saved.isSelfChat,
          timestamp: saved.timestamp,
        },
        duplicate: false,
        isSelfCommand,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Duplicate waMessageId — webhook retry. Normal.
        return { saved: null, duplicate: true, isSelfCommand: false };
      }
      throw err;
    }
  }
}

/**
 * Extracts text content and a normalized message type from a Baileys message body.
 */
export function extractContent(body: EvolutionMessageBody): {
  content: string;
  messageType: MessageType;
} {
  if (typeof body.conversation === "string" && body.conversation.length > 0) {
    return { content: body.conversation, messageType: "TEXT" };
  }
  if (body.extendedTextMessage?.text) {
    return { content: body.extendedTextMessage.text, messageType: "TEXT" };
  }
  if (body.imageMessage) {
    return {
      content: body.imageMessage.caption ?? "[Image]",
      messageType: "IMAGE",
    };
  }
  if (body.audioMessage) {
    return { content: "[Audio]", messageType: "AUDIO" };
  }
  if (body.videoMessage) {
    return {
      content: body.videoMessage.caption ?? "[Video]",
      messageType: "VIDEO",
    };
  }
  if (body.documentMessage) {
    const name = body.documentMessage.fileName ?? "file";
    return { content: `[Document: ${name}]`, messageType: "DOCUMENT" };
  }
  if (body.stickerMessage) {
    return { content: "[Sticker]", messageType: "STICKER" };
  }
  if (body.contactMessage) {
    const name = body.contactMessage.displayName ?? "contact";
    return { content: `[Contact: ${name}]`, messageType: "CONTACT" };
  }
  if (body.locationMessage) {
    return { content: "[Location]", messageType: "LOCATION" };
  }
  return { content: "[Unsupported message]", messageType: "OTHER" };
}

function resolveChatName(
  data: EvolutionMessagesUpsertData,
  isGroup: boolean,
): string | null {
  if (isGroup) {
    const fromMeta =
      data.groupMetadata?.subject ?? (data.groupSubject as string | undefined);
    return fromMeta ?? null;
  }
  return data.pushName ?? null;
}

function resolveTimestamp(raw: number | string | undefined): Date {
  if (typeof raw === "number") return new Date(raw * 1000);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (!Number.isNaN(n)) return new Date(n * 1000);
  }
  return new Date();
}
