import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { envAdmin } from "@/lib/env-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is this deployment actually wired up?
 *
 * ── Why this exists ──
 *
 * A Vercel deployment came up with a green build, served /login
 * perfectly, and could not sign anybody in. The database hostname did
 * not resolve from a serverless function, and the only symptom anybody
 * saw was "That email and password do not match" — which is a lie that
 * costs an afternoon.
 *
 * Every failure this reports is a configuration mistake made once, at
 * deploy time, and invisible until somebody tries to use the system.
 *
 * ── What it deliberately does not say ──
 *
 * No hostnames, no connection strings, no key material, no error
 * details from the driver, no email addresses. Booleans and counts
 * only. It is unauthenticated because a health check nobody can reach
 * without credentials cannot diagnose a broken login, and everything
 * here is already inferable from watching the app fail — the value is
 * in reading it in one request rather than by deduction.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  // ── configuration ──
  //
  // Presence only. Whether a value is RIGHT is what the database check
  // below answers.
  checks.database_url_set = !!process.env.DATABASE_URL;
  checks.admin_configured = !!envAdmin();
  checks.storage_driver =
    process.env.STORAGE_DRIVER ?? (process.env.SUPABASE_URL ? "supabase" : "local");
  checks.supabase_configured =
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  checks.serverless = !!process.env.VERCEL;

  if (!checks.database_url_set) ok = false;
  if (!checks.admin_configured) ok = false;

  // The local storage driver on a serverless host accepts writes and
  // loses them. lib/storage.ts refuses to start in that state; this
  // reports it before anybody uploads a photograph.
  if (checks.serverless && checks.storage_driver === "local") {
    ok = false;
    checks.storage_error = "the local driver cannot be used on a serverless host";
  }

  // ── can we actually reach the database? ──
  try {
    const started = Date.now();
    const c = await pool.connect();
    try {
      const { rows } = await c.query(
        "select count(*)::int as migrations from platform.schema_migration");
      checks.database = "reachable";
      checks.database_ms = Date.now() - started;
      checks.migrations_applied = rows[0].migrations;
    } finally {
      c.release();
    }
  } catch (e: any) {
    ok = false;
    checks.database = "unreachable";

    // The CODE, not the message: ENOTFOUND names the fault without
    // naming the host.
    const code = e?.code ?? "";
    checks.database_error =
      code === "ENOTFOUND"
        ? "hostname does not resolve — on Vercel this usually means DATABASE_URL " +
          "points at Supabase's direct connection, which is IPv6-only. Use the " +
          "Supavisor pooler connection string instead."
        : code === "ETIMEDOUT" || code === "ENETUNREACH"
        ? "host is unreachable from this network"
        : code === "ECONNREFUSED"
        ? "nothing is listening on that port"
        : code === "28P01"
        ? "the database rejected the credentials"
        : code
        ? code
        // No code at all usually means a timeout or a TLS failure, and
        // the message is the only thing that distinguishes them. It is
        // matched, never echoed — the raw text can carry the host.
        : /timeout/i.test(e?.message ?? "")
        ? "the connection timed out"
        : /SSL|TLS|certificate/i.test(e?.message ?? "")
        ? "TLS negotiation failed"
        : "unknown — see the server logs";

    // The detail belongs in the log, where it is not served to the
    // public, and where it is actually useful.
    console.error("[health] database unreachable:", e?.code, e?.message);
  }

  return NextResponse.json(
    { ok, checks, as_of: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
