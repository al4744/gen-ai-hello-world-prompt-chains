"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import type { DeleteChainState } from "@/lib/chains/model";

export default function DeleteChainForm({ action, original, cancelHref, name }: {
  action: (state: DeleteChainState, data: FormData) => Promise<DeleteChainState>;
  original: string; cancelHref: string; name: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const submitted = useRef(false);
  useEffect(() => { if (!pending) submitted.current = false; }, [pending, state]);

  return (
    <form action={formAction} aria-busy={pending} className="mt-6 space-y-5"
      onSubmit={event => { if (submitted.current || pending) event.preventDefault(); else submitted.current = true; }}>
      <input type="hidden" name="original" value={original} />
      {state.error && <p role="alert" className="feedback-error">{state.error}</p>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={cancelHref} prefetch={false} className="button-secondary" aria-disabled={pending || undefined} tabIndex={pending ? -1 : undefined}
          onClick={event => { if (pending) event.preventDefault(); }}>Cancel</Link>
        <button type="submit" className="button-danger" disabled={pending} aria-label={`Delete ${name}`}>{pending ? "Deleting…" : "Delete"}</button>
      </div>
      <p role="status" className="sr-only">{pending ? "Deleting prompt chain." : ""}</p>
    </form>
  );
}
