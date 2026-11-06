"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import type { ChainFormState, ChainValues } from "@/lib/chains/model";
import { CHAIN_LIMITS } from "@/lib/chains/validation";

export default function ChainForm({ action, values, original, cancelHref, mode }: {
  action: (state: ChainFormState, data: FormData) => Promise<ChainFormState>;
  values: ChainValues; original?: string; cancelHref: string; mode: "create" | "edit";
}) {
  const [state, formAction, pending] = useActionState(action, { values, errors: {} });
  const submitted = useRef(false);
  const prefix = useId();
  useEffect(() => { if (!pending) submitted.current = false; }, [pending, state]);

  return (
    <form action={formAction} noValidate aria-busy={pending} className="max-w-2xl rounded-2xl border border-border bg-surface p-6"
      onSubmit={event => { if (submitted.current || pending) event.preventDefault(); else submitted.current = true; }}>
      {original && <input type="hidden" name="original" value={original} />}
      {(state.message || Object.keys(state.errors).length > 0) && <p role="alert" className="feedback-error mb-5">{state.message || "Please correct the highlighted fields."}</p>}
      <fieldset disabled={pending} className="space-y-5">
        <legend className="sr-only">Prompt chain metadata</legend>
        {(["name", "slug", "description"] as const).map(field => {
          const id = `${prefix}-${field}`;
          const help = field === "name" ? `A readable name, up to ${CHAIN_LIMITS.name} characters.` : field === "slug" ? `Lowercase letters, numbers, and single hyphens; up to ${CHAIN_LIMITS.slug} characters.` : `Optional. Up to ${CHAIN_LIMITS.description} characters.`;
          const error = state.errors[field];
          const props = {
            id, name: field, defaultValue: state.values[field], maxLength: CHAIN_LIMITS[field],
            className: "form-input mt-2 w-full", "aria-invalid": Boolean(error),
            "aria-describedby": `${id}-help${error ? ` ${id}-error` : ""}`,
          };
          return (
            <div key={field}>
              <label htmlFor={id} className="text-sm font-semibold">{field === "name" ? "Name" : field === "slug" ? "Slug" : "Description"}</label>
              {field === "description" ? <textarea {...props} rows={4} /> : <input {...props} type="text" required autoCapitalize={field === "slug" ? "none" : undefined} spellCheck={field === "slug" ? false : undefined} />}
              <p id={`${id}-help`} className="mt-2 text-xs leading-5 text-muted">{help}</p>
              {error && <p id={`${id}-error`} className="form-field-error mt-2 text-sm">{error}</p>}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-3 border-t border-border pt-5">
          <button type="submit" disabled={pending} className="button-primary">{pending ? "Saving…" : mode === "create" ? "Create chain" : "Save changes"}</button>
          <Link href={cancelHref} prefetch={false} className="button-secondary">Cancel</Link>
        </div>
      </fieldset>
      {mode === "edit" && <a href={`${cancelHref}/edit`} className="text-link mt-4 inline-block text-xs text-muted">Load latest version (discards unsaved entries)</a>}
      <p role="status" className="sr-only">{pending ? "Saving prompt chain." : ""}</p>
    </form>
  );
}
