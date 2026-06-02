import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import type { ActionRegistry } from "../actions/registry.js";
import { CONDITION_TYPES } from "../automation/conditions.js";
import { TRIGGER_TYPES } from "../automation/triggers.js";
import type { EvolutionClient } from "../evolution/client.js";
import { requireAuth } from "../middleware/auth.js";
import { detectReaction, type MessageIngest } from "../services/message-ingest.js";
import type { AutomationService } from "../services/automation-service.js";
import { jidToChatId } from "../utils/phone.js";

export interface AutomationsRoutesDeps {
  prisma: PrismaClient;
  automationService: AutomationService;
  actionRegistry: ActionRegistry;
  evolution: EvolutionClient;
  ingest: MessageIngest;
}

export const automationsRoutes: FastifyPluginAsync<AutomationsRoutesDeps> = async (
  fastify,
  { prisma, automationService, actionRegistry, evolution, ingest },
) => {
  const auth = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req);

  // ---- Building blocks for the builder UI ----
  fastify.get("/api/automations/primitives", async (req, reply) => {
    try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
    return {
      triggers: TRIGGER_TYPES,
      conditions: CONDITION_TYPES,
      actions: actionRegistry.all().map((a) => ({ type: a.type, description: a.description })),
    };
  });

  // ---- Automations CRUD ----
  fastify.get("/api/automations", async (req, reply) => {
    try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
    return { items: await automationService.list() };
  });

  fastify.post<{
    Body: {
      name: string;
      chatId?: string | null;
      triggerType: string;
      triggerConfig?: Record<string, unknown>;
      delaySeconds?: number;
      conditions?: unknown[];
      actionType: string;
      actionPayload: Record<string, unknown>;
      enabled?: boolean;
    };
  }>("/api/automations", async (req, reply) => {
    try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
    const b = req.body;
    if (!b?.name || !b.triggerType || !b.actionType || !b.actionPayload) {
      return reply.code(400).send({ error: "name, triggerType, actionType, actionPayload required" });
    }
    try {
      const automation = await automationService.create({
        name: b.name,
        chatId: b.chatId ?? null,
        triggerType: b.triggerType,
        triggerConfig: b.triggerConfig ?? {},
        delaySeconds: b.delaySeconds ?? 0,
        conditions: b.conditions ?? [],
        actionType: b.actionType,
        actionPayload: b.actionPayload,
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      });
      return { ok: true, automation };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/automations/:id",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      try {
        const automation = await automationService.update(req.params.id, (req.body ?? {}) as never);
        return { ok: true, automation };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/automations/:id/toggle",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      try {
        const automation = await automationService.setEnabled(req.params.id, Boolean(req.body?.enabled));
        return { ok: true, automation };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/automations/:id/run",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      try {
        await automationService.runNow(req.params.id);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/automations/:id",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      try {
        await automationService.delete(req.params.id);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  // ---- Groups + participants (read groups, map who is who) ----
  fastify.get("/api/groups", async (req, reply) => {
    try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
    const groups = await evolution.fetchAllGroups(false);
    return {
      groups: groups.map((g) => ({
        chatId: jidToChatId(g.id),
        jid: g.id,
        subject: g.subject,
      })),
    };
  });

  fastify.get<{ Params: { chatId: string } }>(
    "/api/groups/:chatId/participants",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      const chatId = req.params.chatId;
      const groups = await evolution.fetchAllGroups(true);
      const group = groups.find((g) => jidToChatId(g.id) === chatId);
      if (!group) return reply.code(404).send({ error: "Group not found" });

      const participants = group.participants ?? [];
      const phones = participants.map((p) => jidToChatId(p.phoneNumber ?? p.id));
      // Resolve names from the manual Config map (name:<phone>).
      const nameRows = phones.length
        ? await prisma.config.findMany({ where: { key: { in: phones.map((p) => `name:${p}`) } } })
        : [];
      const nameByPhone = new Map(nameRows.map((r) => [r.key.slice("name:".length), r.value]));

      return {
        subject: group.subject,
        participants: participants.map((p) => {
          const phone = jidToChatId(p.phoneNumber ?? p.id);
          return {
            phone,
            lid: jidToChatId(p.id),
            name: nameByPhone.get(phone) ?? null,
            admin: p.admin ?? null,
          };
        }),
      };
    },
  );

  // ---- Reactions (read-only) ----
  fastify.get<{ Querystring: { chatId?: string; targetWaMessageId?: string; emoji?: string; limit?: string } }>(
    "/api/reactions",
    async (req, reply) => {
      try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      const q = req.query;
      const limit = Math.min(parseInt(q.limit ?? "100", 10) || 100, 500);
      const reactions = await prisma.reaction.findMany({
        where: {
          ...(q.chatId ? { chatId: q.chatId } : {}),
          ...(q.targetWaMessageId ? { targetWaMessageId: q.targetWaMessageId } : {}),
          ...(q.emoji ? { emoji: q.emoji } : {}),
        },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
      return { items: reactions };
    },
  );

  // ---- Backfill: recover historical reactions stored as "[Unsupported message]"
  // OTHER rows. Stores reactions but does NOT fire automations (calls
  // ingest.applyReaction directly, never the engine). Safe to run repeatedly.
  fastify.post("/api/admin/reprocess-reactions", async (req, reply) => {
    try { auth(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
    const strays = await prisma.message.findMany({
      where: { content: "[Unsupported message]", messageType: "OTHER" },
      select: { id: true, waMessageId: true, rawMessage: true },
    });
    let reactionsStored = 0;
    let straysRemoved = 0;
    let nonReactionSkipped = 0;
    for (const stray of strays) {
      const raw = stray.rawMessage as Record<string, unknown> | null;
      const det = detectReaction(raw?.message);
      if (!det) {
        nonReactionSkipped += 1;
        continue;
      }
      try {
        await ingest.applyReaction(
          raw as unknown as Parameters<MessageIngest["applyReaction"]>[0],
          det,
        );
        reactionsStored += 1;
        await prisma.message.delete({ where: { id: stray.id } });
        straysRemoved += 1;
      } catch (err) {
        fastify.log.warn({ err, waMessageId: stray.waMessageId }, "reprocess-reactions failed for row");
      }
    }
    return { ok: true, scanned: strays.length, reactionsStored, straysRemoved, nonReactionSkipped };
  });
};
