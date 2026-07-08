"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Pencil, RefreshCw, Split, Users, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { EditProfileDialog } from "./edit-profile-dialog";
import { SplitAgesDialog } from "./split-ages-dialog";
import { useReadOnly } from "./read-only";
import type { CharacterData, JobData } from "./types";

export function CharactersTab({
  characters,
  bookStatus,
  analyzeJob,
  onAnalyze,
  onCancel,
  canAnalyze,
}: {
  characters: CharacterData[];
  bookStatus: string;
  analyzeJob: JobData | null;
  onAnalyze: () => void;
  onCancel: () => void;
  canAnalyze: boolean;
}) {
  const router = useRouter();
  const readOnly = useReadOnly();
  const [editFor, setEditFor] = useState<CharacterData | null>(null);
  const [splitFor, setSplitFor] = useState<CharacterData | null>(null);

  async function removeVariant(c: CharacterData) {
    try {
      const res = await fetch(`/api/characters/${c.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        `Lines moved to ${data.reassignedTo}` +
          (data.staleChapters > 0 ? ` — ${data.staleChapters} chapter(s) marked stale` : "")
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove variant");
    }
  }

  if (bookStatus === "analyzing" || analyzeJob) {
    const pct =
      analyzeJob && analyzeJob.total > 0
        ? Math.round((analyzeJob.done / analyzeJob.total) * 100)
        : null;
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <div>
            <p className="font-medium">Reading the book…</p>
            <p className="text-sm text-muted-foreground">
              {analyzeJob?.note ?? "Finding characters and the narrator's voice"}
            </p>
          </div>
          {pct !== null && <Progress value={pct} className="w-64" />}
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel analysis
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (characters.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">No characters yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Analysis reads the whole book, finds every speaking character, captures real
              quotes for voice previews, and profiles the narrator.
            </p>
          </div>
          {!readOnly && (
            <Button onClick={onAnalyze} disabled={!canAnalyze}>
              <Users className="h-4 w-4" />
              {bookStatus === "error" ? "Retry analysis" : "Analyze characters"}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {characters.filter((c) => !c.isNarrator).length} characters + narrator
        </p>
        {!readOnly && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={!canAnalyze}>
              <RefreshCw className="h-3.5 w-3.5" /> Re-run analysis
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Re-run character analysis?</AlertDialogTitle>
              <AlertDialogDescription>
                Reads the whole book again using the Analysis model picked under Models and
                rebuilds this cast list, re-detecting age variants. Voice assignments, script
                attributions, and manually edited profiles are kept for characters whose names
                still match; characters that disappear lose theirs (their lines get flagged for
                review).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onAnalyze}>Re-run analysis</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        )}
      </div>
      <div className="rounded-lg border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">Character</TableHead>
              <TableHead className="w-[32%]">Profile</TableHead>
              <TableHead className="w-[104px]">Share</TableHead>
              <TableHead>Sample quote</TableHead>
              {!readOnly && <TableHead className="w-[112px] text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {characters.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="overflow-hidden">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {c.variantGroup ? c.variantGroup : c.name}
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
                    {c.profileEdited && (
                      <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                        edited
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[
                      c.isNarrator ? null : c.role,
                      c.aliases.length > 0 ? `aka ${c.aliases.join(", ")}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </TableCell>
                <TableCell className="overflow-hidden">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-default">
                        <div className="truncate text-sm">
                          {[
                            c.profile.gender,
                            c.profile.ageRange,
                            c.profile.heritage || c.profile.accentHint,
                          ]
                            .filter((x) => x && x !== "unknown")
                            .join(" · ") || "—"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.profile.personality}
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">
                      <p>{c.profile.personality}</p>
                      {c.profile.speechStyle && (
                        <p className="mt-1 text-muted-foreground">
                          Speech: {c.profile.speechStyle}
                        </p>
                      )}
                      {c.profile.heritage && (
                        <p className="mt-1 text-muted-foreground">
                          Heritage: {c.profile.heritage}
                        </p>
                      )}
                      {c.profile.voiceTexture && (
                        <p className="mt-1 text-muted-foreground">
                          Voice: {c.profile.voiceTexture}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="overflow-hidden">
                  {c.isNarrator ? (
                    <span className="text-xs text-muted-foreground">prose</span>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Progress value={c.dialogueShare * 100} className="h-1.5 w-10" />
                      <span className="font-mono text-xs text-muted-foreground">
                        {Math.round(c.dialogueShare * 100)}%
                      </span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="overflow-hidden">
                  {c.quotes[0] ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="truncate text-sm italic text-muted-foreground">
                          “{c.quotes[0]}”
                        </p>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-md space-y-1">
                        {c.quotes.slice(0, 5).map((q, i) => (
                          <p key={i} className="italic">
                            “{q}”
                          </p>
                        ))}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                {!readOnly && (
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setEditFor(c)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit profile</TooltipContent>
                    </Tooltip>
                    {!c.isNarrator && !c.variantGroup && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setSplitFor(c)}
                          >
                            <Split className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Split into age variants</TooltipContent>
                      </Tooltip>
                    )}
                    {c.variantGroup && (
                      <AlertDialog>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                          </TooltipTrigger>
                          <TooltipContent>Remove this variant</TooltipContent>
                        </Tooltip>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove {c.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Its lines move to the sibling variant and affected chapters are
                              marked stale. If only one variant remains it becomes a regular
                              character again.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeVariant(c)}>
                              Remove variant
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      </div>
      <EditProfileDialog character={editFor} onClose={() => setEditFor(null)} />
      <SplitAgesDialog character={splitFor} onClose={() => setSplitFor(null)} />
    </TooltipProvider>
  );
}
