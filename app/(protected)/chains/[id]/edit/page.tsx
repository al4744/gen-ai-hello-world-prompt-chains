import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain } from "@/lib/chains/data";
import { isSystemChain, metadataSnapshot } from "@/lib/chains/model";
import { BackToChains, ChainPage, ChainReadError, SystemChainNotice } from "@/components/chains/chain-ui";
import ChainForm from "@/components/chains/chain-form";
import { updateChain } from "../../actions";

export const instant = false;

export default async function EditChainPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id } = await params;
  const result = await getChain(supabase, id);
  if (result.status === "missing") notFound();
  return <ChainPage title="Edit prompt chain" description="Update custom chain metadata. Existing steps and ordering remain unchanged." actions={<BackToChains />}>
    {result.status === "error" ? <ChainReadError retryHref={`/chains/${id}/edit`} /> : isSystemChain(result.chain) ? <SystemChainNotice /> : (
      <ChainForm action={updateChain.bind(null, result.chain.id)} values={result.chain} original={metadataSnapshot(result.chain)} cancelHref={`/chains/${result.chain.id}`} mode="edit" />
    )}
  </ChainPage>;
}
