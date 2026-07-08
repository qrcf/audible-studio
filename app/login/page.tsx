import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Sign in · Audiobook Studio" };

export default function LoginPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      {/* useSearchParams inside the form requires a Suspense boundary */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
