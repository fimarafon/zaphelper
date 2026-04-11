import type { Command } from "./types.js";

export const helpCommand: Command = {
  name: "help",
  aliases: ["?", "h"],
  description: "List all available commands.",
  usage: "/help",
  async execute(ctx) {
    const commands = ctx.getCommands().filter((c) => c.name !== "help");
    const lines = ["🤖 *zaphelper — commands*", ""];
    for (const cmd of commands) {
      lines.push(`*/${cmd.name}* — ${cmd.description}`);
      if (cmd.usage) lines.push(`  \`${cmd.usage}\``);
    }
    lines.push("");
    lines.push("_Send any command from your own chat (Message yourself)._");
    return { success: true, reply: lines.join("\n") };
  },
};
