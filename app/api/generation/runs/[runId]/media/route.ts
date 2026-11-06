import { createMediaHandler } from "@/lib/generation/media";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return createMediaHandler()(request, (await context.params).runId);
}
