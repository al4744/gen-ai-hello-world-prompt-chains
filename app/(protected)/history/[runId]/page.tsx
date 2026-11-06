import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { formatCreatedAt } from "@/lib/chains/model";
import { getHistoryRun } from "@/lib/history/data";
import { completedMediaHref, historyHref, savedCaptionAlternatives } from "@/lib/history/model";
import { ChainPage, ChainReadError } from "@/components/chains/chain-ui";
import CompletedImage from "@/components/history/completed-image";
import { SavedCaptions } from "@/components/history/history-gallery";

export const instant = false;

export default async function HistoryDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { runId } = await params;
  const result = await getHistoryRun(supabase, runId);
  if (result.status === "missing") notFound();
  if (result.status === "error") return <ChainPage title="Generation" description="View a completed captioned image."><ChainReadError retryHref={`/history/${runId}`} /></ChainPage>;
  if (result.status !== "ready") return <ChainPage title="Generation unavailable" description="This saved generation could not be verified."><p role="alert" className="feedback-error">A completed image and its saved captions could not be confirmed.</p><Link href="/history" className="button-secondary mt-4" prefetch={false}>Back to History</Link></ChainPage>;
  const { entry } = result;
  return <ChainPage title="Saved generation" description="View the captioned image and original captions saved for this generation."
    actions={<><Link href={historyHref({ page: 1, chainId: entry.chainId })} prefetch={false} className="button-secondary">Chain history</Link><Link href="/generate" prefetch={false} className="button-primary">Generate an image</Link></>}>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <section aria-label="Completed captioned image" className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface"><CompletedImage runId={entry.id} alt={`Completed captioned image created with ${entry.chainName}`} full /></section>
      <div className="min-w-0 space-y-5">
        <section className="rounded-2xl border border-border bg-surface p-6">
          <h2 className="text-base font-semibold">Generation details</h2>
          <dl className="mt-4 space-y-4 text-sm"><div><dt className="text-xs text-muted">Prompt chain when generated</dt><dd className="mt-1 break-words">{entry.chainName}</dd></div>
            <div><dt className="text-xs text-muted">Created</dt><dd className="mt-1"><time dateTime={entry.createdAt}>{formatCreatedAt(entry.createdAt)}</time></dd></div>
            <div><dt className="text-xs text-muted">Completed</dt><dd className="mt-1"><time dateTime={entry.completedAt}>{formatCreatedAt(entry.completedAt)}</time></dd></div></dl>
          <div className="mt-5 flex flex-wrap gap-3"><a href={completedMediaHref(entry.id, true)} download={`caption-${entry.id}.png`} className="button-primary">Download PNG</a>
            {entry.currentChainId ? <Link href={`/chains/${entry.currentChainId}`} prefetch={false} className="button-secondary">Open prompt chain</Link> : <p className="text-xs leading-5 text-muted">The original chain has been deleted. This saved generation remains available.</p>}
          </div>
        </section>
        <section className="rounded-2xl border border-border bg-surface p-6"><h2 className="mb-5 text-base font-semibold">Saved captions</h2>
          <div role="region" aria-label="Full saved captions" tabIndex={0} className="max-h-[32rem] overflow-auto"><SavedCaptions entry={entry} /></div>
          {savedCaptionAlternatives(entry) && <details className="mt-5 text-sm text-muted"><summary className="cursor-pointer">View exact saved output</summary><pre aria-label="Exact saved output" tabIndex={0} className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{entry.finalText}</pre></details>}
        </section>
        <Link href="/history" prefetch={false} className="text-link inline-block text-sm text-muted">All completed generations</Link>
      </div>
    </div>
  </ChainPage>;
}
