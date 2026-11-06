"use client";

export default function StepMoveControls({ name, first, last, disabled = false, dragging = false, handleRef, onMove, instructionsId }: {
  name: string; first: boolean; last: boolean; disabled?: boolean; dragging?: boolean;
  handleRef: (element: Element | null) => void; onMove: (direction: "up" | "down") => void; instructionsId: string;
}) {
  return (
    <div className="step-control-rail" role="group" aria-label={`Reorder ${name}`}>
      <button type="button" name="direction" value="up" className="step-rail-button" disabled={disabled || dragging || first} aria-label={`Move ${name} up`} title="Move up" onClick={() => onMove("up")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
      </button>
      <button ref={handleRef} type="button" className="step-drag-handle" disabled={disabled} aria-label={`Drag ${name} to reorder`} aria-describedby={instructionsId} title="Drag to reorder">
        <svg width="16" height="22" viewBox="0 0 24 30" fill="currentColor" aria-hidden="true">
          {[7, 15, 23].map(y => [8, 16].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
        </svg>
      </button>
      <button type="button" name="direction" value="down" className="step-rail-button" disabled={disabled || dragging || last} aria-label={`Move ${name} down`} title="Move down" onClick={() => onMove("down")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>
      </button>
    </div>
  );
}
