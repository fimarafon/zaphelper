import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import type { CommandRegistry } from "../commands/registry.js";
import { requireAuth } from "../middleware/auth.js";
import type { CommandDispatcher } from "../services/command-dispatcher.js";

export interface CommandRoutesDeps {
  prisma: PrismaClient;
  registry: CommandRegistry;
  dispatcher: CommandDispatcher;
}

export const commandRoutes: FastifyPluginAsync<CommandRoutesDeps> = async (
  fastify,
  { prisma, registry, dispatcher },
) => {
  // Dashboard test runner: executes a command inline (no WhatsApp needed)
  // and returns the reply as JSON.
  fastify.post<{ Body: { input?: string } }>(
    "/api/commands/run",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const input = req.body?.input?.trim();
      if (!input) {
        return reply.code(400).send({ error: "input required" });
      }
      const result = await dispatcher.runInline(input);
      return result;
    },
  );

  fastify.get("/api/commands/registry", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return {
      commands: registry.all().map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        description: c.description,
        usage: c.usage ?? null,
      })),
    };
  });

  fastify.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/api/commands/logs",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
      const logs = await prisma.commandLog.findMany({
        orderBy: { executedAt: "desc" },
        take: limit + 1,
        ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}),
      });
      const hasMore = logs.length > limit;
      const items = hasMore ? logs.slice(0, limit) : logs;
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    },
  );
};
