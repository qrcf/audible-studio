"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BookData } from "./types";

/** Edit the book's title and author — used in the library and the spoken intro. */
export function EditBookDialog({ book }: { book: BookData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) {
      toast.error("Title can't be empty");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/books/${book.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), author: author.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        book.introAudioPath
          ? "Saved — regenerate the intro (Listen tab) to update the spoken title"
          : "Saved"
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setTitle(book.title);
          setAuthor(book.author ?? "");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Edit title & author">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Title &amp; author</DialogTitle>
          <DialogDescription>Shown in your library and read aloud in the book intro.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="book-title">Title</Label>
            <Input id="book-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="book-author">Author</Label>
            <Input
              id="book-author"
              value={author}
              placeholder="Unknown author"
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
