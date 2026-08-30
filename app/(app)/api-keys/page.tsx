import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, currentSession } from "@/lib/session";
import { createKey, revokeKey } from "./actions";

export const dynamic = "force-dynamic";

// The scopes a key may hold, and what each one actually opens.
//
// This list is the ONLY way a key gets minted, so a scope missing here
// is a scope nobody can grant. pricing:write and cost:read were added
// by the storefront API and left out of this list, which meant the
// price endpoints existed and no key on earth could call them.
const SCOPES = [
  ["catalog:read", "Read products, prices, images and barcodes"],
  ["catalog:write", "Edit product name, description, category; add images"],
  ["pricing:write", "Set retail, MRP and wholesale prices"],
  ["stock:read", "Read stock, reservations, order status and the ledger"],
  ["reservations:write", "Hold, confirm, consume and release stock"],
  ["movements:read", "Read movement tickets"],
  ["cost:read", "See landed cost — what you PAID. Never give this to a storefront."],
];

export default async function ApiKeys({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; error?: string; ok?: string }>;
}) {
  const { created, error, ok } = await searchParams;
  const claims = await currentClaims();
  const me = await currentSession();

  const data = await withSession(claims, async (c) => {
    const clients = (await c.query(
      `select id, name, key_prefix, scopes, location_ids, environment,
              status, last_used_at, created_at
         from platform.api_client order by created_at desc`)).rows;

    const requests = (await c.query(
      `select r.method, r.path, r.status_code, r.error_code, r.replayed,
              r.duration_ms, r.occurred_at, c.name as client_name
         from platform.api_request r
         left join platform.api_client c on c.id = r.api_client_id
        order by r.occurred_at desc limit 40`)).rows;

    const summary = (await c.query(
      `select count(*)::int as total,
              count(*) filter (where status_code >= 500)::int as errors,
              count(*) filter (where status_code = 409)::int as conflicts,
              count(*) filter (where replayed)::int as replays,
              coalesce(round(avg(duration_ms))::int, 0) as avg_ms
         from platform.api_request
        where occurred_at > now() - interval '24 hours'`)).rows[0];

    const locations = (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows;

    return { clients, requests, summary, locations };
  });

  const isAdmin = me?.role === "admin";
  // api_client and api_request are admin/finance only. Without this
  // distinction the page says "No keys yet" to an operator when keys
  // plainly exist — an empty state that reads as fact rather than as
  // a permission boundary. Same bug the Phase 3 ticket page had.
  const canSee = me && ["admin", "finance"].includes(me.role);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1>API keys</h1>
          <p className="lede">
            Every consuming app gets its own key with its own scopes. The API runs through the
            same session path as this dashboard — same role, same policies. Whatever a
            third-party integrator cannot do, this dashboard cannot do either.
          </p>
        </div>
        <Link href="/api-keys/usage" className="btn btn-ghost text-[13px] py-1.5">
          Usage and delivery →
        </Link>
      </div>

      {created && (
        <div className="card" style={{ borderColor: "var(--accent)", marginBottom: 18 }}>
          <div className="card-pad">
            <b>Copy this key now — it is shown once and never again.</b>
            <div className="mono" style={{
              marginTop: 10, padding: "12px 14px", background: "var(--ground)",
              borderRadius: 5, wordBreak: "break-all", fontSize: 14,
            }}>{created}</div>
            <p className="lede" style={{ marginTop: 10, marginBottom: 0 }}>
              Only a SHA-256 hash is stored. A database read cannot yield a usable key —
              which also means we cannot recover this one for you. Lose it and mint another.
            </p>
          </div>
        </div>
      )}

      {error && <div className="notice notice-bad" style={{ marginBottom: 18 }}><b>Refused:</b> {error}</div>}
      {ok && <div className="notice notice-info" style={{ marginBottom: 18 }}><b>Done:</b> {ok}</div>}

      {!canSee && (
        <div className="notice notice-bad" style={{ marginBottom: 18 }}>
          <b>{me?.full_name}</b> is a {me?.role.replace("_", " ")} and cannot see API keys or
          the request log — <span className="mono">platform.api_client</span> and{" "}
          <span className="mono">platform.api_request</span> have no read policy for that
          role. The tables below are empty because the database returned nothing, not
          because nothing exists. Switch to the admin in the header.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 mb-5">
        <div className="tile"><div className="tile-n">{data.summary.total}</div><div className="tile-l">Requests, 24h</div></div>
        <div className="tile"><div className="tile-n">{data.summary.avg_ms}ms</div><div className="tile-l">Average</div></div>
        <div className="tile"><div className="tile-n">{data.summary.conflicts}</div><div className="tile-l">409 conflicts</div></div>
        <div className="tile"><div className="tile-n">{data.summary.replays}</div><div className="tile-l">Idempotent replays</div></div>
        <div className="tile">
          <div className="tile-n" style={{ color: data.summary.errors ? "var(--bad)" : undefined }}>
            {data.summary.errors}
          </div>
          <div className="tile-l">Server errors</div>
        </div>
      </div>

      <div className="notice notice-info">
        <b>409 conflicts are healthy.</b> They are the system refusing to oversell — a client
        asking for stock that is no longer there. <b>Replays are healthy too:</b> a client
        retried after a timeout and got its original answer back instead of taking a second
        unit off the shelf. Only the last column should ever be zero.
      </div>

      {isAdmin && (
        <div className="card">
          <form action={createKey} className="card-pad">
            <h2 style={{ marginTop: 0 }}>Mint a key</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
              <div>
                <label className="label" htmlFor="name">What is it for *</label>
                <input className="field" id="name" name="name" required placeholder="Buy/sell app — production"/>
              </div>
              <div>
                <label className="label" htmlFor="environment">Environment</label>
                <select className="field" id="environment" name="environment">
                  <option value="LIVE">LIVE — ic_live_…</option>
                  <option value="SANDBOX">SANDBOX — ic_test_…</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="locations">Locations (none = all)</label>
                <select className="field" id="locations" name="locations" multiple size={4}>
                  {data.locations.map((l: any) => (
                    <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label>Scopes *</label>
              <div style={{ display: "grid", gap: 6 }}>
                {SCOPES.map(([s, desc]) => (
                  <label key={s} style={{ display: "flex", gap: 9, alignItems: "baseline", margin: 0 }}>
                    <input type="checkbox" name="scopes" value={s} style={{ width: "auto" }} />
                    <span className="mono" style={{ minWidth: 160 }}>{s}</span>
                    <span style={{ fontSize: 13 }}>{desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="notice notice-info" style={{ margin: "16px 0" }}>
              Grant the narrowest set that works. A selling app needs{" "}
              <span className="mono">catalog:read</span>,{" "}
              <span className="mono">stock:read</span> and{" "}
              <span className="mono">reservations:write</span> — it has no business posting an
              adjustment, and a key that could would put stock changes outside every approval
              in the system. Add <span className="mono">pricing:write</span> only if that app
              sets its own prices. Leave <span className="mono">cost:read</span> off: it
              reveals what you paid, and a storefront that holds it publishes your margin to
              anyone who opens devtools.
            </div>

            <button type="submit" className="btn">Mint key</button>
          </form>
        </div>
      )}

      <h2>Keys</h2>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Prefix</th><th>Env</th><th>Scopes</th>
              <th>Locations</th><th>Last used</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {data.clients.length === 0 && (
              <tr><td colSpan={8}><div className="px-4 py-10 text-center text-sm text-ink-500">
                {canSee ? "No keys yet." : "Not visible to your role."}
              </div></td></tr>
            )}
            {data.clients.map((c: any) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.key_prefix}…</td>
                <td>
                  <span className={`tag ${c.environment === "LIVE" ? "warn" : "mute"}`}>
                    {c.environment.toLowerCase()}
                  </span>
                </td>
                <td style={{ fontSize: 12 }} className="mono">
                  {c.scopes.join(", ") || <span style={{ color: "var(--ink-soft)" }}>none</span>}
                </td>
                <td style={{ fontSize: 12 }}>
                  {c.location_ids.length === 0
                    ? <span className="pill">all</span>
                    : `${c.location_ids.length} named`}
                </td>
                <td style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  {c.last_used_at
                    ? new Date(c.last_used_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })
                    : "never"}
                </td>
                <td>
                  <span className={`tag ${c.status === "ACTIVE" ? "ok" : "bad"}`}>
                    {c.status.toLowerCase()}
                  </span>
                </td>
                <td>
                  {isAdmin && c.status === "ACTIVE" && (
                    <form action={revokeKey}>
                      <input type="hidden" name="id" value={c.id} />
                      <button type="submit" className="btn btn-ghost" style={{ fontSize: 13, padding: "4px 10px" }}>
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent requests</h2>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th><th>Client</th><th>Method</th><th>Path</th>
              <th className="num">Status</th><th className="num">ms</th><th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data.requests.length === 0 && (
              <tr><td colSpan={7}><div className="px-4 py-10 text-center text-sm text-ink-500">
                {canSee
                  ? <>No API traffic yet. Try <span className="mono">npm run api:smoke</span>.</>
                  : "Not visible to your role."}
              </div></td></tr>
            )}
            {data.requests.map((r: any, i: number) => (
              <tr key={i}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {new Date(r.occurred_at).toLocaleTimeString("en-GB")}
                </td>
                <td style={{ fontSize: 13 }}>{r.client_name ?? "—"}</td>
                <td className="mono">{r.method}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.path}</td>
                <td className="num">
                  <span className={`tag ${
                    r.status_code < 300 ? "ok" : r.status_code < 500 ? "warn" : "bad"
                  }`}>{r.status_code}</span>
                </td>
                <td className="num mono tnum">{r.duration_ms}</td>
                <td style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  {r.replayed ? <span className="pill">replay</span> : (r.error_code ?? "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="lede" style={{ marginTop: 16 }}>
        The contract is published at <span className="mono">/api/v1/openapi</span> and needs no
        key — a developer has to be able to read the spec before they have one.
      </p>
    </>
  );
}
