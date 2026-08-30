import { cookies } from "next/headers";
import { withoutSession } from "./db";

/**
 * Sessions, from Phase 5 onward.
 *
 * The persona switcher this replaces was a build tool: a cookie
 * naming which seeded user you were. It made the location boundary
 * visible while the boundary was being built, which was its job.
 *
 * What matters here is that the CLAIMS SHAPE is unchanged. Every
 * policy, every SECURITY DEFINER body and every test was written
 * against `sub` / `role` / `location_ids` / `all_locations`, and
 * still is. Moving to Supabase Auth later changes where the claims
 * come from, never what they look like.
 */

export const SESSION_COOKIE = "ic_session";

export type Session = {
  sub: string;
  email: string;
  full_name: string;
  role: string;
  all_locations: boolean;
  location_ids: string;
};

export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    return await withoutSession(async (c) => {
      const { rows } = await c.query("select platform.session_claims($1) as claims", [token]);
      return (rows[0].claims as Session | null) ?? null;
    });
  } catch {
    // A database that is down should render the sign-in page, not a
    // stack trace.
    return null;
  }
}

/** Claims for a query. Throws if there is no session — call it only
 *  from pages the middleware has already gated. */
export async function currentClaims(): Promise<Session> {
  const s = await currentSession();
  if (!s) throw new Error("NO_SESSION");
  return s;
}

export function locationList(s: Session): string[] {
  return s.location_ids ? s.location_ids.split(",").filter(Boolean) : [];
}

export function seesEverything(s: Session): boolean {
  return s.all_locations || s.role === "admin";
}

/** Roles that may act rather than only look. */
export const CAN_APPROVE = ["shop_manager", "planner", "admin"];
export const CAN_PLAN = ["planner", "admin"];
export const CAN_SEE_MONEY = ["finance", "admin"];

export function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}
