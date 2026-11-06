"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type SignOutState = { error: string | null };

export async function signOut(): Promise<SignOutState> {
  try {
    const supabase = await createClient();
    // Revoke only this app's session, preserving other Caption Arena logins.
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return { error: "Unable to sign out. Please try again." };
  } catch {
    return { error: "Unable to sign out. Please try again." };
  }

  // Cookie deletion plus layout revalidation clears authenticated router UI.
  revalidatePath("/", "layout");
  redirect("/");
}
