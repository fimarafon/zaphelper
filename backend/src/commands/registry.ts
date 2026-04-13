import type { Command } from "./types.js";
import type { DelegateService } from "../services/delegate-service.js";
import type { ScheduledTaskService } from "../services/scheduled-task-service.js";
import { auditCommand } from "./audit.command.js";
import { createDelegateCommand } from "./delegate.command.js";
import { helpCommand } from "./help.command.js";
import { reminderCommand } from "./reminder.command.js";
import { remindersCommand } from "./reminders.command.js";
import { createScheduleCommand } from "./schedule.command.js";
import {
  createSchedulesCommand,
  createUnscheduleCommand,
} from "./schedules.command.js";
import { statusCommand } from "./status.command.js";
import { status7DaysCommand } from "./status-7days.command.js";
import { statusMonthCommand } from "./status-month.command.js";
import { statusTodayCommand } from "./status-today.command.js";
import { statusWeekCommand } from "./status-week.command.js";
import { statusYesterdayCommand } from "./status-yesterday.command.js";

/**
 * Explicit imports over glob auto-discovery — gives us typed errors at build
 * time, reliable tree-shaking, and a single file to grep when someone asks
 * "what commands exist?".
 *
 * To add a new command:
 *   1. Create src/commands/<name>.command.ts exporting a Command.
 *   2. Import it here and add it to `allCommands`.
 *   3. Restart the container.
 */
/**
 * Commands that don't depend on runtime services. Dynamic commands (e.g.
 * /schedule, which needs ScheduledTaskService) are added at registry
 * construction time via the `extraCommands` constructor argument.
 */
export const staticCommands: Command[] = [
  // Status commands — shortcuts first, then the generic /status for specific dates/ranges.
  statusTodayCommand,
  statusYesterdayCommand,
  status7DaysCommand,
  statusWeekCommand,
  statusMonthCommand,
  statusCommand,
  // Audit (transparency into skipped messages)
  auditCommand,
  // Reminders
  reminderCommand,
  remindersCommand,
  // Misc
  helpCommand,
];

/** Legacy export for callers that don't inject services. */
export const allCommands: Command[] = staticCommands;

/**
 * Factory that builds the full command list including commands that need
 * runtime services injected (like ScheduledTaskService).
 */
export function buildCommandList(deps: {
  taskService?: ScheduledTaskService;
  delegateService?: DelegateService;
}): Command[] {
  const list: Command[] = [...staticCommands];
  if (deps.taskService) {
    list.push(
      createScheduleCommand(deps.taskService),
      createSchedulesCommand(deps.taskService),
      createUnscheduleCommand(deps.taskService),
    );
  }
  if (deps.delegateService) {
    list.push(createDelegateCommand(deps.delegateService));
  }
  return list;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  constructor(commands: Command[] = staticCommands) {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  register(cmd: Command): void {
    this.commands.set(cmd.name.toLowerCase(), cmd);
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias.toLowerCase(), cmd);
    }
  }

  resolve(name: string): Command | null {
    return this.commands.get(name.toLowerCase()) ?? null;
  }

  /**
   * Smart command parser: accepts the full input after the leading "/" and
   * returns { command, rawInput, args } if we can resolve it.
   *
   * Handles two input styles:
   *   1. "statustoday"            → command="statustoday", rawInput="", args=[]
   *   2. "status 04/09"           → command="status", rawInput="04/09", args=["04/09"]
   *   3. "status04/09"            → same as above (smart prefix detection)
   *   4. "status04/03to04/09"     → command="status", rawInput="04/03to04/09"
   *   5. "reminder 2026-04-14 09:00 call"  → command="reminder", rawInput="2026-04-14 09:00 call"
   *
   * For case 3/4, we look for the longest known command prefix that matches
   * the start of the input. We check longest-first so "statusyesterday" wins
   * over "status".
   */
  parseCommandLine(input: string): {
    command: Command;
    rawInput: string;
    args: string[];
  } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Try whitespace-separated first (most natural case).
    const wsSplit = trimmed.split(/\s+/);
    const firstToken = wsSplit[0]!.toLowerCase();
    const directMatch = this.commands.get(firstToken);
    if (directMatch) {
      const rawInput = trimmed.slice(firstToken.length).trim();
      const args = rawInput ? rawInput.split(/\s+/) : [];
      return { command: directMatch, rawInput, args };
    }

    // No space split match — maybe the user typed "/status04/09" with no space.
    // Try matching the longest command name as a prefix of the first token.
    const lowerFirst = firstToken.toLowerCase();
    const candidateKeys = [...this.commands.keys()].sort(
      (a, b) => b.length - a.length,
    );
    for (const key of candidateKeys) {
      if (lowerFirst.startsWith(key) && lowerFirst.length > key.length) {
        const cmd = this.commands.get(key)!;
        // The remainder of the first token becomes the start of rawInput.
        const remainder = trimmed.slice(key.length).trim();
        const args = remainder ? remainder.split(/\s+/) : [];
        return { command: cmd, rawInput: remainder, args };
      }
    }

    return null;
  }

  /** All unique commands (aliases deduped). */
  all(): Command[] {
    return [...new Set(this.commands.values())];
  }
}
