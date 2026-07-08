// Stable per-character accent colors for script views
const PALETTE = [
  "oklch(0.72 0.19 250)", // blue
  "oklch(0.72 0.19 145)", // green
  "oklch(0.75 0.18 60)", // amber
  "oklch(0.7 0.2 320)", // pink
  "oklch(0.72 0.18 200)", // cyan
  "oklch(0.7 0.2 25)", // red-orange
  "oklch(0.72 0.17 280)", // violet
  "oklch(0.75 0.16 100)", // lime
];

export function speakerColor(characterId: string | null): string {
  if (!characterId) return "oklch(0.65 0 0)"; // narrator: neutral gray
  let hash = 0;
  for (let i = 0; i < characterId.length; i++) {
    hash = (hash * 31 + characterId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
