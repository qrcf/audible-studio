"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertCircle, FileText, Loader2, Play, ScrollText, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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
import { StatusBadge } from "@/components/status-badge";
import { estimateCredits, formatCredits, formatDuration } from "@/lib/format";
import { ScriptSheet } from "./script-sheet";
import type { ApiKeysPresent, BookData, ChapterMeta, CharacterData, JobData } from "./types";

export function ChaptersTab({
  book,
  chapters,
  characters,
  jobs,
  busy,
  keys,
  onGenerateAll,
}: {
  book: BookData;
  chapters: ChapterMeta[];
  characters: CharacterData[];
  jobs: JobData[];
  busy: boolean;
  keys: ApiKeysPresent;
  onGenerateAll: () => void;
}) {
  const router = useRouter();
  const [scriptOpen, setScriptOpen] = useState<ChapterMeta | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const jobByChapter = new Map(jobs.filter((j) => j.chapterId).map((j) => [j.chapterId!, j]));
  const hasCast = characters.length > 0 && characters.every((c) => c.assignment);

  async function post(url: string, chapterId: string, okMessage: string) {
    setPending(chapterId);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.info(okMessage);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Scripting splits a chapter into narrator and character lines; generation renders
            each line with its cast voice and stitches the chapter MP3.
          </p>
          <Button onClick={onGenerateAll} disabled={busy || !hasCast || !keys.eleven}>
            <Play className="h-4 w-4" /> Generate all
          </Button>
        </div>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Length</TableHead>
                <TableHead className="text-right">~Credits</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[220px]">Progress</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chapters.map((ch) => {
                const job = jobByChapter.get(ch.id);
                const chapterBusy = ch.status === "scripting" || ch.status === "generating";
                const hasScript = !["pending", "scripting"].includes(ch.status);
                const rowPending = pending === ch.id;

                return (
                  <TableRow key={ch.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {ch.idx + 1}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <span className="block truncate font-medium">{ch.title}</span>
                      {ch.durationSec ? (
                        <span className="text-xs text-muted-foreground">
                          {formatDuration(ch.durationSec)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {(ch.charCount / 1000).toFixed(1)}k
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatCredits(estimateCredits(ch.charCount, book.renderModel))}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={ch.status} />
                        {ch.status === "error" && ch.error && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertCircle className="h-4 w-4 text-destructive" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">{ch.error}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {job && job.status === "running" ? (
                        <div className="flex items-center gap-1.5">
                          <div className="min-w-0 flex-1 space-y-1">
                            <Progress
                              value={job.total > 0 ? (job.done / job.total) * 100 : undefined}
                              className="h-1.5"
                            />
                            <p className="truncate text-xs text-muted-foreground">
                              {job.note ?? `${job.done}/${job.total}`}
                            </p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 text-muted-foreground"
                                onClick={() =>
                                  post(`/api/jobs/${job.id}/cancel`, ch.id, "Cancelling…")
                                }
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Cancel</TooltipContent>
                          </Tooltip>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {hasScript && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setScriptOpen(ch)}
                              >
                                <ScrollText className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>View script</TooltipContent>
                          </Tooltip>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={chapterBusy || rowPending || !keys.anthropic}
                          onClick={() =>
                            post(
                              `/api/chapters/${ch.id}/script`,
                              ch.id,
                              `Scripting “${ch.title}”…`
                            )
                          }
                        >
                          {rowPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                          {hasScript ? "Re-script" : "Script"}
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            !hasScript || chapterBusy || rowPending || !hasCast || !keys.eleven
                          }
                          onClick={() =>
                            post(
                              `/api/chapters/${ch.id}/generate`,
                              ch.id,
                              `Generating “${ch.title}”…`
                            )
                          }
                        >
                          <Play className="h-3.5 w-3.5" />
                          {ch.status === "ready" || ch.status === "stale"
                            ? "Regenerate"
                            : "Generate"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <ScriptSheet
        chapter={scriptOpen}
        characters={characters}
        renderModel={book.renderModel}
        onClose={() => setScriptOpen(null)}
      />
    </TooltipProvider>
  );
}
