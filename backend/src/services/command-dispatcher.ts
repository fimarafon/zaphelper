import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import type { EvolutionClient } from "../evolution/client.js";
import type { IncrementalSync } from "./incremental-sync.js";
import type { Scheduler } from "./scheduler.js";
import type { SelfIdentity } from "./self-identity.js";
import type { IngestedMessage } from "./message-ingest.js";

/**
 * Runs a parsed slash command. Fire-and-forget from the webhook handler:
 * logs every attempt, sends the reply back, updates CommandLog with the
 * outcome. Any thrown error inside a command becomes a FAILURE with an
 * error message sent back to the user.
 */
export class CommandDispatcher {
  private readonly logger: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly registry: CommandRegistry,
    private readonly scheduler: Scheduler,
    private readonly selfIdentity: SelfIdentity,
    private readonly config: AppConfig,
    private readonly incrementalSync: IncrementalSync,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "dispatcher" });
  }

  async dispatch(message: IngestedMessage): Promise<void> {
    const start = Date.now();
    const content = message.content.trim();
    if (!content.startsWith("/")) return;

    const selfJid = this.selfIdentity.getJid();
    const selfPhone = this.selfIdentity.getPhone();
    if (!selfJid || !selfPhone) {
      this.logger.error("Dispatcher invoked without self identity");
      return;
    }

    // Smart parse: handles both "/status 04/09" and "/status04/09" (no space).
    const withoutSlash = content.slice(1).trim();
    const parsed = this.registry.parseCommandLine(withoutSlash);

    if (!parsed) {
      // Not a known command — log the unresolved name and reply with /help hint.
      const firstToken = withoutSlash.split(/\s+/)[0] ?? "";
      const cmdName = firstToken.toLowerCase();
      await this.prisma.commandLog.create({
        data: {
          command: cmdName,
          args: withoutSlash.slice(firstToken.length).trim(),
          rawInput: content,
          messageId: message.id,
          status: "NOT_FOUND",
          output: null,
          durationMs: Date.now() - start,
        },
      });
      const reply = `❓ Unknown command: /${cmdName}\nUse /help to see available commands.`;
      await this.safeSend(selfPhone, reply);
      return;
    }

    const { command: cmd, rawInput, args } = parsed;

    const logRow = await this.prisma.commandLog.create({
      data: {
        command: cmd.name,
        args: rawInput || null,
        rawInput: content,
        messageId: message.id,
        status: "SUCCESS",
      },
    });

    const ctx: CommandContext = {
      args,
      rawInput,
      command: cmd.name,
      prisma: this.prisma,
      evolution: this.evolution,
      scheduler: this.scheduler,
      incrementalSync: this.incrementalSync,
      selfJid,
      selfPhone,
      config: this.config,
      logger: this.logger.child({ command: cmd.name }),
      now: new Date(),
      getCommands: () => this.registry.all(),
    };

    try {
      const result = await cmd.execute(ctx);
      await this.safeSend(selfPhone, result.reply);
      await this.prisma.commandLog.update({
        where: { id: logRow.id },
        data: {
          status: result.success ? "SUCCESS" : "FAILURE",
          output: result.reply,
          error: result.error ?? null,
          durationMs: Date.now() - start,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, cmd: cmd.name }, "Command execution failed");
      const reply = `💥 Error running /${cmd.name}:\n${msg}`;
      await this.safeSend(selfPhone, reply);
      await this.prisma.commandLog.update({
        where: { id: logRow.id },
        data: {
          status: "FAILURE",
          output: reply,
          error: msg,
          durationMs: Date.now() - start,
        },
      });
    }
  }

  /**
   * Executes a command inline (from the dashboard test runner), WITHOUT sending
   * the reply through Evolution API. Returns the result as JSON so the UI can
   * display it directly. Still writes a CommandLog entry for auditability.
   *
   * Useful for debugging commands without needing a connected WhatsApp.
   */
  async runInline(input: string): Promise<{ success: boolean; reply: string; error?: string }> {
    const start = Date.now();
    const content = input.trim();

    if (!content.startsWith("/")) {
      return {
        success: false,
        reply: "Input must start with /",
        error: "bad_input",
      };
    }

    const withoutSlash = content.slice(1).trim();
    const parsed = this.registry.parseCommandLine(withoutSlash);

    if (!parsed) {
      const firstToken = withoutSlash.split(/\s+/)[0] ?? "";
      const cmdName = firstToken.toLowerCase();
      const reply = `❓ Unknown command: /${cmdName}\nUse /help to see available commands.`;
      await this.prisma.commandLog.create({
        data: {
          command: cmdName,
          args: withoutSlash.slice(firstToken.length).trim() || null,
          rawInput: content,
          status: "NOT_FOUND",
          output: reply,
          durationMs: Date.now() - start,
        },
      });
      return { success: false, reply, error: "not_found" };
    }

    const { command: cmd, rawInput, args } = parsed;

    const logRow = await this.prisma.commandLog.create({
      data: {
        command: cmd.name,
        args: rawInput || null,
        rawInput: content,
        status: "SUCCESS",
      },
    });

    // For inline runs, use real self-identity if known, otherwise fall back to
    // placeholder values — commands that actually need to send via Evolution
    // (reminders, etc.) will still work IF self-identity is configured.
    const selfJid = this.selfIdentity.getJid() ?? "inline@dashboard.local";
    const selfPhone = this.selfIdentity.getPhone() ?? "0000000000";

    const ctx: CommandContext = {
      args,
      rawInput,
      command: cmd.name,
      prisma: this.prisma,
      evolution: this.evolution,
      scheduler: this.scheduler,
      incrementalSync: this.incrementalSync,
      selfJid,
      selfPhone,
      config: this.config,
      logger: this.logger.child({ command: cmd.name, mode: "inline" }),
      now: new Date(),
      getCommands: () => this.registry.all(),
    };

    try {
      const result = await cmd.execute(ctx);
      await this.prisma.commandLog.update({
        where: { id: logRow.id },
        data: {
          status: result.success ? "SUCCESS" : "FAILURE",
          output: result.reply,
          error: result.error ?? null,
          durationMs: Date.now() - start,
        },
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, cmd: cmd.name }, "Inline command execution failed");
      const reply = `💥 Erro executando /${cmd.name}:\n${msg}`;
      await this.prisma.commandLog.update({
        where: { id: logRow.id },
        data: {
          status: "FAILURE",
          output: reply,
          error: msg,
          durationMs: Date.now() - start,
        },
      });
      return { success: false, reply, error: msg };
    }
  }

  private async safeSend(phone: string, text: string): Promise<void> {
    try {
      await this.evolution.sendText(phone, text);
    } catch (err) {
      this.logger.error({ err }, "Failed to send command reply");
    }
  }
}
