import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STYLES: Record<string, { label: string; className: string }> = {
  // book statuses
  parsed: { label: "Parsed", className: "bg-muted text-muted-foreground" },
  analyzing: { label: "Analyzing…", className: "bg-blue-500/15 text-blue-400" },
  analyzed: { label: "Analyzed", className: "bg-blue-500/15 text-blue-400" },
  casting: { label: "Casting…", className: "bg-violet-500/15 text-violet-400" },
  cast: { label: "Cast", className: "bg-violet-500/15 text-violet-400" },
  generating: { label: "Generating…", className: "bg-amber-500/15 text-amber-400" },
  ready: { label: "Ready", className: "bg-emerald-500/15 text-emerald-400" },
  error: { label: "Error", className: "bg-destructive/15 text-destructive" },
  // chapter statuses
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
  scripting: { label: "Scripting…", className: "bg-blue-500/15 text-blue-400" },
  scripted: { label: "Scripted", className: "bg-blue-500/15 text-blue-400" },
  stale: { label: "Stale", className: "bg-orange-500/15 text-orange-400" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STYLES[status] ?? { label: status, className: "bg-muted" };
  return (
    <Badge variant="secondary" className={cn("border-transparent", style.className, className)}>
      {style.label}
    </Badge>
  );
}
