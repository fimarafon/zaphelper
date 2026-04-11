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
      // table, ask WhatsApp directly via fetchProfile. Runs in parallel batches
      // of 20 to keep total time under the HTTP timeout (nginx 300s).
      let profileLookups = 0;
      const unknownPhones = new Set<string>();
      for (const phoneJid of lidToPhone.values()) {
        if (!phoneToName.has(phoneJid)) unknownPhones.add(phoneJid);
      }
      fastify.log.info(
        { unknown: unknownPhones.size },
        "Backfill: unresolved participants, will query fetchProfile",
      );

      const phonesList = [...unknownPhones];
      const CONCURRENCY = 20;
      for (let i = 0; i < phonesList.length; i += CONCURRENCY) {
        const batch = phonesList.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (phoneJid) => {
            const phoneDigits = phoneJid.replace(/@.*$/, "");
            const profile = await evolution.fetchProfile(phoneDigits);
            return { phoneJid, name: profile?.name ?? null };
          }),
        );
        for (const r of results) {
          if (r.name && !/^\d+$/.test(r.name)) {
            phoneToName.set(r.phoneJid, r.name);
            profileLookups += 1;
          }
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

      // Two separate retrofits:
      //   A) LID -> real phone number (applies to ALL LIDs we have a mapping for,
      //      regardless of whether we have a name)
      //   B) phone number -> display name (applies wherever we have a name)
      let senderPhoneUpdated = 0;
      let senderNameUpdated = 0;

      // A) Rewrite senderPhone from LID digits to real phone digits.
      for (const [lidJid, phoneJid] of lidToPhone.entries()) {
        const lidDigits = lidJid.replace(/@.*$/, "");
        const phoneDigits = phoneJid.replace(/@.*$/, "");
        if (lidDigits === phoneDigits) continue;
        const res = await prisma.message.updateMany({
          where: { senderPhone: lidDigits },
          data: { senderPhone: phoneDigits },
        });
        senderPhoneUpdated += res.count;
      }

      // B) Set senderName wherever we know it. Also clear senderName when it's
      // just the LID digits so the UI can show a fallback instead.
      for (const [phoneJid, displayName] of phoneToName.entries()) {
        const phoneDigits = phoneJid.replace(/@.*$/, "");
        const res = await prisma.message.updateMany({
          where: { senderPhone: phoneDigits },
          data: { senderName: displayName },
        });
        senderNameUpdated += res.count;
      }

      // Clear senderName when it equals the senderPhone (i.e. it's a bare LID
      // digit string we never resolved). Leaves it null so the UI can fall back
      // to showing the phone number nicely.
      await prisma.$executeRawUnsafe(
        `UPDATE "Message" SET "senderName" = NULL WHERE "senderName" = "senderPhone"`,
      );

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

  // Import pushNames from a DIFFERENT Evolution instance (same WhatsApp number,
  // but a different historical instance that captured contact names before the
  // Evolution 2.3.x pushName-overwrite bug broke them).
  //
  // The instance must be on the same Evolution API server we're already pointed
  // at (uses the same API key). Typical use: import from "markar-a3525386" into
  // "zaphelper-main" to resolve group participant LIDs to real names.
  fastify.post<{ Body: { sourceInstance?: string; maxPages?: number } }>(
    "/api/instance/import-names",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const sourceInstance = req.body?.sourceInstance;
      if (!sourceInstance) {
        return reply
          .code(400)
          .send({ error: "sourceInstance required (e.g. 'markar-a3525386')" });
      }
      const maxPages = req.body?.maxPages ?? 500;
      const started = Date.now();

      fastify.log.info(
        { sourceInstance, maxPages },
        "Importing pushNames from source instance",
      );

      // Step 1: collect LID/phone -> pushName from source instance
      const namesByJid = await evolution.collectPushNamesFromInstance(
        sourceInstance,
        maxPages,
      );
      fastify.log.info(
        { mappingCount: namesByJid.size },
        "Collected pushNames from source",
      );

      // Step 2: build LID -> phoneNumber map from current instance's groups
      // so we can update senderPhone to the real number AND apply the name.
      const lidToPhone = new Map<string, string>();
      try {
        const groups = await evolution.fetchAllGroups(true);
        for (const g of groups) {
          for (const p of g.participants ?? []) {
            if (p.id && p.phoneNumber) {
              lidToPhone.set(p.id, p.phoneNumber);
            }
          }
        }
      } catch (err) {
        fastify.log.warn({ err }, "Import: could not load groups");
      }

      // Step 3: persist every name in the Config table (key=name:<phone>) and
      // apply to existing Message rows — by the LID digits AND by the real phone.
      let configWrites = 0;
      let rowsUpdated = 0;
      let phoneUpdated = 0;

      for (const [jid, name] of namesByJid.entries()) {
        const jidDigits = jid.replace(/@.*$/, "");
        const realPhoneJid = lidToPhone.get(jid);
        const realPhoneDigits = realPhoneJid?.replace(/@.*$/, "") ?? null;

        // Persist in Config so future webhook ingests reuse it.
        // Key by the real phone if we have it, else by the JID digits.
        const configKeyPhone = realPhoneDigits ?? jidDigits;
        await prisma.config.upsert({
          where: { key: `name:${configKeyPhone}` },
          create: { key: `name:${configKeyPhone}`, value: name },
          update: { value: name },
        });
        configWrites += 1;

        // Update all existing messages where senderPhone = LID digits.
        const resLid = await prisma.message.updateMany({
          where: { senderPhone: jidDigits },
          data: {
            senderName: name,
            ...(realPhoneDigits ? { senderPhone: realPhoneDigits } : {}),
          },
        });
        rowsUpdated += resLid.count;
        if (realPhoneDigits) phoneUpdated += resLid.count;

        // Also update rows already rewritten to the real phone (case: previous
        // backfill run replaced LID -> phone but didn't have the name yet).
        if (realPhoneDigits && realPhoneDigits !== jidDigits) {
          const resPhone = await prisma.message.updateMany({
            where: { senderPhone: realPhoneDigits, senderName: null },
            data: { senderName: name },
          });
          rowsUpdated += resPhone.count;
        }
      }

      // Refresh the in-memory name cache so webhook ingests see the new mappings.
      await ingest.refreshNameCache();

      return {
        ok: true,
        durationMs: Date.now() - started,
        sourceInstance,
        namesCollected: namesByJid.size,
        configWrites,
        rowsUpdated,
        phoneUpdated,
      };
    },
  );

  // Manually set display names for phone numbers. Body is a plain object
  // where keys are phone numbers (digits only) and values are the display
  // name to use. The mapping is persisted in the Config table (one row
  // per phone) so it survives restarts and is applied by future ingests.
  fastify.post<{ Body: { mapping: Record<string, string> } }>(
    "/api/instance/name-mapping",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const mapping = req.body?.mapping;
      if (!mapping || typeof mapping !== "object") {
        return reply.code(400).send({ error: "mapping object required" });
      }

      let updated = 0;
      for (const [rawPhone, rawName] of Object.entries(mapping)) {
        if (!rawPhone || !rawName) continue;
        const phone = rawPhone.replace(/\D/g, "");
        const name = String(rawName).trim();
        if (!phone || !name) continue;

        // Persist in Config so the webhook ingest can reuse it later.
        await prisma.config.upsert({
          where: { key: `name:${phone}` },
          create: { key: `name:${phone}`, value: name },
          update: { value: name },
        });

        // Apply to existing rows.
        const res = await prisma.message.updateMany({
          where: { senderPhone: phone },
          data: { senderName: name },
        });
        updated += res.count;
      }

      return { ok: true, updated };
    },
  );

  // List senders in a specific group who don't have a resolved name yet.
  // Useful so the user can see what to map.
  fastify.get<{ Querystring: { group?: string } }>(
    "/api/instance/unresolved-senders",
    async (req, reply) => {
      try {
        requireAuth(req);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const groupFilter = req.query.group ?? config.BE_HOME_LEADS_GROUP_NAME;

      const rows = await prisma.message.groupBy({
        by: ["senderPhone", "senderName"],
        where: {
          isGroup: true,
          chatName: { contains: groupFilter, mode: "insensitive" },
        },
        _count: { id: true },
      });

      // Only keep rows where the name is missing or equals the phone (unresolved)
      const unresolved = rows
        .filter((r) => {
          const hasName = r.senderName && !/^\d+$/.test(r.senderName);
          return !hasName;
        })
        .sort((a, b) => b._count.id - a._count.id)
        .map((r) => ({
          senderPhone: r.senderPhone,
          messageCount: r._count.id,
        }));

      return { unresolved };
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
