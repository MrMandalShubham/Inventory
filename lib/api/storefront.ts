import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { pool } from "../db";

/**
 * The storefront surface.
 *
 * Separate from lib/api/handler.ts on purpose. That one serves an
 * inventory integrator: strict scopes, mandatory idempotency keys,
 * envelope responses. This one serves a shop's own selling app, which
 * asked for plain arrays at plain paths, and gets them.
 *
 * What it does NOT relax is who may call it. Every request still
 * carries an API key, still runs as `authenticated`, and is still
 * subject to row-level security — a storefront key bound to Shop 1
 * cannot read or hold stock anywhere else, and that is enforced by
 * the database rather than by these handlers.
 */

// ── CORS ──
//
// An allowlist, not "*". A wildcard would let any page on the internet
// call this with a browser's credentials; the point of listing origins
// is that only your storefront can.
function allowedOrigins(): string[] {
  return (process.env.STOREFRONT_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins();

  if (!origin || !allowed.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflight(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export type StorefrontContext = {
  db: PoolClient;
  scopes: string[];
  clientId: string;
  /** Locations this key may sell from. Empty means every location. */
  locationIds: string[];
};

type Handler = (ctx: StorefrontContext, req: NextRequest,
                params: Record<string, string>) => Promise<{ status?: number; body: unknown }>;

/**
 * Wrap a storefront route.
 *
 * One connection per request, claims set, role switched — the same
 * path the dashboard uses, so whatever a storefront cannot do, nobody
 * can do.
 */
export function storefrontRoute(scope: string, handler: Handler) {
  return async function route(
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ) {
    const cors = corsHeaders(req);
    const json = (status: number, body: unknown) =>
      NextResponse.json(body as any, { status, headers: cors });

    const auth = req.headers.get("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

    if (!key) {
      return json(401, {
        error: "unauthorized",
        message:
          "Send your key as: Authorization: Bearer ic_live_… . Call this from your " +
          "server, never from the browser — a key in client code is a key anyone can read.",
      });
    }

    let db: PoolClient | null = null;
    try {
      const params = context?.params ? await context.params : {};
      db = await pool.connect();

      const { rows: [row] } = await db.query(
        "select platform.authenticate_api_key($1) as claims", [key]);
      const claims = row?.claims;

      if (!claims) return json(401, { error: "unauthorized", message: "That key is not valid." });

      const scopes: string[] = claims.scopes ?? [];
      if (!scopes.includes(scope) && !scopes.includes("*")) {
        return json(403, {
          error: "insufficient_scope",
          message: `This key does not hold the "${scope}" scope.`,
          required: scope,
          granted: scopes,
        });
      }

      // Rate limiting applies here too. A storefront hammering the
      // catalogue is exactly the traffic the limiter exists for.
      const { rows: [rl] } = await db.query(
        "select * from platform.consume_rate_token($1, 1)", [claims.client_id]);

      if (!rl.allowed) {
        return NextResponse.json(
          { error: "rate_limited", message: `Retry in ${rl.retry_after}s.`,
            retry_after: rl.retry_after },
          { status: 429, headers: { ...cors, "Retry-After": String(rl.retry_after) } });
      }

      let result: { status?: number; body: unknown };
      try {
        await db.query("begin");
        await db.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify(claims)]);
        await db.query("set local role authenticated");

        result = await handler({
          db,
          scopes,
          clientId: String(claims.client_id),
          locationIds: String(claims.location_ids ?? "").split(",").filter(Boolean),
        }, req, params);

        await db.query("commit");
      } catch (inner) {
        await db.query("rollback").catch(() => {});
        throw inner;
      }

      return json(result.status ?? 200, result.body);
    } catch (e: any) {
      const raw = e?.message ?? String(e);
      const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);

      const status =
        e?.code === "42501" || raw.includes("FORBIDDEN") ? 403 :
        e?.code === "P0002" || raw.includes("NO_SUCH") ? 404 :
        e?.code === "23514" || raw.includes("REQUIRED") ? 422 :
        e?.code === "23505" ? 409 :
        /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(e?.code ?? "") ? 503 : 500;

      if (status >= 500) console.error("[storefront]", raw);

      return json(status, {
        error: named ? named[1].toLowerCase() : "error",
        message: named ? named[2] : status >= 500 ? "Something went wrong." : raw,
      });
    } finally {
      db?.release();
    }
  };
}

/** Paise to rupees, as a Number — the shape the storefront asked for. */
export function rupees(paise: number | string | null | undefined): number | null {
  if (paise === null || paise === undefined) return null;
  const n = Number(paise);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

/**
 * Which location this request is about.
 *
 * Order matters, and getting it wrong is silent:
 *
 *   1. ?location= in the query string
 *   2. `location` in the request body, when the caller passes it here
 *   3. the key's own location, but ONLY if it has exactly one and the
 *      caller named none
 *
 * The third is a convenience for a single-shop storefront that should
 * not have to repeat itself. It very nearly became a security bug: the
 * first version checked only the query string, so a reserve call that
 * named HUB in its BODY fell through to the default and was answered
 * for SH1 — 201 Created, for a shop the caller had not asked about.
 *
 * An explicitly named location must always win. A default that
 * overrides what was asked for is not a default, it is a wrong answer
 * delivered confidently.
 */
export async function resolveLocation(
  ctx: StorefrontContext,
  req: NextRequest,
  explicit?: string | null,
): Promise<{ id: string; code: string } | null> {
  const asked = new URL(req.url).searchParams.get("location") ?? explicit ?? null;

  if (!asked) {
    if (ctx.locationIds.length === 1) {
      const { rows } = await ctx.db.query(
        "select id, code from platform.location where id = $1", [ctx.locationIds[0]]);
      return rows[0] ?? null;
    }
    return null;
  }

  const { rows } = await ctx.db.query(
    `select id, code from platform.location
      where upper(code) = upper($1)
         or ($1 ~ '^[0-9a-f-]{36}$' and id = $1::uuid)`, [asked]);

  // A name that matches nothing must NOT fall back to the key's
  // location either — it is a typo, and answering for a different
  // shop is worse than saying so.
  return rows[0] ?? null;
}

/**
 * One product, shaped for the storefront.
 *
 * `cost` is present only when the key holds the `cost:read` scope. It
 * is the landed cost — what you paid — and publishing it publishes
 * your margin, so it is off by default rather than on.
 */
export function toStorefrontProduct(r: any, scopes: string[]) {
  const out: Record<string, unknown> = {
    id: r.id,
    sku: r.sku_code,
    slug: r.slug,
    name: r.name,
    description: r.description ?? null,
    category: r.category_id ?? null,
    unit: r.pack_size ?? null,
    base_unit: r.uom,
    retailPrice: rupees(r.retail_paise),
    mrp: rupees(r.mrp_paise),
    wholesalePrice: rupees(r.wholesale_paise),
    stock: Number(r.available ?? 0),
    image_url: r.image_url ?? null,
    images: r.images ?? [],
  };

  if (scopes.includes("cost:read") || scopes.includes("*")) {
    out.cost = rupees(r.cost_paise);
  }
  return out;
}
