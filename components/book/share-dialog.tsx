"use client";

import { useState } from "react";
import { Check, Copy, Link2, Loader2, RefreshCw, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Owner-only control to mint / copy / revoke a book's read-only share link.
 * One link per book: generating when one exists replaces it (old URL dies).
 */
export function ShareDialog({
  bookId,
  initialToken,
}: {
  bookId: string;
  initialToken: string | null;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Absolute URL is built from the current origin so it matches the host the
  // owner is on (localhost in dev, the deployment domain in prod). Guard
  // `window` so this is SSR-safe; the value is only shown inside the popover,
  // which mounts on the client.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = token ? `${origin}/share/${token}` : null;

  async function mutate(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      const res = await fetch(`/api/books/${bookId}/share`, { method });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setToken(method === "POST" ? data.token : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually");
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Share2 className="h-4 w-4" />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-medium">Share this book</p>
          <p className="text-xs text-muted-foreground">
            Anyone with the link can view — not edit — this book without signing in.
          </p>
        </div>

        {url ? (
          <>
            <div className="flex gap-2">
              <Input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button variant="outline" size="icon" className="shrink-0" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => mutate("DELETE")}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Revoke
              </Button>
              <Button variant="ghost" size="sm" onClick={() => mutate("POST")} disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" />
                Regenerate
              </Button>
            </div>
          </>
        ) : (
          <Button className="w-full" onClick={() => mutate("POST")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Generate link
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
