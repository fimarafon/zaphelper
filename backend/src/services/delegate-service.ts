import type { Delegate, PrismaClient } from "@prisma/client";

/**
 * Read-only commands any delegate can use when no explicit allowedCommands
 * are set. These only produce reports — they never modify state (no
 * scheduling, no reminders, no deleting).
 */
const DEFAULT_ALLOWED_PREFIXES = [
  "status",       // statustoday, statusweek, statusmonth, status7days, statusyesterday, status <date>
  "audit",
  "help",
  "schedules",    // read-only listing
  "reminders",    // read-only listing
];

export class DelegateService {
  /** In-memory cache: phone → Delegate. Refreshed on any mutation. */
  private cache = new Map<string, Delegate>();
  private loaded = false;

  constructor(private readonly prisma: PrismaClient) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const rows = await this.prisma.delegate.findMany();
    this.cache.clear();
    for (const d of rows) {
      this.cache.set(d.phone, d);
    }
    this.loaded = true;
  }

  /**
   * Check if a phone number is a registered AND enabled delegate.
   */
  isActiveDelegate(phone: string): boolean {
    const d = this.cache.get(phone);
    return Boolean(d && d.enabled);
  }

  /**
   * Check if a delegate is allowed to run a specific command.
   * Returns false if the delegate doesn't exist, is disabled, or
   * the command is outside their allowed scope.
   */
  canRunCommand(phone: string, commandName: string): boolean {
    const d = this.cache.get(phone);
    if (!d || !d.enabled) return false;

    // Explicit allowedCommands: if set and contains "*", allow everything.
    if (d.allowedCommands.length > 0) {
      if (d.allowedCommands.includes("*")) return true;
      return d.allowedCommands.some(
        (prefix) => commandName.toLowerCase().startsWith(prefix.toLowerCase()),
      );
    }

    // Default: read-only commands only.
    return DEFAULT_ALLOWED_PREFIXES.some(
      (prefix) => commandName.toLowerCase().startsWith(prefix),
    );
  }

  getDelegate(phone: string): Delegate | null {
    return this.cache.get(phone) ?? null;
  }

  async list(): Promise<Delegate[]> {
    return this.prisma.delegate.findMany({ orderBy: { createdAt: "asc" } });
  }

  async add(phone: string, name: string): Promise<Delegate> {
    const cleaned = phone.replace(/\D/g, "");
    const d = await this.prisma.delegate.upsert({
      where: { phone: cleaned },
      create: { phone: cleaned, name: name.trim(), enabled: true },
      update: { name: name.trim(), enabled: true },
    });
    await this.refresh();
    return d;
  }

  async remove(phone: string): Promise<void> {
    const cleaned = phone.replace(/\D/g, "");
    try {
      await this.prisma.delegate.delete({ where: { phone: cleaned } });
    } catch {
      // not found — fine
    }
    await this.refresh();
  }

  async setEnabled(phone: string, enabled: boolean): Promise<Delegate | null> {
    const cleaned = phone.replace(/\D/g, "");
    try {
      const d = await this.prisma.delegate.update({
        where: { phone: cleaned },
        data: { enabled },
      });
      await this.refresh();
      return d;
    } catch {
      return null;
    }
  }
}
