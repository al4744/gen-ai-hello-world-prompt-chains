import "server-only";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { createExecutionEngine } from "./engine";
import { createOpenRouterProvider } from "./openrouter";
import { createExecutionPersistence, createExecutionStorage } from "./supabase";
import { createCaptionRenderer } from "./renderer";
import { generationEnabled } from "./enabled";
import { ExecutionFault } from "./errors";
import type { ArtifactRenderer } from "./types";

/** Request-scoped factory. Entry points must independently guard as well. */
export function createServerExecutionEngine(options: { renderer?: ArtifactRenderer; hostBudgetMs?: number } = {}) {
  const provider = createOpenRouterProvider({ getApiKey: () => process.env.OPENROUTER_API_KEY });
  return createExecutionEngine({
    renderer: createCaptionRenderer(),
    ...options,
    async authorize() {
      const { supabase, user } = await requireSuperadmin({ onDenied: "throw" });
      return { userId: user.id, persistence: createExecutionPersistence(supabase, user.id), storage: createExecutionStorage(supabase) };
    },
    // Deferred runtime lookup only; implementation/tests never invoke this
    // production getter or inspect a real credential.
    provider: { ...provider, checkConfigured() {
      if (!generationEnabled()) throw new ExecutionFault("generation_disabled");
      provider.checkConfigured();
    } },
  });
}
