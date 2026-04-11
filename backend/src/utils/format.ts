import type { ParsedLead } from "../services/lead-parser.js";

export interface LeadGroup {
  label: string;                         // "Today" or "This week"
  rangeStart: Date;
  rangeEnd: Date;
  total: number;
  byPerson: Array<{ name: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  skipped: number;                       // messages we couldn't parse as leads
}

/**
 * Formats a lead group summary as a WhatsApp-friendly multi-line string.
 * Example output:
 *
 *   📊 Scheduled Leads — Today (04/10):
 *   Total: 15 leads
 *
 *   By person:
 *   • Laura — 10
 *   • Linda — 4
 *   • Alex — 1
 *
 *   By source:
 *   • Thumbtack — 6
 *   • Google — 5
 *   • Angi — 4
 */
export function formatStatusReply(group: LeadGroup, shortDate: string): string {
  const header = `📊 Scheduled Leads — ${group.label} (${shortDate}):`;

  if (group.total === 0) {
    return `${header}\nNo leads found in this period.`;
  }

  const lines: string[] = [header, `Total: ${group.total} leads`, ""];

  lines.push("*By person:*");
  for (const p of group.byPerson) {
    lines.push(`• ${p.name} — ${p.count}`);
  }

  lines.push("");
  lines.push("*By source:*");
  for (const s of group.bySource) {
    lines.push(`• ${s.source} — ${s.count}`);
  }

  if (group.skipped > 0) {
    lines.push("");
    lines.push(`_${group.skipped} message(s) could not be parsed as leads._`);
  }

  return lines.join("\n");
}

/**
 * Given a list of parsed leads and the name of whoever posted each one,
 * build the byPerson and bySource aggregations.
 */
export function aggregateLeads(
  leads: Array<{ poster: string; parsed: ParsedLead }>,
): { byPerson: LeadGroup["byPerson"]; bySource: LeadGroup["bySource"] } {
  const personCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  for (const { poster, parsed } of leads) {
    const personKey = normalizePersonKey(poster);
    personCounts.set(personKey, (personCounts.get(personKey) ?? 0) + 1);
    const source = parsed.source ?? "Unknown";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  const byPerson = [...personCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const bySource = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  return { byPerson, bySource };
}

function normalizePersonKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown";
  // Remove leading WhatsApp-style prefix "~ " or "@".
  return trimmed.replace(/^[~@]\s*/, "");
}
