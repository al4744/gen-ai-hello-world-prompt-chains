"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type DragEvent } from "react";
import { createGenerationWorkflow, defaultCaptions, defaultChainId, executableChain, canStart, contextError, type GenerationChain } from "@/lib/generation/workflow";
import { createImagePreview } from "@/lib/generation/preview";

export default function GenerationForm({ chains, enabled, initialRunId }: {
  chains: GenerationChain[]; enabled: boolean; initialRunId?: string;
}) {
  const [chainId, setChainId] = useState(() => defaultChainId(chains));
  const [context, setContext] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [inputError, setInputError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null), previewAbort = useRef<AbortController | null>(null);
  const selection = useRef(0);
  const [workflow] = useState(() => createGenerationWorkflow({ enabled, onRunId(id) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("run", id); else url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  } }));
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const chain = chains.find(item => item.id === chainId);
  const disabled = !enabled || state.serviceDisabled;
  const contextInvalid = contextError(context);
  const captions = state.run ? defaultCaptions(state.run) : null;
  const ready = canStart(state, enabled) && !!file && executableChain(chain) && !contextInvalid && !previewLoading;

  useEffect(() => {
    workflow.activate();
    if (initialRunId) void workflow.resume(initialRunId);
    return () => { workflow.dispose(); previewAbort.current?.abort(); };
  }, [workflow, initialRunId]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function selectFile(selected: File | null) {
    if (workflow.getSnapshot().busy || !selected) return;
    previewAbort.current?.abort(); const number = ++selection.current;
    const controller = new AbortController(); previewAbort.current = controller;
    setFile(null); setPreview(""); setInputError(""); setPreviewLoading(true);
    try {
      const url = await createImagePreview(selected, controller.signal);
      if (controller.signal.aborted || number !== selection.current) { URL.revokeObjectURL(url); return; }
      setFile(selected); setPreview(url);
    } catch (error) {
      if (!controller.signal.aborted && number === selection.current) setInputError(error instanceof Error ? error.message : "Choose a valid image.");
    } finally { if (number === selection.current && !controller.signal.aborted) setPreviewLoading(false); }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    if (workflow.getSnapshot().busy) return;
    if (event.dataTransfer.files.length !== 1) {
      previewAbort.current?.abort(); selection.current++; setPreviewLoading(false); setFile(null); setPreview("");
      setInputError("Choose one image at a time."); return;
    }
    void selectFile(event.dataTransfer.files[0]);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) void workflow.start({ chain, file, userContext: context });
  }

  return <div className="space-y-5">
    {disabled && <p role="status" className="feedback-success text-muted">Generation is not currently enabled. Explore the prompt chains and preview an image; nothing will be prepared or uploaded until generation is enabled.</p>}
    {chains.length === 0 && <p role="status" className="feedback-success">No prompt chains are available. <Link href="/chains" prefetch={false} className="text-link">Manage prompt chains</Link> to get started.</p>}
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <form onSubmit={submit} aria-label="Generate a captioned image" aria-busy={state.busy} className="min-w-0 space-y-6 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <div>
          <h2 className="text-base font-semibold">Start with an image</h2>
          <p className="mt-2 text-sm leading-6 text-muted">Choose your moment. Your prompt chain takes it from here.</p>
          <div role="group" aria-label="Image upload" onDragOver={event => { event.preventDefault(); if (!state.busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)} onDrop={drop}
            className={`mt-4 overflow-hidden rounded-xl border border-dashed ${dragging ? "border-control-border" : "border-border"} bg-panel`}>
            {preview ? <div className="relative aspect-[4/3] w-full">
              <Image src={preview} alt="Selected original image preview" fill unoptimized sizes="(min-width: 1280px) 40vw, 90vw" className="object-contain p-3"
                onError={() => { setFile(null); setPreview(""); setInputError("The preview could not be displayed. Choose a valid image."); }} />
            </div> : <div className="flex min-h-60 flex-col items-center justify-center px-5 py-8 text-center">
              <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-4 h-9 w-9 text-muted"><rect x="4" y="5" width="24" height="22" rx="4"/><circle cx="12" cy="12" r="2.5"/><path d="m5 24 8-8 5 5 4-4 6 6"/></svg>
              <p className="text-sm font-medium">{previewLoading ? "Checking image preview…" : "Drop an image here"}</p>
              <p id="image-help" className="mt-2 text-xs leading-5 text-muted">JPEG, PNG or WebP · up to 5 MiB</p>
            </div>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
              <p className="min-w-0 flex-1 break-all text-xs text-muted">{file?.name || "One image per generation"}</p>
              <button type="button" disabled={state.busy} onClick={() => input.current?.click()} className="button-secondary">{file ? "Replace image" : "Choose image"}</button>
              <input ref={input} type="file" aria-label="Choose an image" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={state.busy}
                onChange={event => { const selected = event.target.files?.[0] ?? null; event.target.value = ""; void selectFile(selected); }} />
            </div>
          </div>
          {inputError && <p role="alert" className="form-field-error mt-3 text-sm">{inputError}</p>}
        </div>

        <div>
          <label htmlFor="generation-chain" className="text-sm font-medium">Prompt chain</label>
          <select id="generation-chain" className="form-input mt-2 w-full" value={chainId} disabled={state.busy || chains.length === 0}
            aria-describedby="chain-description" onChange={event => setChainId(event.target.value)}>
            <option value="">Choose a prompt chain</option>
            {chains.map(item => <option key={item.id} value={item.id}>
              {item.name}{item.slug === "caption-arena-default" ? " · Default" : ""}{!executableChain(item) ? " · unavailable steps" : ""}
            </option>)}
          </select>
          <p id="chain-description" className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted">{chain?.description || "Choose a chain to decide how captions are created."}</p>
          {chain && !executableChain(chain) && <p className="mt-2 text-xs leading-5 text-muted">This chain is not ready for generation. Review its steps before continuing.</p>}
          {chain && <Link href={`/chains/${chain.id}`} prefetch={false} className="text-link mt-2 inline-block text-xs text-muted">View selected chain</Link>}
        </div>
        <div>
          <label htmlFor="generation-context" className="text-sm font-medium">Context <span className="font-normal text-muted">(optional)</span></label>
          <textarea id="generation-context" className="form-input mt-2 min-h-28 w-full" rows={3} maxLength={1000} value={context} disabled={state.busy}
            placeholder="A little backstory, a mood, or something to keep in mind…" onChange={event => setContext(event.target.value)}
            aria-invalid={!!contextInvalid} aria-describedby="context-help context-count context-error" />
          <div className="mt-2 flex items-start justify-between gap-4 text-xs leading-5 text-muted">
            <p id="context-help">Give the chain some context without changing its saved instructions.</p>
            <span id="context-count" className="shrink-0" aria-live="polite">{Array.from(context).length}/500</span>
          </div>
          <p id="context-error" className="form-field-error mt-1 text-xs">{contextInvalid}</p>
        </div>
        <button type="submit" className="button-primary w-full" disabled={!ready} style={{ cursor: !ready && !state.busy ? "not-allowed" : undefined }}>
          {state.busy && <span className="loading-spinner" aria-hidden="true" />}
          {state.busy ? "Working on your image…" : state.run?.status === "succeeded" ? "Generate again" : "Generate captioned image"}
        </button>
        <p className="text-center text-xs leading-5 text-muted">Your image and results stay in this superadmin workspace.</p>
      </form>

      <section aria-labelledby="generation-result" className="min-w-0 space-y-5 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <div><h2 id="generation-result" className="text-base font-semibold">Your captioned image</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{state.run ? <>Saved run from <span className="font-medium text-foreground">{state.run.chain.name}</span></> : "The finished image and generated text will appear here."}</p>
        </div>
        <div role={state.phase === "error" || state.phase === "failed" || state.phase === "interrupted" ? "alert" : "status"} aria-live="polite"
          className={state.phase === "error" || state.phase === "failed" || state.phase === "interrupted" ? "feedback-error" : "text-sm leading-6 text-muted"}>
          {state.message || "Choose an image and a prompt chain to begin."}
          {state.run?.status === "running" && <div className="mt-3"><label htmlFor="step-progress" className="mb-1 block text-xs">AI steps completed</label><progress id="step-progress" value={state.run.progress.succeeded} max={state.run.progress.total} className="w-full accent-[var(--primary)]" /></div>}
        </div>
        {state.mediaUrl ? <Image src={state.mediaUrl} alt={`Completed captioned image generated by ${state.run?.chain.name ?? "the selected prompt chain"}`} width={1200} height={1600} unoptimized className="h-auto w-full rounded-xl border border-border"
          onError={() => workflow.mediaFailed()} />
          : <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-panel p-6 text-center text-sm leading-6 text-muted">
            {state.busy ? <span className="flex items-center gap-3"><span className="loading-spinner" aria-hidden="true" />{state.run?.status === "succeeded" ? "Loading the saved PNG…" : "Creating something worth a caption."}</span>
              : state.run?.status === "succeeded" ? "Your run is saved. Load its image below." : "One image. A new perspective."}
          </div>}
        {state.mediaError && <p role="alert" className="feedback-error">{state.mediaError}</p>}
        {state.run?.status === "succeeded" && <>
          <div className="flex flex-wrap gap-3">
            {state.mediaUrl && <a href={`/api/generation/runs/${state.run.runId}/media?download=1`} download={`caption-${state.run.runId}.png`} className="button-primary">Download PNG</a>}
            {!state.mediaUrl && <button type="button" disabled={state.busy} onClick={() => void workflow.loadMedia()} className="button-secondary">Load saved image</button>}
            <button type="button" disabled={state.busy} onClick={() => workflow.reset()} className="button-secondary">Create another</button>
          </div>
          <div className="border-t border-border pt-5">
            <h3 className="text-sm font-semibold">Generated text</h3>
            {captions ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{captions.map((caption, index) => <article key={index} className="min-w-0 rounded-xl border border-border bg-panel p-4"><p className="eyebrow">Caption {index === 0 ? "A" : "B"}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{caption}</p></article>)}</div>
              : <pre className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-border bg-panel p-4 font-sans text-sm leading-6">{state.run.finalText}</pre>}
            {captions && <details className="mt-4 text-sm text-muted"><summary className="cursor-pointer">View exact saved output</summary><pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs">{state.run.finalText}</pre></details>}
          </div>
        </>}
        {state.runId && !state.busy && state.run?.status !== "succeeded" && <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void workflow.resume(state.runId!)} className="button-secondary">Check run status</button>
          {state.phase === "prepared" && <button type="button" onClick={() => workflow.reset()} className="button-secondary">Start a new run</button>}
        </div>}
      </section>
    </div>
  </div>;
}
