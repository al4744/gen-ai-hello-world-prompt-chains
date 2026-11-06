import Link from "next/link";
import { captionPreview, completedMediaHref, historyHref, savedCaptionAlternatives, type HistoryEntry } from "@/lib/history/model";
import CompletedImage from "./completed-image";
import LocalDateTime from "./local-date-time";

export function SavedCaptions({ entry, preview = false }: { entry: HistoryEntry; preview?: boolean }) {
  const alternatives = savedCaptionAlternatives(entry);
  return alternatives ? <div className={`grid gap-3 ${preview ? "" : "sm:grid-cols-2"}`}>{alternatives.map((caption, index) => <div key={index} className="min-w-0">
    <p className="eyebrow">Caption {index === 0 ? "A" : "B"}</p>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{preview ? captionPreview(caption, 110) : caption}</p>
  </div>)}</div> : <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{preview ? captionPreview(entry.finalText) : entry.finalText}</pre>;
}

export default function HistoryGallery({ entries }: { entries: HistoryEntry[] }) {
  return <section aria-label="Completed generations" className="grid items-start gap-5 sm:grid-cols-2 xl:grid-cols-3">
    {entries.map(entry => <article key={entry.id} className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
      <CompletedImage runId={entry.id} alt={`Captioned image created with ${entry.chainName}`} />
      <div className="space-y-4 border-t border-border p-5">
        <div>
          <h2 className="break-words text-base font-semibold"><Link href={`/history/${entry.id}`} prefetch={false} className="text-link">{entry.chainName}</Link></h2>
          <LocalDateTime value={entry.createdAt} prefix="Created " className="mt-2 block text-xs leading-5 text-muted" />
        </div>
        <div><p className="mb-3 text-xs font-medium text-muted">Caption preview</p><SavedCaptions entry={entry} preview /></div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/history/${entry.id}`} prefetch={false} className="button-primary">View generation</Link>
          <a href={completedMediaHref(entry.id, true)} download={`caption-${entry.id}.png`} className="button-secondary">Download PNG</a>
        </div>
        <Link href={historyHref({ page: 1, chainId: entry.chainId })} prefetch={false} className="text-link inline-block text-xs text-muted">More from this chain</Link>
      </div>
    </article>)}
  </section>;
}
