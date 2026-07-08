"use client";

import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCredits } from "@/lib/format";

interface Credits {
  used: number;
  limit: number;
  tier: string;
}

export function CreditsBadge() {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/credits")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setCredits)
      .catch(() => setError(true));
  }, []);

  if (error || !credits) return null;

  const remaining = credits.limit - credits.used;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1.5 font-mono text-xs">
            <Coins className="h-3 w-3 text-primary" />
            {formatCredits(credits.used)} / {formatCredits(credits.limit)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          ElevenLabs credits used this cycle ({credits.tier} plan) —{" "}
          {formatCredits(remaining)} remaining
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
