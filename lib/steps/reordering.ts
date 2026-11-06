import type { ChainStep } from "@/lib/chains/model";

export type Point = { x: number; y: number };
export type Rect = { top: number; bottom: number; left: number; right: number };
export type Insertion = { slot: number; top: number };

// Measure real row midpoints; keep the source row in place during hover so
// variable-height/expanded rows and scrolling never shift the target underneath.
export function insertionAt(point: Point, list: Rect, rows: Rect[]): Insertion | null {
  if (!rows.length || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < list.left || point.x > list.right || point.y < list.top || point.y > list.bottom) return null;
  const index = rows.findIndex(row => point.y < (row.top + row.bottom) / 2);
  const slot = index === -1 ? rows.length : index;
  return { slot, top: (slot === rows.length ? rows[rows.length - 1].bottom : rows[slot].top) - list.top };
}

// Slots describe gaps in the list INCLUDING the still-visible source row.
// The RPC destination is a 1-based index AFTER removing that row.
export function destinationForSlot(ids: string[], id: string, slot: number): number | null {
  const from = ids.indexOf(id);
  if (from < 0 || !Number.isInteger(slot) || slot < 0 || slot > ids.length) return null;
  return (slot > from ? slot - 1 : slot) + 1;
}

export function moveToPosition(steps: ChainStep[], id: string, destination: number): ChainStep[] {
  const from = steps.findIndex(step => step.id === id);
  if (from < 0 || !Number.isInteger(destination) || destination < 1 || destination > steps.length || from === destination - 1) return steps;
  const moved = [...steps];
  const [step] = moved.splice(from, 1);
  moved.splice(destination - 1, 0, step);
  return moved.map((item, index) => ({ ...item, step_order: index + 1 }));
}
