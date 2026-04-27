import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { EvolutionClient } from "../evolution/client.js";
import { cleanPhone } from "../utils/phone.js";

const CONFIG_KEY = "self_jid";
// Evolution v2.2.3+ / Baileys with the new privacy protocol delivers self-chat
// messages with a LID-style chatId (e.g. "90306099822759") rather than the
// user's phone number JID. Without tracking this, isSelfChat is always false
// and self-commands like /statustoday never fire.
const CONFIG_KEY_LID = "self_lid";

/**
 * Resolves and caches the user's own WhatsApp identifiers so we can detect
 * self-chat messages. Stores TWO things:
 *   - jid:   "<phone>@s.whatsapp.net"  (legacy / phone-based)
 *   - lid:   "<lid>" or "<lid>@lid"    (new privacy protocol — used for self-chat)
 *
 * isSelfChatJid() returns true if a remoteJid matches EITHER identifier.
 *
 * Priority for jid:
 *   1. Cached value in Config table
 *   2. Env SELF_PHONE_NUMBER (if provided)
 *   3. Evolution API /instance/fetchInstances owner field
 *
 * lid is set either:
 *   - manually (admin endpoint) when we know it
 *   - automatically: first time we see a fromMe=true && !isGroup message whose
 *     chatId is NOT our phoneJid, we capture the chatId as our LID.
 */
export class SelfIdentity {
  private jid: string | null = null;
  private phone: string | null = null;
  private lid: string | null = null;

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
    }

    const lidRow = await this.prisma.config.findUnique({
      where: { key: CONFIG_KEY_LID },
    });
    if (lidRow?.value) {
      this.lid = lidRow.value;
      this.logger.info({ lid: this.lid }, "Self LID loaded from Config");
    }

    if (this.jid) return;

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

  getLid(): string | null {
    return this.lid;
  }

  isKnown(): boolean {
    return this.jid !== null;
  }

  /**
   * Decide if a remoteJid (or chatId without the @suffix) is our own chat.
   * Matches against both the phone JID and the LID.
   */
  isSelfChatJid(remoteJid: string | null | undefined): boolean {
    if (!remoteJid) return false;
    if (this.jid && remoteJid === this.jid) return true;
    // LID may be stored bare ("90306099822759") or fully-qualified ("90306099822759@lid").
    // Match against both forms of remoteJid → bare/qualified equivalence.
    if (this.lid) {
      const bareRemote = remoteJid.replace(/@.*$/, "");
      const bareLid = this.lid.replace(/@.*$/, "");
      if (bareRemote === bareLid) return true;
    }
    return false;
  }

  /**
   * Persist the user's LID (Local Identifier). Called either manually via the
   * admin API or auto-detected during message ingest.
   */
  async setSelfLid(lid: string): Promise<void> {
    const bare = lid.replace(/@.*$/, "");
    this.lid = bare;
    await this.prisma.config.upsert({
      where: { key: CONFIG_KEY_LID },
      create: { key: CONFIG_KEY_LID, value: bare },
      update: { value: bare },
    });
    this.logger.info({ lid: bare }, "Self LID set");
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
