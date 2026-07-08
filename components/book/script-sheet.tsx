"use client";

import { useEffect, useState } from "react";
import { Flag, Loader2, Trash2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { titleAnnouncement } from "@/lib/analysis/clean";
import { DELIVERY_VALUES } from "@/lib/delivery";
import { estimateCredits, estimateSfxCredits, formatCredits } from "@/lib/format";
import { speakerColor } from "./speaker-colors";
import type { ChapterMeta, CharacterData } from "./types";

interface SegmentRow {
  id: string;
  idx: number;
  characterId: string | null;
  kind: "narration" | "dialogue" | "sfx";
  text: string;
  flagged: boolean;
  delivery: string | null;
  sfxDurationSec: number | null;
}

const NARRATOR_VALUE = "__narrator__";
const NO_DELIVERY = "__none__";
const DEFAULT_SFX_SECONDS = 3;

export function ScriptSheet({
  chapter,
  characters,
  renderModel,
  onClose,
}: {
  chapter: ChapterMeta | null;
  characters: CharacterData[];
  renderModel: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ chapterId: string; segments: SegmentRow[] } | null>(
    null
  );

  useEffect(() => {
    if (!chapter) return;
    let cancelled = false;
    fetch(`/api/chapters/${chapter.id}/segments`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setLoaded({ chapterId: chapter.id, segments: data.segments ?? [] });
      })
      .catch(() => toast.error("Failed to load script"));
    return () => {
      cancelled = true;
    };
  }, [chapter]);

  const segments = chapter && loaded?.chapterId === chapter.id ? loaded.segments : null;
  const nameById = new Map(characters.map((c) => [c.id, c.name]));
  const speakables = characters.filter((c) => !c.isNarrator);
  // The chapter-title announcement always stays with the book narrator, so it
  // doesn't count toward (or get changed by) the chapter's narrating voice.
  const isTitleSegment = (s: SegmentRow) =>
    s.idx === 0 &&
    s.kind === "narration" &&
    chapter !== null &&
    s.text === titleAnnouncement(chapter.title);
  const narrationIds = new Set(
    (segments ?? [])
      .filter((s) => s.kind === "narration" && !isTitleSegment(s))
      .map((s) => s.characterId ?? NARRATOR_VALUE)
  );
  const chapterNarrator = narrationIds.size === 1 ? [...narrationIds][0] : NARRATOR_VALUE;
  const flaggedCount = segments?.filter((s) => s.flagged).length ?? 0;
  const speechChars =
    segments?.reduce((n, s) => n + (s.kind === "sfx" ? 0 : s.text.length), 0) ?? 0;
  const sfxSeconds =
    segments?.reduce(
      (n, s) => (s.kind === "sfx" ? n + (s.sfxDurationSec ?? DEFAULT_SFX_SECONDS) : n),
      0
    ) ?? 0;
  const credits = estimateCredits(speechChars, renderModel) + estimateSfxCredits(sfxSeconds);

  async function reassign(segment: SegmentRow, value: string) {
    const characterId = value === NARRATOR_VALUE ? null : value;
    const res = await fetch(`/api/segments/${segment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to reassign");
      return;
    }
    setLoaded(
      (prev) =>
        prev && {
          ...prev,
          segments: prev.segments.map((s) =>
            s.id === segment.id
              ? {
                  ...s,
                  characterId,
                  flagged: false,
                  kind: characterId ? s.kind : "narration",
                  delivery: characterId ? s.delivery : null,
                }
              : s
          ),
        }
    );
    toast.success("Speaker updated — regenerate the chapter to hear it");
  }

  async function setChapterNarrator(value: string) {
    if (!chapter) return;
    const characterId = value === NARRATOR_VALUE ? null : value;
    const res = await fetch(`/api/chapters/${chapter.id}/narrator`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to update narrator");
      return;
    }
    setLoaded(
      (prev) =>
        prev && {
          ...prev,
          segments: prev.segments.map((s) =>
            s.kind === "narration" && !isTitleSegment(s) ? { ...s, characterId } : s
          ),
        }
    );
    toast.success("Narration voice updated — regenerate the chapter to hear it");
  }

  async function setDelivery(segment: SegmentRow, value: string) {
    const delivery = value === NO_DELIVERY ? null : value;
    const res = await fetch(`/api/segments/${segment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to update delivery");
      return;
    }
    setLoaded(
      (prev) =>
        prev && {
          ...prev,
          segments: prev.segments.map((s) => (s.id === segment.id ? { ...s, delivery } : s)),
        }
    );
    toast.success("Delivery updated — regenerate the chapter to hear it");
  }

  async function removeSfx(segment: SegmentRow) {
    const res = await fetch(`/api/segments/${segment.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to remove sound effect");
      return;
    }
    setLoaded(
      (prev) =>
        prev && { ...prev, segments: prev.segments.filter((s) => s.id !== segment.id) }
    );
    toast.success("Sound effect removed — regenerate the chapter to update audio");
  }

  return (
    <Sheet open={chapter !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{chapter?.title}</SheetTitle>
          <SheetDescription>
            {segments
              ? `${segments.length} segments · ${segments.filter((s) => s.kind === "dialogue").length} dialogue · ~${formatCredits(credits)} credits`
              : "Loading…"}
            {flaggedCount > 0 && ` · ${flaggedCount} flagged for review`}
          </SheetDescription>
          {segments && segments.length > 0 && speakables.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Narrated by</span>
              <Select value={chapterNarrator} onValueChange={setChapterNarrator}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NARRATOR_VALUE}>Narrator</SelectItem>
                  {speakables.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </SheetHeader>

        {!segments ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-140px)] pr-4">
            <div className="space-y-3 px-4 pb-8">
              {segments.map((seg) => {
                if (seg.kind === "sfx") {
                  return (
                    <div
                      key={seg.id}
                      className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2"
                    >
                      <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <p className="min-w-0 flex-1 truncate text-sm italic text-muted-foreground">
                        {seg.text}
                      </p>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {seg.sfxDurationSec ?? DEFAULT_SFX_SECONDS}s
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="Remove sound effect"
                        onClick={() => removeSfx(seg)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                }
                const color = speakerColor(seg.characterId);
                const name = seg.characterId
                  ? (nameById.get(seg.characterId) ?? "?")
                  : "Narrator";
                return (
                  <div
                    key={seg.id}
                    className="rounded-md border-l-2 bg-card py-1.5 pl-3"
                    style={{ borderLeftColor: color }}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-medium" style={{ color }}>
                        {name}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {seg.kind}
                      </span>
                      {seg.flagged && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-orange-500/50 text-[10px] text-orange-400"
                        >
                          <Flag className="h-2.5 w-2.5" /> review
                        </Badge>
                      )}
                      <div className="ml-auto flex items-center gap-1 pr-2">
                        {seg.kind === "dialogue" && (
                          <Select
                            value={seg.delivery ?? NO_DELIVERY}
                            onValueChange={(v) => setDelivery(seg, v)}
                          >
                            <SelectTrigger
                              className={`h-6 w-24 border-none bg-transparent px-2 text-xs shadow-none ${
                                seg.delivery ? "text-amber-400" : "text-muted-foreground"
                              }`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_DELIVERY}>neutral</SelectItem>
                              {DELIVERY_VALUES.map((d) => (
                                <SelectItem key={d} value={d}>
                                  {d}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <Select
                          value={seg.characterId ?? NARRATOR_VALUE}
                          onValueChange={(v) => reassign(seg, v)}
                        >
                          <SelectTrigger className="h-6 w-36 border-none bg-transparent px-2 text-xs shadow-none">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NARRATOR_VALUE}>Narrator</SelectItem>
                            {speakables.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <p className="pr-4 text-sm leading-relaxed text-foreground/90">
                      {seg.text}
                    </p>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
