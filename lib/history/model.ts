import { UUID_PATTERN, SYSTEM_CHAIN_SLUG } from "@/lib/chains/model";

export const HISTORY_PAGE_SIZE = 12;
export const HISTORY_MAX_PAGE = 10000;
export type HistoryFilter = { page: number; chainId?: string };
export type HistoryEntry = {
  id: string; chainId: string; currentChainId: string | null; chainName: string; chainSlug: string;
  createdAt: string; completedAt: string; finalText: string;
};

export function parseHistoryFilter(params: { chain?: unknown; page?: unknown }): HistoryFilter | null {
  if (params.chain !== undefined && (typeof params.chain !== "string" || (params.chain !== "" && !UUID_PATTERN.test(params.chain)))) return null;
  if (params.page !== undefined && (typeof params.page !== "string" || !/^[1-9]\d{0,4}$/.test(params.page))) return null;
  const page = params.page === undefined ? 1 : Number(params.page);
  if (!Number.isSafeInteger(page) || page < 1 || page > HISTORY_MAX_PAGE) return null;
  return { page, ...(params.chain ? { chainId: (params.chain as string).toLowerCase() } : {}) };
}
export function historyHref(filter: HistoryFilter = { page: 1 }) {
  const valid = parseHistoryFilter({ page: String(filter.page), chain: filter.chainId });
  if (!valid) throw new Error("Invalid history filter");
  const params = new URLSearchParams();
  if (valid.chainId) params.set("chain", valid.chainId);
  if (valid.page > 1) params.set("page", String(valid.page));
  return `/history${params.size ? `?${params}` : ""}`;
}
export function completedMediaHref(id: string, download = false) {
  if (!UUID_PATTERN.test(id)) throw new Error("Invalid run ID");
  return `/api/generation/runs/${id.toLowerCase()}/media${download ? "?download=1" : ""}`;
}
export function captionPreview(text: string, maximum = 200) {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  return chars.length > maximum ? `${chars.slice(0, maximum).join("")}…` : chars.join("");
}
export function savedCaptionAlternatives(entry: Pick<HistoryEntry, "chainSlug" | "finalText">): [string, string] | null {
  if (entry.chainSlug !== SYSTEM_CHAIN_SLUG) return null;
  try {
    const value = JSON.parse(entry.finalText);
    return value && Object.keys(value).length === 2 && typeof value.caption_a === "string" && typeof value.caption_b === "string"
      ? [value.caption_a, value.caption_b] : null;
  } catch { return null; }
}
