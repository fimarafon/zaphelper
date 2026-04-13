import { type MessageType, type PrismaClient, Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type {
  EvolutionMessageBody,
  EvolutionMessagesUpsertData,
} from "../evolution/webhook-types.js";
import { isGroupJid, jidToChatId } from "../utils/phone.js";
import type { DelegateService } from "./delegate-service.js";
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
  isSelfCommand: boolean;      // fromMe + selfChat + starts with "/"
  isDelegateCommand: boolean;  // !fromMe + DM to me + starts with "/" + sender is active delegate
  delegatePhone: string | null; // phone of the delegate who sent the command (reply target)
}

/**
 * Extracts a message from an Evolution webhook payload, dedupes it, and
 * writes it to the database. Returns whether the caller should dispatch a
 * command based on the saved message.
 */
export class MessageIngest {
  /**
   * In-memory cache of the user's manual name mapping, keyed by phone digits.
   * Populated on first use and refreshed via refreshNameCache().
   */
  private nameCache = new Map<string, string>();
  private nameCacheLoaded = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly selfIdentity: SelfIdentity,
    private readonly logger: Logger,
    private readonly delegateService?: DelegateService,
  ) {}

  async refreshNameCache(): Promise<void> {
    const rows = await this.prisma.config.findMany({
      where: { key: { startsWith: "name:" } },
    });
    this.nameCache.clear();
    for (const row of rows) {
      const phone = row.key.slice("name:".length);
      this.nameCache.set(phone, row.value);
    }
    this.nameCacheLoaded = true;
  }

  private async ensureNameCache(): Promise<void> {
    if (!this.nameCacheLoaded) await this.refreshNameCache();
  }

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
  ): Promise<{ saved: boolean; duplicate: boolean; updated?: boolean }> {
    await this.ensureNameCache();

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
      //   1. Manual mapping from Config (what the user set via /api/instance/name-mapping)
      //   2. phoneNumber -> pushName from contacts (real name)
      //   3. original record.pushName IF it's not just digits (unresolved LID)
      //   4. null
      if (senderPhone) {
        const manualName = this.nameCache.get(senderPhone);
        if (manualName) senderName = manualName;
      }
      if (!senderName) {
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
        // Duplicate — but the Evolution record may reflect an EDIT that
        // happened after our original insert (WhatsApp lets senders edit
        // up to ~15 min). Compare content and upgrade if it changed.
        // This catches the case where the webhook didn't deliver the edit
        // event (e.g. during a restart).
        try {
          const existing = await this.prisma.message.findUnique({
            where: { waMessageId: key.id },
            select: { content: true, id: true },
          });
          if (
            existing &&
            content &&
            content !== "[Unsupported message]" &&
            existing.content !== content
          ) {
            await this.prisma.message.update({
              where: { waMessageId: key.id },
              data: {
                content,
                messageType,
                senderName: senderName ?? undefined,
                senderPhone: senderPhone ?? undefined,
                rawMessage: record as unknown as Prisma.InputJsonValue,
              },
            });
            this.logger.info(
              { waMessageId: key.id, oldLen: existing.content.length, newLen: content.length },
              "Detected edit via backfill/sync — updated existing row",
            );
            return { saved: false, duplicate: true, updated: true };
          }
        } catch (updateErr) {
          this.logger.debug({ updateErr, waMessageId: key.id }, "Edit detection update failed");
        }
        return { saved: false, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Apply a message edit event. WhatsApp lets the sender edit a message
   * they already sent (typically within ~15 minutes). Evolution fires a
   * `messages.update` webhook event carrying the NEW content with the
   * SAME key.id as the original. We locate our existing row by waMessageId
   * and overwrite its content/rawMessage, preserving timestamp.
   *
   * If we don't have the original (e.g. it arrived during a restart and
   * was never saved), we upsert: insert a fresh row with the update payload.
   */
  async applyUpdate(data: EvolutionMessagesUpsertData): Promise<{
    updated: boolean;
    inserted: boolean;
    notFound: boolean;
  }> {
    const key = data.key;
    if (!key?.id) return { updated: false, inserted: false, notFound: true };

    const { content, messageType } = extractContent(data.message ?? {});

    // Some Evolution builds send updates with an empty message payload
    // (just the key + metadata). Skip if we have no content to apply —
    // nothing to do.
    if (!content || content === "[Unsupported message]") {
      return { updated: false, inserted: false, notFound: false };
    }

    try {
      const existing = await this.prisma.message.findUnique({
        where: { waMessageId: key.id },
      });

      if (existing) {
        await this.prisma.message.update({
          where: { waMessageId: key.id },
          data: {
            content,
            messageType,
            // Keep the ORIGINAL rawMessage alongside the new one so we can
            // debug: stick the update under a special key.
            rawMessage: {
              ...((existing.rawMessage ?? {}) as Record<string, unknown>),
              _lastEdit: data as unknown as Prisma.InputJsonValue,
              _editedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        this.logger.info(
          { waMessageId: key.id, chatId: existing.chatId },
          "Applied message edit",
        );
        return { updated: true, inserted: false, notFound: false };
      }

      // Didn't have the original — treat the update as a fresh insert.
      // The ingest path handles dedupe + name resolution.
      const result = await this.ingest(data);
      return { updated: false, inserted: Boolean(result.saved), notFound: false };
    } catch (err) {
      this.logger.error({ err, waMessageId: key.id }, "applyUpdate failed");
      throw err;
    }
  }

  /**
   * Mark a message as deleted. We don't remove the row — keeping the
   * history is more useful than strict compliance. Content is replaced
   * with a sentinel `[deleted]` value so lead parsing skips it naturally.
   */
  async applyDelete(data: EvolutionMessagesUpsertData): Promise<{ deleted: boolean }> {
    const key = data.key;
    if (!key?.id) return { deleted: false };

    try {
      const existing = await this.prisma.message.findUnique({
        where: { waMessageId: key.id },
      });
      if (!existing) return { deleted: false };

      await this.prisma.message.update({
        where: { waMessageId: key.id },
        data: {
          content: "[deleted]",
          messageType: "OTHER",
          rawMessage: {
            ...((existing.rawMessage ?? {}) as Record<string, unknown>),
            _deletedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.info({ waMessageId: key.id }, "Applied message delete");
      return { deleted: true };
    } catch (err) {
      this.logger.error({ err, waMessageId: key.id }, "applyDelete failed");
      throw err;
    }
  }

  async ingest(data: EvolutionMessagesUpsertData): Promise<IngestResult> {
    await this.ensureNameCache();

    const key = data.key;
    if (!key?.id) {
      this.logger.debug("Webhook message missing key.id — skipping");
      return { saved: null, duplicate: false, isSelfCommand: false, isDelegateCommand: false, delegatePhone: null };
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

    // Resolve senderName: prefer manual mapping, then pushName if it's a real
    // name (not just digits = unresolved LID).
    let resolvedSenderName: string | null = null;
    if (senderPhone) {
      const manualName = this.nameCache.get(senderPhone);
      if (manualName) {
        resolvedSenderName = manualName;
      }
    }
    if (!resolvedSenderName && data.pushName && !/^\d+$/.test(data.pushName)) {
      resolvedSenderName = data.pushName;
    }

    try {
      const saved = await this.prisma.message.create({
        data: {
          waMessageId: key.id,
          chatId,
          chatName,
          senderPhone,
          senderName: resolvedSenderName,
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

      // Delegate command detection:
      // - NOT from me (someone else sent it)
      // - NOT a group message (DM directly to my number)
      // - Content starts with "/"
      // - Sender's phone is an active delegate
      let isDelegateCommand = false;
      let delegatePhone: string | null = null;
      if (
        !fromMe &&
        !isGroup &&
        content.trim().startsWith("/") &&
        senderPhone &&
        this.delegateService
      ) {
        await this.delegateService.ensureLoaded();
        if (this.delegateService.isActiveDelegate(senderPhone)) {
          isDelegateCommand = true;
          delegatePhone = senderPhone;
          this.logger.info(
            { senderPhone, command: content.trim().split(/\s+/)[0] },
            "Delegate command detected",
          );
        }
      }

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
        isDelegateCommand,
        delegatePhone,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Duplicate waMessageId — the UNIQUE index on waMessageId is our
        // idempotency key (industry-standard pattern: see docs/BEST-PRACTICES.md).
        // Evolution fires fire-and-forget, so retries from Evolution shouldn't
        // happen in practice, but IncrementalSync + backfill can re-ingest
        // the same record. This path is expected and safe.
        this.logger.debug(
          { waMessageId: key.id, chatId },
          "Dedupe: message already ingested (idempotent no-op)",
        );
        return { saved: null, duplicate: true, isSelfCommand: false, isDelegateCommand: false, delegatePhone: null };
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
