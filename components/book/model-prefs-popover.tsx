"use client";

import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_LLM_MODEL,
  LLM_MODELS,
  LLM_STEPS,
  type LlmStep,
  type ModelPrefs,
} from "@/lib/llm-models";
import type { BookData } from "./types";

export function ModelPrefsPopover({ book }: { book: BookData }) {
  const router = useRouter();
  const prefs = book.modelPrefs ?? {};

  async function patch(
    body: { modelPrefs: ModelPrefs } | { renderModel: string } | { sfxEnabled: boolean },
    ok: string
  ) {
    const res = await fetch(`/api/books/${book.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to save");
      return;
    }
    toast.success(ok);
    router.refresh();
  }

  function setStepModel(step: LlmStep, modelId: string) {
    const next = { ...prefs, [step]: modelId } as ModelPrefs;
    const label = LLM_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
    void patch(
      { modelPrefs: next },
      `${LLM_STEPS.find((s) => s.step === step)?.label} → ${label}`
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Settings2 className="h-4 w-4" />
          Models
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-4">
        <div>
          <p className="text-sm font-medium">Models</p>
          <p className="text-xs text-muted-foreground">
            Pick which model runs each step of the pipeline.
          </p>
        </div>

        {LLM_STEPS.map(({ step, label, description }) => (
          <div key={step} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label className="text-sm">{label}</Label>
              <p className="truncate text-xs text-muted-foreground">{description}</p>
            </div>
            <Select
              value={prefs[step] ?? DEFAULT_LLM_MODEL}
              onValueChange={(v) => setStepModel(step, v)}
            >
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LLM_MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span>{m.label}</span>
                    <span className="text-xs text-muted-foreground"> · {m.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <Label className="text-sm">Audio</Label>
            <p className="truncate text-xs text-muted-foreground">ElevenLabs render quality</p>
          </div>
          <Select
            value={book.renderModel}
            onValueChange={(v) =>
              patch(
                { renderModel: v },
                v === "eleven_flash_v2_5"
                  ? "Draft mode — half credits, faster"
                  : v === "eleven_v3"
                    ? "Expressive mode — inflection tags, boldest acting. Regenerating re-renders every segment."
                    : "Multilingual v2 — steadiest long-form output"
              )
            }
          >
            <SelectTrigger className="w-44 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eleven_v3">Best · Eleven v3</SelectItem>
              <SelectItem value="eleven_multilingual_v2">Multilingual v2</SelectItem>
              <SelectItem value="eleven_flash_v2_5">Draft · Flash (½ cost)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <Label className="text-sm">Sound effects</Label>
            <p className="truncate text-xs text-muted-foreground">
              Very rare, shown in the script; applies at next scripting
            </p>
          </div>
          <Switch
            checked={book.sfxEnabled}
            onCheckedChange={(checked) =>
              patch(
                { sfxEnabled: checked },
                checked
                  ? "Sound effects on — at most a couple per chapter, only when the text names one"
                  : "Sound effects off for this book"
              )
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
