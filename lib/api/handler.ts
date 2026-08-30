import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { pool } from "../db";

/**
 * The API wrapper every /api/v1 route goes through.
 *
 * ── The one thing that matters here ──
 *
 * An API client runs through EXACTLY the same session path as the
 * dashboard: `authenticated` role, claims set, row-level security
 * applied. It gets no privileged route. Whatever a third-party
 * integrator cannot do, our own dashboard cannot do either, and the
 * reverse — which is the only way "the API is the product" is true
 * rather than aspirational.
 */

export type Claims = Record<string, unknown>;

export type ApiContext = {
  /**
   * The session connection, with claims set and role switched.
   *
   * Handlers MUST use this and never pool.connect() of their own — a
   * fresh connection has no claims, so row-level security would see
   * an anonymous caller and silently return nothing. Passing the
   * client in is what makes that mistake impossible to make.
   */
  db: PoolClient;
  claims: Claims;
  clientId: string;
  scopes: string[];
  environment: string;
  body: any;
  req: NextRequest;
  params: Record<string, string>;
};

type Handler = (ctx: ApiContext) => Promise<{ status?: number; body: unknown }>;

type Options = {
  scope: string;
  /** Writes get idempotency handling and require the header. */
  idempotent?: boolean;
};

const ERR: Record<string, { status: number; code: string }> = {
  "42501": { status: 403, code: "forbidden" },
  "P0002": { status: 404, code: "not_found" },
  "23505": { status: 409, code: "conflict" },
  "23514": { status: 409, code: "unprocessable" },
  "23503": { status: 422, code: "bad_reference" },
};

/**
 * Application-level refusals thrown outside Postgres.
 *
 * A caller who sends a PHP script labelled as a PNG has made a
 * mistake; answering 500 tells them WE broke and invites a retry that
 * will fail identically forever. These are 4xx.
 */
const APP_ERR: Record<string, number> = {
  NOT_AN_IMAGE: 415,
  UNSUPPORTED_IMAGE_TYPE: 415,
  IMAGE_TYPE_MISMATCH: 400,
  EMPTY_IMAGE: 400,
  IMAGE_TOO_LARGE: 413,
  // Not the caller's fault, and it must stay a 500 so it pages
  // somebody rather than being silently absorbed by a client.
  STORAGE_MISCONFIGURED: 500,
  STORAGE_WRITE_FAILED: 502,
};

/** Postgres exceptions carry a NAME: prefix; surface it to the client. */
function parsePgError(e: any) {
  const raw: string = e?.message ?? String(e);
  const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);

  // A Postgres code wins: it is the more specific fact.
  const mapped = ERR[e?.code]
    ?? (named && APP_ERR[named[1]] !== undefined
          ? { status: APP_ERR[named[1]], code: named[1].toLowerCase() }
          : { status: 500, code: "internal_error" });

  return {
    status: mapped.status,
    code: named ? named[1].toLowerCase() : mapped.code,
    message: named ? named[2] : raw,
  };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return NextResponse.json(body as any, {
    status,
    headers: { "X-Api-Version": "v1", ...extra },
  });
}

export function apiRoute(opts: Options, handler: Handler) {
  return async function route(
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ) {
    const started = Date.now();
    const path = new URL(req.url).pathname;
    let clientId: string | null = null;
    let idemKey: string | null = null;
    let replayed = false;
    let status = 500;
    let errorCode: string | null = null;
    let db: PoolClient | null = null;
    let throttled = false;
    // Set once the bucket has been charged, so every response — not
    // only a 429 — tells the client where it stands. A limit a client
    // can only discover by hitting it is a limit they will hit.
    let limitHeaders: Record<string, string> = {};

    const finish = (res: NextResponse) => {
      status = res.status;
      // Fire-and-forget on its own connection, AFTER the response is
      // built. It must never sit between the caller and their answer,
      // and a logging failure must never turn a successful write into
      // an error.
      void logRequest({
        clientId, method: req.method, path, status,
        errorCode, idemKey, replayed, throttled, ms: Date.now() - started,
      });
      return res;
    };

    try {
      // Routes without a dynamic segment get no `params` at all.
      // Resolving it outside this try threw a TypeError that Next
      // turned into a bare 500 with no body — which is exactly the
      // kind of error the wrapper exists to prevent.
      const params = context?.params ? await context.params : {};

      // ── 1. Authenticate ──
      const auth = req.headers.get("authorization") ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
      if (!key) {
        errorCode = "unauthorized";
        return finish(json(401, {
          error: { code: "unauthorized", message: "Send your key as: Authorization: Bearer ic_live_…" },
        }, { "WWW-Authenticate": "Bearer" }));
      }

      // ── ONE CONNECTION PER REQUEST ──
      //
      // This used to take up to five: authenticate, look up the
      // idempotency record, run the handler, write the record, log.
      // Each one queued behind a pool of eight while 200 requests
      // were in flight, and the hottest endpoint in the system
      // measured 3.5 SECONDS under the gate load.
      //
      // Auth and the idempotency lookup must run BEFORE the role
      // switch: platform.idempotency_record is admin-only, so an
      // api_client session reads nothing from it and every retry
      // would silently re-execute.
      db = await pool.connect();

      const claims = await (async () => {
        const { rows } = await db!.query(
          "select platform.authenticate_api_key($1) as claims", [key]);
        return rows[0].claims as Claims | null;
      })();

      if (!claims) {
        errorCode = "unauthorized";
        // Unknown, revoked and expired are deliberately indistinguishable.
        return finish(json(401, {
          error: { code: "unauthorized", message: "That key is not valid." },
        }));
      }

      clientId = String(claims.client_id);
      const scopes = (claims.scopes as string[]) ?? [];

      // ── 2. Rate limit ──
      //
      // BEFORE scope, body parsing and idempotency, so a client in a
      // hot retry loop costs one indexed UPDATE rather than a parsed
      // body and a lookup. Throttling that is expensive to apply does
      // not protect anything.
      //
      // Deliberately AFTER authentication: an unauthenticated flood
      // has no client to charge, and metering by key means one app's
      // bad afternoon cannot slow another app down.
      {
        const { rows } = await db.query(
          "select * from platform.consume_rate_token($1, 1)", [clientId]);
        const rl = rows[0];

        limitHeaders = {
          "X-RateLimit-Limit": String(rl.limit_per_min),
          "X-RateLimit-Remaining": String(Math.max(0, rl.remaining ?? 0)),
          ...(rl.quota_left === null || rl.quota_left === undefined
            ? {}
            : { "X-RateLimit-Quota-Remaining": String(rl.quota_left) }),
        };

        if (!rl.allowed) {
          throttled = true;
          errorCode = rl.reason ?? "rate_limited";
          const quota = rl.reason === "daily_quota_exhausted";
          return finish(json(429, {
            error: {
              code: errorCode,
              message: quota
                ? "This key has used its daily quota. It resets at midnight."
                : `This key is limited to ${rl.limit_per_min} requests a minute. Retry in ${rl.retry_after}s.`,
              retry_after: rl.retry_after,
            },
          }, { ...limitHeaders, "Retry-After": String(rl.retry_after) }));
        }
      }

      // ── 3. Scope ──
      if (!scopes.includes(opts.scope) && !scopes.includes("*")) {
        errorCode = "insufficient_scope";
        return finish(json(403, {
          error: {
            code: "insufficient_scope",
            message: `This key does not hold the "${opts.scope}" scope.`,
            required: opts.scope, granted: scopes,
          },
        }));
      }

      // ── 4. Body ──
      let body: any = null;
      if (req.method !== "GET" && req.method !== "DELETE") {
        const text = await req.text();
        if (text) {
          try { body = JSON.parse(text); }
          catch {
            errorCode = "invalid_json";
            return finish(json(400, {
              error: { code: "invalid_json", message: "The request body is not valid JSON." },
            }));
          }
        }
      }

      // ── 5. Idempotency ──
      //
      // Required on writes, not optional. A network timeout is
      // indistinguishable from a failure to the client, so clients
      // retry — and without a key the retry takes a second unit off
      // the shelf.
      if (opts.idempotent) {
        idemKey = req.headers.get("idempotency-key");
        if (!idemKey) {
          errorCode = "idempotency_key_required";
          return finish(json(400, {
            error: {
              code: "idempotency_key_required",
              message: "Writes require an Idempotency-Key header. Reuse it when you retry.",
            },
          }));
        }

        const hash = createHash("sha256")
          .update(`${req.method}\n${path}\n${JSON.stringify(body ?? null)}`)
          .digest("hex");

        const prior = (await db.query(
          `select request_hash, status_code, response_body
             from platform.idempotency_record
            where api_client_id = $1 and key = $2`, [clientId, idemKey])).rows[0];

        if (prior) {
          // Same key, different request. Telling the client is far
          // kinder than handing back an answer to a question it did
          // not ask.
          if (prior.request_hash !== hash) {
            errorCode = "idempotency_key_reused";
            return finish(json(422, {
              error: {
                code: "idempotency_key_reused",
                message: "That Idempotency-Key was already used for a different request.",
              },
            }));
          }
          replayed = true;
          return finish(json(prior.status_code, prior.response_body,
            { ...limitHeaders, "Idempotent-Replay": "true" }));
        }

        (req as any)._idemHash = hash;
      }

      // ── 6. Run it, under RLS, on the same connection ──
      let result: { status?: number; body: unknown };
      try {
        await db.query("begin");
        await db.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify(claims)]);
        await db.query("set local role authenticated");
        result = await handler({
          db, claims, clientId: clientId!, scopes,
          environment: String(claims.environment ?? "LIVE"),
          body, req, params,
        });
        // COMMIT restores the connection's own role: SET LOCAL is
        // transaction-scoped, which is what makes it safe to reuse
        // this client for the admin-level writes below.
        await db.query("commit");
      } catch (inner) {
        await db.query("rollback").catch(() => {});
        throw inner;
      }

      const outStatus = result.status ?? 200;
      const outBody = {
        ...(result.body as object),
        as_of: new Date().toISOString(),
      };

      // Record the response so a retry gets it back verbatim.
      if (opts.idempotent && idemKey) {
        await db.query(
          `insert into platform.idempotency_record
             (api_client_id, key, method, path, request_hash, status_code, response_body)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (api_client_id, key) do nothing`,
          [clientId, idemKey, req.method, path, (req as any)._idemHash, outStatus, outBody]);
      }

      return finish(json(outStatus, outBody, limitHeaders));

    } catch (e: any) {
      const err = parsePgError(e);
      errorCode = err.code;
      return finish(json(err.status,
        { error: { code: err.code, message: err.message } }, limitHeaders));
    } finally {
      db?.release();
    }
  };
}

async function logRequest(r: {
  clientId: string | null; method: string; path: string; status: number;
  errorCode: string | null; idemKey: string | null; replayed: boolean;
  throttled: boolean; ms: number;
}) {
  try {
    const c = await pool.connect();
    try {
      await c.query(
        `insert into platform.api_request
           (api_client_id, method, path, status_code, error_code,
            idempotency_key, replayed, rate_limited, duration_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.clientId, r.method, r.path, r.status, r.errorCode, r.idemKey,
         r.replayed, r.throttled, r.ms]);
    } finally { c.release(); }
  } catch {
    // A logging failure must never turn a successful write into an error.
  }
}
