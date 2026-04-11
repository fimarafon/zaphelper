import clsx from "clsx";
import { useState } from "react";
import { api } from "../api/client";
import { useCommandLogs, useCommandRegistry } from "../api/hooks";

export function Commands() {
  const logs = useCommandLogs();
  const registry = useCommandRegistry();

  const [input, setInput] = useState("/statustoday");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    reply: string;
    error?: string;
  } | null>(null);

  const handleRun = async () => {
    if (!input.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post<{
        success: boolean;
        reply: string;
        error?: string;
      }>("/api/commands/run", { input });
      setResult(res);
      logs.refetch();
    } catch (err) {
      setResult({
        success: false,
        reply: (err as Error).message,
        error: "request_failed",
      });
    } finally {
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !running) {
      handleRun();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Comandos</h2>
        <p className="text-sm text-slate-500">
          Teste comandos direto no painel ou via WhatsApp no seu self-chat.
        </p>
      </div>

      {/* Test runner */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-600">
            🧪 Testar comando
          </h3>
          <span className="text-xs text-slate-400">
            Roda inline, sem precisar de WhatsApp conectado
          </span>
        </div>
        <div className="flex gap-2">
          <input
            className="input flex-1 font-mono"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="/statustoday"
          />
          <button
            onClick={handleRun}
            disabled={running || !input.trim()}
            className="btn-primary whitespace-nowrap"
          >
            {running ? "Executando…" : "▶ Executar"}
          </button>
        </div>
        {result && (
          <div
            className={clsx(
              "mt-3 rounded-md border p-3 text-sm",
              result.success
                ? "border-emerald-200 bg-emerald-50"
                : "border-red-200 bg-red-50",
            )}
          >
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
              <span
                className={
                  result.success ? "text-emerald-700" : "text-red-700"
                }
              >
                {result.success ? "✓ Sucesso" : "✗ Falha"}
              </span>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-800">
              {result.reply}
            </pre>
          </div>
        )}
      </div>

      {/* Available commands */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-600">
          Disponíveis
        </h3>
        <div className="grid gap-3 md:grid-cols-2">
          {registry.data?.commands.map((cmd) => (
            <div
              key={cmd.name}
              className="cursor-pointer rounded-md border border-slate-200 p-3 transition-colors hover:border-brand-300 hover:bg-brand-50/30"
              onClick={() => setInput(`/${cmd.name}`)}
            >
              <div className="flex items-baseline justify-between">
                <code className="font-mono text-sm font-semibold text-brand-700">
                  /{cmd.name}
                </code>
                {cmd.aliases.length > 0 && (
                  <span className="text-xs text-slate-400">
                    aliases: {cmd.aliases.map((a) => `/${a}`).join(", ")}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-600">{cmd.description}</p>
              {cmd.usage && (
                <code className="mt-1 block text-xs text-slate-500">
                  {cmd.usage}
                </code>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Execution history */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-slate-600">Histórico</h3>
        <div className="overflow-hidden rounded-md border border-slate-200">
          <table className="table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Comando</th>
                <th>Input</th>
                <th>Status</th>
                <th>Duração</th>
              </tr>
            </thead>
            <tbody>
              {logs.data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">
                    Nenhum comando executado.
                  </td>
                </tr>
              )}
              {logs.data?.items.map((log) => (
                <tr key={log.id}>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    {new Date(log.executedAt).toLocaleString()}
                  </td>
                  <td>
                    <code className="font-mono">/{log.command}</code>
                  </td>
                  <td className="text-xs text-slate-500">{log.args || "—"}</td>
                  <td>
                    <StatusPill status={log.status} />
                  </td>
                  <td className="text-xs text-slate-500">
                    {log.durationMs != null ? `${log.durationMs}ms` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const classes =
    status === "SUCCESS"
      ? "bg-emerald-50 text-emerald-700"
      : status === "FAILURE"
        ? "bg-red-50 text-red-700"
        : "bg-slate-100 text-slate-600";
  return <span className={`badge ${classes}`}>{status}</span>;
}
