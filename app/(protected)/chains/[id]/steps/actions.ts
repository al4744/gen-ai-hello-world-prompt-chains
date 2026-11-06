"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain, getChainSteps } from "@/lib/chains/data";
import { isSystemChain, UUID_PATTERN, type ChainStep } from "@/lib/chains/model";
import { EMPTY_STEP_VALUES, readExpectedOrder, readOriginalStep, sameOrder, validateStepForm, type StepActionState, type StepFormState } from "@/lib/steps/model";
import { mutateStep } from "@/lib/steps/rpc";
import { reorderStepRPC } from "@/lib/steps/reorder-rpc";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];

async function context(supabase: Client, chainId: string, stepId?: string): Promise<{ error: string } | { steps: ChainStep[]; step: ChainStep | undefined }> {
  if (typeof chainId !== "string" || !UUID_PATTERN.test(chainId) || (stepId !== undefined && (typeof stepId !== "string" || !UUID_PATTERN.test(stepId)))) return { error: "Invalid chain or step ID. Return to the chain directory." } as const;
  const parent = await getChain(supabase, chainId);
  if (parent.status !== "ready") return { error: parent.status === "missing" ? "The parent chain no longer exists or is unavailable." : "Unable to load the parent chain. Please try again." } as const;
  if (isSystemChain(parent.chain)) return { error: "The default chain and its steps are read-only." } as const;
  const result = await getChainSteps(supabase, chainId);
  if (result.status === "error") return { error: "Unable to load the current steps. Please try again." } as const;
  const step = stepId ? result.steps.find(item => item.id === stepId) : undefined;
  if (stepId && !step) return { error: "This step no longer exists or does not belong to this chain." } as const;
  return { steps: result.steps, step };
}

function revalidateSteps(chainId: string, stepId?: string) {
  revalidatePath("/chains");
  revalidatePath(`/chains/${chainId}`);
  revalidatePath(`/chains/${chainId}/steps/new`);
  if (stepId) {
    revalidatePath(`/chains/${chainId}/steps/${stepId}/edit`);
    revalidatePath(`/chains/${chainId}/steps/${stepId}/delete`);
  }
}

const conflict = "The steps changed since this page was opened. Refresh and review the latest version before trying again.";

export async function createStep(chainId: string, _previous: StepFormState, form: FormData): Promise<StepFormState> {
  const { supabase } = await requireSuperadmin();
  const state = form instanceof FormData ? validateStepForm(form) : { values: { ...EMPTY_STEP_VALUES }, errors: {}, message: "Invalid form submission." };
  if (!(form instanceof FormData)) return state;
  const current = await context(supabase, chainId);
  if ("error" in current) return { ...state, message: current.error };
  if (Object.keys(state.errors).length) return state;
  const expected = readExpectedOrder(form);
  if (!expected || !sameOrder(current.steps, expected)) return { ...state, message: conflict };
  const result = await mutateStep(supabase, { chainId, operation: "create", expected, values: state.values });
  if (!result.ok) return { ...state, message: result.error };
  revalidateSteps(chainId, result.id);
  redirect(`/chains/${chainId}?step_created=1#step-${result.id}`);
}

export async function updateStep(chainId: string, stepId: string, _previous: StepFormState, form: FormData): Promise<StepFormState> {
  const { supabase } = await requireSuperadmin();
  const state = form instanceof FormData ? validateStepForm(form) : { values: { ...EMPTY_STEP_VALUES }, errors: {}, message: "Invalid form submission." };
  if (!(form instanceof FormData)) return state;
  const current = await context(supabase, chainId, stepId);
  if ("error" in current) return { ...state, message: current.error };
  if (Object.keys(state.errors).length) return state;
  const expected = readExpectedOrder(form);
  const original = readOriginalStep(form);
  if (!expected || !sameOrder(current.steps, expected) || !original || original.name !== current.step?.name || original.prompt_template !== current.step?.prompt_template) return { ...state, message: conflict };
  const result = await mutateStep(supabase, { chainId, stepId, operation: "update", expected, values: state.values, original });
  if (!result.ok) return { ...state, message: result.error };
  revalidateSteps(chainId, stepId);
  redirect(`/chains/${chainId}?step_updated=1#step-${stepId}`);
}

export async function deleteStep(chainId: string, stepId: string, _previous: StepActionState, form: FormData): Promise<StepActionState> {
  const { supabase } = await requireSuperadmin();
  if (!(form instanceof FormData)) return { error: "Invalid confirmation. Reload the page before trying again." };
  const current = await context(supabase, chainId, stepId);
  if ("error" in current) return { error: current.error };
  const expected = readExpectedOrder(form);
  const original = readOriginalStep(form);
  if (!expected || !sameOrder(current.steps, expected) || !original || original.name !== current.step?.name || original.prompt_template !== current.step?.prompt_template) return { error: conflict };
  const result = await mutateStep(supabase, { chainId, stepId, operation: "delete", expected, original });
  if (!result.ok) return { error: result.error };
  revalidateSteps(chainId, stepId);
  redirect(`/chains/${chainId}?step_deleted=1`);
}

export async function moveStep(chainId: string, stepId: string, _previous: StepActionState, form: FormData): Promise<StepActionState> {
  const { supabase } = await requireSuperadmin();
  if (!(form instanceof FormData)) return { error: "Invalid step move. Reload the page before trying again." };
  const current = await context(supabase, chainId, stepId);
  if ("error" in current) return { error: current.error };
  const expected = readExpectedOrder(form);
  if (!expected || !sameOrder(current.steps, expected)) return { error: conflict };
  const direction = form.get("direction");
  if (direction !== "up" && direction !== "down") return { error: "Choose Move Up or Move Down." };
  const index = current.steps.findIndex(step => step.id === stepId);
  if ((direction === "up" && index === 0) || (direction === "down" && index === current.steps.length - 1)) return { error: "This step cannot move farther in that direction." };
  const result = await mutateStep(supabase, { chainId, stepId, operation: direction === "up" ? "move_up" : "move_down", expected });
  if (!result.ok) return { error: result.error };
  revalidateSteps(chainId, stepId);
  return { error: null, success: direction === "up" ? "Step moved up." : "Step moved down." };
}

export async function reorderStep(chainId: string, stepId: string, _previous: StepActionState, form: FormData): Promise<StepActionState> {
  const { supabase } = await requireSuperadmin();
  if (!(form instanceof FormData)) return { error: "Invalid reorder request. Refresh the page before trying again." };
  const current = await context(supabase, chainId, stepId);
  if ("error" in current) return { error: current.error };
  const expected = readExpectedOrder(form);
  if (!expected || !sameOrder(current.steps, expected)) return { error: conflict };
  const raw = form.get("destination");
  const destination = typeof raw === "string" && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
  if (!Number.isInteger(destination) || destination < 1 || destination > current.steps.length) return { error: "Choose a valid position within this chain." };
  if (current.steps.findIndex(step => step.id === stepId) === destination - 1) return { error: null, success: "Step order unchanged." };
  const result = await reorderStepRPC(supabase, { chainId, stepId, destination, expected });
  if (!result.ok) return { error: result.error };
  revalidateSteps(chainId, stepId);
  return { error: null, success: `Step moved to position ${destination}.` };
}
