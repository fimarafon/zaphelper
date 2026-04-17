import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";

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
