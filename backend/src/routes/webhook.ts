import type { FastifyPluginAsync } from "fastify";
import {
  evolutionWebhookSchema,
  extractDeleteKeys,
  isConnectionUpdate,
  isMessagesDelete,
  isMessagesUpdate,
  isMessagesUpsert,
} from "../evolution/webhook-types.js";
import type { CommandDispatcher } from "../services/command-dispatcher.js";
import type { MessageIngest } from "../services/message-ingest.js";
import type { SelfIdentity } from "../services/self-identity.js";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import { pushWebhookEvent } from "../services/webhook-event-log.js";

export interface WebhookDeps {
  ingest: MessageIngest;
  dispatcher: CommandDispatcher;
  selfIdentity: SelfIdentity;
  prisma: PrismaClient;
  config: AppConfig;
}

/**
 * POST /webhook — receives all Evolution API events.
 *
 * Design notes:
 * - Always respond 200 with { ok: true } unless we actively want Evolution to
 *   retry. Returning 4xx/5xx triggers retries which usually makes things worse.
 * - Command dispatch is fire-and-forget via setImmediate so the webhook
 *   returns within milliseconds — Evolution's timeout won't interfere with
 *   long-running commands like /statusweek.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookDeps> = async (fastify, deps) => {
  const { ingest, dispatcher, selfIdentity, prisma, config } = deps;

  fastify.post("/webhook", async (req, reply) => {
    // Log EVERY inbound event into a ring buffer before any parsing/routing,
    // so if an event gets dropped we can still see what came in. This is the
    // ground-truth record for diagnosing "delete didn't work" / "edit didn't
    // work" / etc. Bounded to the last 200 events to keep memory small.
    pushWebhookEvent(req.body);

    const parsed = evolutionWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      fastify.log.warn({ issues: parsed.error.issues }, "Malformed webhook payload");
      return reply.code(200).send({ ok: true, ignored: "malformed" });
    }

    const payload = parsed.data;

    try {
      // Order matters: check specific events (update/delete) BEFORE upsert,
      // because the payload shapes overlap — both have key+message fields
      // and only the event name distinguishes them.
      if (isConnectionUpdate(payload)) {
        await handleConnectionUpdate(payload.data as Record<string, unknown>);
      } else if (isMessagesUpdate(payload)) {
        await handleMessagesUpdate(payload.data as Parameters<MessageIngest["applyUpdate"]>[0]);
      } else if (isMessagesDelete(payload)) {
        await handleMessagesDelete(payload.data as Record<string, unknown>);
      } else if (isMessagesUpsert(payload)) {
        await handleMessagesUpsert(payload.data as Parameters<MessageIngest["ingest"]>[0]);
      } else {
        fastify.log.debug({ event: payload.event }, "Unhandled webhook event");
      }
    } catch (err) {
      fastify.log.error({ err, event: payload.event }, "Webhook handler error");
    }

    return reply.code(200).send({ ok: true });
  });

  async function handleConnectionUpdate(data: Record<string, unknown>): Promise<void> {
    const rawState = (data.state as string | undefined)?.toLowerCase() ?? "unknown";
    const mapped =
      rawState === "open"
        ? "CONNECTED"
        : rawState === "connecting"
          ? "CONNECTING"
          : rawState === "close" || rawState === "closed"
            ? "DISCONNECTED"
            : "ERROR";

    fastify.log.info({ state: rawState, mapped }, "Connection state change");

    await prisma.instance.upsert({
      where: { name: config.EVOLUTION_INSTANCE_NAME },
      create: {
        name: config.EVOLUTION_INSTANCE_NAME,
        status: mapped,
        lastConnectedAt: mapped === "CONNECTED" ? new Date() : null,
        lastSeenAt: new Date(),
      },
      update: {
        status: mapped,
        lastSeenAt: new Date(),
        ...(mapped === "CONNECTED" ? { lastConnectedAt: new Date() } : {}),
      },
    });

    // When connection opens, refresh self identity from Evolution.
    if (mapped === "CONNECTED" && !selfIdentity.isKnown()) {
      await selfIdentity.refreshFromEvolution();
    }
  }

  async function handleMessagesUpsert(
    data: Parameters<MessageIngest["ingest"]>[0],
  ): Promise<void> {
    const result = await ingest.ingest(data);
    if (result.duplicate) {
      fastify.log.debug("Dedupe: message already stored");
      return;
    }
    if (!result.saved) return;

    // Fire-and-forget command dispatch — do NOT await.
    if (result.isSelfCommand) {
      setImmediate(() => {
        dispatcher.dispatch(result.saved!).catch((err) => {
          fastify.log.error({ err }, "Command dispatch failed");
        });
      });
    }

    // Delegate command: someone authorized sent a / command as a DM to the owner.
    // Reply goes to THEM, not to self-chat.
    if (result.isDelegateCommand && result.delegatePhone) {
      setImmediate(() => {
        dispatcher
          .dispatchAsDelegate(result.saved!, result.delegatePhone!)
          .catch((err) => {
            fastify.log.error({ err, delegate: result.delegatePhone }, "Delegate dispatch failed");
          });
      });
    }
  }

  async function handleMessagesUpdate(
    data: Parameters<MessageIngest["applyUpdate"]>[0],
  ): Promise<void> {
    const result = await ingest.applyUpdate(data);
    fastify.log.info(
      { updated: result.updated, inserted: result.inserted, notFound: result.notFound },
      "Message edit applied",
    );
  }

  async function handleMessagesDelete(data: Record<string, unknown>): Promise<void> {
    const keys = extractDeleteKeys(data);
    if (keys.length === 0) {
      fastify.log.warn(
        { dataKeys: Object.keys(data) },
        "messages.delete received but no keys extractable — shape unknown",
      );
      return;
    }
    for (const k of keys) {
      const result = await ingest.applyDelete({
        key: {
          id: k.id,
          remoteJid: k.remoteJid ?? "",
          fromMe: k.fromMe ?? false,
        },
      } as Parameters<MessageIngest["applyDelete"]>[0]);
      fastify.log.info(
        { waMessageId: k.id, deleted: result.deleted },
        "Message delete applied",
      );
    }
  }
};
