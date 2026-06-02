import type { Automation, Reaction } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { ActionTrigger } from "../actions/types.js";
import { renderTemplate, templateVars } from "../services/automation-engine.js";
import { validateConditions } from "./conditions.js";
import {
  type MessageEvent,
  messageTriggerMatches,
  reactionTriggerMatches,
  validateTrigger,
} from "./triggers.js";

function makeAutomation(o: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    name: "test",
    enabled: true,
    chatId: null,
    triggerType: "lead_posted",
    triggerConfig: {},
    delaySeconds: 0,
    conditions: [],
    actionType: "sendText",
    actionPayload: {},
    lastFiredAt: null,
    lastError: null,
    lastResult: null,
    runCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  } as Automation;
}

function makeReaction(o: Partial<Reaction> = {}): Reaction {
  return {
    id: "r1",
    targetWaMessageId: "MSG1",
    reactionEventId: "EVT1",
    chatId: "120363",
    chatName: "Leads",
    reactorPhone: "14255245126",
    reactorName: "Filipe",
    emoji: "❌",
    removed: false,
    timestamp: new Date(),
    rawEvent: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  } as Reaction;
}

function leadEvent(o: Partial<MessageEvent> = {}): MessageEvent {
  return {
    message: { waMessageId: "MSG1", chatId: "120363", content: "Lead", senderPhone: "1555" },
    isLead: true,
    source: "Google",
    ...o,
  };
}

describe("messageTriggerMatches", () => {
  it("lead_posted matches a lead in scope", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "lead_posted", chatId: "120363" }), leadEvent())).toBe(true);
  });

  it("lead_posted rejects a non-lead", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "lead_posted" }), leadEvent({ isLead: false }))).toBe(false);
  });

  it("rejects a different chat", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "lead_posted", chatId: "999" }), leadEvent())).toBe(false);
  });

  it("message_posted matches any message (no lead required)", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "message_posted" }), leadEvent({ isLead: false }))).toBe(true);
  });

  it("filters by source (string or array)", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "lead_posted", triggerConfig: { source: ["Google", "Facebook"] } }), leadEvent({ source: "Google" }))).toBe(true);
    expect(messageTriggerMatches(makeAutomation({ triggerType: "lead_posted", triggerConfig: { source: "Meta" } }), leadEvent({ source: "Google" }))).toBe(false);
  });

  it("does not match reaction triggers", () => {
    expect(messageTriggerMatches(makeAutomation({ triggerType: "reaction_added" }), leadEvent())).toBe(false);
  });
});

describe("reactionTriggerMatches", () => {
  it("reaction_added matches an added reaction", () => {
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added" }), makeReaction())).toBe(true);
  });

  it("removed reactions match reaction_removed only", () => {
    const removed = makeReaction({ removed: true, emoji: "" });
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_removed" }), removed)).toBe(true);
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added" }), removed)).toBe(false);
  });

  it("filters by emoji and reactor", () => {
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added", triggerConfig: { emoji: "❌" } }), makeReaction({ emoji: "❌" }))).toBe(true);
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added", triggerConfig: { emoji: "✅" } }), makeReaction({ emoji: "❌" }))).toBe(false);
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added", triggerConfig: { reactorPhone: "14255245126" } }), makeReaction())).toBe(true);
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added", triggerConfig: { reactorPhone: "999" } }), makeReaction())).toBe(false);
  });

  it("respects the chat scope", () => {
    expect(reactionTriggerMatches(makeAutomation({ triggerType: "reaction_added", chatId: "999" }), makeReaction({ chatId: "120363" }))).toBe(false);
  });
});

describe("validation", () => {
  it("validateTrigger throws on unknown trigger", () => {
    expect(() => validateTrigger("nope")).toThrow();
    expect(() => validateTrigger("lead_posted")).not.toThrow();
  });

  it("validateConditions accepts [] and known types, rejects unknown", () => {
    expect(() => validateConditions([])).not.toThrow();
    expect(() => validateConditions([{ type: "no_reaction" }])).not.toThrow();
    expect(() => validateConditions([{ type: "bogus" }])).toThrow();
    expect(() => validateConditions("nope")).toThrow();
  });
});

describe("templating", () => {
  const trigger: ActionTrigger = {
    type: "reaction_added",
    chatId: "120363",
    chatName: "Be Home Leads Scheduled",
    reaction: { emoji: "❌", removed: false, reactorPhone: "1425", reactorName: "Filipe", targetWaMessageId: "MSG1" },
    message: { waMessageId: "MSG1", content: "Mike Mulqueen", senderName: "Brandon", senderPhone: "1415", source: "Google" },
  };

  it("templateVars maps reaction + message fields", () => {
    const v = templateVars(trigger);
    expect(v.emoji).toBe("❌");
    expect(v.reactorName).toBe("Filipe");
    expect(v.leadSender).toBe("Brandon");
    expect(v.source).toBe("Google");
    expect(v.chatName).toBe("Be Home Leads Scheduled");
  });

  it("renderTemplate substitutes, recurses, and leaves unknowns intact", () => {
    expect(renderTemplate("Lead {{leadSender}} {{emoji}}", templateVars(trigger))).toBe("Lead Brandon ❌");
    const out = renderTemplate({ text: "{{emoji}}", n: 1, arr: ["{{reactorName}}", "{{unknown}}"] }, templateVars(trigger)) as Record<string, unknown>;
    expect(out.text).toBe("❌");
    expect(out.n).toBe(1);
    expect(out.arr).toEqual(["Filipe", "{{unknown}}"]);
  });

  it("empty vars for absent message (lead_posted with no message yet)", () => {
    const v = templateVars({ type: "lead_posted", chatId: "c", chatName: null, reaction: null, message: null });
    expect(v.leadSender).toBe("");
    expect(v.emoji).toBe("");
    expect(renderTemplate("hi {{leadSender}}", v)).toBe("hi ");
  });
});
