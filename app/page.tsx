import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getAccessState } from "@/lib/auth/require-superadmin";
import { AuthShell } from "@/components/app-shell";
import GoogleSignIn from "@/components/google-sign-in";
import SignOutButton from "@/components/sign-out-button";

export const instant = false;

type HomePageProps = {
  searchParams: Promise<{ auth_error?: string }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  await connection();
  const access = await getAccessState();
  if (access.status === "authorized") redirect("/dashboard");

  const { auth_error } = await searchParams;
  const denied = access.status === "denied";

  return (
    <AuthShell>
      <section aria-labelledby="auth-title" className="w-full max-w-md rounded-2xl border border-border bg-surface p-6">
        <p className="eyebrow">Superadmin workspace</p>
        <h1 id="auth-title" className="mt-3 text-2xl font-bold tracking-tight">Prompt Chain Tool</h1>

        {denied ? (
          <div className="mt-5 space-y-4">
            <div className="feedback-error" role="alert">
              <h2 className="font-semibold">Access denied</h2>
              <p className="mt-2 leading-6">An authorized Google account with superadmin access is required to use this tool.</p>
            </div>
            <p className="text-sm leading-6 text-muted">Sign out to continue with a different account.</p>
            <SignOutButton />
          </div>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-muted">A dedicated workspace for managing the prompt chains behind Caption Arena.</p>
            <p className="mt-3 text-sm leading-6 text-muted">Sign in with your authorized Google account to continue.</p>
            {auth_error === "authentication_failed" && (
              <p role="alert" className="feedback-error mt-5">Sign-in could not be completed. The link may have expired. Please try again.</p>
            )}
            <div className="mt-6"><GoogleSignIn /></div>
            <p className="mt-4 text-xs leading-5 text-muted">Access is limited to approved superadmins.</p>
          </>
        )}
      </section>
    </AuthShell>
  );
}
