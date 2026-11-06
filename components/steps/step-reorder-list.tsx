"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useOptimistic, useRef, useState, useTransition, type RefObject } from "react";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable, type DragMoveEvent } from "@dnd-kit/react";
import { AutoScroller, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import type { ChainStep } from "@/lib/chains/model";
import { orderSnapshot, type StepActionState } from "@/lib/steps/model";
import { destinationForSlot, insertionAt, moveToPosition, type Insertion, type Point } from "@/lib/steps/reordering";
import { moveStep, reorderStep } from "@/app/(protected)/chains/[id]/steps/actions";
import StepMoveControls from "./step-move-controls";
import { useDismissChainSuccess } from "@/components/chains/chain-success-notice";

const sensors = [PointerSensor.configure({
  activationConstraints(event) {
    return event.pointerType === "touch"
      ? [new PointerActivationConstraints.Delay({ value: 180, tolerance: 8 })]
      : [new PointerActivationConstraints.Distance({ value: 6 })];
  },
})];

export default function StepReorderList({ chainId, steps }: { chainId: string; steps: ChainStep[] }) {
  const dismissChainSuccess = useDismissChainSuccess();
  const listRef = useRef<HTMLOListElement | null>(null);
  const pointer = useRef<Point | null>(null);
  const saving = useRef(false);
  const [pending, startTransition] = useTransition();
  const [view, showMove] = useOptimistic(steps, (current, move: { id: string; destination: number }) => moveToPosition(current, move.id, move.destination));
  const [active, setActive] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const [feedback, setFeedback] = useState<StepActionState>({ error: null });
  const instructionsId = useId();

  const locate = useCallback((point: Point): Insertion | null => {
    const list = listRef.current;
    if (!list) return null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-step-row]"), row => row.getBoundingClientRect());
    return insertionAt(point, list.getBoundingClientRect(), rows);
  }, []);

  useEffect(() => {
    if (!active) return;
    // dnd-kit owns gesture/auto-scroll logic. Remeasure the insertion line on
    // scroll too, including when the pointer itself is stationary near an edge.
    const update = () => { if (pointer.current) setInsertion(locate(pointer.current)); };
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { document.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [active, locate]);

  function save(id: string, destination: number, direction?: "up" | "down") {
    const index = steps.findIndex(step => step.id === id);
    if (saving.current || pending || index < 0 || destination < 1 || destination > steps.length || destination === index + 1) return;
    saving.current = true;
    dismissChainSuccess();
    const form = new FormData();
    form.set("expected_order", orderSnapshot(steps));
    form.set(direction ? "direction" : "destination", direction ?? String(destination));
    setFeedback({ error: null });
    startTransition(async () => {
      showMove({ id, destination });
      try {
        // Adjacent arrows ALWAYS keep using installed v1; a drop uses v2 ONCE.
        const result = direction
          ? await moveStep(chainId, id, { error: null }, form)
          : await reorderStep(chainId, id, { error: null }, form);
        setFeedback(result);
      } catch {
        setFeedback({ error: "Unable to save the new order. The previous confirmed order has been restored. Please try again." });
      } finally { saving.current = false; }
      // useOptimistic restores the server-confirmed steps on failure; successful
      // Server Action revalidation supplies the new base order before completion.
    });
  }

  function track({ operation }: DragMoveEvent) {
    pointer.current = { ...operation.position.current };
    setInsertion(locate(pointer.current));
  }

  return (
    <DragDropProvider sensors={sensors}
      plugins={defaults => [...defaults.filter(plugin => plugin !== AutoScroller), AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.12 } })]}
      onBeforeDragStart={event => { if (saving.current || pending) event.preventDefault(); }}
      onDragStart={({ operation }) => {
        const id = operation.source?.id;
        if (typeof id !== "string") return;
        setActive(id); setFeedback({ error: null });
        pointer.current = { ...operation.position.current };
        setInsertion(locate(pointer.current));
      }}
      onDragMove={track}
      onDragEnd={({ operation, canceled }) => {
        const id = operation.source?.id;
        const target = !canceled ? locate(operation.position.current) : null;
        setActive(null); setInsertion(null); pointer.current = null;
        if (canceled || !target || typeof id !== "string") return;
        const destination = destinationForSlot(steps.map(step => step.id), id, target.slot);
        if (destination !== null) save(id, destination);
      }}>
      <p id={instructionsId} className="sr-only">Drag only from the six-dot handle. On touch screens, hold briefly before dragging. Press Escape or release outside the list to cancel. For keyboard reordering, use each step’s up and down buttons.</p>
      <DropList listRef={listRef} chainId={chainId} steps={view} pending={pending} dragging={active !== null} insertion={insertion} instructionsId={instructionsId}
        onMove={(id, direction) => { if (!active) save(id, steps.findIndex(step => step.id === id) + (direction === "up" ? 0 : 2), direction); }} />
      <DragOverlay dropAnimation={null} className="step-drag-overlay" style={{ width: "min(28rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)", height: "auto", maxHeight: "none" }}>
        {source => {
          const step = steps.find(item => item.id === source.id);
          return <div aria-hidden="true"><p className="text-sm font-semibold">{step?.name}</p><p className="mt-1 text-xs text-muted">Release at the insertion line</p></div>;
        }}
      </DragOverlay>
      {feedback.error && <p role="alert" className="feedback-error mx-4 mb-4">{feedback.error} <button type="button" className="text-link" onClick={() => window.location.reload()}>Refresh</button></p>}
      <p role="status" className={pending || feedback.success ? "px-6 pb-4 text-xs text-muted" : "sr-only"}>{pending ? "Saving step order…" : feedback.success || ""}</p>
    </DragDropProvider>
  );
}

function DropList({ listRef, chainId, steps, pending, dragging, insertion, instructionsId, onMove }: {
  listRef: RefObject<HTMLOListElement | null>; chainId: string; steps: ChainStep[]; pending: boolean; dragging: boolean;
  insertion: Insertion | null; instructionsId: string; onMove: (id: string, direction: "up" | "down") => void;
}) {
  const { ref } = useDroppable({ id: `step-list-${chainId}`, disabled: pending });
  const attach = useCallback((node: HTMLOListElement | null) => { listRef.current = node; ref(node); }, [listRef, ref]);
  return <ol ref={attach} className="step-reorder-list" aria-label="Ordered prompt chain steps" aria-busy={pending}>
    {steps.map((step, index) => <DraggableStep key={step.id} chainId={chainId} step={step} first={index === 0} last={index === steps.length - 1} pending={pending} dragging={dragging} instructionsId={instructionsId} onMove={onMove} />)}
    {insertion && <li role="presentation" aria-hidden="true" className="step-insertion-line" style={{ top: insertion.top }} data-insertion-slot={insertion.slot} />}
  </ol>;
}

function DraggableStep({ chainId, step, first, last, pending, dragging, instructionsId, onMove }: {
  chainId: string; step: ChainStep; first: boolean; last: boolean; pending: boolean; dragging: boolean;
  instructionsId: string; onMove: (id: string, direction: "up" | "down") => void;
}) {
  const { ref, handleRef, isDragging } = useDraggable({ id: step.id, disabled: pending });
  return <li ref={ref} id={`step-${step.id}`} data-step-row={step.id} data-dragging={isDragging || undefined} className="chain-directory-row step-reorder-row scroll-mt-6">
    <StepMoveControls name={step.name} first={first} last={last} disabled={pending} dragging={dragging} handleRef={handleRef} onMove={direction => onMove(step.id, direction)} instructionsId={instructionsId} />
    <div className="min-w-0">
      <details>
        <summary className="cursor-pointer break-words text-sm font-semibold"><span className="mr-3 font-mono text-xs text-muted">{step.step_order}</span>{step.name}</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-input p-4 font-mono text-xs leading-6">{step.prompt_template}</pre>
      </details>
      <p className="mt-3 line-clamp-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted">{step.prompt_template.slice(0, 180)}{step.prompt_template.length > 180 ? "…" : ""}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/chains/${chainId}/steps/${step.id}/edit`} prefetch={false} className="button-secondary" aria-disabled={pending || undefined} onClick={event => { if (pending) event.preventDefault(); }}>Edit</Link>
        <Link href={`/chains/${chainId}/steps/${step.id}/delete`} prefetch={false} className="button-danger-secondary" aria-disabled={pending || undefined} onClick={event => { if (pending) event.preventDefault(); }}>Delete</Link>
      </div>
    </div>
  </li>;
}
