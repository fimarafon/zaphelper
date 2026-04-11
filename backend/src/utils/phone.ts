/**
 * Normalize a phone or JID to digits only (e.g. "15551234567").
 */
export function cleanPhone(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * Extract the phone / group ID from a WhatsApp JID.
 *
 * Examples:
 *   "15551234567@s.whatsapp.net" -> "15551234567"
 *   "15551234567-1234567890@g.us" -> "15551234567-1234567890"
 *   "15551234567"                  -> "15551234567"
 */
export function jidToChatId(jid: string): string {
  const at = jid.indexOf("@");
  return at === -1 ? jid : jid.slice(0, at);
}

/**
 * Format a phone number for display, falling back to the raw digits if it
 * doesn't match the expected US-style pattern.
 */
export function formatPhoneForDisplay(phone: string): string {
  const d = cleanPhone(phone);
  if (d.length === 11 && d.startsWith("1")) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return phone;
}

/**
 * Determine if a WhatsApp JID points at a group.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/**
 * Convert a phone number (any format) to its JID form. Assumes US country code
 * if none is provided.
 */
export function phoneToJid(phone: string): string {
  const digits = cleanPhone(phone);
  return `${digits}@s.whatsapp.net`;
}
