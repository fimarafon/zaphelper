import type { Automation, Message, Reaction } from "@prisma/client";

/**
 * Automation trigger primitives. A trigger is "what event starts the
 * automation". Adding a new trigger type = add it here + to TRIGGER_TYPES;
 * the engine and UI pick it up with no schema change.
 */
export type TriggerType =
  | "lead_posted"
  | "message_posted"
  | "reaction_added"
  | "reaction_removed";

export const TRIGGER_TYPES: Array<{ type: TriggerType; description: string }> = [
  { type: "lead_posted", description: "Um lead foi postado no grupo (mensagem reconhecida como lead)" },
  { type: "message_posted", description: "Qualquer mensagem nova no grupo" },
  { type: "reaction_added", description: "Alguém reagiu a uma mensagem com um emoji" },
  { type: "reaction_removed", description: "Alguém removeu a reação de uma mensagem" },
];

const MESSAGE_TRIGGERS = new Set<TriggerType>(["lead_posted", "message_posted"]);
const REACTION_TRIGGERS = new Set<TriggerType>(["reaction_added", "reaction_removed"]);

export function isValidTriggerType(t: string): t is TriggerType {
  return TRIGGER_TYPES.some((x) => x.type === t);
}

export function isMessageTrigger(t: string): boolean {
  return MESSAGE_TRIGGERS.has(t as TriggerType);
}

export function isReactionTrigger(t: string): boolean {
  return REACTION_TRIGGERS.has(t as TriggerType);
}

/** Minimal message shape the triggers/engine need (so the webhook can pass the
 *  already-ingested message without re-fetching the full Prisma row). */
export type TriggerMessage = Pick<Message, "waMessageId" | "chatId" | "content" | "senderPhone">;

/** A normal-message event, with the lead-parse result computed once. */
export interface MessageEvent {
  message: TriggerMessage;
  isLead: boolean;
  source: string | null;
}

/**
 * Does this automation's trigger match an incoming message event?
 * Used by AutomationEngine.onMessage. Pure + unit-testable.
 */
export function messageTriggerMatches(automation: Automation, ev: MessageEvent): boolean {
  if (!isMessageTrigger(automation.triggerType)) return false;
  if (automation.chatId && automation.chatId !== ev.message.chatId) return false;
  if (automation.triggerType === "lead_posted" && !ev.isLead) return false;

  const cfg = asRecord(automation.triggerConfig);
  // source filter (e.g. only Google/Meta leads) — string or string[]
  const wantSources = normalizeList(cfg.source);
  if (wantSources.length > 0 && (!ev.source || !wantSources.includes(ev.source))) {
    return false;
  }
  // fromPhone filter — only when a specific person posted
  if (typeof cfg.fromPhone === "string" && cfg.fromPhone) {
    if (ev.message.senderPhone !== cfg.fromPhone) return false;
  }
  return true;
}

/**
 * Does this automation's trigger match an incoming reaction?
 * Used by AutomationEngine.onReaction. Pure + unit-testable.
 */
export function reactionTriggerMatches(automation: Automation, reaction: Reaction): boolean {
  const wantType: TriggerType = reaction.removed ? "reaction_removed" : "reaction_added";
  if (automation.triggerType !== wantType) return false;
  if (automation.chatId && automation.chatId !== reaction.chatId) return false;

  const cfg = asRecord(automation.triggerConfig);
  // emoji filter only applies when there IS an emoji (removed reactions clear it)
  if (typeof cfg.emoji === "string" && cfg.emoji && reaction.emoji && cfg.emoji !== reaction.emoji) {
    return false;
  }
  if (typeof cfg.reactorPhone === "string" && cfg.reactorPhone) {
    if (reaction.reactorPhone !== cfg.reactorPhone) return false;
  }
  return true;
}

/** Validate a trigger type + config at create/update time. Throws on error. */
export function validateTrigger(triggerType: string): void {
  if (!isValidTriggerType(triggerType)) {
    throw new Error(`Unknown trigger type: "${triggerType}"`);
  }
}

// --- helpers (shared with conditions.ts) ---

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function normalizeList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return [];
}
