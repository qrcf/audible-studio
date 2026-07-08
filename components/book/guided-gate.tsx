"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ListMusic, Play, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ApiKeysPresent, ChapterMeta, CharacterData, JobData } from "./types";

const RUNNING_STAGES = ["analyzing", "casting", "scripting_sample", "generating_sample"];

/**
 * The human decision points of guided setup — cast review, voice review, sample
 * ready — plus a Retry surface if a stage's worker died. Running-stage progress
 * now lives in the ActivityDock (this renders nothing while a stage is healthily
 * running), so the old full-width stepper card is gone.
 */
export function GuidedGate({
  bookId,
  stage,
  bookStatus,
  bookError,
  jobs,
  jobsLoaded,
  chapters,
  characters,
  keys,
  onNavigate,
  onCancel,
}: {
  bookId: string;
  stage: string;
  bookStatus: string;
  bookError: string | null;
  jobs: JobData[];
  jobsLoaded: boolean;
  chapters: ChapterMeta[];
  characters: CharacterData[];
  keys: ApiKeysPresent;
  onNavigate: (tab: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const sample = chapters.find((c) => c.title !== "Front Matter") ?? chapters[0];
  const jobType: JobData["type"] | undefined = (
    { analyzing: "analyze", casting: "cast", scripting_sample: "script", generating_sample: "generate" } as const
  )[stage as "analyzing" | "casting" | "scripting_sample" | "generating_sample"];
  const job = jobType
    ? jobs.find(
        (j) =>
          j.type === jobType &&
          (j.status === "running" || j.status === "queued") &&
          (jobType === "script" || jobType === "generate" ? j.chapterId === sample?.id : true)
      )
    : undefined;

  const bookFailed = ["analyzing", "casting"].includes(stage) && bookStatus === "error";
  const sampleFailed =
    ["scripting_sample", "generating_sample"].includes(stage) && sample?.status === "error";
  // A running-type stage with no live job means the worker died (dev restart) —
  // surface Retry instead of leaving the dock empty. Only once jobs have loaded.
  const orphaned =
    jobsLoaded && RUNNING_STAGES.includes(stage) && !job && !bookFailed && !sampleFailed;
  const failed = bookFailed || sampleFailed || orphaned;
  const failureMessage =
    (bookFailed ? bookError : sampleFailed ? sample?.error : null) ??
    jobs.find((j) => j.status === "failed")?.error ??
    "The step failed.";

  // Healthy running stage → the dock shows progress; nothing to gate here.
  if (!failed && RUNNING_STAGES.includes(stage)) return null;

  async function post(url: string, body?: object) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Request failed");
    return data;
  }

  async function run(fn: () => Promise<unknown>) {
    setPending(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  }

  const action = (name: string, okMessage?: string) =>
    run(async () => {
      await post(`/api/books/${bookId}/pipeline`, { action: name });
      if (okMessage) toast.info(okMessage);
    });

  const generateRemaining = () =>
    run(async () => {
      await post(`/api/books/${bookId}/generate-all`);
      await post(`/api/books/${bookId}/pipeline`, { action: "dismiss" });
      toast.info("Generating the remaining chapters…");
    });

  const speakingCast = characters.filter((c) => !c.isNarrator);
  const remaining = chapters.filter((c) => c.status !== "ready").length;
  const bothKeys = keys.anthropic && keys.eleven;

  return (
    <Card size="sm" className="border-primary/20">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Wand2 className="h-4 w-4 shrink-0 text-primary" />
          <p className="min-w-0 text-sm">
            {failed ? (
              <span className="text-destructive">{failureMessage}</span>
            ) : stage === "cast_review" ? (
              <span className="text-muted-foreground">
                Found {speakingCast.length} character{speakingCast.length === 1 ? "" : "s"} plus the
                narrator. Review the cast, then approve to pick voices.
              </span>
            ) : stage === "voice_review" ? (
              <span className="text-muted-foreground">
                Voices are assigned. Preview each (or pick your own), then approve to hear a sample.
              </span>
            ) : stage === "sample_ready" ? (
              <span className="text-muted-foreground">
                “{sample?.title}” is ready — give it a listen, then generate the rest.
              </span>
            ) : (
              <span className="text-muted-foreground">Guided setup</span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {failed ? (
            <Button size="sm" onClick={() => action("retry", "Retrying…")} disabled={pending}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </Button>
          ) : stage === "cast_review" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onNavigate("characters")}>
                Review characters
              </Button>
              <Button
                size="sm"
                onClick={() => action("approve_cast", "Casting voices…")}
                disabled={pending || !bothKeys}
              >
                <Sparkles className="h-3.5 w-3.5" /> Approve &amp; cast
              </Button>
            </>
          ) : stage === "voice_review" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onNavigate("voices")}>
                Review voices
              </Button>
              <Button
                size="sm"
                onClick={() => action("approve_voices", `Creating “${sample?.title}”…`)}
                disabled={pending || !bothKeys}
              >
                <Play className="h-3.5 w-3.5" /> Approve &amp; sample
              </Button>
            </>
          ) : stage === "sample_ready" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onNavigate("listen")}>
                <Play className="h-3.5 w-3.5" /> Play sample
              </Button>
              {remaining > 0 ? (
                <Button size="sm" onClick={generateRemaining} disabled={pending || !keys.eleven}>
                  <ListMusic className="h-3.5 w-3.5" /> Generate remaining {remaining}
                </Button>
              ) : (
                <Button size="sm" onClick={() => action("dismiss")} disabled={pending}>
                  <Check className="h-3.5 w-3.5" /> Done
                </Button>
              )}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={onCancel}
            disabled={pending}
            aria-label="Cancel guided setup"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
