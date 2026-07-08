export function estimateCredits(chars: number, model: string): number {
  return Math.ceil(chars * (model === "eleven_flash_v2_5" ? 0.5 : 1));
}

/** Sound generation bills ~11 credits per second at explicit duration. */
export function estimateSfxCredits(seconds: number): number {
  return Math.ceil(seconds * 11);
}

export function formatCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
