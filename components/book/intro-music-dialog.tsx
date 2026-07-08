"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Music2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { BookData } from "./types";

/**
 * Write/persist an optional custom brief for the intro music bed. Blank falls
 * back to the mood auto-derived from the narrator profile. Saving only stores
 * the text — (re)generating the intro is what applies it.
 */
export function IntroMusicDialog({ book }: { book: BookData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(book.introMusicPrompt ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/books/${book.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ introMusicPrompt: prompt.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        book.introAudioPath
          ? "Saved — regenerate the intro to apply the new music"
          : "Saved — it'll be used when you generate the intro"
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
        if (o) setPrompt(book.introMusicPrompt ?? "");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Intro music prompt">
          <Music2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Intro music</DialogTitle>
          <DialogDescription>
            Describe the instrumental bed under the spoken title. Leave blank to auto-theme it from
            the book&apos;s mood.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={prompt}
          rows={4}
          placeholder="e.g. Warm solo piano, gentle and hopeful, resolving cleanly. No vocals."
          onChange={(e) => setPrompt(e.target.value)}
        />
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
