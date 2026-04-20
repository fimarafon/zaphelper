import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { detectRevoke } from "../services/message-ingest.js";
import { readWebhookEvents } from "../services/webhook-event-log.js";

export interface MessagesRoutesDeps {
  prisma: PrismaClient;
}

interface MessageListQuery {
  search?: string;
  chatName?: string;
  chatId?: string;
  isGroup?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  limit?: string;
  cursor?: string;
}

export const messagesRoutes: FastifyPluginAsync<MessagesRoutesDeps> = async (
  fastify,
  { prisma },
) => {
  fastify.get<{ Querystring: MessageListQuery }>(
    "/api/messages",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const q = req.query;
      const limit = Math.min(parseInt(q.limit ?? "50", 10) || 50, 200);

      const messages = await prisma.message.findMany({
        where: {
          ...(q.search
            ? {
                OR: [
                  { content: { contains: q.search, mode: "insensitive" } },
                  { senderName: { contains: q.search, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(q.chatName
            ? { chatName: { contains: q.chatName, mode: "insensitive" } }
            : {}),
          ...(q.chatId ? { chatId: q.chatId } : {}),
          ...(q.isGroup === "true"
            ? { isGroup: true }
            : q.isGroup === "false"
              ? { isGroup: false }
              : {}),
          ...(q.from || q.to
            ? {
                timestamp: {
                  ...(q.from ? { gte: new Date(q.from) } : {}),
                  ...(q.to ? { lte: new Date(q.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: { timestamp: "desc" },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });

      const hasMore = messages.length > limit;
      const items = hasMore ? messages.slice(0, limit) : messages;
      const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

      return {
        items: items.map((m) => ({
          id: m.id,
          chatId: m.chatId,
          chatName: m.chatName,
          senderName: m.senderName,
          senderPhone: m.senderPhone,
          content: m.content,
          messageType: m.messageType,
          isGroup: m.isGroup,
          isFromMe: m.isFromMe,
          isSelfChat: m.isSelfChat,
          timestamp: m.timestamp,
        })),
        nextCursor,
      };
    },
  );

  // Manually exclude a message from lead counts (and all queries that filter
  // `messageType: "TEXT"`). This is the same mechanism `applyDelete` uses when
  // a WhatsApp "delete for everyone" webhook fires — but it's triggered by a
  // human via the dashboard, which is needed when the user deletes only for
  // themselves (no webhook fires) or when a lead was recorded but later
  // cancelled / converted / mis-parsed.
  //
  // We keep the row (so audit/history works) but:
  //   - content → "[excluded]"
  //   - messageType → "OTHER" (so /statustoday etc skip it)
  //   - rawMessage._excludedAt → timestamp
  //   - rawMessage._originalContent → preserve the old content for forensics
  fastify.delete<{ Params: { id: string } }>(
    "/api/messages/:id",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const existing = await prisma.message.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Message not found" });
      }

      const updated = await prisma.message.update({
        where: { id },
        data: {
          content: "[excluded]",
          messageType: "OTHER",
          rawMessage: {
            ...((existing.rawMessage ?? {}) as Record<string, unknown>),
            _excludedAt: new Date().toISOString(),
            _originalContent: existing.content,
            _originalMessageType: existing.messageType,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return {
        ok: true,
        message: {
          id: updated.id,
          content: updated.content,
          messageType: updated.messageType,
        },
      };
    },
  );

  // DEBUG: recent raw webhook events from the in-memory ring buffer.
  // Lets us inspect exactly what Evolution sent for delete/edit events.
  fastify.get<{ Querystring: { filter?: string; limit?: string } }>(
    "/api/admin/webhook-events",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const events = readWebhookEvents({
        eventContains: req.query.filter,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      });
      return { count: events.length, events };
    },
  );

  // DEBUG: histogram of "[Unsupported message]" rows by top-level message key.
  // Tells us what kinds of body shapes are hiding in the stray OTHER pool.
  fastify.get("/api/admin/peek-unsupported", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const rows = await prisma.message.findMany({
      where: {
        content: "[Unsupported message]",
        messageType: "OTHER",
      },
      select: {
        id: true,
        waMessageId: true,
        timestamp: true,
        rawMessage: true,
      },
    });
    const histogram: Record<string, number> = {};
    const samples: Record<string, { id: string; waMessageId: string; ts: string; snippet: string }> = {};
    for (const r of rows) {
      const raw = r.rawMessage as Record<string, unknown> | null;
      const msg = (raw?.message ?? {}) as Record<string, unknown>;
      const keys = Object.keys(msg).filter((k) => k !== "messageContextInfo");
      const sig = keys.sort().join("+") || "(empty)";
      histogram[sig] = (histogram[sig] ?? 0) + 1;
      if (!samples[sig]) {
        samples[sig] = {
          id: r.id,
          waMessageId: r.waMessageId,
          ts: r.timestamp.toISOString(),
          snippet: JSON.stringify(msg).slice(0, 400),
        };
      }
    }
    return { total: rows.length, histogram, samples };
  });

  // Retroactively process WhatsApp "delete for everyone" events that were
  // received before the backend knew how to handle protocolMessage REVOKE.
  //
  // Before the fix: revokes arrived as messages.upsert with a protocolMessage
  // body, got decoded as "[Unsupported message]" and saved as stray rows.
  // The original lead row was never marked deleted, so /statustoday kept
  // showing cancelled leads.
  //
  // After the fix: new revokes are intercepted at ingest time. But old
  // stray rows need a sweep. This endpoint:
  //   1. Finds every "[Unsupported message]" row.
  //   2. Parses its rawMessage.message.protocolMessage.
  //   3. If REVOKE, marks the referenced original as "[deleted]".
  //   4. Deletes the stray revoke row itself.
  //
  // Safe to run multiple times: rows already processed won't match the
  // [Unsupported message] filter anymore.
  fastify.post("/api/admin/reprocess-revokes", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const straysToScan = await prisma.message.findMany({
      where: {
        content: "[Unsupported message]",
        messageType: "OTHER",
      },
      select: {
        id: true,
        waMessageId: true,
        chatId: true,
        rawMessage: true,
        timestamp: true,
      },
    });

    let revokesApplied = 0;
    let straysRemoved = 0;
    let nonRevokeSkipped = 0;
    const details: Array<{
      strayId: string;
      targetWaId: string | null;
      targetUpdated: boolean;
    }> = [];

    for (const stray of straysToScan) {
      const raw = stray.rawMessage as Record<string, unknown> | null;
      const revoke = detectRevoke(raw?.message);
      if (!revoke) {
        nonRevokeSkipped += 1;
        continue;
      }

      // Mark the original (referenced) message as [deleted] if it exists
      // and isn't already a sentinel. Guard against overwriting [excluded].
      const target = await prisma.message.findUnique({
        where: { waMessageId: revoke.revokedMessageId },
      });

      let targetUpdated = false;
      if (target && target.content !== "[deleted]" && target.content !== "[excluded]") {
        await prisma.message.update({
          where: { waMessageId: revoke.revokedMessageId },
          data: {
            content: "[deleted]",
            messageType: "OTHER",
            rawMessage: {
              ...((target.rawMessage ?? {}) as Record<string, unknown>),
              _deletedAt: stray.timestamp.toISOString(),
              _deletedRetro: true,
              _originalContent: target.content,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        targetUpdated = true;
        revokesApplied += 1;
      }

      // Remove the stray revoke row either way — it's noise in the DB.
      await prisma.message.delete({ where: { id: stray.id } });
      straysRemoved += 1;

      details.push({
        strayId: stray.id,
        targetWaId: revoke.revokedMessageId,
        targetUpdated,
      });
    }

    return {
      ok: true,
      scanned: straysToScan.length,
      revokesApplied,
      straysRemoved,
      nonRevokeSkipped,
      details: details.slice(0, 50), // cap payload size
    };
  });

  // Distinct chat names — lets the UI build a filter dropdown without loading everything.
  fastify.get("/api/messages/chats", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const rows = await prisma.message.groupBy({
      by: ["chatId", "chatName", "isGroup"],
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 100,
    });
    return {
      chats: rows.map((r) => ({
        chatId: r.chatId,
        chatName: r.chatName,
        isGroup: r.isGroup,
        messageCount: r._count.id,
      })),
    };
  });
};
