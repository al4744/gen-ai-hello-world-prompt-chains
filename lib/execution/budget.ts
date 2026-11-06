import "server-only";
import { ExecutionFault } from "./errors";
import { LIMITS, type Clock, type ErrorCode } from "./types";

export const systemClock: Clock = {
  now: () => Date.now(), monotonic: () => performance.now(),
  schedule(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};

export async function readLimited(stream: ReadableStream<Uint8Array>, maximum: number, signal: AbortSignal,
  code: ErrorCode): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ExecutionFault("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { cancel(); throw new ExecutionFault(code); }
      chunks.push(value);
    }
    if (signal.aborted) throw new ExecutionFault("cancelled");
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Bounded even if an injected dependency ignores cancellation. No retries. */
export async function bounded<T>(clock: Clock, milliseconds: number, parent: AbortSignal | undefined,
  code: ErrorCode, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent?.aborted) throw new ExecutionFault("cancelled");
  if (milliseconds <= 0) throw new ExecutionFault(code);
  const deadline = clock.monotonic() + milliseconds;
  const controller = new AbortController();
  let cancelTimer = () => {};
  let cancelParent = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => { const error = new ExecutionFault("cancelled"); controller.abort(error); reject(error); };
    parent?.addEventListener("abort", abort, { once: true });
    cancelParent = () => parent?.removeEventListener("abort", abort);
    cancelTimer = clock.schedule(() => { const error = new ExecutionFault(code); controller.abort(error); reject(error); }, milliseconds);
  });
  try {
    const value = await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return work(controller.signal);
    })]);
    if (parent?.aborted) throw new ExecutionFault("cancelled");
    // A synchronous decoder/renderer can delay the event-loop timer. Never let
    // a late promise count as timely merely because the timer has not fired.
    if (clock.monotonic() >= deadline) { controller.abort(); throw new ExecutionFault(code); }
    return value;
  }
  finally { cancelTimer(); cancelParent(); }
}

export class ExecutionBudget {
  private stop: number;
  constructor(readonly clock: Clock, hostBudgetMs: number = LIMITS.leaseMs) {
    if (!Number.isFinite(hostBudgetMs) || hostBudgetMs <= LIMITS.cleanupMs || hostBudgetMs > LIMITS.leaseMs) {
      throw new ExecutionFault("contract_mismatch");
    }
    this.stop = clock.monotonic() + hostBudgetMs - LIMITS.cleanupMs;
  }
  claim(deadline: number, claimStarted: number) {
    // Never gain time from a remote clock ahead of ours, response latency,
    // wall-clock rollback, or a future lease extension this engine cannot use.
    this.stop = Math.min(this.stop, this.clock.monotonic() + deadline - this.clock.now() - 1000,
      claimStarted + LIMITS.leaseMs - 1000);
  }
  remaining() { return this.stop - this.clock.monotonic(); }
  io() {
    const ms = Math.min(LIMITS.ioMs, this.remaining());
    if (ms <= 0) throw new ExecutionFault("deadline_exceeded");
    return ms;
  }
  beforeStep() {
    // Authorization, start_step and complete_step each need an I/O allowance.
    if (this.remaining() < LIMITS.finalReserveMs + 3 * LIMITS.ioMs + LIMITS.minProviderMs) {
      throw new ExecutionFault("deadline_exceeded");
    }
  }
  provider() {
    const ms = Math.min(LIMITS.providerMs, this.remaining() - LIMITS.finalReserveMs - LIMITS.ioMs);
    if (ms < LIMITS.minProviderMs) throw new ExecutionFault("deadline_exceeded");
    return ms;
  }
}
