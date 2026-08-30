import { timingSafeEqual } from "node:crypto";
import { withoutSession } from "./db";

/**
 * The single administrator, configured in the environment.
 *
 * ── What this replaces, and what it does not ──
 *
 * It replaces the bcrypt check in platform.credential for ONE account.
 * It does not replace the session, the claims, or row-level security:
 * a successful environment login produces exactly the same session
 * cookie and the same JWT claims as a database login, so every policy
 * downstream behaves identically. Nothing below the login knows the
 * difference, which is the property worth having.
 *
 * ── The trade being made ──
 *
 * The password now sits in plaintext in an environment file rather
 * than as a bcrypt hash in a table. For a system with one operator
 * that is a reasonable simplification. It is worth being clear about
 * the cost:
 *
 *   • anyone who can read the environment can sign in as admin —
 *     there is no second factor and no hash to slow them down;
 *   • rotating it means a redeploy, not a form;
 *   • there is no lockout, because there is no failed-attempt counter
 *     to increment. A slow comparison is the only brake, so the
 *     comparison is constant-time.
 *
 * Database-backed users still work. This is an additional door, not a
 * replacement for the mechanism — 243 tests cover that mechanism, and
 * deleting working, tested code to reach the same place would be a
 * poor trade.
 */

export type EnvAdmin = { email: string; password: string; name: string };

export function envAdmin(): EnvAdmin | null {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) return null;

  return {
    email: email.toLowerCase(),
    password,
    name: process.env.ADMIN_NAME?.trim() || "Administrator",
  };
}

/**
 * Compare without leaking the answer through timing.
 *
 * A plain `===` on secrets returns as soon as two bytes differ, and
 * the time it took is a measurable hint about how much of the guess
 * was right. That matters more here than it would beside bcrypt,
 * because there is no work factor and no lockout standing behind it.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");

  // Length is not secret — but comparing buffers of different lengths
  // throws, so it is checked first and the comparison still runs to
  // keep the shape of the work constant.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Try the environment administrator. Returns a session token, or null
 * if these are not their credentials.
 *
 * Null means "not this door" — the caller falls through to the
 * database. It never means "wrong password" separately from "unknown
 * user", for the same reason platform.sign_in does not distinguish
 * them.
 */
export async function signInEnvAdmin(
  email: string,
  password: string,
  userAgent = "web",
): Promise<{ token: string; expiresAt: Date } | null> {
  const admin = envAdmin();
  if (!admin) return null;

  const emailMatches = constantTimeEquals(email.trim().toLowerCase(), admin.email);
  const passwordMatches = constantTimeEquals(password, admin.password);

  // Both compared before either is acted on, so a wrong email and a
  // wrong password cost the same.
  if (!emailMatches || !passwordMatches) return null;

  return withoutSession(async (c) => {
    // The identity row has to exist: roughly forty columns in this
    // schema reference platform.app_user, and the first movement
    // raised without one dies on a foreign key.
    const { rows: [user] } = await c.query(
      "select platform.ensure_admin($1, $2) as id", [admin.email, admin.name]);

    const { rows: [session] } = await c.query(
      "select * from platform.open_session_for($1, $2)", [user.id, userAgent]);

    return { token: session.token, expiresAt: new Date(session.expires_at) };
  });
}
