"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// One shared audio element so starting a preview stops the previous one
let sharedAudio: HTMLAudioElement | null = null;
let activeStop: (() => void) | null = null;

function getAudio(): HTMLAudioElement {
  if (!sharedAudio) sharedAudio = new Audio();
  return sharedAudio;
}

export function PreviewButton({
  getUrl,
  label,
  variant = "ghost",
}: {
  /** Return a playable URL (object URL or remote). Called on each play. */
  getUrl: () => Promise<string>;
  label: string;
  variant?: "ghost" | "outline";
}) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function toggle() {
    const audio = getAudio();
    if (playing) {
      audio.pause();
      setPlaying(false);
      activeStop = null;
      return;
    }
    activeStop?.(); // stop whatever else is playing
    setLoading(true);
    try {
      const url = await getUrl();
      if (!mounted.current) return;
      audio.src = url;
      audio.onended = () => {
        if (mounted.current) setPlaying(false);
        activeStop = null;
      };
      await audio.play();
      setPlaying(true);
      activeStop = () => {
        audio.pause();
        if (mounted.current) setPlaying(false);
      };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Playback failed");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={variant} size="icon" className="h-8 w-8" onClick={toggle}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : playing ? (
              <Square className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** POST /api/preview and return an object URL for the rendered snippet. */
export async function fetchPreviewUrl(body: {
  voiceId: string;
  text: string;
  settings?: unknown;
}): Promise<string> {
  const res = await fetch("/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Preview failed");
  }
  return URL.createObjectURL(await res.blob());
}
