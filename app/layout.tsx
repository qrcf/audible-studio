import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { AudioLines } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { CreditsBadge } from "@/components/credits-badge";
import { readAuthContext } from "@/lib/auth/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Audiobook Studio",
  description: "Turn any book into a multi-voice audiobook with ElevenLabs",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Viewers see a book they don't own — don't expose the account's credit usage.
  const ctx = await readAuthContext();
  const isViewer = ctx?.role === "viewer";
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <AudioLines className="h-5 w-5 text-primary" />
              Audiobook Studio
            </Link>
            {!isViewer && <CreditsBadge />}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <Toaster />
      </body>
    </html>
  );
}
