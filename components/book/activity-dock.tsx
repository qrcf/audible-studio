"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Clock, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChapterMeta, JobData } from "./types";

const LABELS: Record<JobData["type"], string> = {
  analyze: "Analyzing the book",
  cast: "Casting voices",
  script: "Scripting",
  generate: "Generating",
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

const STORAGE_KEY = "audible:activity-open";

/**
 * One condensed, collapsible surface for every in-flight and queued operation —
 * replaces the old one-tall-card-per-job strip. Collapsed by default: a single
 * summary line ("3 running · 2 queued"); expands to a scrollable list of 1-line
 * rows, each with its own cancel. Driven by the poll's job rows (DB-backed), so
 * it survives refreshes and reflects real progress.
 */
export function ActivityDock({
  jobs,
  chapters,
  onCancelAll,
}: {
  jobs: JobData[];
  chapters: ChapterMeta[];
  onCancelAll?: () => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Restore the persisted expand state. Safe as a lazy initializer: the dock is
  // only mounted once the poll has jobs (client-side), so there's no SSR render
  // to mismatch. Defaults collapsed.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Tick once a second so elapsed/ETA advance between 2s polls.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (jobs.length === 0) return null;

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const cancelOne = (id: string) => {
    fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
  };

  const running = jobs.filter((j) => j.status === "running").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const summary =
    [running ? `${running} running` : null, queued ? `${queued} queued` : null]
      .filter(Boolean)
      .join(" · ") || "Working";

  return (
    <Card className="gap-0 border-primary/20 py-0">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span className="truncate text-sm font-medium">{summary}</span>
        </button>
        {onCancelAll && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
            onClick={onCancelAll}
          >
            Cancel all
          </Button>
        )}
        <button
          type="button"
          onClick={toggle}
          className="shrink-0 text-muted-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <ScrollArea className="max-h-64 border-t border-foreground/10">
          <div className="divide-y divide-foreground/5">
            {jobs.map((job) => {
              const isRunning = job.status === "running";
              const pct = isRunning && job.total > 0 ? (job.done / job.total) * 100 : undefined;
              const { elapsed, eta } = timing(job, nowMs);
              return (
                <div key={job.id} className="flex items-center gap-3 px-4 py-2">
                  {isRunning ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm">{jobLabel(job, chapters)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {isRunning ? `${elapsed}${eta ? ` · ${eta}` : ""}` : "Queued"}
                      </span>
                    </div>
                    {isRunning && <Progress value={pct} className="mt-1 h-1" />}
                    {isRunning && job.note && (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{job.note}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => cancelOne(job.id)}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    aria-label="Cancel this job"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}
