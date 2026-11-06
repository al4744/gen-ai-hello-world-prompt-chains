import type { ReactNode } from "react";
import { connection } from "next/server";
import { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { DashboardShell } from "@/components/app-shell";

export const instant = false;

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  await connection();
  await requireSuperadmin();
  return <DashboardShell>{children}</DashboardShell>;
}
