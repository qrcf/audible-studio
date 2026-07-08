import Link from "next/link";
import { BookX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <BookX className="h-10 w-10 text-muted-foreground" />
      <div>
        <p className="text-lg font-medium">Not found</p>
        <p className="text-sm text-muted-foreground">
          This book doesn&apos;t exist — it may have been deleted.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Back to library</Link>
      </Button>
    </div>
  );
}
