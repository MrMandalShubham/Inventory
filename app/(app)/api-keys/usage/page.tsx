import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, currentSession } from "@/lib/session";
import {
  PageHeader, Tile, Pill, Card, Section, Empty, Notice, TableWrap, When,
} from "../../ui";
import { setLimits, setSubscriptionStatus, retryDeadDeliveries } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Who is using the API, and are their events getting out.
 *
 * The question this screen answers is not "how many requests" — it is
 * "which app is about to become everybody else's problem". So the
 * things that read first are the ones that predict trouble: clients
 * hitting their ceiling, error rates, and subscriptions whose
 * endpoint has stopped answering.
 *
 * Every figure comes from platform.api_request rather than a running
 * counter, so it cannot drift from what actually happened.
 */
export default async function ApiUsage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; error?: string; ok?: string }>;
}) {
  const { days, error, ok } = await searchParams;
  const window = Math.min(Math.max(Number(days) || 7, 1), 90);

  const claims = await currentClaims();
  const me = await currentSession();
  const isAdmin = me?.role === "admin";

  const d = await withSession(claims, async (c) => {
    const usage = (await c.query("select * from platform.api_usage($1)", [window])).rows;
    const endpoints = (await c.query(
      "select * from platform.api_endpoint_usage($1)", [window])).rows;
    const health = (await c.query("select * from platform.webhook_health()")).rows;

    const limits = (await c.query(
      `select id, name, status, rate_limit_per_min, burst, daily_quota,
              case when quota_day = current_date then quota_used else 0 end as quota_used
         from platform.api_client order by name`)).rows;

    return { usage, endpoints, health, limits };
  });

  const totals = d.usage.reduce(
    (a: any, r: any) => ({
      requests: a.requests + Number(r.requests),
      errors: a.errors + Number(r.errors),
      throttled: a.throttled + Number(r.throttled),
    }),
    { requests: 0, errors: 0, throttled: 0 });

  const stuck = d.health.filter((h: any) => Number(h.dead) > 0 || h.consecutive_failures >= 3);
  const backlog = d.health.reduce((a: number, h: any) => a + Number(h.pending), 0);

  const limitById = Object.fromEntries(d.limits.map((l: any) => [l.id, l]));

  return (
    <>
      <PageHeader
        eyebrow="The open API"
        title="Usage and delivery"
        lede={
          <>
            Which applications are calling, whether any of them is close to its
            limit, and whether the events they subscribed to are getting out.
          </>
        }
        actions={
          <div className="flex gap-1">
            {[1, 7, 30].map((n) => (
              <Link
                key={n}
                href={`/api-keys/usage?days=${n}`}
                className={n === window ? "btn text-[13px] py-1.5" : "btn btn-ghost text-[13px] py-1.5"}
              >
                {n === 1 ? "24h" : `${n}d`}
              </Link>
            ))}
          </div>
        }
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mb-4"><Notice tone="info">{ok}</Notice></div>}

      {!isAdmin && me?.role !== "finance" && (
        <Notice tone="warn" title="Not visible to your role.">
          API traffic is restricted to admin and finance. The tables below will be
          empty — the database refused them, this page did not filter them out.
        </Notice>
      )}

      {stuck.length > 0 && (
        <Notice tone="bad" title="Events are not getting out.">
          {stuck.length} subscription{stuck.length === 1 ? " has" : "s have"} dead
          deliveries or a run of failures. The subscriber is not receiving what they
          think they are receiving.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile n={totals.requests.toLocaleString("en-IN")} label={`Requests, last ${window}d`} />
        <Tile
          n={totals.throttled.toLocaleString("en-IN")}
          label="Throttled"
          tone={totals.throttled > 0 ? "warn" : "plain"}
        />
        <Tile
          n={totals.errors.toLocaleString("en-IN")}
          label="Errors"
          tone={totals.errors > 0 ? "warn" : "plain"}
        />
        <Tile
          n={backlog.toLocaleString("en-IN")}
          label="Events waiting to be delivered"
          tone={backlog > 100 ? "bad" : backlog > 0 ? "warn" : "good"}
        />
      </div>

      {/* ─────────────── per client ─────────────── */}

      <Section title="By application">
        <TableWrap>
          <thead>
            <tr>
              <th>Application</th>
              <th className="num">Requests</th>
              <th className="num">Errors</th>
              <th className="num">Throttled</th>
              <th className="num">p50</th>
              <th className="num">p95</th>
              <th>Slowest endpoint</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {d.usage.map((r: any) => {
              const lim = limitById[r.api_client_id];
              const rate = Number(r.error_rate);
              return (
                <tr key={r.api_client_id}>
                  <td>
                    <div className="font-medium">{r.client_name}</div>
                    <div className="meta">
                      {lim ? `${lim.rate_limit_per_min}/min · burst ${lim.burst}` : "—"}
                      {r.environment === "SANDBOX" && <> · <Pill tone="info">sandbox</Pill></>}
                    </div>
                  </td>
                  <td className="num tnum">{Number(r.requests).toLocaleString("en-IN")}</td>
                  <td className="num">
                    {Number(r.errors) === 0 ? (
                      <span className="text-ink-400">0</span>
                    ) : (
                      <Pill tone={rate > 10 ? "bad" : "warn"}>
                        {r.errors} · {rate}%
                      </Pill>
                    )}
                  </td>
                  <td className="num">
                    {Number(r.throttled) === 0 ? (
                      <span className="text-ink-400">0</span>
                    ) : (
                      <Pill tone="warn">{r.throttled}</Pill>
                    )}
                  </td>
                  <td className="num tnum">{r.p50_ms}ms</td>
                  <td className="num tnum">{r.p95_ms}ms</td>
                  <td className="meta mono truncate max-w-56">
                    {r.slowest_path ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="meta">
                    {r.last_seen
                      ? <When at={r.last_seen} relative />
                      : <span className="text-ink-400">never</span>}
                  </td>
                </tr>
              );
            })}
            {d.usage.length === 0 && (
              <tr><td colSpan={8}>
                <Empty denied={!isAdmin && me?.role !== "finance"} what="API usage">
                  No keys have been issued yet.
                </Empty>
              </td></tr>
            )}
          </tbody>
        </TableWrap>
        <p className="meta mt-2">
          A client that is regularly throttled is not misbehaving — it has outgrown
          its limit, or it is retrying without backoff. Both are worth a conversation
          before it becomes an outage.
        </p>
      </Section>

      {/* ─────────────── limits ─────────────── */}

      {isAdmin && (
        <Section title="Limits">
          <div className="grid gap-3 md:grid-cols-2">
            {d.limits.filter((l: any) => l.status === "ACTIVE").map((l: any) => (
              <Card key={l.id} pad>
                <div className="mb-3 flex items-baseline gap-2">
                  <b className="text-[15px]">{l.name}</b>
                  {l.daily_quota && (
                    <span className="meta">
                      {Number(l.quota_used).toLocaleString("en-IN")} of{" "}
                      {Number(l.daily_quota).toLocaleString("en-IN")} today
                    </span>
                  )}
                </div>

                <form action={setLimits} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={l.id} />
                  <div className="w-24">
                    <label className="label" htmlFor={`pm-${l.id}`}>Per minute</label>
                    <input id={`pm-${l.id}`} name="per_min" type="number" min="1"
                           defaultValue={l.rate_limit_per_min}
                           className="field text-right tnum" />
                  </div>
                  <div className="w-24">
                    <label className="label" htmlFor={`b-${l.id}`}>Burst</label>
                    <input id={`b-${l.id}`} name="burst" type="number" min="1"
                           defaultValue={l.burst} className="field text-right tnum" />
                  </div>
                  <div className="w-28">
                    <label className="label" htmlFor={`dq-${l.id}`}>Daily cap</label>
                    <input id={`dq-${l.id}`} name="daily_quota" type="number" min="1"
                           defaultValue={l.daily_quota ?? ""} placeholder="none"
                           className="field text-right tnum" />
                  </div>
                  <button type="submit" className="btn text-[13px] py-1.5">Save</button>
                </form>

                <p className="meta mt-2">
                  Burst is what may be spent at once; the rate is how fast it refills.
                  {l.daily_quota && (
                    <>
                      {" "}
                      <label className="mt-1 flex items-center gap-1.5">
                        <input form="" type="checkbox" disabled className="opacity-40" />
                        <span>To remove the daily cap, clear the field and save.</span>
                      </label>
                    </>
                  )}
                </p>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {/* ─────────────── endpoints ─────────────── */}

      <Section title="Busiest endpoints">
        <TableWrap>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th className="num">Requests</th>
              <th className="num">Errors</th>
              <th className="num">p95</th>
            </tr>
          </thead>
          <tbody>
            {d.endpoints.map((e: any, i: number) => (
              <tr key={i}>
                <td className="mono">
                  <span className="meta mr-2">{e.method}</span>{e.path}
                </td>
                <td className="num tnum">{Number(e.requests).toLocaleString("en-IN")}</td>
                <td className="num tnum">{Number(e.errors) || <span className="text-ink-400">0</span>}</td>
                <td className="num tnum">{e.p95_ms}ms</td>
              </tr>
            ))}
            {d.endpoints.length === 0 && (
              <tr><td colSpan={4}>
                <Empty denied={!isAdmin && me?.role !== "finance"} what="endpoint traffic">
                  No API traffic in this window.
                </Empty>
              </td></tr>
            )}
          </tbody>
        </TableWrap>
        <p className="meta mt-2">
          Ids are collapsed, so <span className="mono">/products/:id</span> is one row
          rather than ten thousand.
        </p>
      </Section>

      {/* ─────────────── webhooks ─────────────── */}

      <Section title="Event delivery">
        {d.health.length === 0 ? (
          <Card pad>
            <Empty denied={!isAdmin} what="webhook subscriptions">
              Nothing is subscribed to events. An application can subscribe through
              the API to be told when stock changes, a ticket closes, or a hold
              lapses — rather than polling for it.
            </Empty>
          </Card>
        ) : (
          <div className="grid gap-3">
            {d.health.map((h: any) => {
              const dead = Number(h.dead);
              const failing = h.consecutive_failures >= 3;
              return (
                <Card key={h.subscription_id} pad>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <b>{h.client_name}</b>
                        <Pill tone="info">{h.event}</Pill>
                        {h.status === "PAUSED" && <Pill tone="warn">paused</Pill>}
                        {dead > 0 && <Pill tone="bad">{dead} dead</Pill>}
                        {failing && h.status === "ACTIVE" && (
                          <Pill tone="bad">{h.consecutive_failures} failures in a row</Pill>
                        )}
                      </div>
                      <div className="meta mono mt-1 truncate">{h.url}</div>

                      <div className="meta mt-1.5">
                        {Number(h.delivered_24h).toLocaleString("en-IN")} delivered in 24h ·{" "}
                        {Number(h.pending).toLocaleString("en-IN")} waiting ·{" "}
                        {h.last_success_at
                          ? <>last success <When at={h.last_success_at} relative /></>
                          : "never delivered"}
                      </div>

                      {h.last_error && (
                        <div className="meta mt-1 text-rose-600">
                          Last error: {h.last_error}
                        </div>
                      )}
                    </div>

                    {isAdmin && (
                      <div className="flex flex-wrap gap-2">
                        {dead > 0 && (
                          <form action={retryDeadDeliveries}>
                            <input type="hidden" name="id" value={h.subscription_id} />
                            <button type="submit" className="btn btn-ghost text-[13px] py-1.5">
                              Retry {dead}
                            </button>
                          </form>
                        )}
                        <form action={setSubscriptionStatus}>
                          <input type="hidden" name="id" value={h.subscription_id} />
                          <input type="hidden" name="status"
                                 value={h.status === "PAUSED" ? "ACTIVE" : "PAUSED"} />
                          <button type="submit" className="btn btn-ghost text-[13px] py-1.5">
                            {h.status === "PAUSED" ? "Resume" : "Pause"}
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <Notice tone="info">
          <b>Delivery needs a worker running.</b> Events are queued the moment they
          happen, but nothing leaves the building until{" "}
          <span className="mono">node scripts/webhook-worker.mjs</span> is running. A
          growing &ldquo;waiting&rdquo; count with no deliveries usually means it is not.
        </Notice>
      </Section>

      <p className="mt-6">
        <Link href="/api-keys" className="text-sm text-teal-700 hover:underline">
          ← Keys
        </Link>
      </p>
    </>
  );
}
