import type { PendingAutomation, PrismaClient } from "@prisma/client";
import cron, { type ScheduledTask as CronScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { AutomationEngine, TriggerContext } from "./automation-engine.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // ~24.8 days — setTimeout's max

/**
 * Fires deferred automations (those with delaySeconds > 0). When the engine
 * triggers an automation that has a delay, it persists a PendingAutomation and
 * notifies this runner (via schedulePending), which sets a timer. At fire time
 * the runner asks the engine to evaluate conditions + run the action.
 *
 * Mirrors ScheduledTaskRunner: timers for near-term, hourly sweep for very long
 * delays, and BOOT RECOVERY — any PENDING whose fireAt already passed (e.g. the
 * container was down across the 2-minute mark) fires immediately on start. That
 * recovery is what makes "wait N minutes then check" reliable across restarts.
 */
export class PendingAutomationRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private hourlySweep: CronScheduledTask | null = null;
  private started = false;
  private readonly logger: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly engine: AutomationEngine,
    private readonly config: AppConfig,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "pending-automation-runner" });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const pendings = await this.prisma.pendingAutomation.findMany({
      where: { status: "PENDING" },
    });
    let recovered = 0;
    for (const p of pendings) {
      if (p.fireAt.getTime() <= Date.now()) recovered += 1;
      this.schedule(p);
    }

    // Backstop sweep: re-schedule long-delay pendings (> setTimeout max) and
    // anything that slipped through. Precise scheduling is via schedulePending.
    this.hourlySweep = cron.schedule(
      "11 * * * *",
      () => void this.sweep(),
      { timezone: this.config.TZ },
    );

    this.logger.info(
      { pending: pendings.length, recovered },
      "PendingAutomationRunner started",
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.hourlySweep) {
      this.hourlySweep.stop();
      this.hourlySweep = null;
    }
    this.started = false;
  }

  /** Called by the engine when it creates a new pending at runtime, so it gets
   *  scheduled precisely (not just at the next sweep). */
  register(pending: PendingAutomation): void {
    this.schedule(pending);
  }

  private schedule(pending: PendingAutomation): void {
    if (this.timers.has(pending.id)) return;
    const delay = pending.fireAt.getTime() - Date.now();
    if (delay <= 0) {
      void this.fire(pending.id);
      return;
    }
    if (delay > MAX_TIMEOUT_MS) {
      // Too far out for setTimeout — the hourly sweep will pick it up later.
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(pending.id);
      void this.fire(pending.id);
    }, delay);
    this.timers.set(pending.id, timer);
  }

  private async fire(id: string): Promise<void> {
    const pending = await this.prisma.pendingAutomation.findUnique({ where: { id } });
    if (!pending || pending.status !== "PENDING") return;

    // Mark DONE BEFORE running so a restart mid-flight can't double-fire it
    // (idempotency: prefer at-most-once for outbound messages).
    await this.prisma.pendingAutomation.update({
      where: { id },
      data: { status: "DONE" },
    });

    const automation = await this.prisma.automation.findUnique({
      where: { id: pending.automationId },
    });
    if (!automation || !automation.enabled) {
      this.logger.debug({ pendingId: id }, "Automation gone/disabled at fire time — skipping");
      return;
    }

    try {
      await this.engine.evaluateAndRun(automation, {
        targetWaMessageId: pending.targetWaMessageId,
        chatId: pending.chatId,
        triggerContext: (pending.triggerContext ?? {}) as TriggerContext,
      });
    } catch (err) {
      this.logger.error({ err, pendingId: id, automationId: automation.id }, "Pending automation fire failed");
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const pendings = await this.prisma.pendingAutomation.findMany({
      where: { status: "PENDING", fireAt: { lte: new Date(now + MAX_TIMEOUT_MS) } },
    });
    let added = 0;
    for (const p of pendings) {
      if (!this.timers.has(p.id)) {
        this.schedule(p);
        added += 1;
      }
    }
    if (added > 0) this.logger.info({ added }, "Pending sweep scheduled deferred automations");
  }
}
