import type { Command } from "./types.js";

export const helpCommand: Command = {
  name: "help",
  aliases: ["?", "h"],
  description: "Lista todos os comandos disponíveis.",
  usage: "/help",
  async execute(ctx) {
    const commands = ctx.getCommands().filter((c) => c.name !== "help");
    const lines = ["🤖 *zaphelper — comandos*", ""];
    for (const cmd of commands) {
      lines.push(`*/${cmd.name}* — ${cmd.description}`);
      if (cmd.usage) lines.push(`  \`${cmd.usage}\``);
    }
    lines.push("");
    lines.push("_Envie qualquer comando no seu próprio chat (Eu mesmo)._");
    return { success: true, reply: lines.join("\n") };
  },
};
