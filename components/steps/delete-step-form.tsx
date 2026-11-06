"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import type { StepActionState } from "@/lib/steps/model";

export default function DeleteStepForm({ action, expectedOrder, original, chainHref, name }: {
  action: (state: StepActionState, form: FormData) => Promise<StepActionState>;
  expectedOrder: string; original: string; chainHref: string; name: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const submitted = useRef(false);
  useEffect(() => { if (!pending) submitted.current = false; }, [pending, state]);
  return (
    <form action={formAction} aria-busy={pending} className="mt-6 space-y-5"
      onSubmit={event => { if (submitted.current || pending) event.preventDefault(); else submitted.current = true; }}>
      <input type="hidden" name="expected_order" value={expectedOrder} />
      <input type="hidden" name="original" value={original} />
      {state.error && <p role="alert" className="feedback-error">{state.error}</p>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={chainHref} prefetch={false} className="button-secondary" aria-disabled={pending || undefined} tabIndex={pending ? -1 : undefined}
          onClick={event => { if (pending) event.preventDefault(); }}>Cancel</Link>
        <button type="submit" className="button-danger" disabled={pending} aria-label={`Delete step ${name}`}>{pending ? "Deleting…" : "Delete"}</button>
      </div>
      <p role="status" className="sr-only">{pending ? "Deleting step and updating the remaining positions." : ""}</p>
    </form>
  );
}
