import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { EvolutionClient } from "../evolution/client.js";
import { cleanPhone } from "../utils/phone.js";

const CONFIG_KEY = "self_jid";

/**
 * Resolves and caches the user's own WhatsApp JID so we can detect self-chat
 * messages. Priority:
 *   1. Cached value in Config table
 *   2. Env SELF_PHONE_NUMBER (if provided)
 *   3. Evolution API /instance/fetchInstances owner field
 */
export class SelfIdentity {
  private jid: string | null = null;
  private phone: string | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly evolution: EvolutionClient,
    private readonly envPhone: string | undefined,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    // 1. Load from DB.
    const row = await this.prisma.config.findUnique({ where: { key: CONFIG_KEY } });
    if (row?.value) {
      this.setJid(row.value);
      this.logger.info({ jid: this.jid }, "Self JID loaded from Config");
      return;
    }

    // 2. Env override.
    if (this.envPhone) {
      const jid = `${cleanPhone(this.envPhone)}@s.whatsapp.net`;
      await this.persist(jid);
      this.logger.info({ jid }, "Self JID from SELF_PHONE_NUMBER env");
      return;
    }

    // 3. Try Evolution.
    await this.refreshFromEvolution();
  }

  async refreshFromEvolution(): Promise<string | null> {
    try {
      const detected = await this.evolution.detectOwnerJid();
      if (detected) {
        await this.persist(detected);
        this.logger.info({ jid: detected }, "Self JID detected from Evolution");
        return detected;
      }
    } catch (err) {
      this.logger.warn({ err }, "detectOwnerJid failed");
    }
    return null;
  }

  getJid(): string | null {
    return this.jid;
  }

  getPhone(): string | null {
    return this.phone;
  }

  isKnown(): boolean {
    return this.jid !== null;
  }

  private async persist(jid: string): Promise<void> {
    this.setJid(jid);
    await this.prisma.config.upsert({
      where: { key: CONFIG_KEY },
      create: { key: CONFIG_KEY, value: jid },
      update: { value: jid },
    });
  }

  private setJid(jid: string): void {
    this.jid = jid;
    const at = jid.indexOf("@");
    this.phone = at === -1 ? cleanPhone(jid) : cleanPhone(jid.slice(0, at));
  }
}
