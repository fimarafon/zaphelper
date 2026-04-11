import { runCommandAction } from "./run-command.action.js";
import { sendTextAction } from "./send-text.action.js";
import { sendVoiceAction } from "./send-voice.action.js";
import type { Action } from "./types.js";
import { webhookAction } from "./webhook.action.js";

/**
 * Registry of all available scheduled-task actions.
 *
 * To add a new action type:
 *   1. Create backend/src/actions/<name>.action.ts
 *   2. Import and add to `allActions` below
 *   3. Restart the container
 *
 * The registry is keyed by action.type so the scheduler can look up the
 * correct implementation from ScheduledTask.actionType at fire time.
 */
export const allActions: Action[] = [
  sendTextAction as Action,
  runCommandAction as Action,
  webhookAction as Action,
  sendVoiceAction as Action,
];

export class ActionRegistry {
  private readonly actions = new Map<string, Action>();

  constructor(actions: Action[] = allActions) {
    for (const a of actions) {
      this.actions.set(a.type.toLowerCase(), a);
    }
  }

  resolve(type: string): Action | null {
    return this.actions.get(type.toLowerCase()) ?? null;
  }

  all(): Action[] {
    return [...this.actions.values()];
  }

  /**
   * Validates that a {type, payload} pair is well-formed. Throws a zod
   * ValidationError on failure — the caller should catch and surface it.
   */
  validate(type: string, payload: unknown): void {
    const action = this.resolve(type);
    if (!action) {
      throw new Error(`Unknown action type: "${type}"`);
    }
    // TypeScript can't narrow `action.validatePayload` through a class
    // method call, so we extract it to a local first. The validator throws
    // on failure; we don't need the assertion effect here.
    const validator = action.validatePayload;
    if (validator) {
      validator(payload);
    }
  }
}
