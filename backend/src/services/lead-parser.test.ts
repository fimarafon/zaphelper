import { describe, expect, it } from "vitest";
import { parseLead } from "./lead-parser.js";

describe("parseLead", () => {
  it("parses the canonical format", () => {
    const input = `Laura Johnson
+1 555-123-4567
123 Main St
Scheduled: 2026-04-10 14:00
Project: Kitchen remodel
(Thumbtack)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.name).toBe("Laura Johnson");
    expect(lead!.phone).toBe("15551234567");
    expect(lead!.address).toBe("123 Main St");
    expect(lead!.project).toBe("Kitchen remodel");
    expect(lead!.source).toBe("Thumbtack");
    expect(lead!.scheduledAt).not.toBeNull();
  });

  it("handles missing address and project", () => {
    const input = `Mike Brown
(555) 987-6543
Scheduled: 2026-04-11 09:30
(Google)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.name).toBe("Mike Brown");
    expect(lead!.phone).toBe("5559876543");
    expect(lead!.address).toBeNull();
    expect(lead!.project).toBeNull();
    expect(lead!.source).toBe("Google");
  });

  it("handles labels in Portuguese", () => {
    const input = `Ana Silva
+1 555-0000
Telefone: 555-1111
Endereco: 200 Oak Ave
Scheduled: 2026-04-12 16:00
Project: Bathroom
(Angi)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.source).toBe("Angi");
  });

  it("normalizes Facebook Ads / Meta / FB variations to Facebook", () => {
    const variants = [
      "(Facebook Ads)",
      "(FB)",
      "Meta ads",
      "Source: Instagram",
      "META ADS",
    ];
    for (const srcLine of variants) {
      const lead = parseLead(`Sam Lee
+1 555-2222
Scheduled: 2026-04-10 11:00
${srcLine}`);
      expect(lead, srcLine).not.toBeNull();
      expect(lead!.source, srcLine).toBe("Facebook");
    }
  });

  it("handles typos in source names", () => {
    const typos: Array<[string, string]> = [
      ["Thumbtack typo", "thumbtak"],
      ["Angi typo", "angie's"],
      ["Google typo", "goolge"],
      ["Facebook typo", "facbook"],
      ["Yelp typo", "yellp"],
      ["Referral typo", "referal"],
      ["Caps Thumbtack", "THUMBTACK"],
      ["Mixed Angi", "ANGI"],
      ["No parens Google", "Google"],
    ];
    const expected: Record<string, string> = {
      "Thumbtack typo": "Thumbtack",
      "Angi typo": "Angi",
      "Google typo": "Google",
      "Facebook typo": "Facebook",
      "Yelp typo": "Yelp",
      "Referral typo": "Referral",
      "Caps Thumbtack": "Thumbtack",
      "Mixed Angi": "Angi",
      "No parens Google": "Google",
    };
    for (const [label, line] of typos) {
      const lead = parseLead(`Sam Lee
+1 555-9999
Scheduled: 2026-04-10 11:00
${line}`);
      expect(lead, label).not.toBeNull();
      expect(lead!.source, label).toBe(expected[label]);
    }
  });

  it("detects source even when it's buried mid-message", () => {
    const input = `Client Name
+1 555-1111
Scheduled: Monday 3pm
We got this lead from Angi yesterday.
Project: bathroom remodel`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.source).toBe("Angi");
  });

  it("strips WhatsApp mention prefix from name heuristic", () => {
    const input = `Alex Rivera
+1 555-3333
Scheduled: 2026-04-10 10:00
(Angi)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.name).toBe("Alex Rivera");
  });

  it("returns null for non-lead content", () => {
    expect(parseLead("hey guys, meeting at 5")).toBeNull();
    expect(parseLead("")).toBeNull();
    expect(parseLead("ok")).toBeNull();
  });

  it("accepts only phone + scheduled as signal", () => {
    const input = `Phone: 555-123-4567
Scheduled: 2026-04-10 09:00`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.phone).toBe("5551234567");
  });

  it("tolerates slash-separated dates and am/pm times", () => {
    const input = `Jordan Kim
+1 555-4444
Scheduled: 2026/04/10 2:00pm
Project: Deck
(Thumbtack)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.scheduledAt).not.toBeNull();
  });
});
