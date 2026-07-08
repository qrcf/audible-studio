"use client";

import { createContext, useContext } from "react";

// Read-only mode for share-link viewers. Provided once at the BookView root so
// deeply nested tabs/dialogs/popovers can hide edit affordances without every
// component threading a prop. Server-side enforcement lives in proxy.ts + the
// per-route checks; this only controls what the UI offers.
const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>;
}

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
