"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/status-badge";
import { estimateCredits, formatCredits } from "@/lib/format";
import { ModelPrefsPopover } from "./model-prefs-popover";
import { EditBookDialog } from "./edit-book-dialog";
import { ShareDialog } from "./share-dialog";
import { ReadOnlyProvider } from "./read-only";
import { PipelineCard } from "./pipeline-card";
import { CharactersTab } from "./characters-tab";
import { VoicesTab } from "./voices-tab";
import { ChaptersTab } from "./chapters-tab";
import { ListenTab } from "./listen-tab";
import type {
  ApiKeysPresent,
  BookData,
  ChapterMeta,
  CharacterData,
  ProgressData,
} from "./types";

const POLL_MS = 2000;

export function BookView({
  book,
  chapters,
  characters,
  keys,
  readOnly = false,
  shareToken = null,
}: {
  book: BookData;
  chapters: ChapterMeta[];
  characters: CharacterData[];
  keys: ApiKeysPresent;
  readOnly?: boolean;
  shareToken?: string | null;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [casting, setCasting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const snapshotRef = useRef<string>("");

  // Merge live poll data over the server-rendered props
  const liveBookStatus = progress?.book.status ?? book.status;
  const livePipelineStage = progress ? progress.book.pipelineStage : book.pipelineStage;
  const liveChapters = useMemo(() => {
    const byId = new Map(progress?.chapters.map((c) => [c.id, c]) ?? []);
    return chapters.map((ch) => {
      const live = byId.get(ch.id);
      return live ? { ...ch, ...live } : ch;
    });
  }, [chapters, progress]);

  const runningJobs = useMemo(
    () => progress?.jobs.filter((j) => j.status === "running") ?? [],
    [progress]
  );
  const busy =
    ["analyzing", "casting", "generating"].includes(liveBookStatus) ||
    liveChapters.some((c) => ["scripting", "generating"].includes(c.status)) ||
    runningJobs.length > 0 ||
    analyzing ||
    casting;

  useEffect(() => {
    // Nothing changes for a read-only viewer — skip the polling/refresh loop.
    if (readOnly) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/books/${book.id}/progress`);
        if (!res.ok || cancelled) return;
        const data: ProgressData = await res.json();
        setProgress(data);
        // When statuses change (a step finished), re-pull server data
        const snapshot =
          data.book.status +
          "|" +
          (data.book.pipelineStage ?? "") +
          "|" +
          data.chapters.map((c) => c.status).join(",");
        if (snapshotRef.current && snapshotRef.current !== snapshot) {
          router.refresh();
        }
        snapshotRef.current = snapshot;
      } catch {
        // dev server restart etc. — keep polling
      }
    };
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [book.id, router, readOnly]);

  const totalChars = chapters.reduce((sum, c) => sum + c.charCount, 0);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/books/${book.id}/analyze`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info("Reading the book to find characters…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }, [book.id, router]);

  const cast = useCallback(async () => {
    setCasting(true);
    try {
      const res = await fetch(`/api/books/${book.id}/cast`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info("Casting voices…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Casting failed");
    } finally {
      setCasting(false);
    }
  }, [book.id, router]);

  const generateAll = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/${book.id}/generate-all`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info("Generating audio for all chapters…");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    }
  }, [book.id, router]);

  const cancelAll = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/${book.id}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info(data.cancelled > 0 ? "Cancelled — finishing the current step" : "Closed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }, [book.id, router]);

  const startPipeline = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/books/${book.id}/pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start guided setup");
    } finally {
      setStarting(false);
    }
  }, [book.id, router]);

  const hasCharacters = characters.length > 0;
  const allAssigned = hasCharacters && characters.every((c) => c.assignment);

  const primaryAction = livePipelineStage ? null : !hasCharacters ? (
    <Button onClick={startPipeline} disabled={busy || starting || !keys.anthropic}>
      {starting || liveBookStatus === "analyzing" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Wand2 className="h-4 w-4" />
      )}
      Run guided setup
    </Button>
  ) : !allAssigned ? (
    <Button onClick={cast} disabled={busy || !keys.anthropic || !keys.eleven}>
      {casting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      Auto-cast voices
    </Button>
  ) : (
    <Button
      onClick={generateAll}
      disabled={busy || !keys.eleven || liveChapters.every((c) => c.status === "ready")}
    >
      {liveBookStatus === "generating" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Play className="h-4 w-4" />
      )}
      Generate all chapters
    </Button>
  );

  const defaultTab = !hasCharacters
    ? "characters"
    : !allAssigned
      ? "voices"
      : liveChapters.some((c) => c.status === "ready")
        ? "listen"
        : "chapters";

  const bookError = progress?.book.error ?? book.error;

  return (
    <ReadOnlyProvider value={readOnly}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{book.title}</h1>
            <StatusBadge status={liveBookStatus} />
            {!readOnly && <EditBookDialog book={book} />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {book.author ? `by ${book.author} · ` : ""}
            {chapters.length} chapters · {totalChars.toLocaleString()} characters · ~
            {formatCredits(estimateCredits(totalChars, book.renderModel))} credits
            {book.povType ? ` · ${book.povType}-person narration` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <>
              <ShareDialog bookId={book.id} initialToken={shareToken} />
              <ModelPrefsPopover book={book} />
              {!livePipelineStage && hasCharacters && (
                <Button variant="outline" onClick={startPipeline} disabled={busy || starting}>
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  Guided setup
                </Button>
              )}
              {primaryAction}
            </>
          )}
        </div>
      </div>

      {!readOnly && livePipelineStage && (
        <PipelineCard
          bookId={book.id}
          stage={livePipelineStage}
          bookStatus={liveBookStatus}
          bookError={bookError}
          jobs={progress?.jobs ?? []}
          chapters={liveChapters}
          characters={characters}
          keys={keys}
          onNavigate={setTab}
          onCancel={cancelAll}
        />
      )}

      {bookError && liveBookStatus === "error" && !livePipelineStage && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{bookError}</AlertDescription>
        </Alert>
      )}

      <Tabs value={tab ?? defaultTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="characters">Characters</TabsTrigger>
          <TabsTrigger value="voices">Voices</TabsTrigger>
          <TabsTrigger value="chapters">Chapters</TabsTrigger>
          <TabsTrigger value="listen">Listen</TabsTrigger>
        </TabsList>
        <TabsContent value="characters" className="mt-4">
          <CharactersTab
            characters={characters}
            bookStatus={liveBookStatus}
            analyzeJob={runningJobs.find((j) => j.type === "analyze") ?? null}
            onAnalyze={analyze}
            onCancel={cancelAll}
            canAnalyze={keys.anthropic && !busy}
          />
        </TabsContent>
        <TabsContent value="voices" className="mt-4">
          <VoicesTab
            characters={characters}
            elevenReady={keys.eleven}
            onRecast={cast}
            casting={casting}
            busy={busy}
          />
        </TabsContent>
        <TabsContent value="chapters" className="mt-4">
          <ChaptersTab
            book={book}
            chapters={liveChapters}
            characters={characters}
            jobs={runningJobs}
            busy={busy}
            keys={keys}
            onGenerateAll={generateAll}
          />
        </TabsContent>
        <TabsContent value="listen" className="mt-4">
          <ListenTab book={book} chapters={liveChapters} />
        </TabsContent>
      </Tabs>
    </div>
    </ReadOnlyProvider>
  );
}
