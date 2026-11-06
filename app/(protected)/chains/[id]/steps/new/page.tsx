import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { getChain, getChainSteps } from "@/lib/chains/data";
import { isSystemChain } from "@/lib/chains/model";
import { EMPTY_STEP_VALUES, orderSnapshot } from "@/lib/steps/model";
import { ChainPage, ChainReadError, SystemChainNotice } from "@/components/chains/chain-ui";
import StepForm from "@/components/steps/step-form";
import { createStep } from "../actions";

export const instant = false;

export default async function NewStepPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const { id } = await params;
  const parent = await getChain(supabase, id);
  if (parent.status === "missing") notFound();
  const href = `/chains/${id}`;
  if (parent.status === "error") return <ChainPage title="Add step" description="Append a step to a custom chain."><ChainReadError retryHref={`${href}/steps/new`} /></ChainPage>;
  if (isSystemChain(parent.chain)) return <ChainPage title="Read-only system chain" description={parent.chain.name} actions={<Link href={href} className="button-secondary">← Chain details</Link>}><SystemChainNotice /></ChainPage>;
  const steps = await getChainSteps(supabase, id);
  return <ChainPage title="Add step" description={`Append a new step to ${parent.chain.name}.`} actions={<Link href={href} prefetch={false} className="button-secondary">← Chain details</Link>}>
    {steps.status === "error" ? <ChainReadError retryHref={`${href}/steps/new`} /> : <StepForm action={createStep.bind(null, id)} values={EMPTY_STEP_VALUES} expectedOrder={orderSnapshot(steps.steps)} chainHref={href} mode="create" />}
  </ChainPage>;
}
