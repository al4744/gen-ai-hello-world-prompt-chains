import { SYSTEM_CHAIN_SLUG, type ChainFormState, type ChainValues } from "./model";

// Application guardrails, separate from the database's authoritative checks.
export const CHAIN_LIMITS = { name: 120, slug: 80, description: 4000 } as const;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EMPTY_CHAIN_VALUES: ChainValues = { name: "", slug: "", description: "" };

export function validateChainForm(formData: FormData): ChainFormState {
  const values = { ...EMPTY_CHAIN_VALUES };
  const errors: ChainFormState["errors"] = {};
  for (const field of ["name", "slug", "description"] as const) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
    else if (value !== null) errors[field] = "Enter a text value.";
    if ([...values[field]].length > CHAIN_LIMITS[field]) errors[field] = `Use ${CHAIN_LIMITS[field]} characters or fewer.`;
    if (values[field].includes("\0")) errors[field] = "Remove the unsupported character.";
  }
  if (!values.name.trim()) errors.name = "Enter a chain name.";
  if (!values.slug.trim()) errors.slug = "Enter a slug.";
  else if (!SLUG_PATTERN.test(values.slug.trim())) errors.slug = "Use lowercase letters, numbers, and single hyphens between words.";
  else if (values.slug.trim() === SYSTEM_CHAIN_SLUG) errors.slug = "This slug is reserved for the existing default chain.";
  return { values, errors };
}

export function normalizedValues(values: ChainValues): ChainValues {
  return { name: values.name.trim(), slug: values.slug.trim(), description: values.description.trim() };
}
