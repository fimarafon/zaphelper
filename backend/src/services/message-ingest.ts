import { type MessageType, type PrismaClient, Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type {
  EvolutionMessageBody,
  EvolutionMessagesUpsertData,
} from "../evolution/webhook-types.js";
import { isGroupJid, jidToChatId } from "../utils/phone.js";
import type { DelegateService } from "./delegate-service.js";
import type { SelfIdentity } from "./self-identity.js";

/**
 * Sentinel content values that indicate the message was intentionally
 * suppressed — either by a "delete for everyone" on WhatsApp (webhook-driven)
 * or by a manual exclusion from the dashboard (DELETE /api/messages/:id).
 *
 * Every path that might overwrite message.content (applyUpdate, ingestRaw
 * edit-detection, fastChatSync) MUST check this before writing. Otherwise
 * the next sync pull from Evolution will resurrect the original content
 * (because Evolution still has the pre-delete payload on its end).
 */
export const EXCLUDED_SENTINELS = new Set(["[excluded]", "[deleted]"]);

export function isExcludedContent(content: string | null | undefined): boolean {
  return content != null && EXCLUDED_SENTINELS.has(content);
}

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

    // Same revoke interception as ingest() — during backfill / incremental
    // sync we might pull historical revoke events that our webhook missed.
    const revokeInSync = detectRevoke(record.message);
    if (revokeInSync) {
      await this.applyDelete({
        key: {
          id: revokeInSync.revokedMessageId,
          remoteJid: revokeInSync.revokedRemoteJid ?? key.remoteJid,
          fromMe: revokeInSync.revokedFromMe ?? key.fromMe ?? false,
        },
      } as EvolutionMessagesUpsertData);
      this.logger.info(
        { revokedId: revokeInSync.revokedMessageId, revokeEventId: key.id },
        "Handled protocolMessage REVOKE during backfill",
      );
      return { saved: false, duplicate: true };
    }

    // Same edit interception as ingest() — backfill might pull historical
    // edits we missed because of webhook downtime / decoding bugs.
    const editInSync = detectEdit(record.message);
    if (editInSync) {
      await this.applyUpdate({
        key: {
          id: editInSync.editedMessageId,
          remoteJid: editInSync.editedRemoteJid ?? key.remoteJid,
          fromMe: editInSync.editedFromMe ?? key.fromMe ?? false,
        },
        message: editInSync.newBody,
      } as EvolutionMessagesUpsertData);
      this.logger.info(
        { editedId: editInSync.editedMessageId, editEventId: key.id },
        "Handled protocolMessage MESSAGE_EDIT during backfill",
      );
      return { saved: false, duplicate: true, updated: true };
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
            existing.content !== content &&
            !isExcludedContent(existing.content)
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

    // Some Evolution builds deliver "delete for everyone" as messages.update
    // rather than messages.upsert or messages.delete. Catch that case here:
    // if the update payload is a protocolMessage REVOKE, route to applyDelete
    // on the referenced original id instead of trying to apply an edit.
    const revokeAsUpdate = detectRevoke(data.message);
    if (revokeAsUpdate) {
      await this.applyDelete({
        key: {
          id: revokeAsUpdate.revokedMessageId,
          remoteJid: revokeAsUpdate.revokedRemoteJid ?? key.remoteJid ?? "",
          fromMe: revokeAsUpdate.revokedFromMe ?? key.fromMe ?? false,
        },
      } as EvolutionMessagesUpsertData);
      this.logger.info(
        { revokedId: revokeAsUpdate.revokedMessageId, updateEventId: key.id },
        "Handled protocolMessage REVOKE arriving via messages.update",
      );
      return { updated: true, inserted: false, notFound: false };
    }

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
        // If the message was manually excluded (via dashboard) or marked as
        // deleted (via WhatsApp "delete for everyone"), do not let an edit
        // event resurrect the content. The user already decided they want
        // this message out of lead counts — an edit is irrelevant.
        if (isExcludedContent(existing.content)) {
          this.logger.info(
            { waMessageId: key.id, existingContent: existing.content },
            "Ignoring applyUpdate on excluded/deleted message",
          );
          return { updated: false, inserted: false, notFound: false };
        }
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

    // Intercept "delete for everyone" — Baileys delivers this as a
    // messages.upsert event carrying a protocolMessage with type REVOKE.
    // The revoke has its own key.id; the id of the message being revoked
    // lives in message.protocolMessage.key.id. We translate this into an
    // applyDelete() call on the original and swallow the revoke event
    // itself (no row for the tombstone).
    const revoke = detectRevoke(data.message);
    if (revoke) {
      await this.applyDelete({
        key: {
          id: revoke.revokedMessageId,
          remoteJid: revoke.revokedRemoteJid ?? key.remoteJid ?? "",
          fromMe: revoke.revokedFromMe ?? key.fromMe ?? false,
        },
      } as EvolutionMessagesUpsertData);
      this.logger.info(
        { revokedId: revoke.revokedMessageId, revokeEventId: key.id },
        "Handled protocolMessage REVOKE (delete for everyone)",
      );
      return { saved: null, duplicate: false, isSelfCommand: false, isDelegateCommand: false, delegatePhone: null };
    }

    // Intercept "Edit message" (protocolMessage type 14). When the user edits
    // a previously-sent message, Baileys/Evolution deliver this as a
    // messages.upsert with a protocolMessage holding both the original key.id
    // and the new content under editedMessage. Without this, edits become
    // stray rows in DB and the original keeps its outdated content (e.g. the
    // Pauline lead with "(not sure)" instead of "Google" after edit).
    const edit = detectEdit(data.message);
    if (edit) {
      await this.applyUpdate({
        key: {
          id: edit.editedMessageId,
          remoteJid: edit.editedRemoteJid ?? key.remoteJid ?? "",
          fromMe: edit.editedFromMe ?? key.fromMe ?? false,
        },
        message: edit.newBody,
      } as EvolutionMessagesUpsertData);
      this.logger.info(
        { editedId: edit.editedMessageId, editEventId: key.id },
        "Handled protocolMessage MESSAGE_EDIT",
      );
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

    // Self-chat detection. WhatsApp + Baileys + new privacy protocol routes
    // self-messages with a LID-style remoteJid (e.g. "90306099822759") rather
    // than the user's phone JID. SelfIdentity.isSelfChatJid() checks both.
    //
    // Auto-detect LID from group messages we send: when fromMe=true && isGroup,
    // key.participant is the user's identifier in that group — and in the new
    // privacy protocol, that's their LID. Capture it once.
    if (
      fromMe &&
      isGroup &&
      key.participant &&
      !this.selfIdentity.getLid()
    ) {
      const candidateLid = jidToChatId(key.participant);
      // Sanity: must look like a non-trivial id, NOT just our phone (which
      // would mean we're on the legacy protocol and don't need a LID).
      const phoneFromJid = this.selfIdentity.getPhone();
      if (candidateLid && candidateLid !== phoneFromJid) {
        this.logger.info(
          { candidateLid, fromGroup: remoteJid },
          "Captured self-LID from fromMe group message",
        );
        void this.selfIdentity
          .setSelfLid(candidateLid)
          .catch((err) => this.logger.warn({ err }, "setSelfLid failed"));
      }
    }

    const isSelfChat = fromMe && this.selfIdentity.isSelfChatJid(remoteJid);

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

      // Trigger commands when YOU type / in any DM (self-chat OR with someone
      // else). Reply goes back to the same chat. Risk: if you accidentally type
      // /statustoday in a chat with a friend/client, the lead list goes to them.
      const isSelfCommand =
        fromMe && !isGroup && content.trim().startsWith("/");

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

/**
 * WhatsApp "delete for everyone" (revoke) detection.
 *
 * When a sender clicks "Delete for everyone" in WhatsApp, Baileys (and
 * therefore Evolution) delivers this as a `messages.upsert` event — NOT
 * a `messages.delete` — containing a `protocolMessage` of type REVOKE.
 * The revoke event has its own NEW key.id (the id of the revoke message
 * itself), and inside `message.protocolMessage.key.id` is the id of the
 * original message being revoked.
 *
 * Without handling this, our ingest creates a stray "[Unsupported message]"
 * row for the revoke and never marks the original message as deleted — so
 * the original stays in /statustoday forever.
 *
 * protocolMessage types (from waproto.Message.ProtocolMessage.Type):
 *   0  = REVOKE          <- "delete for everyone"
 *   14 = MESSAGE_EDIT    <- "edit message" (NOT a revoke — we used to confuse these)
 *
 * We split detection: detectRevoke matches type 0 / "REVOKE" only,
 * detectEdit matches type 14 / "MESSAGE_EDIT" and returns the new content.
 */
export interface RevokeDetection {
  revokedMessageId: string;
  revokedFromMe: boolean | undefined;
  revokedRemoteJid: string | undefined;
}

export function detectRevoke(
  body: unknown,
): RevokeDetection | null {
  if (!body || typeof body !== "object") return null;
  const proto = (body as { protocolMessage?: unknown }).protocolMessage;
  if (!proto || typeof proto !== "object") return null;
  const type = (proto as { type?: unknown }).type;
  // ONLY type 0 / "REVOKE" — type 14 is MESSAGE_EDIT, handled separately
  const isRevoke =
    type === 0 ||
    (typeof type === "string" && type.toUpperCase().includes("REVOKE") && !type.toUpperCase().includes("EDIT"));
  if (!isRevoke) return null;
  const revokedKey = (proto as { key?: Record<string, unknown> }).key;
  if (!revokedKey || typeof revokedKey.id !== "string") return null;
  return {
    revokedMessageId: revokedKey.id,
    revokedFromMe: typeof revokedKey.fromMe === "boolean" ? revokedKey.fromMe : undefined,
    revokedRemoteJid:
      typeof revokedKey.remoteJid === "string" ? revokedKey.remoteJid : undefined,
  };
}

/**
 * Detects a "Edit message" protocolMessage. Returns the original message id
 * and the new content body so the caller can apply the edit.
 *
 * Baileys ProtocolMessage shape for edit:
 *   {
 *     type: 14,                              // MESSAGE_EDIT
 *     key: { id: <originalMessageId>, ... }, // points at original
 *     editedMessage: { conversation: "...", extendedTextMessage: {...}, ... }
 *   }
 */
export interface EditDetection {
  editedMessageId: string;
  newBody: EvolutionMessageBody;
  editedFromMe: boolean | undefined;
  editedRemoteJid: string | undefined;
}

export function detectEdit(body: unknown): EditDetection | null {
  if (!body || typeof body !== "object") return null;
  const proto = (body as { protocolMessage?: unknown }).protocolMessage;
  if (!proto || typeof proto !== "object") return null;
  const type = (proto as { type?: unknown }).type;
  const isEdit =
    type === 14 ||
    (typeof type === "string" && type.toUpperCase().includes("EDIT"));
  if (!isEdit) return null;
  const key = (proto as { key?: Record<string, unknown> }).key;
  const edited = (proto as { editedMessage?: unknown }).editedMessage;
  if (!key || typeof key.id !== "string") return null;
  if (!edited || typeof edited !== "object") return null;
  return {
    editedMessageId: key.id,
    newBody: edited as EvolutionMessageBody,
    editedFromMe: typeof key.fromMe === "boolean" ? key.fromMe : undefined,
    editedRemoteJid:
      typeof key.remoteJid === "string" ? key.remoteJid : undefined,
  };
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
