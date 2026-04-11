import type { PrismaClient, ReminderStatus } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import type { Scheduler } from "../services/scheduler.js";

export interface RemindersRoutesDeps {
  prisma: PrismaClient;
  scheduler: Scheduler;
}

export const remindersRoutes: FastifyPluginAsync<RemindersRoutesDeps> = async (
  fastify,
  { prisma, scheduler },
) => {
  fastify.get<{ Querystring: { status?: string } }>(
    "/api/reminders",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const status = req.query.status?.toUpperCase() as ReminderStatus | undefined;
      const where = status ? { status } : { status: "PENDING" as const };
      const rows = await prisma.reminder.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        take: 200,
      });
      return { items: rows };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/reminders/:id",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const result = await scheduler.cancel(req.params.id);
      if (!result) return reply.code(404).send({ error: "Not found" });
      return { ok: true, reminder: result };
    },
  );
};
