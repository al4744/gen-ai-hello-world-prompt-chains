export const SYSTEM_CHAIN_SLUG = "caption-arena-default";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChainValues = { name: string; slug: string; description: string };
export type Chain = ChainValues & { id: string; created_at: string };
export type ChainSummary = Chain & { stepCount: number | null };
export type ChainStep = { id: string; name: string; step_order: number; prompt_template: string };
export type ChainFormState = {
  values: ChainValues;
  errors: Partial<Record<keyof ChainValues, string>>;
  message?: string;
};
export type DeleteChainState = { error: string | null };

export function isSystemChain(chain: Pick<Chain, "slug">) {
  return chain.slug === SYSTEM_CHAIN_SLUG;
}

export function metadataSnapshot(chain: ChainValues): string {
  return JSON.stringify({ name: chain.name, slug: chain.slug, description: chain.description });
}

export function readSnapshot(formData: FormData): ChainValues | null {
  const raw = formData.get("original");
  if (typeof raw !== "string" || raw.length > 500_000) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.name !== "string" || typeof value.slug !== "string" || typeof value.description !== "string") return null;
    return { name: value.name, slug: value.slug, description: value.description };
  } catch {
    return null;
  }
}

export function sameMetadata(chain: ChainValues, original: ChainValues) {
  return chain.name === original.name && chain.slug === original.slug && chain.description === original.description;
}

export function formatCreatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}
