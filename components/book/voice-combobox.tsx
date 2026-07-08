"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { VoiceData } from "./types";

/** Searchable, scrollable voice picker — the catalog can run to hundreds of voices. */
export function VoiceCombobox({
  voices,
  value,
  selectedLabel,
  onChange,
  disabled,
  loading,
}: {
  voices: VoiceData[];
  value: string | undefined;
  /** Shown when `value` isn't in `voices` (e.g. a voice removed from the account). */
  selectedLabel?: string;
  onChange: (voiceId: string) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = voices.find((v) => v.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((v) =>
      [v.name, v.gender, v.age, v.accent, v.descriptive, v.description].some((f) =>
        f?.toLowerCase().includes(q)
      )
    );
  }, [voices, query]);

  // Keep the active row on screen as the arrow keys move it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(v: VoiceData) {
    onChange(v.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const v = filtered[active];
      if (v) choose(v);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || loading}
          className="w-full min-w-0 justify-between font-normal"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <span className="min-w-0 truncate" title={selected?.name ?? selectedLabel}>
              {selected?.name ?? selectedLabel ?? "Pick a voice"}
            </span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 opacity-50" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search voices…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No voices found</p>
          ) : (
            filtered.map((v, i) => (
              <button
                key={v.id}
                type="button"
                data-index={i}
                onClick={() => choose(v)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  i === active && "bg-accent",
                  v.id === value && "font-medium"
                )}
              >
                <Check
                  className={cn("h-3.5 w-3.5 shrink-0", v.id === value ? "opacity-100" : "opacity-0")}
                />
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[v.gender, v.age, v.accent].filter(Boolean).join(" · ")}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
