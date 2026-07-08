"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertCircle,
  Check,
  ListMusic,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ApiKeysPresent, ChapterMeta, CharacterData, JobData } from "./types";

const STEPS = [
  "Analyze",
  "Review characters",
  "Cast voices",
  "Review voices",
  "Create sample",
  "Listen",
];

const RUNNING_STAGES = ["analyzing", "casting", "scripting_sample", "generating_sample"];

function stageIndex(stage: string): number {
  switch (stage) {
    case "analyzing":
      return 0;
    case "cast_review":
      return 1;
    case "casting":
      return 2;
    case "voice_review":
      return 3;
    case "scripting_sample":
    case "generating_sample":
      return 4;
    case "sample_ready":
      return 5;
    default:
      return 0;
  }
}

const STAGE_JOB_TYPE: Record<string, JobData["type"]> = {
  analyzing: "analyze",
  casting: "cast",
  scripting_sample: "script",
  generating_sample: "generate",
};

export function PipelineCard({
  bookId,
  stage,
  bookStatus,
  bookError,
  jobs,
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
  chapters: ChapterMeta[];
  characters: CharacterData[];
  keys: ApiKeysPresent;
  onNavigate: (tab: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const sample = chapters.find((c) => c.title !== "Front Matter") ?? chapters[0];
  const idx = stageIndex(stage);
  const jobType = STAGE_JOB_TYPE[stage];
  const job = jobType
    ? jobs.find(
        (j) =>
          j.type === jobType &&
          j.status === "running" &&
          (jobType === "script" || jobType === "generate" ? j.chapterId === sample?.id : true)
      )
    : undefined;

  const bookFailed = ["analyzing", "casting"].includes(stage) && bookStatus === "error";
  const sampleFailed =
    ["scripting_sample", "generating_sample"].includes(stage) && sample?.status === "error";
  // A running-type stage with no live job means the worker died (e.g. the dev
  // server restarted mid-run) — surface Retry instead of spinning forever.
  const orphaned = RUNNING_STAGES.includes(stage) && !job && !bookFailed && !sampleFailed;
  const failed = bookFailed || sampleFailed || orphaned;
  const failureMessage =
    (bookFailed ? bookError : sampleFailed ? sample?.error : null) ??
    jobs.find((j) => j.status === "failed")?.error ??
    "The step failed.";
  const running = !failed && RUNNING_STAGES.includes(stage);

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
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Guided setup</p>
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

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {STEPS.map((label, i) => {
            const done = i < idx || stage === "sample_ready";
            const active = i === idx && stage !== "sample_ready";
            return (
              <div key={label} className="flex min-w-0 items-center gap-2">
                {i > 0 && <div className="h-px w-4 shrink-0 bg-border sm:w-6" />}
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                    done && "border-emerald-500/50 bg-emerald-500/15 text-emerald-400",
                    active && !failed && "border-primary/50 bg-primary/15 text-primary",
                    active && failed && "border-destructive/50 bg-destructive/15 text-destructive",
                    !done && !active && "border-border text-muted-foreground"
                  )}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : active && failed ? (
                    <AlertCircle className="h-3.5 w-3.5" />
                  ) : active && running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={cn(
                    "whitespace-nowrap text-xs",
                    active ? "font-medium text-foreground" : "text-muted-foreground"
                  )}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        {failed ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-destructive">{failureMessage}</p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => action("retry", "Retrying…")} disabled={pending}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          </div>
        ) : running ? (
          <div className="space-y-1.5">
            <Progress
              value={job && job.total > 0 ? (job.done / job.total) * 100 : undefined}
              className="h-1.5"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {job?.note ??
                  (stage === "scripting_sample"
                    ? `Scripting “${sample?.title}”…`
                    : stage === "generating_sample"
                      ? `Rendering “${sample?.title}”…`
                      : "Working…")}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
                onClick={onCancel}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : stage === "cast_review" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Found {speakingCast.length} character{speakingCast.length === 1 ? "" : "s"} plus the
              narrator. Check the cast list, then approve to pick voices.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("characters")}>
                Review characters
              </Button>
              <Button
                size="sm"
                onClick={() => action("approve_cast", "Casting voices…")}
                disabled={pending || !bothKeys}
              >
                <Sparkles className="h-3.5 w-3.5" /> Approve & cast voices
              </Button>
            </div>
          </div>
        ) : stage === "voice_review" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Voices are assigned. Preview each one (or pick your own), then approve to hear a
              sample chapter.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("voices")}>
                Review voices
              </Button>
              <Button
                size="sm"
                onClick={() => action("approve_voices", `Creating “${sample?.title}”…`)}
                disabled={pending || !bothKeys}
              >
                <Play className="h-3.5 w-3.5" /> Approve & create sample
              </Button>
            </div>
          </div>
        ) : stage === "sample_ready" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              “{sample?.title}” is ready — give it a listen. Happy with it? Generate the rest.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => onNavigate("listen")}>
                <Play className="h-3.5 w-3.5" /> Play sample
              </Button>
              {remaining > 0 ? (
                <Button size="sm" onClick={generateRemaining} disabled={pending || !keys.eleven}>
                  <ListMusic className="h-3.5 w-3.5" /> Generate remaining {remaining} chapter
                  {remaining === 1 ? "" : "s"}
                </Button>
              ) : (
                <Button size="sm" onClick={() => action("dismiss")} disabled={pending}>
                  <Check className="h-3.5 w-3.5" /> Done
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
