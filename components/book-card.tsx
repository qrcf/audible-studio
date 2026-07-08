"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MoreVertical, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { books } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/status-badge";
import { estimateCredits, formatCredits } from "@/lib/format";

type Book = typeof books.$inferSelect;

export function BookCard({
  book,
  chapterCount,
  charCount,
  characterCount,
}: {
  book: Book;
  chapterCount: number;
  charCount: number;
  characterCount: number;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmOpen(false);
    if (res.ok) {
      toast.success(`Deleted “${book.title}”`);
      router.refresh();
    } else {
      toast.error("Failed to delete book");
    }
  }

  return (
    <>
      <Card className="group relative transition-colors hover:border-primary/40">
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <Link href={`/books/${book.id}`} className="min-w-0">
            <CardTitle className="truncate text-base leading-snug hover:underline">
              {book.title}
            </CardTitle>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {book.sourceFileName}
            </p>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4" /> Delete book
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <StatusBadge status={book.status} />
              {characterCount > 0 && (
                <span className="text-muted-foreground">{characterCount} voices</span>
              )}
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {chapterCount} ch · ~{formatCredits(estimateCredits(charCount, book.renderModel))} cr
            </span>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{book.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the book, its characters, scripts, and all generated audio.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
