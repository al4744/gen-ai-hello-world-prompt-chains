import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { generationEnabled } from "@/lib/execution/enabled";
import { listGenerationChains } from "@/lib/generation/chains";
import { UUID_PATTERN } from "@/lib/chains/model";
import { ChainPage, ChainReadError } from "@/components/chains/chain-ui";
import GenerationForm from "@/components/generation-form";

export const instant = false;

export default async function GeneratePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const enabled = generationEnabled();
  const result = await listGenerationChains(supabase);
  const params = await searchParams;
  const runId = typeof params.run === "string" && UUID_PATTERN.test(params.run) ? params.run.toLowerCase() : undefined;
  return <ChainPage title="Generate" description="Upload an image, choose a prompt chain, and turn its ideas into a captioned image.">
    {result.status === "error" ? <ChainReadError retryHref="/generate" />
      : <GenerationForm key={`${enabled}:${runId ?? "new"}`} chains={result.chains} enabled={enabled} initialRunId={runId} />}
  </ChainPage>;
}
