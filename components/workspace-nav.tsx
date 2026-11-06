"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Dashboard", number: "01" },
  { href: "/chains", label: "Prompt Chains", number: "02" },
  { href: "/generate", label: "Generate", number: "03" },
  { href: "/history", label: "History", number: "04" },
];

export default function WorkspaceNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace navigation" className="min-w-0 self-center px-4 pb-4 md:w-full md:flex-1 md:py-5">
      <p className="eyebrow mb-3 hidden px-3 md:block">Workspace</p>
      <div className="grid gap-2">
        {items.map(item => (
          <Link key={item.href} href={item.href} prefetch={false} className="navigation-link"
            aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? "page" : undefined}>
            <span>{item.label}</span><span className="hidden font-mono text-xs opacity-60 md:inline">{item.number}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
