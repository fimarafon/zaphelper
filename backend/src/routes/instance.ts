import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import { requireAuth } from "../middleware/auth.js";
import type { SelfIdentity } from "../services/self-identity.js";

export interface InstanceRoutesDeps {
  prisma: PrismaClient;
  evolution: EvolutionClient;
  config: AppConfig;
  selfIdentity: SelfIdentity;
}

export const instanceRoutes: FastifyPluginAsync<InstanceRoutesDeps> = async (
  fastify,
  { prisma, evolution, config, selfIdentity },
) => {
  // Current connection status + stored instance row.
  fastify.get("/api/instance/status", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const state = await evolution.getConnectionState().catch(() => "unknown" as const);
    const row = await prisma.instance.findUnique({
      where: { name: config.EVOLUTION_INSTANCE_NAME },
    });
    const mapped =
      state === "open"
        ? "CONNECTED"
        : state === "connecting"
          ? "CONNECTING"
          : state === "close" || state === "unknown"
            ? "DISCONNECTED"
            : "ERROR";

    // Keep DB in sync if it drifted.
    if (row && row.status !== mapped) {
      await prisma.instance.update({
        where: { id: row.id },
        data: { status: mapped, lastSeenAt: new Date() },
      });
    }
    if (!row) {
      await prisma.instance.create({
        data: {
          name: config.EVOLUTION_INSTANCE_NAME,
          status: mapped,
          lastSeenAt: new Date(),
        },
      });
    }

    return {
      instanceName: config.EVOLUTION_INSTANCE_NAME,
      state: mapped,
      rawState: state,
      selfJid: selfIdentity.getJid(),
      selfPhone: selfIdentity.getPhone(),
    };
  });

  // Ensure instance exists, then return a QR code to scan.
  fastify.post("/api/instance/connect", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      await evolution.ensureInstance();
      const qr = await evolution.connect();
      await prisma.instance.upsert({
        where: { name: config.EVOLUTION_INSTANCE_NAME },
        create: {
          name: config.EVOLUTION_INSTANCE_NAME,
          status: "CONNECTING",
          lastSeenAt: new Date(),
        },
        update: { status: "CONNECTING", lastSeenAt: new Date() },
      });
      return {
        base64: qr.base64 ?? null,
        pairingCode: qr.pairingCode ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, "instance/connect failed");
      return reply.code(500).send({ error: msg });
    }
  });

  // Disconnect the WhatsApp session.
  fastify.post("/api/instance/disconnect", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      await evolution.logout();
      await prisma.instance.updateMany({
        where: { name: config.EVOLUTION_INSTANCE_NAME },
        data: { status: "DISCONNECTED" },
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, "instance/disconnect failed");
      return reply.code(500).send({ error: msg });
    }
  });

  // Manually trigger a self-identity refresh.
  fastify.post("/api/instance/refresh-identity", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const jid = await selfIdentity.refreshFromEvolution();
    return { jid };
  });
};
