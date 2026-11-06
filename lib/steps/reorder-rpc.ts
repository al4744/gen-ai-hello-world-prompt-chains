import "server-only";

import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import type { StepOrder } from "./model";
import { errorMessage } from "./rpc";

export async function reorderStepRPC(supabase: Awaited<ReturnType<typeof requireSuperadmin>>["supabase"], input: {
  chainId: string; stepId: string; destination: number; expected: StepOrder;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.rpc("reorder_prompt_chain_step_v2", {
      p_chain_id: input.chainId, p_step_id: input.stepId, p_destination: input.destination, p_expected_order: input.expected,
    });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") return { ok: false, error: "Drag reordering is not available yet. Use the arrows until the database update is installed." };
      return { ok: false, error: errorMessage(error) };
    }
    if (data !== input.stepId) return { ok: false, error: "The saved order could not be confirmed. Refresh the page to check it." };
    return { ok: true };
  } catch { return { ok: false, error: errorMessage(null) }; }
}
