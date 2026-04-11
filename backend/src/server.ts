import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import Fastify from "fastify";
import { CommandRegistry } from "./commands/registry.js";
import { loadConfig } from "./config.js";
import { EvolutionClient } from "./evolution/client.js";
import { createLogger } from "./logger.js";
import { registerAuthHook } from "./middleware/auth.js";
import { prisma } from "./prisma.js";
import { authRoutes } from "./routes/auth.js";
import { commandRoutes } from "./routes/commands.js";
import { instanceRoutes } from "./routes/instance.js";
import { messagesRoutes } from "./routes/messages.js";
import { remindersRoutes } from "./routes/reminders.js";
import { webhookRoutes } from "./routes/webhook.js";
import { CommandDispatcher } from "./services/command-dispatcher.js";
import { MessageIngest } from "./services/message-ingest.js";
import { Scheduler } from "./services/scheduler.js";
import { SelfIdentity } from "./services/self-identity.js";

async function bootstrap() {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);

  logger.info({ env: config.NODE_ENV, tz: config.TZ }, "Starting zaphelper");

  // --- Core dependencies ---
  const evolution = new EvolutionClient({
    baseUrl: config.EVOLUTION_API_URL,
    apiKey: config.EVOLUTION_API_KEY,
    instanceName: config.EVOLUTION_INSTANCE_NAME,
    webhookUrl: config.WEBHOOK_URL,
    logger,
  });

  const selfIdentity = new SelfIdentity(
    prisma,
    evolution,
    config.SELF_PHONE_NUMBER,
    logger,
  );

  const scheduler = new Scheduler(prisma, evolution, selfIdentity, config, logger);
  const registry = new CommandRegistry();
  const dispatcher = new CommandDispatcher(
    prisma,
    evolution,
    registry,
    scheduler,
    selfIdentity,
    config,
    logger,
  );
  const ingest = new MessageIngest(prisma, selfIdentity, logger);

  // --- Init async state before taking traffic ---
  await selfIdentity.init();
  await scheduler.start();

  // --- Fastify app ---
  // Pass a pino-shaped logger config instead of the logger instance — Fastify's
  // generic types get picky when handed a concrete pino Logger.
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      transport:
        config.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:HH:MM:ss",
                ignore: "pid,hostname",
              },
            },
    },
    bodyLimit: 5 * 1024 * 1024, // 5 MB — Evolution can push large media payloads
    trustProxy: true,
  });

  // Accept empty JSON bodies on POST — browsers often send
  // `Content-Type: application/json` with no body when fetching with
  // `method: "POST"` and no payload.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body === "" || body == null) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(fastifyCookie, { secret: config.JWT_SECRET });
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  registerAuthHook(app, config);

  // --- Routes ---
  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(webhookRoutes, { ingest, dispatcher, selfIdentity, prisma, config });
  await app.register(authRoutes, { config });
  await app.register(instanceRoutes, { prisma, evolution, config, selfIdentity, ingest });
  await app.register(messagesRoutes, { prisma });
  await app.register(commandRoutes, { prisma, registry, dispatcher });
  await app.register(remindersRoutes, { prisma, scheduler });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
    logger.error({ err }, "Unhandled error");
    reply.code(statusCode).send({ error: err.message });
  });

  // --- Lifecycle ---
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    try {
      await app.close();
      await scheduler.stop();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, host: config.HOST }, "zaphelper listening");
  } catch (err) {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  }

  // --- Post-boot best-effort: ensure instance and webhook are configured ---
  // Don't block startup on this — Evolution may not be reachable yet.
  void (async () => {
    try {
      const state = await evolution.ensureInstance();
      logger.info({ state }, "Evolution instance checked");
      if (state === "open" && !selfIdentity.isKnown()) {
        await selfIdentity.refreshFromEvolution();
      }
    } catch (err) {
      logger.warn({ err }, "Could not ensure Evolution instance on boot");
    }
  })();
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
