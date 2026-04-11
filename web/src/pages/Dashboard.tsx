import { useEffect, useState } from "react";
import {
  useCommandLogs,
  useConnectInstance,
  useDisconnectInstance,
  useInstanceStatus,
  useReminders,
} from "../api/hooks";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { QrCode } from "../components/QrCode";

export function Dashboard() {
  const [showQr, setShowQr] = useState(false);
  const status = useInstanceStatus(showQr ? 3000 : 15000);
  const connect = useConnectInstance();
  const disconnect = useDisconnectInstance();
  const logs = useCommandLogs();
  const reminders = useReminders();

  // Stop polling once connected.
  useEffect(() => {
    if (status.data?.state === "CONNECTED" && showQr) {
      setShowQr(false);
    }
  }, [status.data?.state, showQr]);

  const handleConnect = async () => {
    setShowQr(true);
    await connect.mutateAsync();
  };

  const handleDisconnect = async () => {
    if (!confirm("Desconectar o WhatsApp?")) return;
    await disconnect.mutateAsync();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-slate-500">
          Status da conexão e atividade recente.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Status card */}
        <div className="card lg:col-span-2">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-600">WhatsApp</h3>
              <div className="mt-2 flex items-center gap-3">
                <ConnectionBadge state={status.data?.state ?? "DISCONNECTED"} />
                {status.data?.selfPhone && (
                  <span className="text-sm text-slate-500">
                    {status.data.selfPhone}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              {status.data?.state === "CONNECTED" ? (
                <button
                  onClick={handleDisconnect}
                  className="btn-secondary"
                  disabled={disconnect.isPending}
                >
                  Desconectar
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  className="btn-primary"
                  disabled={connect.isPending}
                >
                  {connect.isPending ? "Gerando QR…" : "Conectar WhatsApp"}
                </button>
              )}
            </div>
          </div>

          {showQr && connect.data && status.data?.state !== "CONNECTED" && (
            <div className="mt-6 flex flex-col items-center gap-3 border-t border-slate-200 pt-6">
              <QrCode
                base64={connect.data.base64}
                pairingCode={connect.data.pairingCode}
              />
              <p className="max-w-sm text-center text-sm text-slate-500">
                Abra o WhatsApp no celular → Aparelhos conectados → Conectar um
                aparelho → aponte a câmera para o QR Code acima.
              </p>
            </div>
          )}

          {connect.error && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {(connect.error as Error).message}
            </div>
          )}
        </div>

        {/* Stats card */}
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-600">Resumo</h3>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Lembretes ativos</dt>
              <dd className="font-semibold">
                {reminders.data?.items.length ?? 0}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Comandos (últimos)</dt>
              <dd className="font-semibold">
                {logs.data?.items.length ?? 0}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Recent commands */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-600">Últimos comandos</h3>
        </div>
        {!logs.data || logs.data.items.length === 0 ? (
          <div className="text-sm text-slate-500">Nenhum comando executado ainda.</div>
        ) : (
          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Comando</th>
                  <th>Status</th>
                  <th>Duração</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.items.slice(0, 10).map((log) => (
                  <tr key={log.id}>
                    <td className="text-slate-500">
                      {new Date(log.executedAt).toLocaleString()}
                    </td>
                    <td>
                      <code className="font-mono">/{log.command}</code>
                    </td>
                    <td>
                      <StatusPill status={log.status} />
                    </td>
                    <td className="text-slate-500">
                      {log.durationMs != null ? `${log.durationMs}ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
