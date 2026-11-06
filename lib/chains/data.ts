import "server-only";

import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { UUID_PATTERN, type Chain, type ChainStep, type ChainSummary } from "./model";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];
const FIELDS = "id, slug, name, description, created_at";
export const PAGE_SIZE = 50;

// Call only after the page/action has obtained this client from requireSuperadmin.
export async function getChain(supabase: Client, id: string): Promise<
  { status: "ready"; chain: Chain } | { status: "missing" } | { status: "error" }
> {
  if (!UUID_PATTERN.test(id)) return { status: "missing" };
  try {
    const { data, error } = await supabase.from("prompt_chains").select(FIELDS).eq("id", id).maybeSingle();
    if (error) return { status: "error" };
    return data ? { status: "ready", chain: data as Chain } : { status: "missing" };
  } catch {
    return { status: "error" };
  }
}

export async function listChains(supabase: Client, page: number): Promise<
  { status: "ready"; chains: ChainSummary[]; total: number } | { status: "error" }
> {
  const start = (page - 1) * PAGE_SIZE;
  try {
    const result = await supabase.from("prompt_chains")
      .select(`${FIELDS}, prompt_chain_steps(count)`, { count: "exact" })
      .order("created_at", { ascending: false }).order("id").range(start, start + PAGE_SIZE - 1);
    if (!result.error && result.data) {
      const rows = result.data as unknown as (Chain & { prompt_chain_steps: { count: number }[] })[];
      return { status: "ready", total: result.count ?? rows.length, chains: rows.map(({ prompt_chain_steps, ...chain }) => ({
        ...chain, stepCount: prompt_chain_steps?.[0]?.count ?? null,
      })) };
    }
    // Step counts are optional: retain metadata access if the related-table
    // count is unavailable, without downloading prompt contents for the list.
    const fallback = await supabase.from("prompt_chains").select(FIELDS, { count: "exact" })
      .order("created_at", { ascending: false }).order("id").range(start, start + PAGE_SIZE - 1);
    if (fallback.error || !fallback.data) return { status: "error" };
    return { status: "ready", total: fallback.count ?? fallback.data.length,
      chains: (fallback.data as Chain[]).map(chain => ({ ...chain, stepCount: null })) };
  } catch {
    return { status: "error" };
  }
}

export async function getChainSteps(supabase: Client, id: string): Promise<
  { status: "ready"; steps: ChainStep[] } | { status: "error" }
> {
  if (!UUID_PATTERN.test(id)) return { status: "error" };
  try {
    // Paginate to avoid silently truncating chains at the API's row limit.
    const steps: ChainStep[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase.from("prompt_chain_steps")
        .select("id, name, step_order, prompt_template").eq("chain_id", id)
        .order("step_order").order("id").range(offset, offset + 499);
      if (error || !data) return { status: "error" };
      steps.push(...data as ChainStep[]);
      if (data.length < 500) return { status: "ready", steps };
    }
  } catch {
    return { status: "error" };
  }
}
