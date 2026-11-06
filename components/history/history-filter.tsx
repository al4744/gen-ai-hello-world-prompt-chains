"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { historyHref } from "@/lib/history/model";

export default function HistoryFilter({ chainId, choices }: { chainId?: string; choices: [string, string][] }) {
  const router = useRouter();
  return <div role="group" aria-label="History filter" className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-surface p-5">
    <div className="min-w-0 flex-1 basis-64"><label htmlFor="history-chain" className="text-sm font-medium">Prompt chain</label>
      <select id="history-chain" name="chain" value={chainId ?? ""} className="form-input mt-2 w-full"
        onChange={event => router.push(historyHref({ page: 1, chainId: event.target.value || undefined }), { scroll: false })}>
        <option value="">All prompt chains</option>{choices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </div>
    {chainId && <Link href={historyHref()} prefetch={false} className="button-secondary">Clear filter</Link>}
  </div>;
}
