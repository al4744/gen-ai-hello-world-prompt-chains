import Link from "next/link";
import type { ReactNode } from "react";

export function ChainPage({ title, description, actions, children }: {
  title: string; description: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="eyebrow">Prompt Chain Tool</p>
          <h1 className="mt-3 break-words text-3xl font-bold tracking-tight">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      <div className="mt-8">{children}</div>
    </div>
  );
}

export function ChainReadError({ retryHref = "/chains" }: { retryHref?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6">
      <p role="alert" className="feedback-error">Unable to load this information. Please try again.</p>
      <a href={retryHref} className="button-secondary mt-4">Try again</a>
    </div>
  );
}

export function SystemChainNotice() {
  return <p className="rounded-xl border border-border bg-panel p-4 text-sm leading-6 text-muted">This is the existing Caption Arena default chain. Its metadata, steps, and mix configuration are read-only in this tool.</p>;
}

export function SystemBadge() {
  return <span className="inline-flex rounded-full border border-border bg-panel px-2.5 py-1 text-xs font-medium">Default · System</span>;
}

export function BackToChains() {
  return <Link href="/chains" prefetch={false} className="button-secondary">← Prompt chains</Link>;
}
