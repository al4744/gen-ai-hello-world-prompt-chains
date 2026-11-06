import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain } from "@/lib/chains/data";
import { isSystemChain, metadataSnapshot } from "@/lib/chains/model";
import { BackToChains, ChainPage, ChainReadError, SystemChainNotice } from "@/components/chains/chain-ui";
import DeleteChainForm from "@/components/chains/delete-chain-form";
import { deleteChain } from "../../actions";

export const instant = false;

export default async function DeleteChainPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id } = await params;
  const result = await getChain(supabase, id);
  if (result.status === "missing") notFound();
  return <ChainPage title="Delete prompt chain" description="Review the selected chain before confirming permanent deletion." actions={<BackToChains />}>
    {result.status === "error" ? <ChainReadError retryHref={`/chains/${id}/delete`} /> : isSystemChain(result.chain) ? <SystemChainNotice /> : (
      <section aria-labelledby="delete-title" className="max-w-2xl rounded-2xl border border-border bg-surface p-6">
        <h2 id="delete-title" className="text-2xl font-bold tracking-tight">Are you sure?</h2>
        <p className="mt-3 text-sm leading-6 text-muted">You are about to permanently delete this prompt chain. This cannot be undone.</p>
        <div className="feedback-error mt-5">
          <p className="break-words font-semibold">{result.chain.name}</p>
          <p className="mt-2 break-all font-mono text-xs">{result.chain.slug}</p>
        </div>
        <p className="mt-5 text-sm leading-6 text-muted">The database automatically removes this chain’s stored steps and mix entry.</p>
        <DeleteChainForm action={deleteChain.bind(null, result.chain.id)} original={metadataSnapshot(result.chain)} cancelHref={`/chains/${result.chain.id}`} name={result.chain.name} />
      </section>
    )}
  </ChainPage>;
}
