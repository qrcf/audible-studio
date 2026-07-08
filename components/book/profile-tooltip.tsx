import type { CharacterProfile } from "@/lib/db/schema";

/**
 * Vertically-stacked character profile for a tooltip: the personality sketch
 * as a lead line, then one dimmed-labelled attribute per line. Wrapped in a
 * single flex-col so it stacks cleanly inside TooltipContent (whose base is a
 * horizontal inline-flex meant for label+shortcut).
 */
export function ProfileTooltipBody({ profile }: { profile: CharacterProfile }) {
  const rows: [string, string | undefined][] = [
    ["Speech", profile.speechStyle],
    ["Heritage", profile.heritage],
    ["Accent", profile.accentHint],
    ["Voice", profile.voiceTexture],
  ];
  const shown = rows.filter(([, v]) => v && v.trim());
  return (
    <div className="flex flex-col gap-1 text-left">
      {profile.personality && <p className="leading-snug">{profile.personality}</p>}
      {shown.map(([label, value]) => (
        <p key={label} className="leading-snug">
          <span className="font-medium opacity-60">{label}: </span>
          {value}
        </p>
      ))}
    </div>
  );
}
