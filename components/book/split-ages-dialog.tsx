"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CharacterData } from "./types";

export function SplitAgesDialog({
  character,
  onClose,
}: {
  character: CharacterData | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={character !== null} onOpenChange={(open) => !open && onClose()}>
      {character && <SplitForm key={character.id} character={character} onClose={onClose} />}
    </Dialog>
  );
}

function SplitForm({
  character,
  onClose,
}: {
  character: CharacterData;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState([
    { label: "child", ageRange: "" },
    { label: "adult", ageRange: character.profile.ageRange },
  ]);

  async function save() {
    if (rows.some((r) => !r.label.trim())) {
      toast.error("Every life stage needs a label");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/characters/${character.id}/variants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variants: rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        `Split into ${data.characters.length} age variants — assign voices to the new ones`
      );
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to split");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Split {character.name} into age variants</DialogTitle>
        <DialogDescription>
          One person, different voices per life stage. The <strong>first</strong> stage keeps the
          current voice and all attributed lines; the others start uncast — re-script chapters (or
          reassign lines in the script viewer) to move dialogue between stages.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={row.label}
              placeholder="Stage (e.g. child)"
              className="w-40"
              onChange={(e) =>
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
              }
            />
            <Input
              value={row.ageRange}
              placeholder="Age range (e.g. 8-10)"
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((r, j) => (j === i ? { ...r, ageRange: e.target.value } : r))
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={rows.length <= 2}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              aria-label="Remove stage"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRows((rs) => [...rs, { label: "", ageRange: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> Add stage
        </Button>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Split
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
