/**
 * In-memory ring buffer of the most recent inbound webhook events.
 *
 * Purpose: when a delete / edit / etc fails to apply, we need to see what
 * Evolution actually sent us — the raw payload BEFORE any parsing, routing,
 * or filtering. Lives in memory only (resets on restart), holds the last
 * ~200 events. Exposed via GET /api/admin/webhook-events.
 *
 * NOTE: This is a debug tool. Payloads are stored whole (truncated to 8KB
 * per event to avoid runaway memory). In production with heavy traffic,
 * consider replacing with a DB-backed capped table.
 */

const MAX_EVENTS = 200;
const MAX_PAYLOAD_BYTES = 8_192;

export interface CapturedWebhookEvent {
  receivedAt: string;
  eventName: string | null;
  /** Full payload, JSON-stringified then truncated if over the limit. */
  rawJson: string;
  /** Convenience: top-level keys of payload.data if it's an object. */
  dataKeys: string[];
  /** Result trace — set after the handler runs, lets us see the path taken. */
  outcome: string | null;
  outcomeDetail: string | null;
}

const ring: CapturedWebhookEvent[] = [];
const idIndex = new Map<string, CapturedWebhookEvent>();

export function pushWebhookEvent(body: unknown): string | null {
  try {
    let raw = typeof body === "string" ? body : JSON.stringify(body);
    if (raw.length > MAX_PAYLOAD_BYTES) {
      raw = `${raw.slice(0, MAX_PAYLOAD_BYTES)}... [truncated]`;
    }

    let eventName: string | null = null;
    let dataKeys: string[] = [];
    let waMessageId: string | null = null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const ev = b.event;
      if (typeof ev === "string") eventName = ev;
      const data = b.data as Record<string, unknown> | undefined;
      if (data && typeof data === "object") {
        dataKeys = Object.keys(data);
        const key = data.key as Record<string, unknown> | undefined;
        if (key && typeof key.id === "string") waMessageId = key.id;
      }
    }

    const entry: CapturedWebhookEvent = {
      receivedAt: new Date().toISOString(),
      eventName,
      rawJson: raw,
      dataKeys,
      outcome: null,
      outcomeDetail: null,
    };
    ring.push(entry);
    if (waMessageId) idIndex.set(waMessageId, entry);

    while (ring.length > MAX_EVENTS) {
      const removed = ring.shift();
      if (removed) {
        // Best-effort cleanup of idIndex on rotation.
        for (const [k, v] of idIndex.entries()) {
          if (v === removed) idIndex.delete(k);
        }
      }
    }

    return waMessageId;
  } catch {
    return null;
  }
}

/**
 * Annotate the most recently captured event for a given waMessageId with
 * the result of processing. Lets debug endpoints answer "what happened to
 * the message I just sent?" definitively.
 */
export function tagWebhookOutcome(
  waMessageId: string | null | undefined,
  outcome: string,
  detail?: string,
): void {
  if (!waMessageId) return;
  const entry = idIndex.get(waMessageId);
  if (!entry) return;
  entry.outcome = outcome;
  entry.outcomeDetail = detail ?? null;
}

export function readWebhookEvents(filter?: {
  eventContains?: string;
  limit?: number;
}): CapturedWebhookEvent[] {
  const limit = filter?.limit ?? MAX_EVENTS;
  let out = ring.slice();
  if (filter?.eventContains) {
    const needle = filter.eventContains.toLowerCase();
    out = out.filter(
      (e) =>
        (e.eventName?.toLowerCase().includes(needle) ?? false) ||
        e.rawJson.toLowerCase().includes(needle),
    );
  }
  return out.slice(-limit).reverse();
}
