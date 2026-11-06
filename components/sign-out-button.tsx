"use client";

import { useActionState } from "react";
import { signOut, type SignOutState } from "@/app/auth/actions";

export default function SignOutButton() {
  const [state, action, pending] = useActionState<SignOutState>(signOut, { error: null });

  return (
    <form action={action} className="space-y-3">
      <button type="submit" className="button-secondary w-full" disabled={pending} aria-busy={pending}>
        {pending ? "Signing out…" : "Sign out"}
        <span aria-hidden="true"> →</span>
      </button>
      <p role="status" className="sr-only">{pending ? "Signing out." : ""}</p>
      {state.error && <p role="alert" className="feedback-error">{state.error}</p>}
    </form>
  );
}
