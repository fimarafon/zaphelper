// Types for Evolution API responses and internal models.

export type ConnectionState = "open" | "close" | "connecting" | "refused" | "unknown";

export interface InstanceSummary {
  id?: string;
  name: string;
  connectionStatus?: ConnectionState;
  ownerJid?: string;
  owner?: string;
  number?: string;
  profileName?: string;
  profilePicUrl?: string;
}

export interface CreateInstanceResponse {
  instance: {
    instanceName: string;
    instanceId?: string;
    status?: string;
    state?: ConnectionState;
  };
  hash?: { apikey?: string } | string;
  qrcode?: {
    code?: string;
    base64?: string;
  };
}

export interface ConnectionStateResponse {
  instance: {
    instanceName: string;
    state: ConnectionState;
  };
}

export interface QrCodeResponse {
  base64?: string;
  code?: string;
  pairingCode?: string | null;
  count?: number;
}

export interface SendTextBody {
  number: string;
  text: string;
  delay?: number;
  linkPreview?: boolean;
}

export interface SendMediaBody {
  number: string;
  mediatype: "image" | "video" | "audio" | "document";
  media: string;
  caption?: string;
  fileName?: string;
  mimetype?: string;
}

export interface SendResponse {
  key?: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message?: unknown;
  messageTimestamp?: number | string;
  status?: string;
}

export interface GroupInfo {
  id: string;
  subject: string;
  subjectOwner?: string;
  subjectTime?: number;
  owner?: string;
  desc?: string;
  descId?: string;
  size?: number;
  creation?: number;
  participants?: Array<{ id: string; admin?: string | null }>;
}

export interface CheckNumberResponse {
  exists: boolean;
  jid: string;
  number: string;
}

export class EvolutionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "EvolutionApiError";
  }
}
