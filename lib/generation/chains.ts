import "server-only";
import { listChains, PAGE_SIZE } from "@/lib/chains/data";
import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import type { GenerationChain } from "./workflow";

/** Reuse the guarded directory's queries; include every page, without prompts. */
export async function listGenerationChains(client: Awaited<ReturnType<typeof requireSuperadmin>>["supabase"]): Promise<
  { status: "ready"; chains: GenerationChain[] } | { status: "error" }
> {
  const first = await listChains(client, 1);
  if (first.status === "error") return first;
  const rows = [...first.chains];
  const pages = Math.ceil(first.total / PAGE_SIZE);
  for (let page = 2; page <= pages; page++) {
    const next = await listChains(client, page);
    if (next.status === "error") return next;
    rows.push(...next.chains);
  }
  return { status: "ready", chains: [...new Map(rows.map(chain => [chain.id, {
    id: chain.id, name: chain.name, slug: chain.slug, description: chain.description, stepCount: chain.stepCount,
  }])).values()] };
}
