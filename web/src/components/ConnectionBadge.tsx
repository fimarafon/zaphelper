import clsx from "clsx";

interface Props {
  state: "CONNECTED" | "CONNECTING" | "DISCONNECTED" | "ERROR";
}

const CONFIG: Record<Props["state"], { label: string; classes: string; dot: string }> = {
  CONNECTED: {
    label: "Conectado",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  CONNECTING: {
    label: "Conectando",
    classes: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500 animate-pulse",
  },
  DISCONNECTED: {
    label: "Desconectado",
    classes: "bg-slate-50 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
  ERROR: {
    label: "Erro",
    classes: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};

export function ConnectionBadge({ state }: Props) {
  const cfg = CONFIG[state];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium",
        cfg.classes,
      )}
    >
      <span className={clsx("h-2 w-2 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}
