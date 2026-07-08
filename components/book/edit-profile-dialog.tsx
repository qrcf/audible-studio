"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CharacterData } from "./types";

export function EditProfileDialog({
  character,
  onClose,
}: {
  character: CharacterData | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={character !== null} onOpenChange={(open) => !open && onClose()}>
      {character && (
        // Keyed so the form state resets per character
        <ProfileForm key={character.id} character={character} onClose={onClose} />
      )}
    </Dialog>
  );
}

function ProfileForm({
  character,
  onClose,
}: {
  character: CharacterData;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    gender: character.profile.gender,
    ageRange: character.profile.ageRange,
    accentHint: character.profile.accentHint,
    heritage: character.profile.heritage ?? "",
    voiceTexture: character.profile.voiceTexture ?? "",
    personality: character.profile.personality,
    speechStyle: character.profile.speechStyle,
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/characters/${character.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success("Profile saved — it will guide the next voice casting");
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSaving(false);
    }
  }

  const textFields: { key: keyof typeof form; label: string; placeholder: string }[] = [
    { key: "ageRange", label: "Age", placeholder: "e.g. 30s, elderly, 8-10" },
    { key: "heritage", label: "Heritage / ethnicity", placeholder: "e.g. Hawaiian, Russian émigré" },
    { key: "accentHint", label: "Accent", placeholder: "e.g. Southern US, RP British" },
    { key: "voiceTexture", label: "Voice texture", placeholder: "e.g. gravelly and deep" },
    { key: "personality", label: "Personality", placeholder: "Short sketch" },
    { key: "speechStyle", label: "Speech style", placeholder: "e.g. clipped, formal" },
  ];

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Edit profile — {character.name}</DialogTitle>
        <DialogDescription>
          These details steer voice casting. Your edits survive re-analysis as long as the
          character keeps this exact name.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-[110px_1fr] items-center gap-3">
          <Label className="text-xs">Gender</Label>
          <Select value={form.gender} onValueChange={set("gender")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="male">male</SelectItem>
              <SelectItem value="female">female</SelectItem>
              <SelectItem value="nonbinary">nonbinary</SelectItem>
              <SelectItem value="unknown">unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {textFields.map(({ key, label, placeholder }) => (
          <div key={key} className="grid grid-cols-[110px_1fr] items-center gap-3">
            <Label className="text-xs">{label}</Label>
            <Input
              value={form[key]}
              placeholder={placeholder}
              onChange={(e) => set(key)(e.target.value)}
            />
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save profile
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
