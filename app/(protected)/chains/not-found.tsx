import { BackToChains, ChainPage } from "@/components/chains/chain-ui";

export default function ChainNotFound() {
  return <ChainPage title="Chain not found" description="This chain no longer exists or is unavailable to your session." actions={<BackToChains />}><p className="rounded-2xl border border-border bg-surface p-6 text-sm text-muted">No changes were made. Return to the directory to see the available chains.</p></ChainPage>;
}
