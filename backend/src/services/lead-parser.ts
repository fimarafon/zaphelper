/**
 * Flexible line-based parser for lead messages in the "Be Home Leads Scheduled"
 * group. Uses line matchers rather than a monolithic regex so it's resilient
 * to format variations.
 *
 * Target format:
 *   Laura Name
 *   +1 555-1234
 *   123 Main St
 *   Scheduled: 2026-04-10 14:00
 *   Project: Kitchen remodel
 *   (Thumbtack)
 */

export interface ParsedLead {
  name: string | null;
  phone: string | null;
  address: string | null;
  scheduledAt: Date | null;
  project: string | null;
  source: string | null;
  rawLines: string[];
}

const PHONE_RX = /(\+?\d[\d\s().-]{7,}\d)/;
const KEY_VALUE_RX = /^([A-Za-z ]+):\s*(.+)$/;
const DATE_RX = /(\d{4}[-/]\d{1,2}[-/]\d{1,2})[\sT]+(\d{1,2}:\d{2}(?:\s*[ap]m)?)/i;
const ADDRESS_RX = /^\d+\s+[A-Za-z].*/;
const NAME_RX = /^[A-Z][a-zA-Z.'-]+(\s+[A-Z][a-zA-Z.'-]+)+$/;
const STRIP_MENTION_RX = /^[~@]\s*/;

/**
 * Canonical sources + typo-tolerant variants. The parser looks for any of these
 * tokens anywhere in the message (case-insensitive, parens optional), and the
 * first match wins. Order matters slightly for disambiguation — longer names
 * come first so "facebook ads" isn't mistaken for just "facebook".
 *
 * To add a new source: add an entry to CANONICAL_SOURCES with its aliases.
 */
const CANONICAL_SOURCES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "Thumbtack", aliases: ["thumbtack", "thumbtak", "thumback", "thumb tack", "tumbtack", "tumtack"] },
  { canonical: "Angi", aliases: ["angi", "angie", "angis", "angi's", "angie's list", "angieslist", "angislist"] },
  { canonical: "Yelp", aliases: ["yelp", "yellp"] },
  { canonical: "Google", aliases: ["google", "googl", "goolge", "gogle", "google ads", "google lsa", "lsa"] },
  { canonical: "Facebook", aliases: ["facebook", "facbook", "face book", "fb", "facebook ads", "meta"] },
  { canonical: "Referral", aliases: ["referral", "referal", "referred", "reference", "indicação", "indicacao", "indicado", "word of mouth", "wom"] },
];

/**
 * Match any line/string against the canonical source list.
 * Strategy:
 *   1. Normalize: lowercase, strip punctuation/parens
 *   2. Try exact alias match (word-boundary)
 *   3. Try levenshtein-like "contains an alias" fuzzy match
 * Returns the canonical name or null.
 */
export function detectSource(text: string): string | null {
  if (!text) return null;

  // Normalize: lowercase, remove parens and punctuation except spaces,
  // collapse whitespace.
  const normalized = text
    .toLowerCase()
    .replace(/[()[\]{}<>.,;:!?*_\-+/\\'"“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;

  // Word set for fast substring checks.
  const words = new Set(normalized.split(" "));

  for (const { canonical, aliases } of CANONICAL_SOURCES) {
    for (const alias of aliases) {
      // Single-word alias: must appear as a whole word in the text.
      if (!alias.includes(" ")) {
        if (words.has(alias)) return canonical;
        // Also catch substring match for stubborn typos (min 4 chars).
        if (alias.length >= 4 && normalized.includes(alias)) return canonical;
      } else {
        // Multi-word alias: exact substring match.
        if (normalized.includes(alias)) return canonical;
      }
    }
  }
  return null;
}

/**
 * Parses the text body of a single WhatsApp message into a ParsedLead, or
 * returns null if the message doesn't look like a lead (e.g. a random comment).
 */
export function parseLead(content: string): ParsedLead | null {
  if (!content || typeof content !== "string") return null;

  const rawLines = content.split(/\r?\n/).map((l) => l.trim());
  const lines = rawLines.filter(Boolean);
  if (lines.length < 2) return null;

  const lead: ParsedLead = {
    name: null,
    phone: null,
    address: null,
    scheduledAt: null,
    project: null,
    source: null,
    rawLines: lines,
  };

  // --- SOURCE DETECTION (multi-strategy, ordered by specificity) ---
  //
  // Strategy 1: check the LAST line (most common case — "(Thumbtack)" or "ANGI")
  // Strategy 2: check the PENULTIMATE line (if last is a period, caption, etc.)
  // Strategy 3: check any line that starts with "Source:" / "source:" / "Fonte:"
  // Strategy 4: fall back to scanning the ENTIRE message as one blob
  //
  // detectSource() is typo-tolerant and handles all known aliases.
  const trySourceIn = (s: string | undefined) => {
    if (lead.source || !s) return;
    const found = detectSource(s);
    if (found) lead.source = found;
  };

  // Strategy 1 & 2: last two lines
  trySourceIn(lines[lines.length - 1]);
  trySourceIn(lines[lines.length - 2]);

  // Strategy 3: any "Source:" / "Fonte:" line
  if (!lead.source) {
    for (const line of lines) {
      const kv = line.match(KEY_VALUE_RX);
      if (kv && kv[1] && kv[2]) {
        const key = kv[1].toLowerCase().trim();
        if (
          key === "source" ||
          key === "fonte" ||
          key === "origem" ||
          key === "from" ||
          key === "platform" ||
          key === "plataforma"
        ) {
          trySourceIn(kv[2]);
          if (lead.source) break;
        }
      }
    }
  }

  // Strategy 4: whole-message fallback — catches sources buried in the middle.
  if (!lead.source) {
    trySourceIn(content);
  }

  // --- OTHER FIELD EXTRACTION ---
  for (const rawLine of lines) {
    const line = rawLine.replace(STRIP_MENTION_RX, "");

    // Key-value lines: "Scheduled: 2026-04-10 14:00", "Project: Kitchen"
    const kv = line.match(KEY_VALUE_RX);
    if (kv && kv[1] && kv[2]) {
      const key = kv[1].toLowerCase().trim();
      const value = kv[2].trim();

      if (key.startsWith("sched")) {
        const m = value.match(DATE_RX);
        if (m && m[1] && m[2]) {
          lead.scheduledAt = parseLooseDate(m[1], m[2]);
        }
        continue;
      }
      if (key.startsWith("project") || key.startsWith("progect") || key.startsWith("service")) {
        lead.project = value;
        continue;
      }
      if (key.startsWith("address") || key === "local" || key === "location") {
        lead.address = value;
        continue;
      }
      if (key.startsWith("name") || key === "nome") {
        lead.name = value;
        continue;
      }
      if (key.startsWith("phone") || key === "tel" || key === "telefone") {
        const p = value.match(PHONE_RX);
        if (p && p[1]) lead.phone = normalizePhone(p[1]);
        continue;
      }
    }

    // Loose phone match: phone on its own line.
    if (!lead.phone) {
      const phoneMatch = line.match(PHONE_RX);
      if (phoneMatch && phoneMatch[1]) {
        const stripped = line.replace(PHONE_RX, "").trim();
        if (stripped.length < 6) {
          lead.phone = normalizePhone(phoneMatch[1]);
          continue;
        }
      }
    }

    // Address heuristic — starts with digits then words, no colon.
    if (!lead.address && ADDRESS_RX.test(line) && !line.includes(":")) {
      lead.address = line;
      continue;
    }

    // Name heuristic — first title-case multi-word line that isn't anything else.
    if (!lead.name && NAME_RX.test(line)) {
      lead.name = line;
      continue;
    }
  }

  // Require at least one of: name, phone, scheduledAt. Otherwise it's probably noise.
  const hasSignal = Boolean(lead.name || lead.phone || lead.scheduledAt);
  if (!hasSignal) return null;

  return lead;
}

/**
 * Parse a "YYYY-MM-DD" + "HH:MM" pair into a Date. Returns null on failure.
 * Treats the date as local (no timezone conversion — the caller is responsible).
 */
export function parseLooseDate(dateStr: string, timeStr: string): Date | null {
  const isoLike = `${dateStr.replace(/\//g, "-")}T${normalizeTime(timeStr)}:00`;
  const d = new Date(isoLike);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeTime(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (ampmMatch && ampmMatch[1] && ampmMatch[2] && ampmMatch[3]) {
    let hour = parseInt(ampmMatch[1], 10);
    if (ampmMatch[3] === "pm" && hour < 12) hour += 12;
    if (ampmMatch[3] === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${ampmMatch[2]}`;
  }
  const plain = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (plain && plain[1] && plain[2]) {
    return `${plain[1].padStart(2, "0")}:${plain[2]}`;
  }
  return trimmed;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits;
}
