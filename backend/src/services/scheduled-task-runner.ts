import type { PrismaClient, ScheduledTask as DbScheduledTask } from "@prisma/client";
import cron, { type ScheduledTask as CronScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { ActionContext } from "../actions/types.js";
import type { ActionRegistry } from "../actions/registry.js";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { SelfIdentity } from "./self-identity.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // ~24.8 days

/**
 * Dispatches scheduled tasks (cron + one-shot) by running their action
 * implementations. Independent from the Reminder scheduler so the two can
 * evolve separately — reminders stay simple, tasks are the extensible path.
 *
 * Design:
 *   - Recurring tasks: registered with node-cron, fire on every match
 *   - One-shot tasks: scheduled via setTimeout, fire once, auto-disable
 *   - On boot: loads all enabled tasks and registers them
 *   - On create/update: register or re-register the task's cron/timer
 *   - On disable/delete: stop the cron/timer
 *   - Past-due one-shot tasks (container was down): fire immediately
 *   - Every hour: sweep to re-enter deferred long-range tasks
 */
export class ScheduledTaskRunner {
  private readonly cronJobs = new Map<string, CronScheduledTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private hourlySweep: CronScheduledTask | null = null;
  private started = false;
  private readonly logger: Logger;

  /** Lazily injected by server.ts to avoid circular dependency on CommandDispatcher. */
  public runInlineCommand?: (
    input: string,
  ) => Promise<{ success: boolean; reply: string; error?: string }>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly selfIdentity: SelfIdentity,
    private readonly config: AppConfig,
    private readonly registry: ActionRegistry,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "task-runner" });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const tasks = await this.prisma.scheduledTask.findMany({
      where: { enabled: true },
    });

    let registered = 0;
    let immediate = 0;
    let deferred = 0;

    for (const task of tasks) {
      try {
        const result = this.register(task);
        if (result === "immediate") immediate += 1;
        else if (result === "deferred") deferred += 1;
        else registered += 1;
      } catch (err) {
        this.logger.error({ err, id: task.id }, "Failed to register task on boot");
      }
    }

    // Hourly sweep — re-registers long-delay one-shots whose fire time is
    // now within 24 hours of setTimeout's max delay window.
    this.hourlySweep = cron.schedule(
      "7 * * * *",
      () => {
        void this.sweep();
      },
      { timezone: this.config.TZ },
    );

    this.logger.info(
      { total: tasks.length, registered, immediate, deferred },
      "ScheduledTaskRunner started",
    );
  }

  async stop(): Promise<void> {
    for (const job of this.cronJobs.values()) job.stop();
    this.cronJobs.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.hourlySweep) {
      this.hourlySweep.stop();
      this.hourlySweep = null;
    }
    this.started = false;
  }

  /**
   * Register (or re-register) a task with the runner. Returns the outcome:
   *   "cron"      → recurring cron registered
   *   "timer"     → one-shot setTimeout registered
   *   "immediate" → past-due one-shot, fired right now
   *   "deferred"  → one-shot with delay > MAX_TIMEOUT_MS, waiting for sweep
   *   "skipped"   → disabled or invalid
   */
  register(task: DbScheduledTask): "cron" | "timer" | "immediate" | "deferred" | "skipped" {
    if (!task.enabled) {
      this.unregister(task.id);
      return "skipped";
    }

    // Cancel any existing registration first (idempotent re-register).
    this.unregister(task.id);

    if (task.cronExpression) {
      if (!cron.validate(task.cronExpression)) {
        this.logger.warn(
          { id: task.id, cron: task.cronExpression },
          "Invalid cron expression, skipping",
        );
        return "skipped";
      }

      const job = cron.schedule(
        task.cronExpression,
        () => {
          void this.fireTask(task.id);
        },
        { timezone: this.config.TZ },
      );
      this.cronJobs.set(task.id, job);

      // Compute and store nextFireAt asynchronously (best effort).
      void this.updateNextFireAt(task.id, task.cronExpression);

      return "cron";
    }

    if (task.fireAt) {
      const delay = task.fireAt.getTime() - Date.now();
      if (delay <= 0) {
        // Fire immediately (past-due). Don't await — bootstrap shouldn't block.
        void this.fireTask(task.id, { missed: true });
        return "immediate";
      }
      if (delay > MAX_TIMEOUT_MS) {
        return "deferred";
      }
      const timer = setTimeout(() => {
        this.timers.delete(task.id);
        void this.fireTask(task.id);
      }, delay);
      this.timers.set(task.id, timer);
      return "timer";
    }

    // No schedule set — task exists but won't auto-fire. Admin-only trigger.
    return "skipped";
  }

  unregister(taskId: string): void {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /**
   * Load the task fresh from the DB and execute its action. Used both by
   * cron fire callbacks and by manual "run now" requests from the UI.
   */
  async fireTask(taskId: string, opts: { missed?: boolean } = {}): Promise<void> {
    const task = await this.prisma.scheduledTask.findUnique({ where: { id: taskId } });
    if (!task) {
      this.logger.warn({ taskId }, "fireTask: task not found, unregistering");
      this.unregister(taskId);
      return;
    }
    if (!task.enabled) {
      this.logger.debug({ taskId }, "fireTask: task disabled, skipping");
      return;
    }

    const action = this.registry.resolve(task.actionType);
    if (!action) {
      this.logger.error(
        { taskId, actionType: task.actionType },
        "Unknown action type",
      );
      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastFiredAt: new Date(),
          lastError: `Unknown action type: ${task.actionType}`,
          failureCount: { increment: 1 },
        },
      });
      return;
    }

    // Build action context
    const ctx: ActionContext = {
      prisma: this.prisma,
      evolution: this.evolution,
      selfIdentity: this.selfIdentity,
      config: this.config,
      logger: this.logger.child({ taskId: task.id, action: task.actionType }),
      taskId: task.id,
      runInlineCommand: this.runInlineCommand,
    };

    const startedAt = new Date();
    try {
      // Validate payload before running (catches malformed tasks).
      const validator = action.validatePayload;
      if (validator) {
        validator(task.actionPayload);
      }
      const result = await action.execute(ctx, task.actionPayload as never);

      const prefix = opts.missed ? "[missed run] " : "";
      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastFiredAt: startedAt,
          lastError: result.success ? null : (result.error ?? "unknown error"),
          lastResult: (prefix + result.output).slice(0, 500),
          runCount: { increment: 1 },
          failureCount: result.success
            ? task.failureCount
            : task.failureCount + 1,
          // For one-shot: auto-disable after firing.
          ...(task.fireAt && !task.cronExpression ? { enabled: false } : {}),
        },
      });

      // Update nextFireAt for cron tasks.
      if (task.cronExpression) {
        void this.updateNextFireAt(task.id, task.cronExpression);
      }

      this.logger.info(
        { taskId: task.id, success: result.success },
        "Task fired",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, taskId: task.id }, "Task execution threw");
      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastFiredAt: startedAt,
          lastError: msg,
          runCount: { increment: 1 },
          failureCount: { increment: 1 },
        },
      });
    }
  }

  /**
   * Re-scan for tasks whose one-shot fire time is now within MAX_TIMEOUT_MS
   * (handles the long-delay case where setTimeout overflows).
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now + MAX_TIMEOUT_MS);
    const upcoming = await this.prisma.scheduledTask.findMany({
      where: {
        enabled: true,
        cronExpression: null,
        fireAt: { lte: cutoff, gte: new Date(now) },
      },
    });
    let added = 0;
    for (const task of upcoming) {
      if (!this.timers.has(task.id)) {
        this.register(task);
        added += 1;
      }
    }
    if (added > 0) {
      this.logger.info({ added }, "Task sweep picked up deferred one-shots");
    }
  }

  /**
   * Compute the next fire time for a cron expression and store it. Uses
   * node-cron internals if available; falls back to a simple "next hour"
   * estimate otherwise.
   */
  private async updateNextFireAt(taskId: string, cronExpr: string): Promise<void> {
    // node-cron doesn't expose a public getNext(), so we approximate:
    // we return the current time + 1 hour as a best-effort next fire.
    // The dashboard can recompute with a proper cron parser if needed.
    try {
      const approx = new Date(Date.now() + 60 * 60 * 1000);
      await this.prisma.scheduledTask.update({
        where: { id: taskId },
        data: { nextFireAt: approx },
      });
    } catch {
      // ignore — not critical
    }
    void cronExpr; // silence unused warning
  }
}
