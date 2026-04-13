import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import type { DelegateService } from "../services/delegate-service.js";

export interface DelegatesRoutesDeps {
  delegateService: DelegateService;
}

export const delegatesRoutes: FastifyPluginAsync<DelegatesRoutesDeps> = async (
  fastify,
  { delegateService },
) => {
  fastify.get("/api/delegates", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const items = await delegateService.list();
    return { items };
  });

  fastify.post<{ Body: { phone: string; name: string } }>(
    "/api/delegates",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (!req.body?.phone || !req.body?.name) {
        return reply.code(400).send({ error: "phone and name required" });
      }
      const d = await delegateService.add(req.body.phone, req.body.name);
      return { ok: true, delegate: d };
    },
  );

  fastify.post<{ Params: { phone: string }; Body: { enabled: boolean } }>(
    "/api/delegates/:phone/toggle",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const d = await delegateService.setEnabled(
        req.params.phone,
        Boolean(req.body?.enabled),
      );
      if (!d) return reply.code(404).send({ error: "Delegate not found" });
      return { ok: true, delegate: d };
    },
  );

  fastify.delete<{ Params: { phone: string } }>(
    "/api/delegates/:phone",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      await delegateService.remove(req.params.phone);
      return { ok: true };
    },
  );
};
