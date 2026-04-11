import type { Logger } from "pino";
import {
  type CheckNumberResponse,
  type ConnectionState,
  type ConnectionStateResponse,
  type CreateInstanceResponse,
  EvolutionApiError,
  type GroupInfo,
  type InstanceSummary,
  type QrCodeResponse,
  type SendMediaBody,
  type SendResponse,
  type SendTextBody,
} from "./types.js";

export interface EvolutionClientConfig {
  baseUrl: string; // e.g. https://evolution.example.com
  apiKey: string;
  instanceName: string;
  webhookUrl: string;
  logger: Logger;
}

/**
 * Typed wrapper around the Evolution API.
 *
 * One client per instance — `instanceName` is constructor-injected so callers don't
 * have to pass it every method call. All HTTP goes through a single `request()` so
 * errors, headers, logging, and retries live in one place.
 */
export class EvolutionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instanceName: string;
  private readonly webhookUrl: string;
  private readonly logger: Logger;

  constructor(cfg: EvolutionClientConfig) {
    // Strip trailing slash to avoid double-slash URLs.
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.instanceName = cfg.instanceName;
    this.webhookUrl = cfg.webhookUrl;
    this.logger = cfg.logger.child({ component: "evolution-client" });
  }

  // ---------- Instance lifecycle ----------

  async createInstance(): Promise<CreateInstanceResponse> {
    return this.request<CreateInstanceResponse>("POST", "/instance/create", {
      instanceName: this.instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      webhook: {
        url: this.webhookUrl,
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
      },
    });
  }

  async fetchInstances(): Promise<InstanceSummary[]> {
    const result = await this.request<unknown>("GET", "/instance/fetchInstances");
    if (Array.isArray(result)) {
      return result.map(normalizeInstanceSummary);
    }
    return [];
  }

  async getInstance(): Promise<InstanceSummary | null> {
    const all = await this.fetchInstances();
    return all.find((i) => i.name === this.instanceName) ?? null;
  }

  async getConnectionState(): Promise<ConnectionState> {
    try {
      const res = await this.request<ConnectionStateResponse>(
        "GET",
        `/instance/connectionState/${encodeURIComponent(this.instanceName)}`,
      );
      return res.instance?.state ?? "unknown";
    } catch (err) {
      if (err instanceof EvolutionApiError && err.status === 404) return "unknown";
      throw err;
    }
  }

  async connect(): Promise<QrCodeResponse> {
    return this.request<QrCodeResponse>(
      "GET",
      `/instance/connect/${encodeURIComponent(this.instanceName)}`,
    );
  }

  async logout(): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/instance/logout/${encodeURIComponent(this.instanceName)}`,
    );
  }

  async deleteInstance(): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/instance/delete/${encodeURIComponent(this.instanceName)}`,
    );
  }

  async setWebhook(): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/webhook/set/${encodeURIComponent(this.instanceName)}`,
      {
        webhook: {
          enabled: true,
          url: this.webhookUrl,
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
        },
      },
    );
  }

  /**
   * Ensures the instance exists and has the webhook configured. Safe to call
   * repeatedly — idempotent across Evolution API versions.
   */
  async ensureInstance(): Promise<ConnectionState> {
    const existing = await this.getInstance();
    if (!existing) {
      this.logger.info({ instanceName: this.instanceName }, "Creating Evolution instance");
      await this.createInstance();
    }
    // Always reassert the webhook in case it drifted.
    try {
      await this.setWebhook();
    } catch (err) {
      this.logger.warn({ err }, "setWebhook failed (non-fatal)");
    }
    return this.getConnectionState();
  }

  // ---------- Messaging ----------

  async sendText(phone: string, text: string): Promise<SendResponse> {
    const body: SendTextBody = {
      number: cleanPhone(phone),
      text,
    };
    return this.request<SendResponse>(
      "POST",
      `/message/sendText/${encodeURIComponent(this.instanceName)}`,
      body,
    );
  }

  async sendMedia(
    phone: string,
    mediaUrl: string,
    type: SendMediaBody["mediatype"],
    opts: { caption?: string; fileName?: string } = {},
  ): Promise<SendResponse> {
    const body: SendMediaBody = {
      number: cleanPhone(phone),
      mediatype: type,
      media: mediaUrl,
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.fileName ? { fileName: opts.fileName } : {}),
    };
    return this.request<SendResponse>(
      "POST",
      `/message/sendMedia/${encodeURIComponent(this.instanceName)}`,
      body,
    );
  }

  // ---------- Discovery ----------

  async getGroupInfo(groupJid: string): Promise<GroupInfo | null> {
    const jid = groupJid.endsWith("@g.us") ? groupJid : `${groupJid}@g.us`;
    try {
      const res = await this.request<GroupInfo>(
        "POST",
        `/group/findGroupInfos/${encodeURIComponent(this.instanceName)}`,
        { groupJid: jid },
      );
      if (res && typeof res === "object" && "subject" in res) return res;
    } catch (err) {
      this.logger.debug({ err, jid }, "findGroupInfos failed, trying fetchAllGroups");
    }

    try {
      const all = await this.request<GroupInfo[]>(
        "GET",
        `/group/fetchAllGroups/${encodeURIComponent(this.instanceName)}?getParticipants=false`,
      );
      if (Array.isArray(all)) {
        return all.find((g) => g.id === jid) ?? null;
      }
    } catch (err) {
      this.logger.debug({ err, jid }, "fetchAllGroups fallback failed");
    }
    return null;
  }

  async getProfilePicture(phone: string): Promise<string | null> {
    try {
      const res = await this.request<{ profilePictureUrl?: string }>(
        "POST",
        `/chat/fetchProfilePictureUrl/${encodeURIComponent(this.instanceName)}`,
        { number: cleanPhone(phone) },
      );
      return res.profilePictureUrl ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches all chats this instance knows about (Evolution's own PostgreSQL cache).
   * Uses POST now — /chat/findChats only accepts POST in recent Evolution builds.
   */
  async fetchAllChats(): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await this.request<Array<Record<string, unknown>>>(
        "POST",
        `/chat/findChats/${encodeURIComponent(this.instanceName)}`,
        { where: {} },
      );
      return Array.isArray(res) ? res : [];
    } catch (err) {
      this.logger.warn({ err }, "fetchAllChats failed");
      return [];
    }
  }

  /**
   * Fetches all groups with their subjects — this is where group display names
   * live. /chat/findChats doesn't carry the subject field.
   */
  async fetchAllGroups(): Promise<Array<{ id: string; subject: string }>> {
    try {
      const res = await this.request<Array<Record<string, unknown>>>(
        "GET",
        `/group/fetchAllGroups/${encodeURIComponent(this.instanceName)}?getParticipants=false`,
      );
      if (!Array.isArray(res)) return [];
      return res
        .filter((g): g is { id: string; subject: string } =>
          typeof g.id === "string" && typeof g.subject === "string",
        )
        .map((g) => ({ id: g.id, subject: g.subject }));
    } catch (err) {
      this.logger.warn({ err }, "fetchAllGroups failed");
      return [];
    }
  }

  /**
   * Fetches one page of messages from Evolution's database.
   * Evolution's /chat/findMessages returns { messages: { total, pages, currentPage, records } }.
   */
  async fetchMessagesPage(
    page: number,
    pageSize = 100,
  ): Promise<{
    total: number;
    pages: number;
    currentPage: number;
    records: Array<Record<string, unknown>>;
  }> {
    const body = {
      where: {},
      page,
      offset: pageSize,
    };
    const res = await this.request<{
      messages: {
        total: number;
        pages: number;
        currentPage: number;
        records: Array<Record<string, unknown>>;
      };
    }>(
      "POST",
      `/chat/findMessages/${encodeURIComponent(this.instanceName)}`,
      body,
    );
    return (
      res?.messages ?? { total: 0, pages: 0, currentPage: page, records: [] }
    );
  }

  async checkNumberExists(phone: string): Promise<boolean> {
    const cleaned = cleanPhone(phone);
    try {
      const res = await this.request<CheckNumberResponse[] | CheckNumberResponse>(
        "POST",
        `/chat/whatsappNumbers/${encodeURIComponent(this.instanceName)}`,
        { numbers: [cleaned] },
      );
      if (Array.isArray(res)) {
        return res.some((entry) => entry?.exists === true);
      }
      return res?.exists === true;
    } catch {
      return false;
    }
  }

  /**
   * Attempts to detect the connected user's JID by inspecting the instance summary.
   * Works across several Evolution API versions by checking multiple field names.
   */
  async detectOwnerJid(): Promise<string | null> {
    const summary = await this.getInstance();
    if (!summary) return null;
    const candidates = [summary.ownerJid, summary.owner, summary.number];
    for (const c of candidates) {
      if (!c || typeof c !== "string") continue;
      if (c.includes("@")) return c;
      const digits = c.replace(/\D/g, "");
      if (digits.length >= 8) return `${digits}@s.whatsapp.net`;
    }
    return null;
  }

  // ---------- private ----------

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: this.apiKey,
    };

    let attempt = 0;
    const maxRetries = method === "GET" ? 2 : 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = text.length ? JSON.parse(text) : undefined;
        } catch {
          parsed = text;
        }

        if (!res.ok) {
          const errMsg =
            typeof parsed === "object" && parsed !== null && "message" in parsed
              ? String((parsed as { message: unknown }).message)
              : `Evolution API ${res.status} on ${method} ${path}`;
          throw new EvolutionApiError(errMsg, res.status, path, parsed);
        }

        return parsed as T;
      } catch (err) {
        attempt += 1;
        if (
          err instanceof EvolutionApiError &&
          err.status < 500 // Don't retry client errors
        ) {
          throw err;
        }
        if (attempt > maxRetries) {
          if (err instanceof EvolutionApiError) throw err;
          throw new EvolutionApiError(
            err instanceof Error ? err.message : String(err),
            0,
            path,
          );
        }
        this.logger.warn({ attempt, path, err }, "Retrying Evolution API request");
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }
}

function cleanPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function normalizeInstanceSummary(raw: unknown): InstanceSummary {
  // Evolution API returns different shapes across versions — flatten both.
  const obj = (raw as Record<string, unknown>) ?? {};
  const inner = (obj.instance as Record<string, unknown> | undefined) ?? obj;
  const name =
    (inner.instanceName as string | undefined) ??
    (inner.name as string | undefined) ??
    (obj.name as string | undefined) ??
    "";
  return {
    id: inner.instanceId as string | undefined,
    name,
    connectionStatus: (inner.connectionStatus ?? inner.state) as
      | InstanceSummary["connectionStatus"],
    ownerJid: (inner.ownerJid ?? inner.owner) as string | undefined,
    owner: inner.owner as string | undefined,
    number: inner.number as string | undefined,
    profileName: inner.profileName as string | undefined,
    profilePicUrl: inner.profilePicUrl as string | undefined,
  };
}
