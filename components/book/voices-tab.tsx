"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { VoiceSettings } from "@/lib/db/schema";
import { PreviewButton, fetchPreviewUrl } from "./preview-button";
import { useReadOnly } from "./read-only";
import type { CharacterData, VoiceData } from "./types";
import { ProfileTooltipBody } from "./profile-tooltip";
import { VoiceCombobox } from "./voice-combobox";

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; voices: VoiceData[] };

const NO_VOICES: VoiceData[] = [];

export function VoicesTab({
  characters,
  elevenReady,
  onRecast,
  casting,
  castRunning,
}: {
  characters: CharacterData[];
  elevenReady: boolean;
  onRecast: () => void;
  casting: boolean;
  castRunning: boolean;
}) {
  const router = useRouter();
  const readOnly = useReadOnly();
  const [saving, setSaving] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ key: number; state: CatalogState } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The catalog is fetched on demand (not serialized into the page) so book
  // pages render without waiting on ElevenLabs; the server layers memory + DB
  // snapshot caches, so this is instant after the first load. "loading" is
  // derived (no result for the current reloadKey yet) rather than set in the
  // effect.
  useEffect(() => {
    if (!elevenReady) return;
    let cancelled = false;
    fetch("/api/voices")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load voices");
        if (!cancelled) setLoaded({ key: reloadKey, state: { status: "ready", voices: data } });
      })
      .catch((err) => {
        if (!cancelled) {
          setLoaded({
            key: reloadKey,
            state: {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to load voices",
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [elevenReady, reloadKey]);

  const catalog: CatalogState =
    loaded && loaded.key === reloadKey ? loaded.state : { status: "loading" };
  const voices = catalog.status === "ready" ? catalog.voices : NO_VOICES;

  // Cast picks can come from the full live library, outside the cached browse
  // list — so fold every character's assigned voice into the picker list (cast
  // voices first) and always show them, with catalog metadata when available.
  const allVoices = useMemo<VoiceData[]>(() => {
    const byId = new Map(voices.map((v) => [v.id, v] as const));
    const castFirst: VoiceData[] = [];
    const seen = new Set<string>();
    for (const c of characters) {
      const a = c.assignment;
      if (!a || seen.has(a.voiceId)) continue;
      seen.add(a.voiceId);
      castFirst.push(
        byId.get(a.voiceId) ?? {
          id: a.voiceId,
          name: a.voiceName,
          category: "cast",
          description: null,
          gender: null,
          age: null,
          accent: null,
          descriptive: null,
          useCase: null,
          previewUrl: null,
        }
      );
    }
    return [...castFirst, ...voices.filter((v) => !seen.has(v.id))];
  }, [voices, characters]);

  if (!elevenReady) {
    return (
      <Alert variant="destructive">
        <AlertTitle>ElevenLabs key missing</AlertTitle>
        <AlertDescription>
          Add ELEVENLABS_API_KEY to .env.local to load voices and generate audio.
        </AlertDescription>
      </Alert>
    );
  }
  if (characters.length === 0) {
    return (
      <Alert>
        <AlertTitle>No cast yet</AlertTitle>
        <AlertDescription>
          Run character analysis first — then voices can be auto-assigned here.
        </AlertDescription>
      </Alert>
    );
  }
  if (catalog.status === "loading") {
    return (
      <div className="space-y-3">
        {Array.from({ length: Math.min(characters.length + 1, 6) }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (catalog.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the voice catalog</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          {catalog.message}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  async function changeVoice(characterId: string, voiceId: string) {
    setSaving(characterId);
    try {
      const res = await fetch(`/api/characters/${characterId}/voice`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        data.staleChapters > 0
          ? `Voice changed — ${data.staleChapters} generated chapter${data.staleChapters > 1 ? "s" : ""} marked stale`
          : "Voice changed"
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change voice");
    } finally {
      setSaving(null);
    }
  }

  return (
    <TooltipProvider>
    <div className="space-y-4">
      {!readOnly && (
      <div className="flex items-center justify-end">
        <Button variant="outline" onClick={onRecast} disabled={castRunning}>
          {casting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Re-run auto-cast
        </Button>
      </div>
      )}

      <div className="rounded-lg border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">Character</TableHead>
              <TableHead className="w-[32%]">Voice</TableHead>
              <TableHead>Why this voice</TableHead>
              <TableHead className="w-[110px] text-right">Preview</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {characters.map((c) => {
              const assigned = c.assignment;
              const assignedVoice = allVoices.find((v) => v.id === assigned?.voiceId);
              const quote = c.quotes[0];

              return (
                <TableRow key={c.id}>
                  <TableCell className="overflow-hidden">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="cursor-default">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium">
                              {c.variantGroup ?? c.name}
                            </span>
                            {c.variantLabel && (
                              <Badge variant="outline" className="shrink-0 text-[10px]">
                                {c.variantLabel}
                              </Badge>
                            )}
                            {c.isNarrator && (
                              <Badge variant="outline" className="shrink-0 text-[10px]">
                                narrator
                              </Badge>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[
                              c.profile.gender,
                              c.profile.ageRange,
                              c.profile.heritage || c.profile.accentHint,
                            ]
                              .filter((x) => x && x !== "unknown")
                              .join(" · ")}
                          </div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        <ProfileTooltipBody profile={c.profile} />
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    {readOnly ? (
                      <span className="block min-w-0 truncate text-sm">
                        {assignedVoice?.name ?? assigned?.voiceName ?? "—"}
                      </span>
                    ) : (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <VoiceCombobox
                        voices={allVoices}
                        value={assigned?.voiceId}
                        selectedLabel={assigned?.voiceName}
                        onChange={(v) => changeVoice(c.id, v)}
                        disabled={allVoices.length === 0}
                        loading={saving === c.id}
                      />
                      {assigned && (
                        <VoiceSettingsPopover
                          characterId={c.id}
                          settings={assigned.settings}
                          onSaved={() => router.refresh()}
                        />
                      )}
                    </div>
                    )}
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    {assigned ? (
                      <div className="flex min-w-0 items-start gap-2">
                        {assigned.overridden && (
                          <Badge variant="outline" className="mt-0.5 shrink-0">
                            manual
                          </Badge>
                        )}
                        <p
                          className="line-clamp-2 min-w-0 whitespace-normal text-xs text-muted-foreground"
                          title={assigned.rationale ?? undefined}
                        >
                          {assigned.rationale}
                        </p>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not assigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {assignedVoice?.previewUrl && (
                        <PreviewButton
                          label="Voice sample (free)"
                          getUrl={async () => assignedVoice.previewUrl!}
                        />
                      )}
                      {!readOnly && assigned && quote && (
                        <PreviewButton
                          variant="outline"
                          label={`Hear ${c.isNarrator ? "the opening" : "a real quote"} in this voice`}
                          getUrl={() =>
                            fetchPreviewUrl({
                              voiceId: assigned.voiceId,
                              text: quote,
                              settings: assigned.settings,
                            })
                          }
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {!readOnly && (
        <p className="text-xs text-muted-foreground">
          The outlined play button renders the character&apos;s actual line from the book with
          the selected voice (uses a few credits, cached). Changing a voice marks already
          generated chapters stale — regenerating only re-renders that character&apos;s lines.
        </p>
      )}
    </div>
    </TooltipProvider>
  );
}

function VoiceSettingsPopover({
  characterId,
  settings,
  onSaved,
}: {
  characterId: string;
  settings: VoiceSettings;
  onSaved: () => void;
}) {
  const [local, setLocal] = useState(settings);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/characters/${characterId}/voice`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: local }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        data.staleChapters > 0
          ? `Settings saved — ${data.staleChapters} chapter${data.staleChapters > 1 ? "s" : ""} marked stale`
          : "Settings saved"
      );
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const rows: { key: keyof VoiceSettings; label: string; min: number; max: number; step: number }[] = [
    { key: "stability", label: "Stability", min: 0, max: 1, step: 0.05 },
    { key: "similarityBoost", label: "Similarity", min: 0, max: 1, step: 0.05 },
    { key: "style", label: "Style", min: 0, max: 1, step: 0.05 },
    { key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.05 },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <Settings2 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-4" align="end">
        {rows.map(({ key, label, min, max, step }) => (
          <div key={key} className="space-y-1.5">
            <div className="flex justify-between">
              <Label className="text-xs">{label}</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {local[key].toFixed(2)}
              </span>
            </div>
            <Slider
              value={[local[key]]}
              min={min}
              max={max}
              step={step}
              onValueChange={([v]) => setLocal((s) => ({ ...s, [key]: v }))}
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Lower stability = more emotional range; higher = steadier delivery.
        </p>
        <Button size="sm" className="w-full" onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save settings
        </Button>
      </PopoverContent>
    </Popover>
  );
}
