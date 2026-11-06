import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain, getChainSteps } from "@/lib/chains/data";
import { isSystemChain, UUID_PATTERN } from "@/lib/chains/model";
import { orderSnapshot, originalStep } from "@/lib/steps/model";
import { ChainPage, ChainReadError, SystemChainNotice } from "@/components/chains/chain-ui";
import StepForm from "@/components/steps/step-form";
import { updateStep } from "../../actions";

export const instant = false;

export default async function EditStepPage({ params }: { params: Promise<{ id: string; stepId: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id, stepId } = await params;
  if (!UUID_PATTERN.test(stepId)) notFound();
  const parent = await getChain(supabase, id);
  if (parent.status === "missing") notFound();
  const href = `/chains/${id}`;
  const back = <Link href={href} prefetch={false} className="button-secondary">← Chain details</Link>;
  if (parent.status === "error") return <ChainPage title="Edit step" description="Update a stored step." actions={back}><ChainReadError retryHref={`${href}/steps/${stepId}/edit`} /></ChainPage>;
  if (isSystemChain(parent.chain)) return <ChainPage title="Read-only system chain" description={parent.chain.name} actions={back}><SystemChainNotice /></ChainPage>;
  const steps = await getChainSteps(supabase, id);
  if (steps.status === "error") return <ChainPage title="Edit step" description={parent.chain.name} actions={back}><ChainReadError retryHref={`${href}/steps/${stepId}/edit`} /></ChainPage>;
  const step = steps.steps.find(item => item.id === stepId);
  if (!step) notFound();
  return <ChainPage title="Edit step" description={`Step ${step.step_order} in ${parent.chain.name}. Its position stays unchanged.`} actions={back}>
    <StepForm action={updateStep.bind(null, id, stepId)} values={step} expectedOrder={orderSnapshot(steps.steps)} original={originalStep(step)} chainHref={href} mode="edit" />
  </ChainPage>;
}
