import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- Types ----

export interface SessionUser {
  username: string;
}

export interface InstanceStatus {
  instanceName: string;
  state: "CONNECTED" | "CONNECTING" | "DISCONNECTED" | "ERROR";
  rawState: string;
  selfJid: string | null;
  selfPhone: string | null;
}

export interface QrCode {
  base64: string | null;
  pairingCode: string | null;
}

export interface MessageRow {
  id: string;
  chatId: string;
  chatName: string | null;
  senderName: string | null;
  senderPhone: string | null;
  content: string;
  messageType: string;
  isGroup: boolean;
  isFromMe: boolean;
  isSelfChat: boolean;
  timestamp: string;
}

export interface CommandLogRow {
  id: string;
  command: string;
  args: string | null;
  rawInput: string;
  output: string | null;
  status: "SUCCESS" | "FAILURE" | "NOT_FOUND";
  error: string | null;
  executedAt: string;
  durationMs: number | null;
}

export interface Reminder {
  id: string;
  scheduledAt: string;
  message: string;
  status: "PENDING" | "SENT" | "MISSED" | "CANCELLED" | "FAILED";
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface RegistryCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string | null;
}

// ---- Auth ----

export function useMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await api.get<{ user: SessionUser }>("/api/auth/me");
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { username: string; password: string }) =>
      api.post<{ ok: true; user: SessionUser }>("/api/auth/login", vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/api/auth/logout"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

// ---- Instance ----

export function useInstanceStatus(pollMs?: number) {
  return useQuery({
    queryKey: ["instance", "status"],
    queryFn: () => api.get<InstanceStatus>("/api/instance/status"),
    refetchInterval: pollMs ?? false,
  });
}

export function useConnectInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<QrCode>("/api/instance/connect"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instance", "status"] });
    },
  });
}

export function useDisconnectInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/api/instance/disconnect"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instance", "status"] });
    },
  });
}

// ---- Messages ----

export interface MessagesQuery {
  search?: string;
  chatName?: string;
  isGroup?: "true" | "false" | "";
  limit?: number;
  cursor?: string;
}

export function useMessages(params: MessagesQuery = {}) {
  return useQuery({
    queryKey: ["messages", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.search) q.set("search", params.search);
      if (params.chatName) q.set("chatName", params.chatName);
      if (params.isGroup) q.set("isGroup", params.isGroup);
      if (params.limit) q.set("limit", String(params.limit));
      if (params.cursor) q.set("cursor", params.cursor);
      return api.get<{ items: MessageRow[]; nextCursor: string | null }>(
        `/api/messages?${q.toString()}`,
      );
    },
  });
}

export function useChatList() {
  return useQuery({
    queryKey: ["messages", "chats"],
    queryFn: () =>
      api.get<{
        chats: Array<{
          chatId: string;
          chatName: string | null;
          isGroup: boolean;
          messageCount: number;
        }>;
      }>("/api/messages/chats"),
    staleTime: 60_000,
  });
}

// ---- Commands ----

export function useCommandLogs() {
  return useQuery({
    queryKey: ["commands", "logs"],
    queryFn: () =>
      api.get<{ items: CommandLogRow[]; nextCursor: string | null }>(
        "/api/commands/logs",
      ),
    refetchInterval: 10_000,
  });
}

export function useCommandRegistry() {
  return useQuery({
    queryKey: ["commands", "registry"],
    queryFn: () =>
      api.get<{ commands: RegistryCommand[] }>("/api/commands/registry"),
    staleTime: 5 * 60_000,
  });
}

// ---- Reminders ----

export function useReminders(status?: string) {
  return useQuery({
    queryKey: ["reminders", status ?? "PENDING"],
    queryFn: () =>
      api.get<{ items: Reminder[] }>(
        `/api/reminders${status ? `?status=${status}` : ""}`,
      ),
  });
}

export function useCancelReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.del<{ ok: true; reminder: Reminder }>(`/api/reminders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reminders"] });
    },
  });
}

// ---- Schedules ----

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string | null;
  fireAt: string | null;
  actionType: string;
  actionPayload: Record<string, unknown>;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionDescriptor {
  type: string;
  description: string;
}

export function useSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.get<{ items: ScheduledTask[] }>("/api/schedules"),
    refetchInterval: 30_000,
  });
}

export function useScheduleActions() {
  return useQuery({
    queryKey: ["schedules", "actions"],
    queryFn: () =>
      api.get<{ actions: ActionDescriptor[] }>("/api/schedules/actions"),
    staleTime: 5 * 60_000,
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      actionType: string;
      actionPayload: Record<string, unknown>;
      cronExpression?: string;
      fireAt?: string;
    }) => api.post<{ ok: true; task: ScheduledTask }>("/api/schedules", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useToggleSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<{ ok: true; task: ScheduledTask }>(
        `/api/schedules/${id}/toggle`,
        { enabled },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useRunScheduleNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: true }>(`/api/schedules/${id}/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/schedules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}
