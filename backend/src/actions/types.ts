import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { SelfIdentity } from "../services/self-identity.js";

/**
 * Data about the event that triggered an action. Present when the action was
 * fired by an event-driven Automation (reaction/lead trigger) rather than by a
 * time-based ScheduledTask. Lets actions reference who reacted, which lead,
 * etc. The AutomationEngine also uses this to substitute {{var}} placeholders
 * in the action payload (e.g. sendText `text: "Lead {{leadSender}} got {{emoji}}"`).
 */
export interface ActionTrigger {
  /** The triggerType that fired, e.g. "reaction_added" | "lead_posted". */
  type: string;
  /** The chat/group where the trigger happened. Used by sendText `to: "group"`. */
  chatId: string | null;
  chatName: string | null;
  /** Present for reaction_* triggers. */
  reaction?: {
    emoji: string;
    removed: boolean;
    reactorPhone: string | null;
    reactorName: string | null;
    targetWaMessageId: string;
  } | null;
  /** The relevant message — the lead for *_posted triggers, or the message a
   *  reaction targeted for reaction_* triggers (when we have it stored). */
  message?: {
    waMessageId: string;
    content: string;
    senderName: string | null;
    senderPhone: string | null;
    source: string | null;
  } | null;
}

/**
 * Context passed to every Action when it fires. Contains shared services
 * the action may need (Evolution client, Prisma, config, etc.) plus a
 * logger scoped to the specific task.
 */
export interface ActionContext {
  prisma: PrismaClient;
  evolution: EvolutionClient;
  selfIdentity: SelfIdentity;
  config: AppConfig;
  logger: Logger;
  /** The task's in-memory ID (useful for audit trails). */
  taskId: string;
  /** Optional dispatcher used by the `runCommand` action to re-enter the
   *  command pipeline. Injected lazily to avoid circular imports. */
  runInlineCommand?: (input: string) => Promise<{ success: boolean; reply: string; error?: string }>;
  /** Present only when the action was fired by an event-driven Automation.
   *  Undefined for time-based ScheduledTask runs. */
  trigger?: ActionTrigger;
}

/**
 * Result of running an Action. `output` is truncated and stored in
 * ScheduledTask.lastResult for visibility in the dashboard.
 */
export interface ActionResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * A pluggable Action implementation. To add a new type:
 *   1. Create backend/src/actions/<name>.action.ts exporting an Action object
 *   2. Register it in backend/src/actions/registry.ts
 *   3. Validate payload.* in your execute() and return an ActionResult
 */
export interface Action<P = unknown> {
  /** Unique string identifier stored in ScheduledTask.actionType. */
  type: string;
  /** Human-friendly description, shown in /schedule help. */
  description: string;
  /**
   * Optional synchronous validation — throws if the payload is malformed.
   * Returns void on success. (Not typed as an `asserts` predicate because
   * TS's narrowing can't follow it through class methods and map.get().)
   */
  validatePayload?: (payload: unknown) => void;
  execute: (ctx: ActionContext, payload: P) => Promise<ActionResult>;
}
