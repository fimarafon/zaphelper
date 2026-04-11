import type { FastifyPluginAsync } from "fastify";
import type { ActionRegistry } from "../actions/registry.js";
import { requireAuth } from "../middleware/auth.js";
import type { ScheduledTaskService } from "../services/scheduled-task-service.js";

export interface SchedulesRoutesDeps {
  taskService: ScheduledTaskService;
  actionRegistry: ActionRegistry;
}

export const schedulesRoutes: FastifyPluginAsync<SchedulesRoutesDeps> = async (
  fastify,
  { taskService, actionRegistry },
) => {
  // List all tasks.
  fastify.get("/api/schedules", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const tasks = await taskService.list();
    return { items: tasks };
  });

  // List all available action types (for the frontend form).
  fastify.get("/api/schedules/actions", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return {
      actions: actionRegistry.all().map((a) => ({
        type: a.type,
        description: a.description,
      })),
    };
  });

  // Create task.
  fastify.post<{
    Body: {
      name: string;
      actionType: string;
      actionPayload: Record<string, unknown>;
      cronExpression?: string;
      fireAt?: string;
      enabled?: boolean;
    };
  }>("/api/schedules", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const body = req.body;
    if (!body?.name || !body.actionType || !body.actionPayload) {
      return reply.code(400).send({ error: "name, actionType, actionPayload required" });
    }
    try {
      const task = await taskService.create({
        name: body.name,
        actionType: body.actionType,
        actionPayload: body.actionPayload,
        ...(body.cronExpression ? { cronExpression: body.cronExpression } : {}),
        ...(body.fireAt ? { fireAt: new Date(body.fireAt) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      });
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  // Update task.
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      enabled?: boolean;
      cronExpression?: string | null;
      fireAt?: string | null;
      actionType?: string;
      actionPayload?: Record<string, unknown>;
    };
  }>("/api/schedules/:id", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      const body = req.body ?? {};
      const task = await taskService.update(req.params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.cronExpression !== undefined
          ? { cronExpression: body.cronExpression }
          : {}),
        ...(body.fireAt !== undefined
          ? { fireAt: body.fireAt ? new Date(body.fireAt) : null }
          : {}),
        ...(body.actionType !== undefined ? { actionType: body.actionType } : {}),
        ...(body.actionPayload !== undefined
          ? { actionPayload: body.actionPayload }
          : {}),
      });
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  // Toggle enabled.
  fastify.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/schedules/:id/toggle",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      try {
        const task = await taskService.setEnabled(
          req.params.id,
          Boolean(req.body?.enabled),
        );
        return { ok: true, task };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  // Run now (outside schedule, useful for testing).
  fastify.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      try {
        await taskService.runNow(req.params.id);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  // Delete task.
  fastify.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      try {
        await taskService.delete(req.params.id);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
};
