import type { PrismaClient } from "@prisma/client";
import { normalizeList } from "./triggers.js";

/**
 * Automation condition primitives. Conditions are evaluated at ACTION time
 * (after any delay), against the live DB state — so "no_reaction" reflects
 * whether anyone has reacted by the moment the delay elapses. Adding a new
 * condition type = add a case here + to CONDITION_TYPES.
 *
 * Semantics: ALL conditions must pass (logical AND). An empty list passes.
 */
export const CONDITION_TYPES: Array<{ type: string; description: string }> = [
  { type: "no_reaction", description: "O lead NÃO tem reação ativa (opcional: de um emoji específico)" },
  { type: "has_reaction", description: "O lead TEM reação ativa (opcional: emoji e/ou pessoa)" },
  { type: "source_is", description: "A fonte detectada do lead está na lista (ex.: Google, Meta)" },
];

const KNOWN = new Set(CONDITION_TYPES.map((c) => c.type));

export interface ConditionContext {
  prisma: PrismaClient;
  /** The lead/message the automation is about (for reaction checks). */
  targetWaMessageId: string | null;
  chatId: string | null;
  /** Detected lead source, if known (for source_is). */
  leadSource: string | null;
}

/** Validate a conditions array at create/update time. Throws on unknown type. */
export function validateConditions(conditions: unknown): void {
  if (conditions == null) return;
  if (!Array.isArray(conditions)) {
    throw new Error("conditions must be an array");
  }
  for (const c of conditions) {
    const type = (c as { type?: unknown })?.type;
    if (typeof type !== "string" || !KNOWN.has(type)) {
      throw new Error(`Unknown condition type: ${JSON.stringify(type)}`);
    }
  }
}

/** Evaluate all conditions (AND). Returns true if the action should run. */
export async function evaluateConditions(
  conditions: unknown,
  ctx: ConditionContext,
): Promise<boolean> {
  const list = Array.isArray(conditions) ? conditions : [];
  for (const raw of list) {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (!(await evaluateOne(c, ctx))) return false;
  }
  return true;
}

async function evaluateOne(c: Record<string, unknown>, ctx: ConditionContext): Promise<boolean> {
  switch (c.type) {
    case "no_reaction": {
      // Vacuously true if there's no target to react to.
      if (!ctx.targetWaMessageId) return true;
      const emoji = typeof c.emoji === "string" && c.emoji ? c.emoji : null;
      const count = await ctx.prisma.reaction.count({
        where: {
          targetWaMessageId: ctx.targetWaMessageId,
          removed: false,
          ...(emoji ? { emoji } : { emoji: { not: "" } }),
        },
      });
      return count === 0;
    }
    case "has_reaction": {
      if (!ctx.targetWaMessageId) return false;
      const emoji = typeof c.emoji === "string" && c.emoji ? c.emoji : null;
      const reactorPhone =
        typeof c.reactorPhone === "string" && c.reactorPhone ? c.reactorPhone : null;
      const count = await ctx.prisma.reaction.count({
        where: {
          targetWaMessageId: ctx.targetWaMessageId,
          removed: false,
          ...(emoji ? { emoji } : {}),
          ...(reactorPhone ? { reactorPhone } : {}),
        },
      });
      return count > 0;
    }
    case "source_is": {
      const sources = normalizeList(c.sources);
      if (sources.length === 0) return true;
      return ctx.leadSource != null && sources.includes(ctx.leadSource);
    }
    default:
      // Unknown condition (shouldn't happen — validated on write). Be lenient.
      return true;
  }
}
