"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  Download,
  Headphones,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { speakerColor } from "./speaker-colors";
import type { BookData, ChapterMeta } from "./types";

interface TimedPhrase {
  text: string;
  startSec: number;
  durationSec: number;
}

interface ReadalongSegment {
  id: string;
  idx: number;
  characterId: string | null;
  characterName: string;
  kind: "narration" | "dialogue" | "sfx";
  text: string;
  startSec: number;
  durationSec: number;
  phrases: TimedPhrase[];
}

interface ReadalongScript {
  chapterId: string;
  segments?: ReadalongSegment[];
  error?: string;
}

export function ListenTab({ book, chapters }: { book: BookData; chapters: ChapterMeta[] }) {
  const playable = chapters.filter(
    (c) => c.audioPath && (c.status === "ready" || c.status === "stale")
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<ChapterMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState("1");
  const [readAlong, setReadAlong] = useState(false);
  const [script, setScript] = useState<ReadalongScript | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const play = useCallback(
    (chapter: ChapterMeta) => {
      const audio = audioRef.current;
      if (!audio || !chapter.audioPath) return;
      if (current?.id !== chapter.id) {
        audio.src = `/api/audio/${chapter.audioPath}`;
        audio.playbackRate = Number(rate);
        setCurrent(chapter);
        setTime(0);
      }
      audio.play();
    },
    [current, rate]
  );

  const next = useCallback(() => {
    if (!current) return;
    const i = playable.findIndex((c) => c.id === current.id);
    if (i >= 0 && i + 1 < playable.length) play(playable[i + 1]);
  }, [current, playable, play]);

  const prev = useCallback(() => {
    if (!current) return;
    const i = playable.findIndex((c) => c.id === current.id);
    if (i > 0) play(playable[i - 1]);
  }, [current, playable, play]);

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    const onTime = () => setTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, []);

  // Auto-advance uses the latest playlist
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => next();
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [next]);

  // Load the timed script for the current chapter when read-along is on
  useEffect(() => {
    if (!readAlong || !current) return;
    if (script?.chapterId === current.id) return;
    let cancelled = false;
    const chapterId = current.id;
    fetch(`/api/chapters/${chapterId}/readalong`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Read-along unavailable");
        if (!cancelled) setScript({ chapterId, segments: data.segments });
      })
      .catch((err) => {
        if (!cancelled) {
          setScript({
            chapterId,
            error: err instanceof Error ? err.message : "Read-along unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readAlong, current, script]);

  // Which segment + phrase is under the playhead (small lists — linear scans)
  const activeSegments =
    readAlong && current && script?.chapterId === current.id ? script.segments : undefined;
  let activeIdx = -1;
  let activePhraseIdx = -1;
  if (activeSegments) {
    for (let i = 0; i < activeSegments.length; i++) {
      if (activeSegments[i].startSec <= time + 0.05) activeIdx = i;
      else break;
    }
    const phrases = activeSegments[activeIdx]?.phrases;
    if (phrases) {
      for (let i = 0; i < phrases.length; i++) {
        if (phrases[i].startSec <= time + 0.05) activePhraseIdx = i;
        else break;
      }
    }
  }

  // Keep the active line centered in the transcript panel
  useEffect(() => {
    if (activeIdx < 0) return;
    const container = scrollRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-seg-idx="${activeIdx}"]`);
    if (!container || !el) return;
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
      behavior: "smooth",
    });
  }, [activeIdx]);

  const seekTo = (startSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = startSec;
    if (!playing) audio.play();
  };

  if (playable.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Headphones className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">Nothing to listen to yet</p>
            <p className="text-sm text-muted-foreground">
              Generate chapters in the Chapters tab and they&apos;ll appear here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
  };

  return (
    <div className="space-y-4">
      <Card className="sticky top-16 z-30 border-primary/20 bg-card/95 backdrop-blur">
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="truncate font-medium">
                {current ? current.title : "Select a chapter below"}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {formatDuration(time)} / {formatDuration(duration)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={readAlong ? "default" : "outline"}
                size="sm"
                onClick={() => setReadAlong((v) => !v)}
                disabled={!current && playable.length === 0}
              >
                <BookOpenText className="h-4 w-4" /> Read along
              </Button>
              <Select
                value={rate}
                onValueChange={(v) => {
                  setRate(v);
                  if (audioRef.current) audioRef.current.playbackRate = Number(v);
                }}
              >
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["0.75", "1", "1.25", "1.5", "1.75", "2"].map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Slider
            value={[duration ? (time / duration) * 100 : 0]}
            max={100}
            step={0.1}
            onValueChange={([v]) => {
              const audio = audioRef.current;
              if (audio && duration) audio.currentTime = (v / 100) * duration;
            }}
          />

          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" size="icon" onClick={prev} disabled={!current}>
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => skip(-15)} disabled={!current}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              className="h-11 w-11 rounded-full"
              onClick={() => {
                if (!current && playable[0]) play(playable[0]);
                else if (playing) audioRef.current?.pause();
                else audioRef.current?.play();
              }}
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => skip(15)} disabled={!current}>
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={next} disabled={!current}>
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {readAlong && current && (
        <Card>
          <CardContent className="py-4">
            {!script || script.chapterId !== current.id ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading script…
              </div>
            ) : script.error ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{script.error}</p>
            ) : (
              <div ref={scrollRef} className="max-h-[55vh] space-y-1 overflow-y-auto pr-3">
                {script.segments!.map((seg, i) => {
                  const active = i === activeIdx;
                  if (seg.kind === "sfx") {
                    return (
                      <div
                        key={seg.id}
                        data-seg-idx={i}
                        onClick={() => seekTo(seg.startSec)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border-l-2 border-transparent py-1.5 pl-3 pr-2 transition-colors",
                          active
                            ? "bg-primary/10"
                            : "opacity-60 hover:bg-muted/50 hover:opacity-100"
                        )}
                      >
                        <Volume2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">
                          Sound effect
                        </span>
                        <span className="truncate text-sm italic text-muted-foreground">
                          {seg.text}
                        </span>
                      </div>
                    );
                  }
                  const speakerChanged =
                    i === 0 || script.segments![i - 1].characterId !== seg.characterId;
                  const color = speakerColor(seg.characterId);
                  return (
                    <div
                      key={seg.id}
                      data-seg-idx={i}
                      onClick={() => seekTo(seg.startSec)}
                      className={cn(
                        "cursor-pointer rounded-md border-l-2 py-1.5 pl-3 pr-2 transition-colors",
                        active
                          ? "bg-primary/10"
                          : "border-transparent opacity-70 hover:bg-muted/50 hover:opacity-100"
                      )}
                      style={{ borderLeftColor: active || seg.kind === "dialogue" ? color : undefined }}
                    >
                      {speakerChanged && seg.kind === "dialogue" && (
                        <span className="mr-2 text-xs font-medium" style={{ color }}>
                          {seg.characterName}
                        </span>
                      )}
                      <span
                        className={cn(
                          "text-sm leading-relaxed",
                          active ? "text-foreground" : "text-foreground/80",
                          seg.kind === "narration" && "text-muted-foreground"
                        )}
                      >
                        {seg.phrases.map((phrase, p) => (
                          <span
                            key={p}
                            onClick={(e) => {
                              e.stopPropagation();
                              seekTo(phrase.startSec);
                            }}
                            className={cn(
                              "rounded-sm transition-colors duration-200",
                              active && p === activePhraseIdx
                                ? "bg-primary/25 text-foreground"
                                : "hover:bg-muted"
                            )}
                          >
                            {phrase.text}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {playable.length} of {chapters.length} chapters generated
        </p>
        <Button variant="outline" asChild>
          <a href={`/api/books/${book.id}/download`}>
            <Download className="h-4 w-4" /> Download all (.zip)
          </a>
        </Button>
      </div>

      <div className="divide-y rounded-lg border">
        {playable.map((ch) => (
          <div
            key={ch.id}
            className={cn(
              "flex items-center gap-3 px-4 py-2.5",
              current?.id === ch.id && "bg-primary/5"
            )}
          >
            <Button
              variant={current?.id === ch.id && playing ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={() => {
                if (current?.id === ch.id && playing) audioRef.current?.pause();
                else play(ch);
              }}
            >
              {current?.id === ch.id && playing ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {ch.idx + 1}. {ch.title}
              </p>
            </div>
            {ch.status === "stale" && (
              <Badge variant="outline" className="border-orange-500/50 text-orange-400">
                stale
              </Badge>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {ch.durationSec ? formatDuration(ch.durationSec) : ""}
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a href={`/api/audio/${ch.audioPath}`} download={`${ch.idx + 1} - ${ch.title}.mp3`}>
                <Download className="h-4 w-4" />
              </a>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
