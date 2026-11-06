import { createGenerationHandlers } from "@/lib/generation/handlers";

export async function POST(request: Request) {
  return createGenerationHandlers().prepare(request);
}
