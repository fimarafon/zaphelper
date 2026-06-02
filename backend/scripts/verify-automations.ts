/**
 * End-to-end verification for the composable automation engine.
 *
 * Exercises the REAL engine + pending-runner + ingest against the local DB,
 * with a STUBBED Evolution client (no network). Proves the two examples Filipe
 * gave, plus the safety invariant:
 *
 *   A) Inactivity FIRES: lead_posted -> wait (delay) -> no_reaction true ->
 *      sendText to:"group" (posts back into the group).
 *   B) Inactivity SUPPRESSED: same, but a 👍 reaction exists -> condition false
 *      -> action does NOT fire.
 *   C) Reaction -> person: reaction_added(❌) -> sendText to a number, with
 *      {{leadSender}}/{{emoji}} templating resolved.
 *
 * Self-cleaning. Run: DATABASE_URL=... npx tsx scripts/verify-automations.ts
 */
import { PrismaClient } from "@prisma/client";
import { ActionRegistry } from "../src/actions/registry.js";
import { createLogger } from "../src/logger.js";
import { AutomationEngine } from "../src/services/automation-engine.js";
import { MessageIngest } from "../src/services/message-ingest.js";
import { PendingAutomationRunner } from "../src/services/pending-automation-runner.js";

const prisma = new PrismaClient();
const logger = createLogger("production");

const sentText: Array<{ to: string; text: string }> = [];
const sentToChat: Array<{ jid: string; text: string }> = [];
const evolutionStub = {
  sendText: async (to: string, text: string) => { sentText.push({ to, text }); return { ok: true }; },
  // Mirror the real client's group-JID suffixing so the test sees the end state.
  sendToChat: async (jid: string, text: string) => {
    sentToChat.push({ jid: jid.includes("@") ? jid : `${jid}@g.us`, text });
    return { ok: true };
  },
} as unknown as ConstructorParameters<typeof AutomationEngine>[1];

const selfIdentityStub = {
  getJid: () => null,
  getPhone: () => "16198886149",
  getLid: () => null,
  isSelfChatJid: () => false,
  setSelfLid: async () => {},
} as unknown as ConstructorParameters<typeof MessageIngest>[1];

const configStub = { TZ: "America/New_York" } as unknown as ConstructorParameters<typeof AutomationEngine>[3];

const CHAT_ID = "120999000222";
const CHAT_JID = `${CHAT_ID}@g.us`;
const LEAD_ID = "E2E_AUTO_LEAD";
const LEAD_CONTENT = "Mike Mulqueen\n+1 (415) 819-0400\n(Google)";
const A1 = "E2E inactivity rule";
const A2 = "E2E reaction rule";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`, cond ? "" : (extra ?? ""));
  if (!cond) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await prisma.pendingAutomation.deleteMany({ where: { chatId: CHAT_ID } });
  await prisma.automation.deleteMany({ where: { name: { in: [A1, A2] } } });
  await prisma.reaction.deleteMany({ where: { targetWaMessageId: LEAD_ID } });
  await prisma.message.deleteMany({ where: { waMessageId: LEAD_ID } });
}

async function main() {
  const registry = new ActionRegistry();
  const ingest = new MessageIngest(prisma, selfIdentityStub, logger);
  const engine = new AutomationEngine(prisma, evolutionStub, selfIdentityStub, configStub, registry, logger);
  const runner = new PendingAutomationRunner(prisma, engine, configStub, logger);
  engine.schedulePending = (p) => runner.register(p);

  await cleanup();

  await prisma.message.create({
    data: {
      waMessageId: LEAD_ID, chatId: CHAT_ID, chatName: "Be Home Leads Scheduled",
      senderName: "Brandon", senderPhone: "14153052495", content: LEAD_CONTENT,
      rawMessage: {}, messageType: "TEXT", isGroup: true, isFromMe: false, isSelfChat: false,
      timestamp: new Date(),
    },
  });

  const leadMsg = { waMessageId: LEAD_ID, chatId: CHAT_ID, content: LEAD_CONTENT, senderPhone: "14153052495" };

  // ---- A) Inactivity fires ----
  console.log("\nA) Inactivity: lead -> wait 1s -> nobody reacted -> post in group");
  await prisma.automation.create({
    data: {
      name: A1, enabled: true, chatId: CHAT_ID, triggerType: "lead_posted", triggerConfig: {},
      delaySeconds: 1, conditions: [{ type: "no_reaction" }] as never,
      actionType: "sendText", actionPayload: { to: "group", text: "2 min. Please call the lead!" } as never,
    },
  });
  sentToChat.length = 0;
  await engine.onMessage(leadMsg);
  const pendingCount = await prisma.pendingAutomation.count({ where: { chatId: CHAT_ID, status: "PENDING" } });
  check("a PendingAutomation was created (deferred)", pendingCount === 1, `count=${pendingCount}`);
  await sleep(1500);
  check("action fired after the delay", sentToChat.length === 1, `sentToChat=${sentToChat.length}`);
  check("posted to the group JID", sentToChat[0]?.jid === CHAT_JID, sentToChat[0]?.jid);
  check("with the configured text", sentToChat[0]?.text === "2 min. Please call the lead!", sentToChat[0]?.text);

  // ---- B) Inactivity suppressed by a reaction ----
  console.log("\nB) Same, but someone reacted 👍 within the window -> action suppressed");
  await prisma.reaction.create({
    data: {
      targetWaMessageId: LEAD_ID, reactionEventId: "E2E_THUMB", chatId: CHAT_ID, chatName: "x",
      reactorPhone: "15550000002", reactorName: "Rep", emoji: "👍", removed: false,
      timestamp: new Date(), rawEvent: {},
    },
  });
  sentToChat.length = 0;
  await engine.onMessage(leadMsg);
  await sleep(1500);
  check("action did NOT fire (no_reaction condition false)", sentToChat.length === 0, `sentToChat=${sentToChat.length}`);

  // ---- C) Reaction -> person, with templating ----
  console.log("\nC) Reaction ❌ -> message a person, with {{leadSender}}/{{emoji}} templating");
  await prisma.reaction.deleteMany({ where: { targetWaMessageId: LEAD_ID } });
  await prisma.automation.create({
    data: {
      name: A2, enabled: true, chatId: CHAT_ID, triggerType: "reaction_added",
      triggerConfig: { emoji: "❌" } as never, delaySeconds: 0, conditions: [] as never,
      actionType: "sendText",
      actionPayload: { to: "14255245126", text: "Lead de {{leadSender}} recebeu {{emoji}}" } as never,
    },
  });
  const rx = await ingest.ingest({
    key: { id: "E2E_AUTO_RX", remoteJid: CHAT_JID, fromMe: false, participant: "14255000009@s.whatsapp.net" },
    message: { reactionMessage: { key: { id: LEAD_ID }, text: "❌" } },
    pushName: "Filipe",
    messageTimestamp: 1775865468,
  } as unknown as Parameters<MessageIngest["ingest"]>[0]);
  check("reaction captured", rx.reaction?.row.emoji === "❌");
  sentText.length = 0;
  await engine.onReaction(rx.reaction!.row);
  check("action fired", sentText.length === 1, `sentText=${sentText.length}`);
  check("sent to the configured number", sentText[0]?.to === "14255245126", sentText[0]?.to);
  check("template rendered with lead sender + emoji", sentText[0]?.text === "Lead de Brandon recebeu ❌", sentText[0]?.text);

  await runner.stop();
  await cleanup();
  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Verification script crashed:", err);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
