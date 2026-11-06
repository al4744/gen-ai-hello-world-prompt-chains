"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain } from "@/lib/chains/data";
import { SYSTEM_CHAIN_SLUG, UUID_PATTERN, isSystemChain, readSnapshot, sameMetadata, type ChainFormState, type DeleteChainState } from "@/lib/chains/model";
import { EMPTY_CHAIN_VALUES, normalizedValues, validateChainForm } from "@/lib/chains/validation";

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function saveFailure(state: ChainFormState, error?: unknown): ChainFormState {
  if (codeOf(error) === "23505") return { ...state, errors: { ...state.errors, slug: "This slug is already in use. Choose another." } };
  if (codeOf(error) === "23514" || codeOf(error) === "22001") {
    return { ...state, message: "The name or slug does not meet the database requirements, or a value is too long. Please check your entries." };
  }
  return { ...state, message: "Unable to save this chain. Please try again." };
}

function revalidateChain(id?: string) {
  revalidatePath("/chains");
  if (id) {
    revalidatePath(`/chains/${id}`);
    revalidatePath(`/chains/${id}/edit`);
    revalidatePath(`/chains/${id}/delete`);
  }
}

export async function createChain(_previous: ChainFormState, formData: FormData): Promise<ChainFormState> {
  // Authorization happens independently of every page and outside query catches,
  // so the existing auth redirect can never be swallowed as a form failure.
  const { supabase } = await requireSuperadmin();
  if (!(formData instanceof FormData)) return { values: { ...EMPTY_CHAIN_VALUES }, errors: {}, message: "Invalid form submission. Please try again." };
  const state = validateChainForm(formData);
  if (Object.keys(state.errors).length) return state;
  let id: string;
  try {
    // Only columns granted for INSERT. IDs and timestamps remain DB-generated.
    const { data, error } = await supabase.from("prompt_chains")
      .insert(normalizedValues(state.values)).select("id").single();
    if (error || !data || !UUID_PATTERN.test(data.id)) return saveFailure(state, error);
    id = data.id;
  } catch {
    return saveFailure(state);
  }
  revalidateChain(id);
  redirect(`/chains/${id}?created=1`);
}

export async function updateChain(id: string, _previous: ChainFormState, formData: FormData): Promise<ChainFormState> {
  const { supabase } = await requireSuperadmin();
  if (!(formData instanceof FormData)) return { values: { ...EMPTY_CHAIN_VALUES }, errors: {}, message: "Invalid form submission. Please try again." };
  const state = validateChainForm(formData);
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return { ...state, message: "Invalid chain ID. Return to the directory." };
  const current = await getChain(supabase, id);
  if (current.status === "error") return { ...state, message: "Unable to load this chain. Please try again." };
  if (current.status === "missing") return { ...state, message: "This chain no longer exists or is unavailable. Return to the directory." };
  if (isSystemChain(current.chain)) return { ...state, message: "The existing default chain is read-only and cannot be edited." };
  if (Object.keys(state.errors).length) return state;
  const original = readSnapshot(formData);
  if (!original || !sameMetadata(current.chain, original)) return { ...state, message: "This chain has changed since the form was opened. Load the latest version before saving." };
  try {
    // Compare all original metadata in the UPDATE itself, closing the race
    // between the preceding read and the write without a schema change.
    const { data, error } = await supabase.from("prompt_chains")
      .update(normalizedValues(state.values)).eq("id", id).neq("slug", SYSTEM_CHAIN_SLUG)
      .eq("slug", original.slug).eq("name", original.name).eq("description", original.description)
      .select("id").maybeSingle();
    if (error) return saveFailure(state, error);
    if (!data) return { ...state, message: "This chain changed or was deleted before it could be saved. Load the latest version before trying again." };
  } catch {
    return saveFailure(state);
  }
  revalidateChain(id);
  redirect(`/chains/${id}?updated=1`);
}

export async function deleteChain(id: string, _previous: DeleteChainState, formData: FormData): Promise<DeleteChainState> {
  const { supabase } = await requireSuperadmin();
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return { error: "Invalid chain ID. Return to the directory." };
  if (!(formData instanceof FormData)) return { error: "Invalid confirmation. Reload this page before trying again." };
  const current = await getChain(supabase, id);
  if (current.status === "error") return { error: "Unable to load this chain. Please try again." };
  if (current.status === "missing") {
    revalidateChain(id);
    redirect("/chains?already_deleted=1");
  }
  if (isSystemChain(current.chain)) return { error: "The existing default chain is protected and cannot be deleted." };
  const original = readSnapshot(formData);
  if (!original || !sameMetadata(current.chain, original)) return { error: "This chain has changed. Reload the confirmation page and review it before deleting." };
  try {
    // Delete exactly one custom parent. Existing database foreign keys alone
    // cascade to its steps/mix; this application issues no child-table writes.
    const { data, error } = await supabase.from("prompt_chains").delete()
      .eq("id", id).neq("slug", SYSTEM_CHAIN_SLUG)
      .eq("slug", original.slug).eq("name", original.name).eq("description", original.description)
      .select("id").maybeSingle();
    if (error) return { error: codeOf(error) === "23503" ? "This chain is still referenced and cannot be deleted." : "Unable to delete this chain. Please try again." };
    if (!data) return { error: "This chain changed or was already deleted. Reload the page to check its current state." };
  } catch {
    return { error: "Unable to delete this chain. Please try again." };
  }
  revalidateChain(id);
  redirect("/chains?deleted=1");
}
