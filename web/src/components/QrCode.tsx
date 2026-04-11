interface Props {
  base64: string | null;
  pairingCode?: string | null;
}

export function QrCode({ base64, pairingCode }: Props) {
  if (!base64) {
    return (
      <div className="flex h-64 w-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
        Gerando QR Code…
      </div>
    );
  }

  // Evolution returns either a full data URI or raw base64.
  const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;

  return (
    <div className="flex flex-col items-center gap-3">
      <img
        src={src}
        alt="QR Code para conectar WhatsApp"
        className="h-64 w-64 rounded-lg border border-slate-200 bg-white p-2"
      />
      {pairingCode && (
        <div className="text-center text-sm text-slate-500">
          Ou use o código: <code className="font-mono text-slate-800">{pairingCode}</code>
        </div>
      )}
    </div>
  );
}
