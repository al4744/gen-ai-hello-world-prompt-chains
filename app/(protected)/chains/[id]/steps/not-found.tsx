import { BackToChains, ChainPage } from "@/components/chains/chain-ui";

export default function StepNotFound() {
  return <ChainPage title="Step not found" description="The step or its parent chain no longer exists or is unavailable." actions={<BackToChains />}><p className="rounded-2xl border border-border bg-surface p-6 text-sm text-muted">No changes were made. Return to the chain directory to continue.</p></ChainPage>;
}
