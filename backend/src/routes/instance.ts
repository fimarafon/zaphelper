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

      // ---- Step 1: build the resolution maps ----
      //
      //   chatNameMap:  remoteJid     -> display name (group subject or DM pushName)
      //   lidToPhone:   "x@lid"       -> "y@s.whatsapp.net"  (from group participants)
      //   phoneToName:  "y@s.whatsapp.net" -> pushName         (from contacts table)
      const chatNameMap = new Map<string, string>();
      const lidToPhone = new Map<string, string>();
      const phoneToName = new Map<string, string>();

      try {
        const groups = await evolution.fetchAllGroups(true);
        for (const g of groups) {
          chatNameMap.set(g.id, g.subject);
          for (const p of g.participants ?? []) {
            if (p.id && p.phoneNumber) {
              lidToPhone.set(p.id, p.phoneNumber);
            }
          }
        }
        fastify.log.info(
          { groups: groups.length, lidMappings: lidToPhone.size },
          "Backfill: loaded groups + participants",
        );
      } catch (err) {
        fastify.log.warn({ err }, "Backfill: could not load groups");
      }

      try {
        const contacts = await evolution.fetchAllContacts();
        for (const c of contacts) {
          if (c.pushName && !/^\d+$/.test(c.pushName)) {
            phoneToName.set(c.remoteJid, c.pushName);
          }
        }
        fastify.log.info({ contactNames: phoneToName.size }, "Backfill: loaded contacts");
      } catch (err) {
        fastify.log.warn({ err }, "Backfill: could not load contacts");
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
            // DM chatName — only set if we don't already have a group subject.
            chatNameMap.set(remoteJid, name);
          }
        }
        fastify.log.info({ chats: chats.length }, "Backfill: loaded chats");
      } catch (err) {
        fastify.log.warn({ err }, "Backfill: could not load chats");
      }

      // Step 1b: for participants whose phone number isn't in our contacts
      // table, ask WhatsApp directly via fetchProfile. This is slow (one HTTP
      // call per unknown participant) but runs once per backfill.
      let profileLookups = 0;
      const unknownPhones = new Set<string>();
      for (const phoneJid of lidToPhone.values()) {
        if (!phoneToName.has(phoneJid)) unknownPhones.add(phoneJid);
      }
      fastify.log.info(
        { unknown: unknownPhones.size },
        "Backfill: unresolved participants, will query fetchProfile",
      );
      for (const phoneJid of unknownPhones) {
        const phoneDigits = phoneJid.replace(/@.*$/, "");
        const profile = await evolution.fetchProfile(phoneDigits);
        if (profile?.name && !/^\d+$/.test(profile.name)) {
          phoneToName.set(phoneJid, profile.name);
          profileLookups += 1;
        }
      }
      fastify.log.info({ profileLookups }, "Backfill: profile lookups done");

      const resolver = { chatNameMap, lidToPhone, phoneToName };

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
              const res = await ingest.ingestRaw(record, resolver);
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

      // ---- Step 3: retrofit existing rows ----
      //
      // After the backfill re-ingests from Evolution, duplicate key errors
      // mean we already have a row — but from a previous run that may have
      // stored wrong chatName/senderName. Force-update rows by chatId.
      //
      // For chatName: any row in the same group gets the group subject.
      // For senderName: for each LID -> phone -> name resolution, update
      // every row whose senderPhone matches the LID digits.
      let chatNameUpdated = 0;
      for (const [jid, name] of chatNameMap.entries()) {
        const chatId = jid.replace(/@.*$/, "");
        const res = await prisma.message.updateMany({
          where: { chatId, isGroup: true },
          data: { chatName: name },
        });
        chatNameUpdated += res.count;
      }

      // Build a combined LID -> displayName map to retrofit senderName.
      const lidToName = new Map<string, string>();
      for (const [lidJid, phoneJid] of lidToPhone.entries()) {
        const name = phoneToName.get(phoneJid);
        if (name) lidToName.set(lidJid, name);
      }

      let senderNameUpdated = 0;
      let senderPhoneUpdated = 0;
      for (const [lidJid, displayName] of lidToName.entries()) {
        const lidDigits = lidJid.replace(/@.*$/, "");
        const realPhoneJid = lidToPhone.get(lidJid);
        const realPhoneDigits = realPhoneJid?.replace(/@.*$/, "") ?? null;

        // Update senderName on rows stored with the bare LID as senderPhone.
        const resName = await prisma.message.updateMany({
          where: { senderPhone: lidDigits },
          data: { senderName: displayName },
        });
        senderNameUpdated += resName.count;

        // Also replace the LID in senderPhone with the real phone number so
        // the dashboard shows proper numbers instead of opaque LIDs.
        if (realPhoneDigits) {
          const resPhone = await prisma.message.updateMany({
            where: { senderPhone: lidDigits },
            data: { senderPhone: realPhoneDigits },
          });
          senderPhoneUpdated += resPhone.count;
        }
      }

      fastify.log.info(
        { chatNameUpdated, senderNameUpdated, senderPhoneUpdated },
        "Backfill: retrofitted existing rows",
      );

      return {
        ok: true,
        durationMs: Date.now() - started,
        pagesFetched: page,
        pagesTotal: totalPages,
        saved: totalSaved,
        duplicate: totalDuplicate,
        skipped: totalSkipped,
        groups: chatNameMap.size,
        lidMappings: lidToPhone.size,
        contactNames: phoneToName.size,
        profileLookups,
        retrofit: {
          chatNameUpdated,
          senderNameUpdated,
          senderPhoneUpdated,
        },
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
