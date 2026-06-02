import { describe, expect, it } from "vitest";
import { detectReaction } from "./message-ingest.js";

describe("detectReaction", () => {
  it("detects a reaction with an emoji", () => {
    const det = detectReaction({
      reactionMessage: {
        key: { id: "TARGET123", remoteJid: "120363@g.us", fromMe: false },
        text: "✅",
        senderTimestampMs: "1775865468000",
      },
    });
    expect(det).not.toBeNull();
    expect(det!.targetMessageId).toBe("TARGET123");
    expect(det!.emoji).toBe("✅");
    expect(det!.removed).toBe(false);
  });

  it("treats an empty text as a removed reaction", () => {
    const det = detectReaction({
      reactionMessage: { key: { id: "TARGET123" }, text: "" },
    });
    expect(det).not.toBeNull();
    expect(det!.emoji).toBe("");
    expect(det!.removed).toBe(true);
  });

  it("treats a missing text as removed (emoji empty)", () => {
    const det = detectReaction({
      reactionMessage: { key: { id: "TARGET123" } },
    });
    expect(det).not.toBeNull();
    expect(det!.removed).toBe(true);
    expect(det!.emoji).toBe("");
  });

  it("handles a non-checkmark emoji (👍, ❌)", () => {
    expect(detectReaction({ reactionMessage: { key: { id: "x" }, text: "👍" } })!.emoji).toBe("👍");
    expect(detectReaction({ reactionMessage: { key: { id: "x" }, text: "❌" } })!.emoji).toBe("❌");
  });

  it("returns null for a normal text message", () => {
    expect(detectReaction({ conversation: "hello" })).toBeNull();
    expect(detectReaction({ extendedTextMessage: { text: "hi" } })).toBeNull();
  });

  it("returns null for a reactionMessage without a target key id", () => {
    expect(detectReaction({ reactionMessage: { text: "✅" } })).toBeNull();
    expect(detectReaction({ reactionMessage: { key: {}, text: "✅" } })).toBeNull();
  });

  it("returns null for empty / invalid bodies", () => {
    expect(detectReaction(undefined)).toBeNull();
    expect(detectReaction(null)).toBeNull();
    expect(detectReaction("nope")).toBeNull();
    expect(detectReaction({})).toBeNull();
  });
});
