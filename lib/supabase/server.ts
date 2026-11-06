import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions } from "./options";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
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
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components cannot write cookies. The proxy refreshes
            // sessions; Route Handlers and Server Actions can write here.
          }
        },
      },
    }
  );
}
