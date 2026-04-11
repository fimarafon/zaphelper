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

  it("handles multi-word sources", () => {
    const input = `Sam Lee
+1 555-2222
Scheduled: 2026-04-10 11:00
(Facebook Ads)`;
    const lead = parseLead(input);
    expect(lead).not.toBeNull();
    expect(lead!.source).toBe("Facebook Ads");
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
