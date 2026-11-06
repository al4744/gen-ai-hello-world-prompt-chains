"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import { STEP_LIMITS, type StepFormState, type StepValues } from "@/lib/steps/model";

export default function StepForm({ action, values, expectedOrder, original, chainHref, mode }: {
  action: (state: StepFormState, form: FormData) => Promise<StepFormState>;
  values: StepValues; expectedOrder: string; original?: string; chainHref: string; mode: "create" | "edit";
}) {
  const [state, formAction, pending] = useActionState(action, { values, errors: {} });
  const submitted = useRef(false);
  const prefix = useId();
  useEffect(() => { if (!pending) submitted.current = false; }, [pending, state]);
  return (
    <form action={formAction} noValidate aria-busy={pending} className="max-w-3xl rounded-2xl border border-border bg-surface p-6"
      onSubmit={event => { if (submitted.current || pending) event.preventDefault(); else submitted.current = true; }}>
      <input type="hidden" name="expected_order" value={expectedOrder} />
      {original && <input type="hidden" name="original" value={original} />}
      {(state.message || Object.keys(state.errors).length > 0) && <p role="alert" className="feedback-error mb-5">{state.message || "Please correct the highlighted fields."}</p>}
      <fieldset disabled={pending} className="space-y-5">
        <legend className="sr-only">Step name and prompt template</legend>
        {(["name", "prompt_template"] as const).map(field => {
          const id = `${prefix}-${field}`;
          const error = state.errors[field];
          const props = { id, name: field, defaultValue: state.values[field], maxLength: STEP_LIMITS[field], required: true,
            "aria-invalid": Boolean(error), "aria-describedby": `${id}-help${error ? ` ${id}-error` : ""}` };
          return <div key={field}>
            <label htmlFor={id} className="text-sm font-semibold">{field === "name" ? "Step name" : "Prompt template"}</label>
            {field === "name" ? <input {...props} type="text" className="form-input mt-2 w-full" /> : <textarea {...props} rows={10} spellCheck={false} className="form-input mt-2 w-full" style={{ fontFamily: "var(--font-geist-mono), monospace" }} />}
            <p id={`${id}-help`} className="mt-2 text-xs leading-5 text-muted">{field === "name" ? `A readable label, up to ${STEP_LIMITS.name} characters.` : `Stored exactly as written, including spacing and line breaks. Up to ${STEP_LIMITS.prompt_template.toLocaleString("en-US")} characters.`}</p>
            {error && <p id={`${id}-error`} className="form-field-error mt-2 text-sm">{error}</p>}
          </div>;
        })}
        <div className="flex flex-wrap gap-3 border-t border-border pt-5">
          <button type="submit" className="button-primary" disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Add step" : "Save changes"}</button>
          <Link href={chainHref} prefetch={false} className="button-secondary">Cancel</Link>
        </div>
      </fieldset>
      <button type="button" disabled={pending} onClick={() => window.location.reload()} className="text-link mt-4 inline-block text-xs text-muted">Reload this form (discards unsaved entries)</button>
      <p role="status" className="sr-only">{pending ? "Saving prompt chain step." : ""}</p>
    </form>
  );
}
