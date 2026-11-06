"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function GoogleSignIn() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error || !data.url) throw new Error("Sign-in failed");
      // The SDK navigates to Google. Keep the button pending until departure.
    } catch {
      setError("Unable to connect to Google. Please try again.");
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        aria-busy={pending}
        aria-describedby={error ? "google-sign-in-error" : undefined}
        className="button-primary w-full"
      >
        {pending && <span className="loading-spinner" aria-hidden="true" />}
        {pending ? "Connecting to Google…" : "Continue with Google"}
      </button>
      <p role="status" className="sr-only">{pending ? "Opening Google sign-in." : ""}</p>
      {error && <p id="google-sign-in-error" role="alert" className="feedback-error">{error}</p>}
    </div>
  );
}
