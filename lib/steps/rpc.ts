import "server-only";

import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { UUID_PATTERN } from "@/lib/chains/model";
import type { StepOrder, StepValues } from "./model";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];
type Operation = "create" | "update" | "delete" | "move_up" | "move_down";

export function errorMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "PGRST202" || code === "42883") return "Step management is not available yet. The database update must be installed by an administrator.";
  if (code === "40001" || code === "23505") return "The steps changed since this page was opened. Refresh and review the latest order before trying again.";
  if (code === "55P03" || code === "40P01") return "Another change is in progress. Refresh the page and try again.";
  if (code === "P0002") return "The step or its parent chain no longer exists or is unavailable.";
  if (code === "42501") return "This chain is read-only or your session cannot change its steps.";
  if (code === "23514" || code === "22001") return "The step name or template does not meet the database requirements. Please review your entries.";
  if (code === "22023" || code === "22P02") return "The requested step change is invalid. Refresh the page before trying again.";
  return "Unable to save this step change. Please try again.";
}

export async function mutateStep(supabase: Client, input: {
  chainId: string; operation: Operation; expected: StepOrder; stepId?: string; values?: StepValues; original?: StepValues;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    // A single POST RPC owns the entire transaction. There is deliberately no
    // fallback to direct INSERT/UPDATE/DELETE if the function is unavailable.
    const { data, error } = await supabase.rpc("manage_prompt_chain_steps_v1", {
      p_chain_id: input.chainId, p_operation: input.operation, p_expected_order: input.expected,
      p_step_id: input.stepId ?? null, p_name: input.values?.name.trim() ?? null,
      p_prompt_template: input.values?.prompt_template ?? null,
      p_expected_name: input.original?.name ?? null, p_expected_template: input.original?.prompt_template ?? null,
    });
    if (error) return { ok: false, error: errorMessage(error) };
    if (typeof data !== "string" || !UUID_PATTERN.test(data) || (input.stepId && data !== input.stepId)) return { ok: false, error: "The change could not be confirmed. Refresh the page to check its current state." };
    return { ok: true, id: data };
  } catch { return { ok: false, error: errorMessage(null) }; }
}
