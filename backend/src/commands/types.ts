import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { IncrementalSync } from "../services/incremental-sync.js";
import type { Scheduler } from "../services/scheduler.js";

export interface CommandContext {
  /** The parsed argument tokens (whitespace-split, quote-aware is NOT required for v1). */
  args: string[];
  /** Everything after the command name, preserving whitespace. */
  rawInput: string;
  /** The canonical command name (e.g. "statustoday"). */
  command: string;
  prisma: PrismaClient;
  evolution: EvolutionClient;
  scheduler: Scheduler;
  /**
   * Safety-net sync service. Any status/audit command should call
   * `incrementalSync.syncNowForCommand()` before querying the DB so the
   * result reflects the latest state — independent of whether the webhook
   * delivered recent messages or not.
   */
  incrementalSync: IncrementalSync;
  /** The user's own JID, e.g. "15551234567@s.whatsapp.net". */
  selfJid: string;
  /** The user's own phone, digits only. */
  selfPhone: string;
  config: AppConfig;
  logger: Logger;
  /** Injected for testability — real runs use `new Date()`. */
  now: Date;
  /**
   * Lazy accessor for the list of registered commands. Used by /help to build
   * its response without creating a circular import with registry.ts.
   */
  getCommands: () => Command[];
}

export interface CommandResult {
  success: boolean;
  /** Text to send back to the self-chat. WhatsApp supports basic markdown-ish formatting. */
  reply: string;
  /** Optional error details for the CommandLog audit row. */
  error?: string;
}

export interface Command {
  /** Primary command name — the string after the leading "/". */
  name: string;
  /** Optional aliases (also routed to this command). */
  aliases?: string[];
  /** One-line description shown in /help. */
  description: string;
  /** Usage hint, e.g. "/reminder YYYY-MM-DD HH:MM <message>". */
  usage?: string;
  execute(ctx: CommandContext): Promise<CommandResult>;
}
