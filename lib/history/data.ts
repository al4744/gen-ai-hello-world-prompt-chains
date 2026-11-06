import "server-only";
import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { integer, object, sha, text, timestamp, uuid, validateOutput } from "@/lib/execution/contracts";
import { SYSTEM_CHAIN_SLUG } from "@/lib/chains/model";
import { LIMITS } from "@/lib/execution/types";
import { HISTORY_MAX_PAGE, HISTORY_PAGE_SIZE, parseHistoryFilter, type HistoryEntry, type HistoryFilter } from "./model";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];
// Private receipt fields are checked server-side and never become UI props.
const FIELDS = "id,original_chain_id,current_chain_id,chain_name,chain_slug,status,created_at,completed_at,final_text,creator_id_snapshot,artifact_path,artifact_sha256,artifact_size_bytes";

function successful(client: Client, fields = FIELDS) {
  return client.from("prompt_chain_runs").select(fields).eq("status", "succeeded")
    .not("completed_at", "is", null).not("final_text", "is", null).not("artifact_path", "is", null)
    .not("artifact_sha256", "is", null).not("artifact_size_bytes", "is", null)
    .gte("artifact_size_bytes", 1).lte("artifact_size_bytes", LIMITS.imageBytes);
}
function project(value: unknown): HistoryEntry {
  const row = object(value);
  if (row.status !== "succeeded") throw new Error("Unfinished run");
  const id = uuid(row.id), chainId = uuid(row.original_chain_id), creator = uuid(row.creator_id_snapshot);
  const currentChainId = row.current_chain_id === null ? null : uuid(row.current_chain_id);
  if ((currentChainId && currentChainId !== chainId) || row.artifact_path !== `${creator}/${id}/captioned.png`) throw new Error("Invalid receipt");
  sha(row.artifact_sha256); integer(row.artifact_size_bytes, 1, LIMITS.imageBytes);
  const created = timestamp(text(row.created_at, 64)), completed = timestamp(text(row.completed_at, 64));
  const finalText = text(row.final_text, LIMITS.outputBytes), chainName = text(row.chain_name, 2048), chainSlug = text(row.chain_slug, 256);
  if (!validateOutput(chainSlug === SYSTEM_CHAIN_SLUG ? "composed" : "sequential", finalText)
      || !chainName.trim() || !chainSlug.trim() || completed < created) throw new Error("Invalid saved values");
  return { id, chainId, currentChainId, chainName, chainSlug, createdAt: new Date(created).toISOString(), completedAt: new Date(completed).toISOString(), finalText };
}

/** Caller must supply the session client obtained from requireSuperadmin(). */
export async function listHistory(client: Client, filter: HistoryFilter): Promise<
  { status: "ready"; entries: HistoryEntry[]; hasNext: boolean; omitted: number; capped: boolean } | { status: "error" | "invalid" }
> {
  const valid = parseHistoryFilter({ page: String(filter.page), chain: filter.chainId });
  if (!valid) return { status: "invalid" };
  try {
    let query = successful(client);
    if (valid.chainId) query = query.eq("original_chain_id", valid.chainId);
    const start = (valid.page - 1) * HISTORY_PAGE_SIZE;
    const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(start, start + HISTORY_PAGE_SIZE).abortSignal(AbortSignal.timeout(7000));
    if (result.error || !Array.isArray(result.data)) return { status: "error" };
    const entries: HistoryEntry[] = []; let omitted = 0;
    for (const value of result.data.slice(0, HISTORY_PAGE_SIZE)) {
      try {
        const entry = project(value);
        if (valid.chainId && entry.chainId !== valid.chainId) throw new Error("Wrong chain");
        entries.push(entry);
      } catch { omitted++; }
    }
    const extra = result.data.length > HISTORY_PAGE_SIZE;
    return { status: "ready", entries, omitted, hasNext: extra && valid.page < HISTORY_MAX_PAGE, capped: extra && valid.page === HISTORY_MAX_PAGE };
  } catch { return { status: "error" }; }
}

export async function getHistoryRun(client: Client, runId: string): Promise<
  { status: "ready"; entry: HistoryEntry } | { status: "missing" | "invalid" | "error" }
> {
  let id: string;
  try { id = uuid(runId); } catch { return { status: "missing" }; }
  try {
    const result = await successful(client).eq("id", id).abortSignal(AbortSignal.timeout(7000)).maybeSingle();
    if (result.error) return { status: "error" };
    if (!result.data) return { status: "missing" };
    try {
      const entry = project(result.data);
      return entry.id === id ? { status: "ready", entry } : { status: "invalid" };
    } catch { return { status: "invalid" }; }
  } catch { return { status: "error" }; }
}

/** Rare fallback for a selected archived chain on an empty/later page. */
export async function getSavedChainName(client: Client, chainId: string): Promise<string | null> {
  try {
    const id = uuid(chainId);
    const result = await successful(client, "original_chain_id,chain_name").eq("original_chain_id", id)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(7000)).maybeSingle();
    if (result.error || !result.data) return null;
    const row = object(result.data);
    if (uuid(row.original_chain_id) !== id) return null;
    const name = text(row.chain_name, 2048);
    return name.trim() ? name : null;
  } catch { return null; }
}
