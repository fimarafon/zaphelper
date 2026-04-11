import type { Command } from "./types.js";
import { helpCommand } from "./help.command.js";
import { reminderCommand } from "./reminder.command.js";
import { remindersCommand } from "./reminders.command.js";
import { statusTodayCommand } from "./status-today.command.js";
import { statusWeekCommand } from "./status-week.command.js";

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
export const allCommands: Command[] = [
  statusTodayCommand,
  statusWeekCommand,
  reminderCommand,
  remindersCommand,
  helpCommand,
];

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  constructor(commands: Command[] = allCommands) {
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

  /** All unique commands (aliases deduped). */
  all(): Command[] {
    return [...new Set(this.commands.values())];
  }
}
