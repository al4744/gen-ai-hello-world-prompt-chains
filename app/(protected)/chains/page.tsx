import Link from "next/link";
import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { listChains, PAGE_SIZE } from "@/lib/chains/data";
import { formatCreatedAt, isSystemChain } from "@/lib/chains/model";
import { ChainPage, ChainReadError, SystemBadge } from "@/components/chains/chain-ui";

export const instant = false;

export default async function ChainsPage({ searchParams }: {
  searchParams: Promise<{ page?: string; deleted?: string; already_deleted?: string }>;
}) {
  await connection();
  const { supabase } = await requireSuperadmin();
  const params = await searchParams;
  const rawPage = typeof params.page === "string" && /^\d{1,6}$/.test(params.page) ? Number(params.page) : 1;
  const page = Math.max(1, rawPage);
  const result = await listChains(supabase, page);

  return (
    <ChainPage title="Prompt chains" description="Manage the named prompt configurations behind Caption Arena."
      actions={<Link href="/chains/new" prefetch={false} className="button-primary font-semibold">Create chain</Link>}>
      {params.deleted === "1" && <p role="status" className="feedback-success mb-5">Prompt chain deleted.</p>}
      {params.already_deleted === "1" && <p role="status" className="feedback-success mb-5">This chain was already deleted. Nothing else was changed.</p>}
      {result.status === "error" ? <ChainReadError /> : (
        <>
          <section aria-label="Prompt chain directory" className="overflow-hidden rounded-2xl border border-border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
              <h2 className="text-base font-semibold">Chain directory</h2>
              <p className="text-xs text-muted">{result.total} {result.total === 1 ? "chain" : "chains"}</p>
            </div>
            {result.chains.length === 0 ? (
              <div className="p-6">
                <h3 className="font-semibold">{page > 1 ? "No chains on this page" : "No prompt chains yet"}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{page > 1 ? "Return to the first page to see the current directory." : "Create a chain to start organizing prompt metadata. Steps can be added in a later milestone."}</p>
                {page > 1 && <Link href="/chains" className="button-secondary mt-4">First page</Link>}
              </div>
            ) : result.chains.map(chain => (
              <article key={chain.id} className="chain-directory-row flex flex-wrap items-start justify-between gap-5 p-6">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="min-w-0 max-w-full break-words text-base font-semibold"><Link href={`/chains/${chain.id}`} prefetch={false} className="text-link">{chain.name}</Link></h3>
                    {isSystemChain(chain) && <SystemBadge />}
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted">{chain.slug}</p>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted">{chain.description || "No description provided."}</p>
                  <p className="mt-3 text-xs leading-5 text-muted">Created {formatCreatedAt(chain.created_at)} · {chain.stepCount === null ? "Step count unavailable" : `${chain.stepCount} ${chain.stepCount === 1 ? "step" : "steps"}`}</p>
                </div>
                <div className="flex flex-wrap gap-2" aria-label={`Actions for ${chain.name}`}>
                  <Link href={`/chains/${chain.id}`} prefetch={false} className="button-secondary">View</Link>
                  {!isSystemChain(chain) && <>
                    <Link href={`/chains/${chain.id}/edit`} prefetch={false} className="button-secondary">Edit</Link>
                    <Link href={`/chains/${chain.id}/delete`} prefetch={false} className="button-danger-secondary">Delete</Link>
                  </>}
                </div>
              </article>
            ))}
          </section>
          {(page > 1 || result.total > PAGE_SIZE) && (
            <nav aria-label="Chain directory pages" className="mt-5 flex flex-wrap items-center gap-3">
              {page > 1 && <Link href={`/chains?page=${page - 1}`} prefetch={false} className="button-secondary">Previous</Link>}
              <span className="text-sm text-muted">Page {page} of {Math.max(1, Math.ceil(result.total / PAGE_SIZE))}</span>
              {page * PAGE_SIZE < result.total && <Link href={`/chains?page=${page + 1}`} prefetch={false} className="button-secondary">Next</Link>}
            </nav>
          )}
        </>
      )}
    </ChainPage>
  );
}
