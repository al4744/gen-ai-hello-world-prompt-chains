import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions } from "./options";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: authCookieOptions,
      global: {
        fetch(input, init) {
          return fetch(input, { ...init, cache: "no-store" });
        },
      },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );

          // Preserve any preceding cookie writes from this request.
          const previousCookies = response.cookies.getAll();
          response = NextResponse.next({ request });
          previousCookies.forEach((cookie) => response.cookies.set(cookie));
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
          Object.entries(headers).forEach(([name, value]) =>
            response.headers.set(name, value)
          );
        },
      },
    }
  );

  try {
    await supabase.auth.getClaims();
  } catch {
    // A failed refresh never grants access. Pages and endpoints independently
    // verify the user and superadmin profile through the server-side guard.
  }

  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  response.headers.set("CDN-Cache-Control", "no-store");
  response.headers.set("Vercel-CDN-Cache-Control", "no-store");
  return response;
}
