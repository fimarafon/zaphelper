import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import { requireAuth } from "../middleware/auth.js";
import type { MessageIngest } from "../services/message-ingest.js";
import type { SelfIdentity } from "../services/self-identity.js";

export interface InstanceRoutesDeps {
  prisma: PrismaClient;
  evolution: EvolutionClient;
  config: AppConfig;
  selfIdentity: SelfIdentity;
  ingest: MessageIngest;
}

export const instanceRoutes: FastifyPluginAsync<InstanceRoutesDeps> = async (
  fastify,
  { prisma, evolution, config, selfIdentity, ingest },
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

  // Backfill historical messages from Evolution's own database into ours.
  // Evolution keeps a full copy of messages it has received — we can walk its
  // /chat/findMessages pagination and insert each record into our DB.
  //
  // This is safe to call multiple times: the unique constraint on
  // Message.waMessageId dedupes on conflict.
  fastify.post<{ Body: { maxPages?: number } }>(
    "/api/instance/backfill",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const maxPages = req.body?.maxPages ?? 1000;
      const started = Date.now();

      // Step 1: build chat name map.
      //   - /group/fetchAllGroups gives us group subjects (the display name)
      //   - /chat/findChats gives us pushName for DMs
      const chatNameMap = new Map<string, string>();
      try {
        const groups = await evolution.fetchAllGroups();
        for (const g of groups) {
          chatNameMap.set(g.id, g.subject);
        }
        fastify.log.info({ groups: groups.length }, "Backfill: loaded groups");
      } catch (err) {
        fastify.log.warn({ err }, "Backfill: could not load groups");
      }

      try {
        const chats = await evolution.fetchAllChats();
        for (const c of chats) {
          const remoteJid = (c.remoteJid ?? c.id) as string | undefined;
          const name =
            (c.pushName as string | undefined) ??
            (c.name as string | undefined) ??
            null;
          if (remoteJid && name && !chatNameMap.has(remoteJid)) {
            chatNameMap.set(remoteJid, name);
          }
        }
        fastify.log.info({ chats: chats.length }, "Backfill: loaded chats");
      } catch (err) {
        fastify.log.warn({ err }, "Backfill: could not load chats");
      }

      // Step 2: paginate through messages.
      let page = 1;
      let totalSaved = 0;
      let totalDuplicate = 0;
      let totalSkipped = 0;
      let totalPages = 0;
      let lastError: string | null = null;

      while (page <= maxPages) {
        try {
          const result = await evolution.fetchMessagesPage(page, 100);
          totalPages = result.pages;
          if (!result.records || result.records.length === 0) break;

          for (const record of result.records) {
            try {
              const res = await ingest.ingestRaw(record, chatNameMap);
              if (res.saved) totalSaved += 1;
              else if (res.duplicate) totalDuplicate += 1;
              else totalSkipped += 1;
            } catch (err) {
              totalSkipped += 1;
              fastify.log.debug({ err }, "ingestRaw failed for a record");
            }
          }

          fastify.log.info(
            {
              page,
              totalPages: result.pages,
              saved: totalSaved,
              duplicate: totalDuplicate,
            },
            "Backfill progress",
          );

          if (page >= result.pages) break;
          page += 1;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          fastify.log.error({ err, page }, "Backfill page fetch failed");
          break;
        }
      }

      // Step 3: retrofit chatName on any messages whose chatId matches a
      // known name but have chatName null OR chatName equal to the bare chatId
      // (from a previous backfill run that didn't have the name map yet).
      let updated = 0;
      for (const [jid, name] of chatNameMap.entries()) {
        const chatId = jid.replace(/@.*$/, "");
        const res = await prisma.message.updateMany({
          where: {
            chatId,
            OR: [{ chatName: null }, { chatName: chatId }],
          },
          data: { chatName: name },
        });
        updated += res.count;
      }
      fastify.log.info({ updated }, "Backfill: retrofitted chatName");

      return {
        ok: true,
        durationMs: Date.now() - started,
        pagesFetched: page,
        pagesTotal: totalPages,
        saved: totalSaved,
        duplicate: totalDuplicate,
        skipped: totalSkipped,
        error: lastError,
      };
    },
  );

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
