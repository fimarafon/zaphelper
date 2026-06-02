import type { Automation, PrismaClient } from "@prisma/client";
import type { ActionRegistry } from "../actions/registry.js";
import { validateConditions } from "../automation/conditions.js";
import { validateTrigger } from "../automation/triggers.js";
import type { AutomationEngine } from "./automation-engine.js";

export interface CreateAutomationInput {
  name: string;
  chatId?: string | null;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  delaySeconds?: number;
  conditions?: unknown[];
  actionType: string;
  actionPayload: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  enabled?: boolean;
  chatId?: string | null;
  triggerType?: string;
  triggerConfig?: Record<string, unknown>;
  delaySeconds?: number;
  conditions?: unknown[];
  actionType?: string;
  actionPayload?: Record<string, unknown>;
}

/**
 * CRUD + validation for Automations. Mirrors ScheduledTaskService, but
 * validates the three composable parts: trigger (type), conditions (types),
 * and action (type + payload via the same ActionRegistry). Event-triggered, so
 * there's nothing to (un)register on the runner — the engine reads enabled
 * automations per event.
 */
export class AutomationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: ActionRegistry,
    private readonly engine: AutomationEngine,
  ) {}

  async create(input: CreateAutomationInput): Promise<Automation> {
    this.validate(input.triggerType, input.conditions ?? [], input.actionType, input.actionPayload, input.delaySeconds);
    return this.prisma.automation.create({
      data: {
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        chatId: input.chatId ?? null,
        triggerType: input.triggerType,
        triggerConfig: (input.triggerConfig ?? {}) as never,
        delaySeconds: input.delaySeconds ?? 0,
        conditions: (input.conditions ?? []) as never,
        actionType: input.actionType,
        actionPayload: input.actionPayload as never,
      },
    });
  }

  async update(id: string, input: UpdateAutomationInput): Promise<Automation> {
    const existing = await this.prisma.automation.findUnique({ where: { id } });
    if (!existing) throw new Error("Automation not found");

    const nextTrigger = input.triggerType ?? existing.triggerType;
    const nextConditions = input.conditions ?? (existing.conditions as unknown[]);
    const nextActionType = input.actionType ?? existing.actionType;
    const nextActionPayload =
      input.actionPayload ?? (existing.actionPayload as Record<string, unknown>);
    const nextDelay = input.delaySeconds ?? existing.delaySeconds;
    this.validate(nextTrigger, nextConditions, nextActionType, nextActionPayload, nextDelay);

    return this.prisma.automation.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
        ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
        ...(input.triggerConfig !== undefined ? { triggerConfig: input.triggerConfig as never } : {}),
        ...(input.delaySeconds !== undefined ? { delaySeconds: input.delaySeconds } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions as never } : {}),
        ...(input.actionType !== undefined ? { actionType: input.actionType } : {}),
        ...(input.actionPayload !== undefined ? { actionPayload: input.actionPayload as never } : {}),
      },
    });
  }

  async delete(id: string): Promise<void> {
    // Clean up any deferred runs so they don't fire for a deleted automation.
    await this.prisma.pendingAutomation.deleteMany({ where: { automationId: id } });
    await this.prisma.automation.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.prisma.automation.update({ where: { id }, data: { enabled } });
  }

  /** Fire the action now with a sample trigger (dashboard "Test"). */
  async runNow(id: string): Promise<void> {
    await this.engine.fireAutomationNow(id);
  }

  async list(): Promise<Automation[]> {
    return this.prisma.automation.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string): Promise<Automation | null> {
    return this.prisma.automation.findUnique({ where: { id } });
  }

  // --- private ---

  private validate(
    triggerType: string,
    conditions: unknown,
    actionType: string,
    actionPayload: unknown,
    delaySeconds: number | undefined,
  ): void {
    validateTrigger(triggerType);
    validateConditions(conditions);
    this.registry.validate(actionType, actionPayload);
    if (delaySeconds !== undefined) {
      if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
        throw new Error("delaySeconds must be a non-negative integer");
      }
    }
  }
}
