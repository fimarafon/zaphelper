import { useState } from "react";
import {
  useAutomationPrimitives,
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useGroups,
  useRunAutomationNow,
  useToggleAutomation,
  type Automation,
  type CreateAutomationBody,
} from "../api/hooks";

interface FormState {
  name: string;
  chatId: string;
  triggerType: string;
  // trigger filters (shown per trigger type)
  emoji: string;
  reactorPhone: string;
  source: string;
  fromPhone: string;
  // wait + conditions + action
  delayMinutes: string;
  conditionsJson: string;
  actionType: string;
  actionPayloadJson: string;
}

// Default = the user's "2 minutes, nobody reacted" example, ready to tweak.
const DEFAULT_FORM: FormState = {
  name: "",
  chatId: "",
  triggerType: "lead_posted",
  emoji: "",
  reactorPhone: "",
  source: "",
  fromPhone: "",
  delayMinutes: "2",
  conditionsJson: JSON.stringify([{ type: "no_reaction" }], null, 2),
  actionType: "sendText",
  actionPayloadJson: JSON.stringify({ to: "group", text: "2 min. Please call the lead!" }, null, 2),
};

const isReactionTrigger = (t: string) => t === "reaction_added" || t === "reaction_removed";

export function Automacoes() {
  const automations = useAutomations();
  const primitives = useAutomationPrimitives();
  const groups = useGroups();
  const createAutomation = useCreateAutomation();
  const toggle = useToggleAutomation();
  const runNow = useRunAutomationNow();
  const del = useDeleteAutomation();

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const groupName = (chatId: string | null) =>
    chatId ? groups.data?.groups.find((g) => g.chatId === chatId)?.subject ?? chatId : "Qualquer grupo";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const actionPayload = JSON.parse(form.actionPayloadJson) as Record<string, unknown>;
      const conditions = JSON.parse(form.conditionsJson) as unknown[];
      if (!Array.isArray(conditions)) throw new Error("Condições devem ser uma lista JSON (ex.: [])");

      const triggerConfig: Record<string, unknown> = {};
      if (isReactionTrigger(form.triggerType)) {
        if (form.emoji.trim()) triggerConfig.emoji = form.emoji.trim();
        if (form.reactorPhone.trim()) triggerConfig.reactorPhone = form.reactorPhone.replace(/\D/g, "");
      } else if (form.triggerType === "lead_posted") {
        const sources = form.source.split(",").map((s) => s.trim()).filter(Boolean);
        if (sources.length) triggerConfig.source = sources;
      } else if (form.triggerType === "message_posted") {
        if (form.fromPhone.trim()) triggerConfig.fromPhone = form.fromPhone.replace(/\D/g, "");
      }

      const delayMin = Number(form.delayMinutes) || 0;
      const body: CreateAutomationBody = {
        name: form.name,
        chatId: form.chatId || null,
        triggerType: form.triggerType,
        triggerConfig,
        delaySeconds: Math.max(0, Math.round(delayMin * 60)),
        conditions,
        actionType: form.actionType,
        actionPayload,
      };
      await createAutomation.mutateAsync(body);
      setForm(DEFAULT_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const handleActionTypeChange = (type: string) => {
    setForm((f) => ({
      ...f,
      actionType: type,
      actionPayloadJson: JSON.stringify(payloadTemplateFor(type), null, 2),
    }));
  };

  const groupChats = groups.data?.groups ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Automações</h2>
          <p className="text-sm text-slate-500">
            Monte do seu jeito: <b>grupo → gatilho → (espera) → condições → ação</b>. Ex.: lead chega →
            espera 2 min → se ninguém reagiu → cobra no grupo.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancelar" : "+ Nova automação"}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label">Nome</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ex.: Cobrar lead não atendido em 2 min"
                  required
                />
              </div>
              <div>
                <label className="label">Grupo</label>
                <select
                  className="input"
                  value={form.chatId}
                  onChange={(e) => setForm({ ...form, chatId: e.target.value })}
                >
                  <option value="">Qualquer grupo</option>
                  {groupChats.map((g) => (
                    <option key={g.chatId} value={g.chatId}>
                      {g.subject}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* GATILHO */}
            <div className="rounded-md border border-slate-200 p-3">
              <label className="label">1. Gatilho — o que dispara</label>
              <select
                className="input"
                value={form.triggerType}
                onChange={(e) => setForm({ ...form, triggerType: e.target.value })}
              >
                {primitives.data?.triggers.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.description}
                  </option>
                ))}
              </select>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {isReactionTrigger(form.triggerType) && (
                  <>
                    <div>
                      <label className="label">Emoji (vazio = qualquer)</label>
                      <input
                        className="input"
                        value={form.emoji}
                        onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                        placeholder="❌"
                      />
                    </div>
                    <div>
                      <label className="label">Telefone de quem reagiu (opcional)</label>
                      <input
                        className="input"
                        value={form.reactorPhone}
                        onChange={(e) => setForm({ ...form, reactorPhone: e.target.value })}
                        placeholder="vazio = qualquer pessoa"
                      />
                    </div>
                  </>
                )}
                {form.triggerType === "lead_posted" && (
                  <div className="md:col-span-2">
                    <label className="label">Fonte do lead (opcional, separe por vírgula)</label>
                    <input
                      className="input"
                      value={form.source}
                      onChange={(e) => setForm({ ...form, source: e.target.value })}
                      placeholder="ex.: Google, Facebook (vazio = qualquer fonte)"
                    />
                  </div>
                )}
                {form.triggerType === "message_posted" && (
                  <div className="md:col-span-2">
                    <label className="label">Telefone de quem postou (opcional)</label>
                    <input
                      className="input"
                      value={form.fromPhone}
                      onChange={(e) => setForm({ ...form, fromPhone: e.target.value })}
                      placeholder="vazio = qualquer pessoa"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* ESPERA */}
            <div>
              <label className="label">2. Espera antes de checar (minutos)</label>
              <input
                className="input w-40"
                type="number"
                min={0}
                step={1}
                value={form.delayMinutes}
                onChange={(e) => setForm({ ...form, delayMinutes: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500">0 = na hora. Ex.: 2 = espera 2 min e então checa as condições.</p>
            </div>

            {/* CONDIÇÕES */}
            <div>
              <label className="label">3. Condições (JSON — todas precisam passar)</label>
              <textarea
                className="input font-mono text-xs"
                rows={4}
                value={form.conditionsJson}
                onChange={(e) => setForm({ ...form, conditionsJson: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500">
                <code className="font-mono">[]</code> = sem condição.{" "}
                <code className="font-mono">{'[{"type":"no_reaction"}]'}</code> = ninguém reagiu.{" "}
                <code className="font-mono">{'[{"type":"no_reaction","emoji":"👍"}]'}</code> = ninguém reagiu com 👍.{" "}
                <code className="font-mono">{'[{"type":"source_is","sources":["Google","Facebook"]}]'}</code>.
                {primitives.data?.conditions?.length
                  ? ` Tipos: ${primitives.data.conditions.map((c) => c.type).join(", ")}.`
                  : ""}
              </p>
            </div>

            {/* AÇÃO */}
            <div className="rounded-md border border-slate-200 p-3">
              <label className="label">4. Ação</label>
              <select
                className="input"
                value={form.actionType}
                onChange={(e) => handleActionTypeChange(e.target.value)}
              >
                {primitives.data?.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.type} — {a.description}
                  </option>
                ))}
              </select>
              <textarea
                className="input mt-3 font-mono text-xs"
                rows={5}
                value={form.actionPayloadJson}
                onChange={(e) => setForm({ ...form, actionPayloadJson: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500">
                <code className="font-mono">to</code>: <code className="font-mono">"group"</code> (manda no grupo do gatilho),{" "}
                <code className="font-mono">"self"</code>, ou um número. Variáveis no texto:{" "}
                <code className="font-mono">{"{{emoji}} {{reactorName}} {{leadSender}} {{leadContent}} {{chatName}}"}</code>.
              </p>
            </div>

            {formError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{formError}</div>
            )}

            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={createAutomation.isPending}>
                {createAutomation.isPending ? "Criando…" : "Criar automação"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setForm(DEFAULT_FORM);
                  setShowForm(false);
                }}
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card p-0">
        <table className="table">
          <thead>
            <tr>
              <th className="w-12">On</th>
              <th>Nome</th>
              <th>Quando</th>
              <th>Ação</th>
              <th>Última execução</th>
              <th className="text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {automations.isLoading && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">Carregando…</td>
              </tr>
            )}
            {automations.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">
                  Nenhuma automação ainda. Clique em <b>+ Nova automação</b>.
                </td>
              </tr>
            )}
            {automations.data?.items.map((a) => (
              <AutomationRow
                key={a.id}
                automation={a}
                groupLabel={groupName(a.chatId)}
                onToggle={(enabled) => toggle.mutate({ id: a.id, enabled })}
                onRun={() => runNow.mutate(a.id)}
                onDelete={() => {
                  if (confirm(`Excluir a automação "${a.name}"?`)) del.mutate(a.id);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AutomationRow({
  automation,
  groupLabel,
  onToggle,
  onRun,
  onDelete,
}: {
  automation: Automation;
  groupLabel: string;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const cfg = automation.triggerConfig as Record<string, unknown>;
  const filterBits: string[] = [];
  if (typeof cfg.emoji === "string" && cfg.emoji) filterBits.push(cfg.emoji);
  if (Array.isArray(cfg.source) && cfg.source.length) filterBits.push(String(cfg.source.join("/")));
  if (typeof cfg.reactorPhone === "string" && cfg.reactorPhone) filterBits.push(`de ${cfg.reactorPhone}`);
  if (typeof cfg.fromPhone === "string" && cfg.fromPhone) filterBits.push(`de ${cfg.fromPhone}`);

  return (
    <tr>
      <td>
        <input type="checkbox" checked={automation.enabled} onChange={(e) => onToggle(e.target.checked)} />
      </td>
      <td>
        <div className="font-medium">{automation.name}</div>
        {automation.lastError && (
          <div className="mt-1 text-xs text-red-600">⚠️ {automation.lastError}</div>
        )}
      </td>
      <td className="text-xs text-slate-600">
        <div className="font-medium text-slate-700">{automation.triggerType}</div>
        <div className="text-slate-400">
          {groupLabel}
          {filterBits.length ? ` · ${filterBits.join(" ")}` : ""}
          {automation.delaySeconds > 0 ? ` · espera ${Math.round(automation.delaySeconds / 60)}min` : ""}
          {Array.isArray(automation.conditions) && automation.conditions.length > 0
            ? ` · ${automation.conditions.length} condição(ões)`
            : ""}
        </div>
      </td>
      <td>
        <span className="badge bg-sky-50 text-sky-700">{automation.actionType}</span>
      </td>
      <td className="whitespace-nowrap text-xs text-slate-500">
        {automation.lastFiredAt ? (
          <>
            {new Date(automation.lastFiredAt).toLocaleString()}
            <br />
            <span className="text-slate-400">
              ({automation.runCount} exec., {automation.failureCount} falhas)
            </span>
          </>
        ) : (
          "nunca"
        )}
      </td>
      <td className="text-right">
        <div className="flex justify-end gap-1">
          <button className="btn-secondary text-xs" onClick={onRun} title="Testar agora">
            ▶ Testar
          </button>
          <button className="btn-danger text-xs" onClick={onDelete}>
            Excluir
          </button>
        </div>
      </td>
    </tr>
  );
}

function payloadTemplateFor(actionType: string): Record<string, unknown> {
  switch (actionType) {
    case "sendText":
      return { to: "group", text: "2 min. Please call the lead!" };
    case "runCommand":
      return { command: "/statustoday", deliverToSelf: true };
    case "webhook":
      return {
        url: "https://n8n.example.com/webhook/lead",
        method: "POST",
        body: { emoji: "{{emoji}}", reactor: "{{reactorName}}", lead: "{{leadSender}}" },
        deliverResponse: false,
      };
    case "sendVoice":
      return { to: "self", text: "Lead de {{leadSender}} sem retorno", voiceId: "21m00Tcm4TlvDq8ikWAM" };
    default:
      return {};
  }
}
