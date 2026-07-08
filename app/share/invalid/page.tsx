import { Unlink } from "lucide-react";

export const metadata = { title: "Link not available · Audiobook Studio" };

export default function ShareInvalidPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
      <Unlink className="h-8 w-8 text-muted-foreground" />
      <h1 className="text-xl font-semibold tracking-tight">This link is no longer active</h1>
      <p className="text-sm text-muted-foreground">
        The share link has been revoked or replaced. Ask the owner for a new one.
      </p>
    </div>
  );
}
