"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDuration } from "@/lib/format";
import type { ChapterMeta, JobData } from "./types";

const LABELS: Record<JobData["type"], string> = {
  analyze: "Analyzing the book",
  cast: "Casting voices",
  script: "Scripting",
  generate: "Generating audio",
  intro: "Generating intro",
};

function jobLabel(job: JobData, chapters: ChapterMeta[]): string {
  const base = LABELS[job.type] ?? "Working";
  if ((job.type === "script" || job.type === "generate") && job.chapterId) {
    const ch = chapters.find((c) => c.id === job.chapterId);
    if (ch) return `${base} · ${ch.title}`;
  }
  return base;
}

/** Elapsed since the job started, and a rough ETA once it has real progress. */
function timing(job: JobData, nowMs: number): { elapsed: string; eta: string | null } {
  const startedMs = Date.parse(job.createdAt);
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 1000) : 0;
  const elapsed = formatDuration(elapsedSec);
  if (job.total > 0 && job.done > 0 && job.done < job.total && elapsedSec > 2) {
    const remainingSec = (elapsedSec / job.done) * (job.total - job.done);
    return { elapsed, eta: `~${formatDuration(remainingSec)} left` };
  }
  return { elapsed, eta: null };
}

/**
 * A compact, always-visible strip of the book's running operations. Driven by
 * the poll's job rows (DB-backed), so it reflects real progress and reappears
 * after a refresh. Shown outside guided setup, where the PipelineCard is the
 * richer surface.
 */
export function ProgressStrip({
  jobs,
  chapters,
}: {
  jobs: JobData[];
  chapters: ChapterMeta[];
}) {
  // Tick once a second so elapsed/ETA advance between 2s polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (jobs.length === 0) return null;

  return (
    <Card className="border-primary/20">
      <CardContent className="space-y-3 py-4">
        {jobs.map((job) => {
          const pct = job.total > 0 ? (job.done / job.total) * 100 : undefined;
          const { elapsed, eta } = timing(job, nowMs);
          return (
            <div key={job.id} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  <span className="truncate">{jobLabel(job, chapters)}</span>
                </p>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {elapsed}
                  {eta ? ` · ${eta}` : ""}
                </span>
              </div>
              <Progress value={pct} className="h-1.5" />
              {job.note && <p className="text-xs text-muted-foreground">{job.note}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
