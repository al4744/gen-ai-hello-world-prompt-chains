import { createGenerationHandlers } from "@/lib/generation/handlers";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return createGenerationHandlers().status(request, (await context.params).runId);
}
