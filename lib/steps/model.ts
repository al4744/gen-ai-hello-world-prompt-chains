import { UUID_PATTERN, type ChainStep } from "@/lib/chains/model";

export type StepValues = { name: string; prompt_template: string };
export type StepFormState = { values: StepValues; errors: Partial<Record<keyof StepValues, string>>; message?: string };
export type StepActionState = { error: string | null; success?: string };
export type StepOrder = { id: string; step_order: number }[];
export const EMPTY_STEP_VALUES: StepValues = { name: "", prompt_template: "" };
// Request-size guardrails; database CHECK constraints remain authoritative.
export const STEP_LIMITS = { name: 120, prompt_template: 100_000 } as const;

export function orderSnapshot(steps: Pick<ChainStep, "id" | "step_order">[]): string {
  return JSON.stringify(steps.map(({ id, step_order }) => ({ id, step_order })));
}

export function readExpectedOrder(form: FormData): StepOrder | null {
  const raw = form.get("expected_order");
  if (typeof raw !== "string" || raw.length > 500_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = new Set<string>();
    let previous = 0;
    const order: StepOrder = [];
    for (const item of value) {
      if (!item || typeof item.id !== "string" || !UUID_PATTERN.test(item.id) || ids.has(item.id.toLowerCase()) || !Number.isInteger(item.step_order) || item.step_order <= previous || item.step_order > 2147483647) return null;
      ids.add(item.id.toLowerCase());
      previous = item.step_order;
      order.push({ id: item.id, step_order: item.step_order });
    }
    return order;
  } catch { return null; }
}

export function sameOrder(steps: Pick<ChainStep, "id" | "step_order">[], expected: StepOrder) {
  return steps.length === expected.length && steps.every((step, index) => step.id === expected[index].id && step.step_order === expected[index].step_order);
}

export function originalStep(step: StepValues) {
  return JSON.stringify({ name: step.name, prompt_template: step.prompt_template });
}

export function readOriginalStep(form: FormData): StepValues | null {
  const raw = form.get("original");
  if (typeof raw !== "string" || raw.length > 500_000) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value.name === "string" && typeof value.prompt_template === "string" ? { name: value.name, prompt_template: value.prompt_template } : null;
  } catch { return null; }
}

export function validateStepForm(form: FormData): StepFormState {
  const values = { ...EMPTY_STEP_VALUES };
  const errors: StepFormState["errors"] = {};
  for (const field of ["name", "prompt_template"] as const) {
    const value = form.get(field);
    if (typeof value === "string") values[field] = value;
    if (typeof value !== "string" || !value.trim()) errors[field] = field === "name" ? "Enter a step name." : "Enter a prompt template containing more than whitespace.";
    else if (value.length > STEP_LIMITS[field]) errors[field] = `Use ${STEP_LIMITS[field].toLocaleString("en-US")} characters or fewer.`;
    else if (value.includes("\0")) errors[field] = "Remove the unsupported character.";
  }
  return { values, errors };
}
