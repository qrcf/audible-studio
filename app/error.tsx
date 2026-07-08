"use client";

import { RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-16">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>{error.message || "An unexpected error occurred."}</AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline">
        <RotateCcw className="h-4 w-4" /> Try again
      </Button>
    </div>
  );
}
