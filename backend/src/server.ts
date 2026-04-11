import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import Fastify from "fastify";
import { ActionRegistry } from "./actions/registry.js";
import { buildCommandList, CommandRegistry } from "./commands/registry.js";
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
import { schedulesRoutes } from "./routes/schedules.js";
import { webhookRoutes } from "./routes/webhook.js";
import { CommandDispatcher } from "./services/command-dispatcher.js";
import { IncrementalSync } from "./services/incremental-sync.js";
import { MessageIngest } from "./services/message-ingest.js";
import { Scheduler } from "./services/scheduler.js";
import { ScheduledTaskRunner } from "./services/scheduled-task-runner.js";
import { ScheduledTaskService } from "./services/scheduled-task-service.js";
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

  // Scheduled tasks (generic cron + actions, separate from Reminder)
  const actionRegistry = new ActionRegistry();
  const taskRunner = new ScheduledTaskRunner(
    prisma,
    evolution,
    selfIdentity,
    config,
    actionRegistry,
    logger,
  );
  const taskService = new ScheduledTaskService(prisma, taskRunner, actionRegistry);

  // Command registry with both static and dynamic commands.
  const commandList = buildCommandList({ taskService });
  const registry = new CommandRegistry(commandList);

  const ingest = new MessageIngest(prisma, selfIdentity, logger);

  // Incremental sync — safety net for the webhook. Pulls anything Evolution
  // received but didn't deliver (e.g. during restarts / brief crashes). Also
  // offers a synchronous `syncNowForCommand()` used by /status* commands so
  // they never show stale data even if the webhook is milliseconds behind.
  const incrementalSync = new IncrementalSync(
    prisma,
    evolution,
    ingest,
    config,
    logger,
  );

  const dispatcher = new CommandDispatcher(
    prisma,
    evolution,
    registry,
    scheduler,
    selfIdentity,
    config,
    incrementalSync,
    logger,
  );

  // Wire the dispatcher back into the task runner so runCommand actions work.
  taskRunner.runInlineCommand = (input: string) => dispatcher.runInline(input);

  // --- Init async state before taking traffic ---
  await selfIdentity.init();
  await scheduler.start();
  await taskRunner.start();
  await incrementalSync.start();

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
  // Deep healthcheck: checks DB round-trip + Evolution connectivity.
  // Returns 503 if any critical dependency is unhealthy, so EasyPanel/Traefik
  // can pull the container out of rotation and restart it.
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
    let allOk = true;

    // DB check
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (err) {
      checks.db = {
        ok: false,
        latencyMs: Date.now() - dbStart,
        error: err instanceof Error ? err.message : String(err),
      };
      allOk = false;
    }

    // Evolution API check (doesn't have to be connected — just reachable)
    const evoStart = Date.now();
    try {
      const state = await evolution.getConnectionState();
      checks.evolution = {
        ok: state !== "unknown",
        latencyMs: Date.now() - evoStart,
        ...(state === "unknown" ? { error: `state=${state}` } : {}),
      };
      if (state === "unknown") allOk = false;
    } catch (err) {
      checks.evolution = {
        ok: false,
        latencyMs: Date.now() - evoStart,
        error: err instanceof Error ? err.message : String(err),
      };
      // Evolution unreachable is degraded but not fatal — we still serve the
      // dashboard. Don't flip allOk to false on Evolution failure alone.
    }

    // Self identity — if we don't know the user's JID, commands won't work.
    checks.selfIdentity = {
      ok: selfIdentity.isKnown(),
    };
    // Not critical for / health probing — logs but doesn't fail.

    return reply
      .code(allOk ? 200 : 503)
      .send({
        ok: allOk,
        ts: new Date().toISOString(),
        checks,
      });
  });

  await app.register(webhookRoutes, { ingest, dispatcher, selfIdentity, prisma, config });
  await app.register(authRoutes, { config });
  await app.register(instanceRoutes, { prisma, evolution, config, selfIdentity, ingest });
  await app.register(messagesRoutes, { prisma });
  await app.register(commandRoutes, { prisma, registry, dispatcher });
  await app.register(remindersRoutes, { prisma, scheduler });
  await app.register(schedulesRoutes, { taskService, actionRegistry });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
    logger.error({ err }, "Unhandled error");
    reply.code(statusCode).send({ error: err.message });
  });

  // --- Lifecycle ---
  // Graceful shutdown: give Fastify up to 10 seconds to drain in-flight
  // requests (including webhooks) before disconnecting Prisma. Without this,
  // a SIGTERM during a deploy would hard-close active webhook connections,
  // causing Evolution to give up on those messages (no retry).
  //
  // Process: 1) stop accepting new connections 2) let in-flight finish
  // 3) stop services 4) disconnect DB 5) exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown initiated");

    // Hard kill-switch — if we hang, force-exit after 15s.
    const killSwitch = setTimeout(() => {
      logger.error("Shutdown exceeded 15s, force-exiting");
      process.exit(1);
    }, 15_000);
    killSwitch.unref();

    try {
      // 1) Stop accepting new connections; wait for in-flight to finish.
      // Fastify's close() awaits all handlers to return.
      await app.close();
      logger.info("Fastify closed (in-flight drained)");

      // 2) Stop background services.
      await scheduler.stop();
      await taskRunner.stop();
      incrementalSync.stop();
      logger.info("Background services stopped");

      // 3) Disconnect DB last.
      await prisma.$disconnect();
      logger.info("Prisma disconnected");
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }
    clearTimeout(killSwitch);
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
