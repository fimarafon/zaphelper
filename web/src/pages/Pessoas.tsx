import { useEffect, useState } from "react";
import {
  useGroupParticipants,
  useGroups,
  useSetNameMapping,
} from "../api/hooks";

/**
 * "Quem é quem" — read a group's participants and map phone → name. Names are
 * stored in the Config table (name:<phone>) and used everywhere we resolve a
 * sender/reactor, so automations can target people by name later.
 */
export function Pessoas() {
  const groups = useGroups();
  const [chatId, setChatId] = useState<string>("");
  const participants = useGroupParticipants(chatId || null);
  const saveNames = useSetNameMapping();

  const [edits, setEdits] = useState<Record<string, string>>({});

  // Seed the editable fields whenever a different group's participants load.
  useEffect(() => {
    if (!participants.data) return;
    const seed: Record<string, string> = {};
    for (const p of participants.data.participants) seed[p.phone] = p.name ?? "";
    setEdits(seed);
  }, [participants.data]);

  const handleSave = async () => {
    const mapping: Record<string, string> = {};
    for (const [phone, name] of Object.entries(edits)) {
      if (name.trim()) mapping[phone] = name.trim();
    }
    if (Object.keys(mapping).length === 0) {
      window.alert("Nada para salvar — preencha ao menos um nome.");
      return;
    }
    try {
      await saveNames.mutateAsync(mapping);
      await participants.refetch();
      window.alert("Nomes salvos.");
    } catch (err) {
      window.alert(`Falha: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Pessoas</h2>
        <p className="text-sm text-slate-500">
          Veja quem está no grupo e mapeie <b>quem é quem</b> (nome ↔ número). Esses nomes aparecem
          nos relatórios, nas reações e podem ser usados nas automações.
        </p>
      </div>

      <div className="card">
        <label className="label">Grupo</label>
        <select className="input md:w-1/2" value={chatId} onChange={(e) => setChatId(e.target.value)}>
          <option value="">Selecione um grupo…</option>
          {groups.data?.groups.map((g) => (
            <option key={g.chatId} value={g.chatId}>
              {g.subject}
            </option>
          ))}
        </select>
      </div>

      {chatId && (
        <div className="card p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <span className="text-sm font-medium text-slate-600">
              {participants.data?.subject ?? "Participantes"}
              {participants.data ? ` — ${participants.data.participants.length} pessoas` : ""}
            </span>
            <button className="btn-primary text-xs" onClick={handleSave} disabled={saveNames.isPending}>
              {saveNames.isPending ? "Salvando…" : "Salvar nomes"}
            </button>
          </div>
          <div className="max-h-[65vh] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Nome</th>
                  <th className="w-20">Admin</th>
                </tr>
              </thead>
              <tbody>
                {participants.isLoading && (
                  <tr>
                    <td colSpan={3} className="py-8 text-center text-slate-500">Carregando…</td>
                  </tr>
                )}
                {participants.data?.participants.map((p) => (
                  <tr key={p.phone}>
                    <td className="whitespace-nowrap font-mono text-xs text-slate-600">{p.phone}</td>
                    <td>
                      <input
                        className="input"
                        value={edits[p.phone] ?? ""}
                        placeholder="(sem nome) — digite para mapear"
                        onChange={(e) => setEdits((s) => ({ ...s, [p.phone]: e.target.value }))}
                      />
                    </td>
                    <td className="text-xs text-slate-400">{p.admin ? "✓" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
