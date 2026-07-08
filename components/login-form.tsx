"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function postJson(url: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState<"signin" | "register" | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [setupSecret, setSetupSecret] = useState("");

  function onSuccess() {
    const next = searchParams.get("next");
    const dest = next && next.startsWith("/") ? next : "/";
    // Full-document navigation: forces a clean load where the proxy re-reads
    // the freshly-set session cookie. A client router.replace can stall right
    // after the WebAuthn ceremony and leave the button spinning.
    window.location.replace(dest);
  }

  async function signIn() {
    setBusy("signin");
    try {
      const options = await postJson("/api/auth/login/options");
      const assertion = await startAuthentication({ optionsJSON: options });
      await postJson("/api/auth/login/verify", assertion);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(null);
    }
  }

  async function register() {
    setBusy("register");
    try {
      const headers = { "x-setup-secret": setupSecret.trim() };
      const options = await postJson("/api/auth/register/options", undefined, headers);
      const attestation = await startRegistration({ optionsJSON: options });
      await postJson("/api/auth/register/verify", attestation, headers);
      toast.success("Passkey registered");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
      setBusy(null);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5 text-primary" /> Sign in
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button className="w-full" onClick={signIn} disabled={busy !== null}>
          {busy === "signin" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Fingerprint className="h-4 w-4" />
          )}
          Sign in with passkey
        </Button>

        {showRegister ? (
          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="setup-secret">Setup secret</Label>
              <Input
                id="setup-secret"
                type="password"
                value={setupSecret}
                onChange={(e) => setSetupSecret(e.target.value)}
                placeholder="From SETUP_SECRET in the environment"
              />
            </div>
            <Button
              variant="secondary"
              className="w-full"
              onClick={register}
              disabled={busy !== null || setupSecret.trim().length === 0}
            >
              {busy === "register" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Register this device
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowRegister(true)}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
          >
            First time on this device? Register a passkey
          </button>
        )}
      </CardContent>
    </Card>
  );
}
