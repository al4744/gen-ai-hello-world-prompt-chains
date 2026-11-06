import "server-only";

import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export type AccessState =
  | { status: "signed-out" }
  | { status: "denied" }
  | { status: "authorized"; supabase: ServerClient; user: User };

/** Request-scoped verification. Never cache this result across requests. */
export async function getAccessState(client?: ServerClient): Promise<AccessState> {
  let supabase: ServerClient;
  let user: User;

  try {
    supabase = client ?? await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return { status: "signed-out" };
    user = data.user;
  } catch {
    return { status: "signed-out" };
  }

  if (!user.identities?.some((identity) => identity.provider === "google")) {
    return { status: "denied" };
  }

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_superadmin")
      .eq("id", user.id)
      .maybeSingle();

    if (error || profile?.is_superadmin !== true) return { status: "denied" };
  } catch {
    return { status: "denied" };
  }

  return { status: "authorized", supabase, user };
}

export class AuthorizationError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? "Sign-in required." : "Superadmin access required.");
    this.name = "AuthorizationError";
  }
}

/**
 * Call before every protected read or mutation, including future Server Actions.
 * Route Handlers can use { onDenied: "throw" } and map AuthorizationError to
 * its 401/403 status without receiving an HTML login redirect.
 */
export async function requireSuperadmin(
  options: { onDenied?: "redirect" | "throw" } = {}
) {
  const access = await getAccessState();
  if (access.status === "authorized") {
    return { supabase: access.supabase, user: access.user };
  }

  if (options.onDenied === "throw") {
    throw new AuthorizationError(access.status === "signed-out" ? 401 : 403);
  }

  redirect(access.status === "signed-out" ? "/" : "/?auth_error=access_denied");
}
