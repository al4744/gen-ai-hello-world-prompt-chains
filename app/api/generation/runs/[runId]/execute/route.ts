import { createGenerationHandlers } from "@/lib/generation/handlers";

// Host headroom only: the core and database lease remain capped at 120 seconds.
export const maxDuration = 150;
export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return createGenerationHandlers().execute(request, (await context.params).runId);
}
