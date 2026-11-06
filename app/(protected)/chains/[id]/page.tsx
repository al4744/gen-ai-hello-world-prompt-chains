import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain, getChainSteps } from "@/lib/chains/data";
import { formatCreatedAt, isSystemChain } from "@/lib/chains/model";
import { BackToChains, ChainPage, ChainReadError, SystemBadge, SystemChainNotice } from "@/components/chains/chain-ui";

export const instant = false;

export default async function ChainDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; updated?: string }>;
}) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id } = await params;
  const result = await getChain(supabase, id);
  if (result.status === "missing") notFound();
  if (result.status === "error") return <ChainPage title="Prompt chain" description="Inspect chain metadata and stored steps." actions={<BackToChains />}><ChainReadError retryHref={`/chains/${id}`} /></ChainPage>;
  const { chain } = result;
  const steps = await getChainSteps(supabase, chain.id);
  const feedback = await searchParams;

  return (
    <ChainPage title={chain.name} description="Chain metadata and a read-only view of its stored steps."
      actions={<><BackToChains />{!isSystemChain(chain) && <>
        <Link href={`/chains/${chain.id}/edit`} prefetch={false} className="button-primary font-semibold">Edit chain</Link>
        <Link href={`/chains/${chain.id}/delete`} prefetch={false} className="button-danger-secondary">Delete</Link>
      </>}</>}>
      {(feedback.created === "1" || feedback.updated === "1") && <p role="status" className="feedback-success mb-5">{feedback.created === "1" ? "Prompt chain created." : "Changes saved."}</p>}
      {isSystemChain(chain) && <div className="mb-5"><SystemChainNotice /></div>}
      <section aria-labelledby="metadata-title" className="rounded-2xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="metadata-title" className="text-base font-semibold">Chain details</h2>{isSystemChain(chain) && <SystemBadge />}</div>
        <dl className="mt-5 grid gap-5 sm:grid-cols-2">
          <div><dt className="text-xs font-medium text-muted">Slug</dt><dd className="mt-2 break-all font-mono text-sm">{chain.slug}</dd></div>
          <div><dt className="text-xs font-medium text-muted">Created</dt><dd className="mt-2 text-sm">{formatCreatedAt(chain.created_at)}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs font-medium text-muted">Description</dt><dd className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{chain.description || "No description provided."}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs font-medium text-muted">Chain ID</dt><dd className="mt-2 break-all font-mono text-xs text-muted">{chain.id}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="steps-title" className="mt-5 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 id="steps-title" className="text-base font-semibold">Stored steps{steps.status === "ready" ? ` (${steps.steps.length})` : ""}</h2>
          <span className="text-xs text-muted">Read-only</span>
        </div>
        {steps.status === "error" ? <div className="p-6"><p role="alert" className="feedback-error">Stored steps could not be loaded. Chain metadata is still available.</p></div> : steps.steps.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-muted">No steps yet. This chain is ready for the step-management milestone.</p>
        ) : <ol>{steps.steps.map(step => (
          <li key={step.id} className="chain-directory-row p-6">
            <details>
              <summary className="cursor-pointer break-words text-sm font-semibold"><span className="mr-3 font-mono text-xs text-muted">{step.step_order}</span>{step.name}</summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-input p-4 font-mono text-xs leading-6">{step.prompt_template}</pre>
            </details>
          </li>
        ))}</ol>}
      </section>
    </ChainPage>
  );
}
