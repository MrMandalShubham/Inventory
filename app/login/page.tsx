import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { withoutSession } from "@/lib/db";
import { SESSION_COOKIE, currentSession } from "@/lib/session";
import { signInEnvAdmin, envAdmin } from "@/lib/env-admin";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  let token: string, expires: Date;
  try {
    // The configured administrator first. Returns null when these are
    // not their credentials, so an ordinary user falls straight
    // through to the database — the two doors are indistinguishable
    // from the outside, including on failure.
    const fromEnv = await signInEnvAdmin(email, password, "web");
    if (fromEnv) {
      (await cookies()).set(SESSION_COOKIE, fromEnv.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        expires: fromEnv.expiresAt,
        path: "/",
      });
      redirect(next);
    }

    const row = await withoutSession(async (c) => {
      const { rows } = await c.query("select * from platform.sign_in($1,$2,$3)",
        [email, password, "web"]);
      return rows[0];
    });

    // Bad credentials come back as NO ROWS, not as an exception — see
    // migration 0023. Raising there would have rolled back the
    // failed-attempt counter that makes the lockout work.
    if (!row) {
      redirect(`/login?error=${encodeURIComponent(
        "That email and password do not match.")}&email=${encodeURIComponent(email)}`);
    }

    token = row.token;
    expires = new Date(row.expires_at);
  } catch (e) {
    // redirect() throws; let it through.
    if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
    if ((e as any)?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;

    const raw = e instanceof Error ? e.message : String(e);
    const msg = raw.includes("ACCOUNT_LOCKED")
      ? "Too many attempts. Try again in a few minutes."
      : "That email and password do not match.";
    redirect(`/login?error=${encodeURIComponent(msg)}&email=${encodeURIComponent(email)}`);
  }

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    expires,
  });

  redirect(next.startsWith("/") ? next : "/");
}

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; email?: string; next?: string }>;
}) {
  const { error, email, next } = await searchParams;
  if (await currentSession()) redirect("/");

  return (
    <main className="min-h-dvh grid place-items-center px-5 py-10 bg-ink-50">
      <div className="w-full max-w-sm">
        <div className="mb-7">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-teal-600 text-white text-sm font-bold">
              IC
            </span>
            <span className="text-lg font-semibold tracking-tight">Inventory Core</span>
          </div>
          <p className="lede mt-2 text-sm">
            One record of stock that every app can trust.
          </p>
        </div>

        <div className="card card-pad">
          <h1 className="h-sect mb-4">Sign in</h1>

          {error && (
            <div className="notice notice-bad mb-4" role="alert">{error}</div>
          )}

          <form action={signIn} className="space-y-4">
            <input type="hidden" name="next" value={next ?? "/"} />

            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoFocus
                     autoComplete="username" defaultValue={email ?? ""}
                     className="field" placeholder="you@example.com" />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" name="password" type="password" required
                     autoComplete="current-password" className="field" />
            </div>

            <button type="submit" className="btn w-full">Sign in</button>
          </form>
        </div>

        {envAdmin() && (
          <div className="notice notice-info mt-4 text-[13px]">
            <b>Administrator sign-in.</b> The single administrator is configured in the
            environment as <span className="mono">{envAdmin()!.email}</span>. Everyone
            else signs in against the database.
          </div>
        )}

        <div className="notice notice-info mt-4 text-[13px]">
          <b>Demo data.</b> Password for the seeded users is{" "}
          <span className="mono">inventory</span>. Try{" "}
          <span className="mono">arun@example.com</span> (operator, one shop) against the
          administrator and watch the data change — the database refuses what a role may
          not see, rather than a page hiding it.
        </div>
      </div>
    </main>
  );
}
