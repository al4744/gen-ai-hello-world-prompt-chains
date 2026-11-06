import Link from "next/link";
import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { listGenerationChains } from "@/lib/generation/chains";
import { getSavedChainName, listHistory } from "@/lib/history/data";
import { historyHref, parseHistoryFilter } from "@/lib/history/model";
import { UUID_PATTERN } from "@/lib/chains/model";
import { ChainPage, ChainReadError } from "@/components/chains/chain-ui";
import HistoryGallery from "@/components/history/history-gallery";
import HistoryFilter from "@/components/history/history-filter";

export const instant = false;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ chain?: string; page?: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const filter = parseHistoryFilter(await searchParams);
  if (!filter) return <ChainPage title="History" description="Browse the captioned images saved by your prompt chains.">
    <p role="alert" className="feedback-error">Choose a valid prompt chain and page number.</p><Link href="/history" prefetch={false} className="button-secondary mt-4">Clear filters</Link>
  </ChainPage>;
  const [history, directory] = await Promise.all([listHistory(supabase, filter), listGenerationChains(supabase)]);
  if (history.status !== "ready") return <ChainPage title="History" description="Browse the captioned images saved by your prompt chains."><ChainReadError retryHref={historyHref(filter)} /></ChainPage>;
  const choices = new Map<string, string>();
  if (directory.status === "ready") for (const chain of directory.chains) {
    if (typeof chain.id === "string" && UUID_PATTERN.test(chain.id) && typeof chain.name === "string"
        && chain.name.trim() && chain.name.isWellFormed() && chain.name.length <= 500) choices.set(chain.id.toLowerCase(), chain.name);
  }
  for (const entry of history.entries) if (!choices.has(entry.chainId)) choices.set(entry.chainId, entry.chainName);
  if (filter.chainId && !choices.has(filter.chainId)) choices.set(filter.chainId, await getSavedChainName(supabase, filter.chainId) || "Selected chain");
  const selectedName = filter.chainId ? choices.get(filter.chainId) : null;
  return <ChainPage title="History" description="Browse the captioned images saved by your prompt chains."
    actions={<Link href="/generate" prefetch={false} className="button-primary">Generate an image</Link>}>
    <HistoryFilter chainId={filter.chainId} choices={[...choices].sort((a, b) => a[1].localeCompare(b[1], "en"))} />
    <div className="mb-5"><h2 className="break-words text-base font-semibold">{selectedName ? `Generations from ${selectedName}` : "All completed generations"}</h2>
      <p className="mt-2 text-xs leading-5 text-muted">Each generation keeps the chain name and captions saved when it ran. Dates are shown in UTC.</p>
    </div>
    {directory.status === "error" && <p role="status" className="feedback-success mb-5 text-muted">The chain directory could not be loaded. You can still browse saved generations and filter using the chains shown here.</p>}
    {history.omitted > 0 && <p role="status" className="feedback-success mb-5 text-muted">Some saved entries could not be verified and are hidden.</p>}
    {history.entries.length ? <HistoryGallery entries={history.entries} /> : <section className="rounded-2xl border border-border bg-surface p-6">
      <h3 className="font-semibold">{filter.page > 1 ? "No completed generations on this page" : "No completed generations yet"}</h3>
      <p className="mt-2 break-words text-sm leading-6 text-muted">{filter.page > 1 ? "Return to the first page to see the newest saved images." : selectedName ? `Successful captioned images from ${selectedName} will appear here.` : "Your successful captioned images will appear here after generation is enabled and a run finishes."}</p>
      <div className="mt-4 flex flex-wrap gap-3"><Link href="/generate" prefetch={false} className="button-primary">Go to Generate</Link>
        {filter.page > 1 && <Link href={historyHref({ ...filter, page: 1 })} prefetch={false} className="button-secondary">First page</Link>}
      </div>
    </section>}
    {(filter.page > 1 || history.hasNext) && <nav aria-label="History pages" className="mt-6 flex flex-wrap items-center gap-3">
      {filter.page > 1 && <Link href={historyHref({ ...filter, page: filter.page - 1 })} prefetch={false} className="button-secondary">Previous</Link>}
      <span className="text-sm text-muted">Page {filter.page}</span>
      {history.hasNext && <Link href={historyHref({ ...filter, page: filter.page + 1 })} prefetch={false} className="button-secondary">Next</Link>}
    </nav>}
    {history.capped && <p role="status" className="mt-4 text-sm text-muted">Refine the prompt-chain filter to browse older generations.</p>}
  </ChainPage>;
}
