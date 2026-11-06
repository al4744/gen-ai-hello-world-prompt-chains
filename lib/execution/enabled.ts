import "server-only";

/** Deferred server lookup. No public flag, import-time reads, or truthy coercion. */
export function generationEnabled() {
  return process.env.PROMPT_CHAIN_GENERATION_ENABLED === "true";
}
