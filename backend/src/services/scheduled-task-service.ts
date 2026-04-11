import type { PrismaClient, ScheduledTask } from "@prisma/client";
import cron from "node-cron";
import type { ActionRegistry } from "../actions/registry.js";
import type { ScheduledTaskRunner } from "./scheduled-task-runner.js";

export interface CreateTaskInput {
  name: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  cronExpression?: string;
  fireAt?: Date;
  enabled?: boolean;
}

export interface UpdateTaskInput {
  name?: string;
  enabled?: boolean;
  cronExpression?: string | null;
  fireAt?: Date | null;
  actionType?: string;
  actionPayload?: Record<string, unknown>;
}

/**
 * Thin service layer around scheduledTask CRUD — handles validation and
 * tells the ScheduledTaskRunner to (un)register tasks as they change.
 *
 * Validation rules:
 *   - Either cronExpression OR fireAt must be set (not both, not neither)
 *   - actionType must be known to the ActionRegistry
 *   - actionPayload must validate against the action's schema
 *   - cron expression must be syntactically valid
 *   - fireAt must be in the future (for new tasks)
 */
export class ScheduledTaskService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: ScheduledTaskRunner,
    private readonly registry: ActionRegistry,
  ) {}

  async create(input: CreateTaskInput): Promise<ScheduledTask> {
    this.validateScheduling(input.cronExpression, input.fireAt);
    this.registry.validate(input.actionType, input.actionPayload);

    const task = await this.prisma.scheduledTask.create({
      data: {
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        actionType: input.actionType,
        actionPayload: input.actionPayload as never,
        ...(input.cronExpression ? { cronExpression: input.cronExpression } : {}),
        ...(input.fireAt ? { fireAt: input.fireAt } : {}),
      },
    });
    this.runner.register(task);
    return task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<ScheduledTask> {
    const existing = await this.prisma.scheduledTask.findUnique({ where: { id } });
    if (!existing) throw new Error("Task not found");

    // If scheduling or action fields changed, revalidate.
    const nextCron = input.cronExpression ?? existing.cronExpression;
    const nextFireAt = input.fireAt ?? existing.fireAt;
    // Only enforce "in the future" if fireAt is being changed.
    const scheduleChanged =
      input.cronExpression !== undefined || input.fireAt !== undefined;
    if (scheduleChanged) {
      this.validateScheduling(nextCron ?? undefined, nextFireAt ?? undefined, {
        enforceFuture: input.fireAt !== undefined,
      });
    }

    const nextType = input.actionType ?? existing.actionType;
    const nextPayload =
      input.actionPayload ?? (existing.actionPayload as Record<string, unknown>);
    if (input.actionType !== undefined || input.actionPayload !== undefined) {
      this.registry.validate(nextType, nextPayload);
    }

    const updated = await this.prisma.scheduledTask.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.cronExpression !== undefined
          ? { cronExpression: input.cronExpression }
          : {}),
        ...(input.fireAt !== undefined ? { fireAt: input.fireAt } : {}),
        ...(input.actionType !== undefined ? { actionType: input.actionType } : {}),
        ...(input.actionPayload !== undefined
          ? { actionPayload: input.actionPayload as never }
          : {}),
      },
    });
    this.runner.register(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.runner.unregister(id);
    await this.prisma.scheduledTask.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    const task = await this.prisma.scheduledTask.update({
      where: { id },
      data: { enabled },
    });
    if (enabled) {
      this.runner.register(task);
    } else {
      this.runner.unregister(id);
    }
    return task;
  }

  /**
   * Fire the task right now, outside its normal schedule. Useful for testing.
   */
  async runNow(id: string): Promise<void> {
    await this.runner.fireTask(id);
  }

  async list(): Promise<ScheduledTask[]> {
    return this.prisma.scheduledTask.findMany({
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string): Promise<ScheduledTask | null> {
    return this.prisma.scheduledTask.findUnique({ where: { id } });
  }

  // --- private ---

  private validateScheduling(
    cronExpression: string | undefined,
    fireAt: Date | undefined,
    opts: { enforceFuture?: boolean } = {},
  ): void {
    if (cronExpression && fireAt) {
      throw new Error("Set either cronExpression OR fireAt, not both.");
    }
    if (!cronExpression && !fireAt) {
      throw new Error("Must set either cronExpression or fireAt.");
    }
    if (cronExpression && !cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }
    if (fireAt && opts.enforceFuture !== false) {
      if (fireAt.getTime() <= Date.now()) {
        throw new Error("fireAt must be in the future.");
      }
    }
  }
}
