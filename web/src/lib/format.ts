/**
 * Format an ISO date string as "YYYY-MM-DD HH:MM" in the browser's timezone.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Shorter relative formatter — "agora", "5min atrás", "2h atrás", "3d atrás",
 * else falls back to formatDateTime.
 */
export function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 30) return "agora";
  if (diffSec < 60) return `${diffSec}s atrás`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min atrás`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h atrás`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d atrás`;
  return formatDateTime(iso);
}
