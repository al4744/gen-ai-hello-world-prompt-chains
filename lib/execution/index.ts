import "server-only";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { createExecutionEngine } from "./engine";
import { createOpenRouterProvider } from "./openrouter";
import { createExecutionPersistence, createExecutionStorage } from "./supabase";
import type { ArtifactRenderer } from "./types";

/** No route or Server Action is registered. A future entry point must also guard. */
export function createServerExecutionEngine(options: { renderer?: ArtifactRenderer; hostBudgetMs?: number } = {}) {
  return createExecutionEngine({
    ...options,
    async authorize() {
      const { supabase, user } = await requireSuperadmin({ onDenied: "throw" });
      return { userId: user.id, persistence: createExecutionPersistence(supabase, user.id), storage: createExecutionStorage(supabase) };
    },
    // Deferred runtime lookup only; implementation/tests never invoke this
    // production getter or inspect a real credential.
    provider: createOpenRouterProvider({ getApiKey: () => process.env.OPENROUTER_API_KEY }),
  });
}
