import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessState } from "@/lib/auth/require-superadmin";

export async function GET(request: Request) {
  const url = new URL(request.url);

  function destination(path: string) {
    // All callers supply fixed internal paths. Never consume next/returnTo,
    // forwarded host headers, or provider error descriptions as destinations.
    const response = NextResponse.redirect(new URL(path, url.origin));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code?.trim()) {
    return destination("/?auth_error=authentication_failed");
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return destination("/?auth_error=authentication_failed");

    const access = await getAccessState(supabase);
    if (access.status === "signed-out") {
      return destination("/?auth_error=authentication_failed");
    }
    if (access.status === "denied") {
      // Keep this app's session so the denied screen can offer sign-out.
      return destination("/?auth_error=access_denied");
    }

    return destination("/dashboard");
  } catch {
    return destination("/?auth_error=authentication_failed");
  }
}
