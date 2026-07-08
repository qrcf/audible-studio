"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Download,
  Headphones,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { speakerColor } from "./speaker-colors";
import { useReadOnly } from "./read-only";
import { IntroMusicDialog } from "./intro-music-dialog";
import type { BookData, ChapterMeta, JobData } from "./types";

function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// The download attribute is ignored after the audio route's cross-origin
// redirect, so downloads fetch the bytes and save them with a proper name.
async function saveAudio(audioPath: string, filename: string) {
  const res = await fetch(`/api/audio/${audioPath}`);
  if (!res.ok) throw new Error("Download failed");
  saveBlob(await res.blob(), filename);
}

function safeName(title: string, fallback: string): string {
  return title.replace(/[^\w\s-]/g, "").trim().slice(0, 80) || fallback;
}

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
  paraBreakBefore: boolean;
  spaceBefore: boolean;
  isTitle?: boolean;
  phrases: TimedPhrase[];
}

// Book-page render model: timed phrase fragments regrouped into paragraphs
interface ReaderPiece {
  segIdx: number;
  phraseIdx: number;
  text: string;
  label?: string; // speaker name, shown once when the dialogue speaker changes
}
type ReaderBlock =
  | { kind: "title"; segIdx: number; text: string }
  | { kind: "sfx"; segIdx: number }
  | { kind: "para"; pieces: ReaderPiece[] };

interface ReadalongScript {
  chapterId: string;
  segments?: ReadalongSegment[];
  error?: string;
}

const INTRO_ID = "__intro__";

export function ListenTab({
  book,
  chapters,
  introJob,
}: {
  book: BookData;
  chapters: ChapterMeta[];
  introJob: JobData | null;
}) {
  const readOnly = useReadOnly();
  const router = useRouter();
  const [startingIntro, setStartingIntro] = useState(false);
  const readyChapters = useMemo(
    () => chapters.filter((c) => c.audioPath && (c.status === "ready" || c.status === "stale")),
    [chapters]
  );
  const introReady = Boolean(book.introAudioPath);
  const introBusy = Boolean(introJob) || startingIntro;
  // The intro is its own leading section. Its row is ALWAYS shown (so a book
  // without one can generate it), but it only joins the playback list once its
  // audio exists.
  const introItem = useMemo<ChapterMeta>(
    () => ({
      id: INTRO_ID,
      idx: -1,
      title: "Intro",
      charCount: 0,
      status: introReady ? "ready" : "pending",
      durationSec: book.introDurationSec,
      audioPath: book.introAudioPath,
      error: null,
    }),
    [introReady, book.introAudioPath, book.introDurationSec]
  );
  const playable = useMemo<ChapterMeta[]>(
    () => (introReady ? [introItem, ...readyChapters] : readyChapters),
    [introReady, introItem, readyChapters]
  );
  // What the list renders: the intro row leads (always for the owner so they can
  // generate it; for read-only viewers only once it exists), then ready chapters.
  const displayList = useMemo<ChapterMeta[]>(
    () => (introReady || !readOnly ? [introItem, ...readyChapters] : readyChapters),
    [introReady, readOnly, introItem, readyChapters]
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<ChapterMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState("1");
  const [readAlong, setReadAlong] = useState(true);
  const [zipping, setZipping] = useState(false);
  const [script, setScript] = useState<ReadalongScript | null>(null);
  // Pagination: the reader shows one page at a time and turns automatically as
  // the highlight advances. `pages` holds the pixel offset of each page's first
  // block (a page break never splits a block); `pageIdx` is the visible page.
  const pageViewportRef = useRef<HTMLDivElement | null>(null);
  const pageInnerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<number[]>([0]);
  const [pageIdx, setPageIdx] = useState(0);
  // While the reader turns pages by hand, auto-follow pauses briefly so it
  // doesn't yank back to the playhead mid-read.
  const userPagedAtRef = useRef(0);

  const play = useCallback(
    (chapter: ChapterMeta) => {
      const audio = audioRef.current;
      if (!audio || !chapter.audioPath) return;
      if (current?.id !== chapter.id) {
        audio.src = `/api/audio/${chapter.audioPath}`;
        audio.playbackRate = Number(rate);
        setCurrent(chapter);
        setTime(0);
        setPageIdx(0); // a new chapter opens on its first page
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
    if (current.id === INTRO_ID) return; // the intro section has no script
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

  // Regroup the flat segment→phrase list into book-page blocks: paragraphs of
  // flowing prose (narration + dialogue), with title/sfx as their own blocks.
  // A phrase can carry internal blank lines, so each phrase is split on
  // paragraph breaks and its later chunks open fresh paragraphs.
  const blocks = useMemo<ReaderBlock[]>(() => {
    if (!activeSegments) return [];
    const out: ReaderBlock[] = [];
    let para: ReaderPiece[] | null = null;
    let lastDialogueSpeaker: string | null = null;
    const closePara = () => {
      if (para && para.length) out.push({ kind: "para", pieces: para });
      para = null;
    };
    activeSegments.forEach((seg, segIdx) => {
      if (seg.isTitle) {
        closePara();
        out.push({ kind: "title", segIdx, text: seg.text });
        return;
      }
      if (seg.kind === "sfx") {
        closePara();
        out.push({ kind: "sfx", segIdx });
        return;
      }
      if (seg.paraBreakBefore || !para) {
        closePara();
        para = [];
      } else if (seg.spaceBefore && para.length) {
        // Re-insert the whitespace trimmed at storage between segments, onto
        // the previous piece so it renders outside any speaker label.
        para[para.length - 1] = {
          ...para[para.length - 1],
          text: para[para.length - 1].text + " ",
        };
      }
      const label =
        seg.kind === "dialogue" && seg.characterId !== lastDialogueSpeaker
          ? seg.characterName
          : undefined;
      if (seg.kind === "dialogue") lastDialogueSpeaker = seg.characterId;
      seg.phrases.forEach((phrase, phraseIdx) => {
        const chunks = phrase.text.split(/\n\s*\n/);
        chunks.forEach((chunk, ci) => {
          if (ci > 0) {
            closePara();
            para = [];
          }
          if (!chunk.trim()) return;
          para!.push({
            segIdx,
            phraseIdx,
            text: chunk,
            label: phraseIdx === 0 && ci === 0 ? label : undefined,
          });
        });
      });
    });
    closePara();
    return out;
  }, [activeSegments]);

  // Slice the flowing text into pages that fill the viewport without ever
  // splitting a block: walk the rendered blocks, and whenever the next one
  // would overflow the current page, start a fresh page at its top offset.
  const recomputePages = useCallback(() => {
    const viewport = pageViewportRef.current;
    const inner = pageInnerRef.current;
    if (!viewport || !inner) return;
    const h = viewport.clientHeight;
    if (h <= 0) return;
    const starts = [0];
    let pageTop = 0;
    for (const el of inner.querySelectorAll<HTMLElement>("[data-block-idx]")) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top > pageTop && bottom - pageTop > h) {
        pageTop = top;
        starts.push(top);
      }
    }
    setPages((prev) =>
      prev.length === starts.length && prev.every((v, i) => v === starts[i]) ? prev : starts
    );
  }, []);

  // Recompute on content or size changes (fonts loading, window resize, chapter
  // swap). Observing the inner element also catches late reflow.
  useEffect(() => {
    recomputePages();
    const viewport = pageViewportRef.current;
    const inner = pageInnerRef.current;
    if (!viewport || !inner) return;
    const ro = new ResizeObserver(() => recomputePages());
    ro.observe(viewport);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [blocks, recomputePages]);

  // pageIdx can briefly outrun the page count after a re-paginate; clamp at read
  // time so we never translate past the last page. (play() resets to page 0 on a
  // chapter change; a resize keeps the current page and auto-follow re-seeks it.)
  const pageCount = pages.length;
  const currentPage = Math.min(pageIdx, pageCount - 1);

  // Turn to the page holding the active phrase — unless the reader just paged
  // by hand, in which case following stands down for a few seconds.
  useEffect(() => {
    if (activeIdx < 0) return;
    if (Date.now() - userPagedAtRef.current < 4000) return;
    const inner = pageInnerRef.current;
    const el = inner?.querySelector<HTMLElement>(
      `[data-seg-idx="${activeIdx}"][data-phrase-idx="${Math.max(activePhraseIdx, 0)}"]`
    );
    if (!el) return;
    const offset = el.offsetTop;
    let target = 0;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i] <= offset + 1) target = i;
      else break;
    }
    setPageIdx((cur) => (cur === target ? cur : target));
  }, [activeIdx, activePhraseIdx, pages]);

  const goToPage = (i: number) => {
    userPagedAtRef.current = Date.now();
    setPageIdx(Math.max(0, Math.min(pages.length - 1, i)));
  };

  const seekTo = (startSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    userPagedAtRef.current = 0; // clicking a line opts back into following
    audio.currentTime = startSec;
    if (!playing) audio.play();
  };

  if (readyChapters.length === 0 && !introReady && !introBusy) {
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

  // Kick off intro generation as a tracked job; the poll picks up the running
  // job within ~2s and drives the progress UI (which survives a refresh).
  async function generateIntro() {
    setStartingIntro(true);
    try {
      const res = await fetch(`/api/books/${book.id}/intro`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info(introReady ? "Regenerating intro…" : "Generating intro — title, author & music…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate intro");
    } finally {
      setStartingIntro(false);
    }
  }

  // The paginated reader sits above the transport. When it's showing, the
  // controls ride directly beneath it in normal flow (text over controls);
  // with no reader, they pin to the top so they stay reachable down the list.
  const showReader = Boolean(readAlong && current && current.id !== INTRO_ID);

  return (
    <div className="space-y-4">
      {showReader && current && (
        <Card>
          <CardContent className="py-4">
            {!script || script.chapterId !== current.id ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading script…
              </div>
            ) : script.error ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{script.error}</p>
            ) : (
              <>
                <div ref={pageViewportRef} className="relative h-[60vh] overflow-hidden">
                  <div
                    ref={pageInnerRef}
                    style={{ transform: `translateY(${-(pages[currentPage] ?? 0)}px)` }}
                    className="relative mx-auto max-w-[65ch] px-2 font-serif text-[17px] leading-8 text-foreground/90 transition-transform duration-500 ease-out"
                  >
                    {blocks.map((block, bi) => {
                      if (block.kind === "title") {
                        return (
                          <p
                            key={bi}
                            data-block-idx={bi}
                            data-seg-idx={block.segIdx}
                            data-phrase-idx={0}
                            onClick={() => seekTo(script.segments![block.segIdx].startSec)}
                            className="mb-6 mt-2 cursor-pointer text-center font-sans text-sm font-medium uppercase tracking-wide text-muted-foreground"
                          >
                            {block.text}
                          </p>
                        );
                      }
                      if (block.kind === "sfx") {
                        const seg = script.segments![block.segIdx];
                        const active = block.segIdx === activeIdx;
                        return (
                          <div
                            key={bi}
                            data-block-idx={bi}
                            data-seg-idx={block.segIdx}
                            data-phrase-idx={0}
                            onClick={() => seekTo(seg.startSec)}
                            className={cn(
                              "my-5 flex cursor-pointer items-center justify-center gap-2 font-sans text-xs",
                              active ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            <Volume2 className="h-3 w-3 shrink-0" />
                            <span className="italic">{seg.text}</span>
                          </div>
                        );
                      }
                      return (
                        <p key={bi} data-block-idx={bi} className="my-4">
                          {block.pieces.map((p, pi) => {
                            const seg = script.segments![p.segIdx];
                            const phrase = seg.phrases[p.phraseIdx];
                            const active =
                              p.segIdx === activeIdx && p.phraseIdx === activePhraseIdx;
                            const color =
                              seg.kind === "dialogue" ? speakerColor(seg.characterId) : undefined;
                            return (
                              <Fragment key={pi}>
                                {p.label && (
                                  <span
                                    className="mr-1.5 font-sans text-xs font-medium"
                                    style={{ color }}
                                  >
                                    {p.label}
                                  </span>
                                )}
                                <span
                                  data-seg-idx={p.segIdx}
                                  data-phrase-idx={p.phraseIdx}
                                  onClick={() => seekTo(phrase.startSec)}
                                  title={seg.kind === "dialogue" ? seg.characterName : undefined}
                                  style={{ color }}
                                  className={cn(
                                    "cursor-pointer rounded-sm transition-colors duration-200",
                                    active ? "bg-primary/25 text-foreground" : "hover:bg-muted",
                                    seg.kind === "narration" && !active && "text-foreground/80"
                                  )}
                                >
                                  {p.text}
                                </span>
                              </Fragment>
                            );
                          })}
                        </p>
                      );
                    })}
                  </div>
                </div>
                {pageCount > 1 && (
                  <div className="mt-2 flex items-center justify-center gap-4 text-sm text-muted-foreground">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage === 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="tabular-nums">
                      Page {currentPage + 1} of {pageCount}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage >= pageCount - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card
        className={cn(
          "z-30 border-primary/20 bg-card/95 backdrop-blur",
          !showReader && "sticky top-16"
        )}
      >
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

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {readyChapters.length} of {chapters.length} chapters generated
        </p>
        {!readOnly && (
        <Button
          variant="outline"
          disabled={zipping || playable.length === 0}
          onClick={async () => {
            // Zip in the browser: chapters stream from the CDN, so no server
            // function ever holds the whole book in memory.
            setZipping(true);
            try {
              const JSZip = (await import("jszip")).default;
              const zip = new JSZip();
              for (const ch of playable) {
                const res = await fetch(`/api/audio/${ch.audioPath}`);
                if (!res.ok) throw new Error(`Chapter ${ch.idx + 1} download failed`);
                zip.file(
                  `${String(ch.idx + 1).padStart(2, "0")} - ${safeName(ch.title, `Chapter ${ch.idx + 1}`)}.mp3`,
                  await res.blob()
                );
              }
              saveBlob(
                await zip.generateAsync({ type: "blob", compression: "STORE" }),
                `${safeName(book.title, "audiobook")}.zip`
              );
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Download failed");
            } finally {
              setZipping(false);
            }
          }}
        >
          {zipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download all (.zip)
        </Button>
        )}
      </div>

      <div className="divide-y rounded-lg border">
        {displayList.map((ch) => {
          const isIntro = ch.id === INTRO_ID;

          // Intro row before it has audio (missing) or while (re)generating — no
          // play/download yet; it offers Generate or shows live progress.
          if (isIntro && (!introReady || introBusy)) {
            const pct =
              introJob && introJob.total > 0 ? (introJob.done / introJob.total) * 100 : undefined;
            return (
              <div key={ch.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground">
                  {introBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Music className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">Intro</p>
                  {introBusy ? (
                    <div className="mt-1 space-y-1">
                      <Progress value={pct} className="h-1" />
                      <p className="truncate text-xs text-muted-foreground">
                        {introJob?.note ?? "Starting…"}
                      </p>
                    </div>
                  ) : (
                    <p className="truncate text-xs text-muted-foreground">
                      {book.title}
                      {book.author ? `, by ${book.author}` : ""} · title &amp; a themed music bed
                    </p>
                  )}
                </div>
                {!readOnly && !introBusy && (
                  <>
                    <IntroMusicDialog book={book} />
                    <Button variant="outline" size="sm" onClick={generateIntro}>
                      <Music className="h-3.5 w-3.5" /> Generate intro
                    </Button>
                  </>
                )}
              </div>
            );
          }

          return (
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
              {isIntro ? (
                <>
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> Intro
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {book.title}
                    {book.author ? `, by ${book.author}` : ""}
                  </p>
                </>
              ) : (
                <p className="truncate text-sm font-medium">
                  {ch.idx + 1}. {ch.title}
                </p>
              )}
            </div>
            {ch.status === "stale" && (
              <Badge variant="outline" className="border-orange-500/50 text-orange-400">
                stale
              </Badge>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {ch.durationSec ? formatDuration(ch.durationSec) : ""}
            </span>
            {!readOnly && isIntro && <IntroMusicDialog book={book} />}
            {!readOnly && isIntro && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Regenerate title & music"
                disabled={startingIntro}
                onClick={generateIntro}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
            {!readOnly && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() =>
                  saveAudio(
                    ch.audioPath!,
                    isIntro ? "00 - Intro.mp3" : `${ch.idx + 1} - ${ch.title}.mp3`
                  ).catch(() => toast.error("Download failed"))
                }
              >
                <Download className="h-4 w-4" />
              </Button>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
