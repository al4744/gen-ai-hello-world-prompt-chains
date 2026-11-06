import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";

export const instant = false;

export default async function DashboardPage() {
  await connection();
  // The page authorizes itself independently of its enclosing layout.
  const { user } = await requireSuperadmin();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <header>
        <p className="eyebrow">Prompt Chain Tool</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">Welcome back.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Your superadmin workspace for Caption Arena prompt chains.</p>
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="account-title" className="min-w-0 rounded-2xl border border-border bg-surface p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="account-title" className="text-base font-semibold">You’re signed in</h2>
              {user.email && <p className="mt-2 break-all text-sm leading-6 text-muted">{user.email}</p>}
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium">Superadmin</span>
          </div>
        </section>

        <section aria-labelledby="next-title" className="min-w-0 rounded-2xl border border-border bg-surface p-6">
          <p className="eyebrow">Workspace</p>
          <h2 id="next-title" className="mt-2 text-lg font-semibold">Manage your prompt chains</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Open Prompt Chains in the navigation to manage chain metadata and inspect stored steps. Step editing and execution will follow in a later milestone.</p>
        </section>
      </div>
    </div>
  );
}
