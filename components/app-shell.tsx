import Link from "next/link";
import type { ReactNode } from "react";
import SignOutButton from "@/components/sign-out-button";
import ThemeSelector from "@/components/theme-selector";
import WorkspaceNav from "@/components/workspace-nav";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <Link href="/" className="brand-link inline-block">
          <p className="eyebrow">Caption Arena</p>
          <p className="mt-1 text-base font-semibold tracking-tight">Prompt Chain Tool<span className="text-muted">.</span></p>
        </Link>
      </header>
      <main id="main-content" className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
      <footer className="px-6 pb-6 text-center text-xs text-muted">Caption Arena · Prompt Chain Tool</footer>
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh md:flex">
      <aside className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-border bg-panel md:sticky md:top-0 md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
        <div className="min-w-0 py-4 pr-3 pl-4 md:border-b md:border-border md:px-6 md:py-6">
          <Link href="/dashboard" prefetch={false} className="brand-link block">
            <p className="eyebrow">Caption Arena</p>
            <p className="mt-1 text-base font-bold tracking-tight md:mt-2 md:text-lg">Prompt Chain Tool<span className="text-muted">.</span></p>
          </Link>
        </div>
        <div className="self-center pr-4 md:hidden"><ThemeSelector /></div>
        <WorkspaceNav />
        <div className="pr-4 pb-4 md:space-y-3 md:border-t md:border-border md:p-5">
          <p className="hidden text-xs text-muted md:block">Superadmin workspace</p>
          <div className="hidden md:block"><ThemeSelector /></div>
          <SignOutButton />
        </div>
      </aside>
      <main id="main-content" className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
