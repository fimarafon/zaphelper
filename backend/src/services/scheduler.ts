import type { PrismaClient, Reminder } from "@prisma/client";
import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { SelfIdentity } from "./self-identity.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // ~24.8 days — setTimeout silently overflows above this.

/**
 * Persistent reminder scheduler.
 *
 * Design:
 * - On boot, loads all PENDING reminders. Past-due ones fire immediately with a
 *   [Missed] prefix; future ones are scheduled via setTimeout.
 * - New reminders are scheduled on-demand via schedule().
 * - A daily node-cron sweep picks up reminders whose delay exceeded MAX_TIMEOUT_MS
 *   the last time we saw them.
 *
 * Rationale for setTimeout over cron for the actual fires: one-shot timestamps
 * are a poor fit for cron's recurring-pattern model. node-cron only handles the
 * daily sweep; setTimeout handles the precise fire time.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private dailySweep: ScheduledTask | null = null;
  private started = false;
  private readonly logger: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly selfIdentity: SelfIdentity,
    private readonly config: AppConfig,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "scheduler" });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const pending = await this.prisma.reminder.findMany({
      where: { status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
    });

    const now = Date.now();
    let immediate = 0;
    let scheduled = 0;
    let deferred = 0;

    for (const r of pending) {
      const delay = r.scheduledAt.getTime() - now;
      if (delay <= 0) {
        // Fire missed ones, but don't block startup.
        this.fire(r, { missed: true }).catch((err) => {
          this.logger.error({ err, id: r.id }, "Missed reminder fire failed");
        });
        immediate += 1;
      } else if (delay > MAX_TIMEOUT_MS) {
        deferred += 1; // sweep will pick it up.
      } else {
        this.scheduleTimer(r, delay);
        scheduled += 1;
      }
    }

    this.dailySweep = cron.schedule(
      "5 0 * * *",
      () => {
        void this.sweep();
      },
      { timezone: this.config.TZ },
    );

    this.logger.info(
      { loaded: pending.length, immediate, scheduled, deferred },
      "Scheduler started",
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.dailySweep) {
      this.dailySweep.stop();
      this.dailySweep = null;
    }
    this.started = false;
  }

  /**
   * Schedule a freshly-created reminder. Safe to call multiple times for the
   * same reminder (idempotent).
   */
  schedule(reminder: Reminder): void {
    if (this.timers.has(reminder.id)) return;
    const delay = reminder.scheduledAt.getTime() - Date.now();
    if (delay <= 0) {
      void this.fire(reminder, { missed: false });
      return;
    }
    if (delay > MAX_TIMEOUT_MS) {
      // Sweep will pick this up within 24 hours of the fire time.
      this.logger.debug({ id: reminder.id, delay }, "Reminder deferred to sweep");
      return;
    }
    this.scheduleTimer(reminder, delay);
  }

  async cancel(id: string): Promise<Reminder | null> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    try {
      return await this.prisma.reminder.update({
        where: { id },
        data: { status: "CANCELLED" },
      });
    } catch {
      return null;
    }
  }

  /**
   * Look for any PENDING reminders scheduled within the next 24 hours that
   * aren't in our in-memory timer map yet (i.e. ones that were deferred because
   * their delay exceeded MAX_TIMEOUT_MS).
   */
  async sweep(): Promise<void> {
    const in24h = new Date(Date.now() + 24 * 3600 * 1000);
    const upcoming = await this.prisma.reminder.findMany({
      where: {
        status: "PENDING",
        scheduledAt: { lte: in24h },
      },
    });
    let added = 0;
    for (const r of upcoming) {
      if (!this.timers.has(r.id)) {
        this.schedule(r);
        added += 1;
      }
    }
    if (added > 0) {
      this.logger.info({ added }, "Sweep picked up reminders");
    }
  }

  private scheduleTimer(reminder: Reminder, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      this.fire(reminder, { missed: false }).catch((err) => {
        this.logger.error({ err, id: reminder.id }, "Reminder fire failed");
      });
    }, delay);
    this.timers.set(reminder.id, timer);
  }

  private async fire(reminder: Reminder, opts: { missed: boolean }): Promise<void> {
    const selfPhone = this.selfIdentity.getPhone();
    if (!selfPhone) {
      this.logger.warn({ id: reminder.id }, "No self phone — cannot send reminder");
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: "FAILED", error: "Self phone not configured" },
      });
      return;
    }

    try {
      const prefix = opts.missed ? "⏰ [Missed reminder] " : "⏰ Reminder: ";
      await this.evolution.sendText(selfPhone, `${prefix}${reminder.message}`);
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: opts.missed ? "MISSED" : "SENT",
          sentAt: new Date(),
        },
      });
      this.logger.info({ id: reminder.id, missed: opts.missed }, "Reminder sent");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, id: reminder.id }, "Failed to send reminder");
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: "FAILED", error: msg },
      });
    }
  }
}
