import {
  type Automation,
  type PendingAutomation,
  Prisma,
  type PrismaClient,
  type Reaction,
  type Message,
} from "@prisma/client";
import type { Logger } from "pino";
import type { ActionContext, ActionTrigger } from "../actions/types.js";
import type { ActionRegistry } from "../actions/registry.js";
import { evaluateConditions, type ConditionContext } from "../automation/conditions.js";
import {
  type MessageEvent,
  type TriggerMessage,
  messageTriggerMatches,
  reactionTriggerMatches,
} from "../automation/triggers.js";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import { parseLead } from "./lead-parser.js";
import type { SelfIdentity } from "./self-identity.js";

const ACTION_EXECUTION_TIMEOUT_MS = 60_000;

/** Serializable snapshot of the triggering event (stored on PendingAutomation). */
export interface TriggerContext {
  reaction?: {
    emoji: string;
    removed: boolean;
    reactorPhone: string | null;
    reactorName: string | null;
    targetWaMessageId: string;
  } | null;
  source?: string | null;
}

export interface TriggerInput {
  targetWaMessageId: string | null;
  chatId: string | null;
  triggerContext: TriggerContext;
}

type TargetMessage = Pick<
  Message,
  "waMessageId" | "content" | "senderName" | "senderPhone" | "chatName"
>;

/**
 * The composable automation engine: scope(group) -> TRIGGER -> (delay) ->
 * CONDITIONS -> ACTION. The event-driven counterpart to ScheduledTaskRunner.
 *
 * Reuses the existing ActionRegistry / ActionContext / Action implementations
 * (sendText, runCommand, webhook, sendVoice). New triggers/conditions/actions
 * are drop-in primitives (see automation/triggers.ts, automation/conditions.ts).
 *
 * INVARIANT: only invoked from the real-time webhook path (onMessage/onReaction)
 * and from PendingAutomationRunner (delayed). The sync/backfill ingest path
 * never calls the engine, so historical events never fire actions.
 */
export class AutomationEngine {
  private readonly logger: Logger;

  /** Lazily injected by server.ts so `runCommand` actions can re-enter the
   *  command pipeline (same pattern as ScheduledTaskRunner). */
  public runInlineCommand?: (
    input: string,
  ) => Promise<{ success: boolean; reply: string; error?: string }>;

  /** Injected by server.ts → PendingAutomationRunner.register, so a freshly
   *  created delayed automation is scheduled precisely (not only at the sweep). */
  public schedulePending?: (pending: PendingAutomation) => void;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly selfIdentity: SelfIdentity,
    private readonly config: AppConfig,
    private readonly registry: ActionRegistry,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "automation-engine" });
  }

  /** Real-time: a normal message was ingested. Match message triggers. */
  async onMessage(message: TriggerMessage): Promise<void> {
    const automations = await this.prisma.automation.findMany({
      where: { enabled: true, triggerType: { in: ["lead_posted", "message_posted"] } },
    });
    if (automations.length === 0) return;

    const parsed = parseLead(message.content);
    const ev: MessageEvent = {
      message,
      isLead: parsed !== null,
      source: parsed?.source ?? null,
    };

    for (const automation of automations.filter((a) => messageTriggerMatches(a, ev))) {
      await this.trigger(automation, {
        targetWaMessageId: message.waMessageId,
        chatId: message.chatId,
        triggerContext: { source: ev.source },
      });
    }
  }

  /** Real-time: a new/changed reaction arrived. Match reaction triggers. */
  async onReaction(reaction: Reaction): Promise<void> {
    const automations = await this.prisma.automation.findMany({
      where: { enabled: true, triggerType: { in: ["reaction_added", "reaction_removed"] } },
    });
    if (automations.length === 0) return;

    for (const automation of automations.filter((a) => reactionTriggerMatches(a, reaction))) {
      await this.trigger(automation, {
        targetWaMessageId: reaction.targetWaMessageId,
        chatId: reaction.chatId,
        triggerContext: {
          reaction: {
            emoji: reaction.emoji,
            removed: reaction.removed,
            reactorPhone: reaction.reactorPhone,
            reactorName: reaction.reactorName,
            targetWaMessageId: reaction.targetWaMessageId,
          },
        },
      });
    }
  }

  /** Route a matched automation: defer if it has a delay, else run now. */
  private async trigger(automation: Automation, input: TriggerInput): Promise<void> {
    if (automation.delaySeconds > 0) {
      const fireAt = new Date(Date.now() + automation.delaySeconds * 1000);
      const pending = await this.prisma.pendingAutomation.create({
        data: {
          automationId: automation.id,
          targetWaMessageId: input.targetWaMessageId,
          chatId: input.chatId,
          triggerContext: input.triggerContext as unknown as Prisma.InputJsonValue,
          fireAt,
        },
      });
      this.schedulePending?.(pending);
      this.logger.info(
        { automationId: automation.id, name: automation.name, delaySeconds: automation.delaySeconds },
        "Automation deferred (will be evaluated after delay)",
      );
      return;
    }
    await this.evaluateAndRun(automation, input);
  }

  /**
   * Evaluate the automation's conditions against current state and run the
   * action if they pass. Called immediately (no delay) and by the
   * PendingAutomationRunner (after the delay elapses).
   */
  async evaluateAndRun(automation: Automation, input: TriggerInput): Promise<void> {
    const targetMessage = await this.loadTargetMessage(input.targetWaMessageId);

    let leadSource = input.triggerContext.source ?? null;
    if (leadSource == null && targetMessage) {
      leadSource = parseLead(targetMessage.content)?.source ?? null;
    }

    const condCtx: ConditionContext = {
      prisma: this.prisma,
      targetWaMessageId: input.targetWaMessageId,
      chatId: input.chatId,
      leadSource,
    };

    const pass = await evaluateConditions(automation.conditions, condCtx);
    if (!pass) {
      this.logger.debug(
        { automationId: automation.id, name: automation.name },
        "Automation conditions not met — action skipped",
      );
      await this.prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastFiredAt: new Date(),
          lastResult: "(condições não atendidas — ação não executada)",
        },
      });
      return;
    }

    const trigger = this.buildTrigger(automation, input, targetMessage, leadSource);
    await this.runAction(automation, trigger);
  }

  /** Fire an automation's action NOW with a sample trigger (dashboard "Test"). */
  async fireAutomationNow(automationId: string): Promise<void> {
    const automation = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!automation) throw new Error("Automation not found");
    const cfg = (automation.triggerConfig ?? {}) as Record<string, unknown>;
    const trigger: ActionTrigger = {
      type: automation.triggerType,
      chatId: automation.chatId,
      chatName: "Teste",
      reaction: {
        emoji: typeof cfg.emoji === "string" && cfg.emoji ? cfg.emoji : "✅",
        removed: false,
        reactorPhone: typeof cfg.reactorPhone === "string" ? cfg.reactorPhone : null,
        reactorName: "Teste",
        targetWaMessageId: "test",
      },
      message: { waMessageId: "test", content: "Lead de teste", senderName: "Teste", senderPhone: null, source: "Google" },
    };
    await this.runAction(automation, trigger);
  }

  private async loadTargetMessage(waMessageId: string | null): Promise<TargetMessage | null> {
    if (!waMessageId) return null;
    try {
      return await this.prisma.message.findUnique({
        where: { waMessageId },
        select: { waMessageId: true, content: true, senderName: true, senderPhone: true, chatName: true },
      });
    } catch (err) {
      this.logger.debug({ err, waMessageId }, "loadTargetMessage failed");
      return null;
    }
  }

  private buildTrigger(
    automation: Automation,
    input: TriggerInput,
    targetMessage: TargetMessage | null,
    leadSource: string | null,
  ): ActionTrigger {
    return {
      type: automation.triggerType,
      chatId: input.chatId,
      chatName: targetMessage?.chatName ?? null,
      reaction: input.triggerContext.reaction ?? null,
      message: targetMessage
        ? {
            waMessageId: targetMessage.waMessageId,
            content: targetMessage.content,
            senderName: targetMessage.senderName,
            senderPhone: targetMessage.senderPhone,
            source: leadSource,
          }
        : null,
    };
  }

  private async runAction(automation: Automation, trigger: ActionTrigger): Promise<void> {
    const action = this.registry.resolve(automation.actionType);
    if (!action) {
      this.logger.error(
        { automationId: automation.id, actionType: automation.actionType },
        "Unknown action type",
      );
      await this.prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastFiredAt: new Date(),
          lastError: `Unknown action type: ${automation.actionType}`,
          failureCount: { increment: 1 },
        },
      });
      return;
    }

    const ctx: ActionContext = {
      prisma: this.prisma,
      evolution: this.evolution,
      selfIdentity: this.selfIdentity,
      config: this.config,
      logger: this.logger.child({ automationId: automation.id, action: automation.actionType }),
      taskId: `automation:${automation.id}`,
      runInlineCommand: this.runInlineCommand,
      trigger,
    };

    const payload = renderTemplate(automation.actionPayload, templateVars(trigger));
    const startedAt = new Date();
    try {
      action.validatePayload?.(payload);
      const result = await Promise.race([
        action.execute(ctx, payload as never),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Action timed out after ${ACTION_EXECUTION_TIMEOUT_MS / 1000}s`)),
            ACTION_EXECUTION_TIMEOUT_MS,
          ),
        ),
      ]);
      await this.prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastFiredAt: startedAt,
          lastError: result.success ? null : (result.error ?? "unknown error"),
          lastResult: result.output.slice(0, 500),
          runCount: { increment: 1 },
          failureCount: result.success ? { set: 0 } : { increment: 1 },
        },
      });
      this.logger.info(
        { automationId: automation.id, name: automation.name, success: result.success },
        "Automation action fired",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, automationId: automation.id }, "Automation action threw");
      await this.prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastFiredAt: startedAt,
          lastError: msg,
          runCount: { increment: 1 },
          failureCount: { increment: 1 },
        },
      });
    }
  }
}

/** Build the {{var}} substitution table from a trigger. */
export function templateVars(trigger: ActionTrigger): Record<string, string> {
  const r = trigger.reaction;
  const m = trigger.message;
  return {
    emoji: r?.emoji ?? "",
    reactorName: r?.reactorName ?? "",
    reactorPhone: r?.reactorPhone ?? "",
    chatName: trigger.chatName ?? "",
    chatId: trigger.chatId ?? "",
    leadContent: (m?.content ?? "").slice(0, 500),
    leadSender: m?.senderName ?? "",
    leadPhone: m?.senderPhone ?? "",
    source: m?.source ?? "",
  };
}

/**
 * Recursively replace {{var}} placeholders in every string within a JSON-like
 * payload. Unknown placeholders are left intact; non-string leaves pass through.
 */
export function renderTemplate(payload: unknown, vars: Record<string, string>): unknown {
  if (typeof payload === "string") {
    return payload.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : `{{${key}}}`,
    );
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => renderTemplate(item, vars));
  }
  if (payload && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      out[k] = renderTemplate(v, vars);
    }
    return out;
  }
  return payload;
}
