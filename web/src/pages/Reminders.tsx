import { useState } from "react";
import { useCancelReminder, useReminders } from "../api/hooks";

const TABS = [
  { value: "PENDING", label: "Ativos" },
  { value: "SENT", label: "Enviados" },
  { value: "MISSED", label: "Perdidos" },
  { value: "CANCELLED", label: "Cancelados" },
  { value: "FAILED", label: "Falharam" },
] as const;

export function Reminders() {
  const [status, setStatus] = useState<(typeof TABS)[number]["value"]>("PENDING");
  const reminders = useReminders(status);
  const cancel = useCancelReminder();

  const handleCancel = async (id: string) => {
    if (!confirm("Cancelar este lembrete?")) return;
    await cancel.mutateAsync(id);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Lembretes</h2>
        <p className="text-sm text-slate-500">
          Crie lembretes enviando <code className="font-mono">/reminder</code>{" "}
          no seu chat pessoal do WhatsApp.
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setStatus(t.value)}
            className={
              "px-4 py-2 text-sm font-medium " +
              (status === t.value
                ? "border-b-2 border-brand-600 text-brand-700"
                : "text-slate-500 hover:text-slate-800")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Mensagem</th>
              <th>Criado em</th>
              <th className="w-32"></th>
            </tr>
          </thead>
          <tbody>
            {reminders.isLoading && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-500">
                  Carregando…
                </td>
              </tr>
            )}
            {reminders.data?.items.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-500">
                  Nenhum lembrete nesta categoria.
                </td>
              </tr>
            )}
            {reminders.data?.items.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap font-medium">
                  {new Date(r.scheduledAt).toLocaleString()}
                </td>
                <td className="max-w-xl whitespace-pre-wrap">{r.message}</td>
                <td className="whitespace-nowrap text-xs text-slate-500">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="text-right">
                  {status === "PENDING" && (
                    <button
                      onClick={() => handleCancel(r.id)}
                      disabled={cancel.isPending}
                      className="btn-secondary text-xs"
                    >
                      Cancelar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
