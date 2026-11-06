import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain, getChainSteps } from "@/lib/chains/data";
import { isSystemChain, UUID_PATTERN } from "@/lib/chains/model";
import { orderSnapshot, originalStep } from "@/lib/steps/model";
import { ChainPage, ChainReadError, SystemChainNotice } from "@/components/chains/chain-ui";
import DeleteStepForm from "@/components/steps/delete-step-form";
import { deleteStep } from "../../actions";

export const instant = false;

export default async function DeleteStepPage({ params }: { params: Promise<{ id: string; stepId: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id, stepId } = await params;
  if (!UUID_PATTERN.test(stepId)) notFound();
  const parent = await getChain(supabase, id);
  if (parent.status === "missing") notFound();
  const href = `/chains/${id}`;
  const back = <Link href={href} prefetch={false} className="button-secondary">← Chain details</Link>;
  if (parent.status === "error") return <ChainPage title="Delete step" description="Review a step before deleting." actions={back}><ChainReadError retryHref={`${href}/steps/${stepId}/delete`} /></ChainPage>;
  if (isSystemChain(parent.chain)) return <ChainPage title="Read-only system chain" description={parent.chain.name} actions={back}><SystemChainNotice /></ChainPage>;
  const steps = await getChainSteps(supabase, id);
  if (steps.status === "error") return <ChainPage title="Delete step" description={parent.chain.name} actions={back}><ChainReadError retryHref={`${href}/steps/${stepId}/delete`} /></ChainPage>;
  const step = steps.steps.find(item => item.id === stepId);
  if (!step) notFound();
  return <ChainPage title="Delete step" description="Review the step and its parent before confirming permanent deletion." actions={back}>
    <section aria-labelledby="delete-step-title" className="max-w-2xl rounded-2xl border border-border bg-surface p-6">
      <h2 id="delete-step-title" className="text-2xl font-bold tracking-tight">Are you sure?</h2>
      <p className="mt-3 text-sm leading-6 text-muted">This permanently deletes the selected step. The remaining steps will be renumbered in their current order.</p>
      <div className="feedback-error mt-5">
        <p className="break-words font-semibold">Step {step.step_order}: {step.name}</p>
        <p className="mt-2 break-words text-sm">{parent.chain.name}</p>
        <p className="mt-1 break-all font-mono text-xs">{parent.chain.slug}</p>
      </div>
      <DeleteStepForm action={deleteStep.bind(null, id, stepId)} expectedOrder={orderSnapshot(steps.steps)} original={originalStep(step)} chainHref={href} name={step.name} />
    </section>
  </ChainPage>;
}
