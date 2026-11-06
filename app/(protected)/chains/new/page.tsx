import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { EMPTY_CHAIN_VALUES } from "@/lib/chains/validation";
import { BackToChains, ChainPage } from "@/components/chains/chain-ui";
import ChainForm from "@/components/chains/chain-form";
import { createChain } from "../actions";

export const instant = false;

export default async function NewChainPage() {
  await connection();
  await requireSuperadmin();
  return <ChainPage title="Create prompt chain" description="Start with a name, a unique slug, and a description. New chains begin without steps or mix configuration." actions={<BackToChains />}>
    <ChainForm action={createChain} values={EMPTY_CHAIN_VALUES} cancelHref="/chains" mode="create" />
  </ChainPage>;
}
