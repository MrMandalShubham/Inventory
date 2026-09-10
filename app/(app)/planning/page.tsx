import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE, CAN_PLAN } from "@/lib/session";
import {
  PageHeader, Tile, Pill, Dot, Card, Empty, Notice, TableWrap, Section, When,
} from "../ui";
import { refreshMetrics, raiseFromSuggestion } from "./actions";
import { param } from "@/lib/params";

export const dynamic = "force-dynamic";

/**
 * The replenishment run.
 *
 * It produces a worklist: these products at these locations are below
 * their reorder point, here is the suggested quantity and where it
 * should come from. A planner approves, adjusts or rejects each line.
 *
 * Every row can show its own arithmetic, because a planner who cannot
 * reconstruct a number will override it — and once they start
 * overriding they stop reading.
 */
export default async function Planning({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; error?: string; ok?: string }>;
}) {
  const { loc, error, ok } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const locations = (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows;

    const locId = param(loc)
      ? (locations.find((l: any) => l.code === param(loc))?.id ?? null)
      : null;

    const suggestions = (await c.query(
      "select * from insight.suggestions($1)", [locId])).rows;

    const freshness = (await c.query(
      "select max(computed_at) as at, count(*)::int as n from insight.product_metric")).rows[0];

    const cover = (await c.query(
      `select
         count(*) filter (where m.available <= 0)::int                       as empty,
         count(*) filter (where m.available > 0 and m.available <= m.reorder_point)::int as low,
         count(*) filter (where m.days_of_cover > insight.setting('cover_ceiling_days'))::int as over,
         count(*) filter (where m.on_hand > 0 and m.days_since_movement >
                                insight.setting('dead_stock_days'))::int     as dead
         from insight.product_metric m
         join platform.location l on l.id = m.location_id
        where l.type <> 'VIRTUAL' and ($1::uuid is null or m.location_id = $1)`,
      [locId])).rows[0];

    return { locations, suggestions, freshness, cover, locId };
  });

  const canPlan = CAN_PLAN.includes(me.role);
  const canRaise = CAN_APPROVE.includes(me.role);
  const stale = d.freshness.at
    && Date.now() - new Date(d.freshness.at).getTime() > 26 * 3600 * 1000;

  return (
    <>
      <PageHeader
        title="Replenishment"
        lede="What is below its reorder point, how much to bring, and where it should come from. Reorder points are worked out per shop per product — a line selling 40 a day in one shop may sell 4 in another."
        actions={canPlan ? (
          <form action={refreshMetrics}>
            <input type="hidden" name="back" value={loc ? `/planning?loc=${loc}` : "/planning"} />
            <button type="submit" className="btn btn-ghost">Recalculate</button>
          </form>
        ) : undefined}
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mb-4"><Notice tone="info" title="Done:">{ok}</Notice></div>}

      {d.freshness.n === 0 ? (
        <Notice tone="warn" title="Nothing has been calculated yet.">
          Press <b>Recalculate</b>, or wire the nightly job. Until then there is no demand
          history to reason from.
        </Notice>
      ) : stale ? (
        <Notice tone="warn" title="These figures are more than a day old.">
          Last calculated <When at={d.freshness.at} relative />. Demand moves; a stale
          reorder point is a stockout waiting to happen.
        </Notice>
      ) : (
        <Notice tone="info" title="Calculated from the ledger.">
          {d.freshness.n.toLocaleString("en-IN")} lines, last run <When at={d.freshness.at} relative />.
          Nothing here is typed in — every number is derived from movements that actually
          happened.
        </Notice>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile n={d.cover.empty} label="Nothing to sell" tone={d.cover.empty ? "bad" : "good"} />
        <Tile n={d.cover.low} label="Below reorder point" tone={d.cover.low ? "warn" : "good"} />
        <Tile n={d.cover.over} label="More cover than they can sell" tone={d.cover.over ? "warn" : "plain"} />
        <Tile n={d.cover.dead} label="Dead stock" tone={d.cover.dead ? "warn" : "plain"} />
      </div>

      <Card className="mt-5">
        <form action="/planning" method="get" className="flex flex-wrap items-end gap-3">
          <div className="min-w-44">
            <label className="label" htmlFor="loc">Location</label>
            <select id="loc" name="loc" defaultValue={loc ?? ""} className="field">
              <option value="">All I can see</option>
              {d.locations.map((l: any) => (
                <option key={l.code} value={l.code}>{l.code} — {l.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">Filter</button>
        </form>
      </Card>

      <Section title={`Suggestions (${d.suggestions.length})`}>
        {d.suggestions.length === 0 ? (
          <Card>
            <Empty>
              Nothing is below its reorder point
              {loc ? ` at ${loc}` : ""}. Either everything is well stocked, or the metrics
              need recalculating.
            </Empty>
          </Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Urgency</span></th>
                <th>Product</th><th>Where</th>
                <th className="num">Sellable</th><th className="num">Reorder at</th>
                <th className="num">Suggest</th><th>From</th><th>Why</th>
                <th className="w-28"></th>
              </tr>
            </thead>
            <tbody>
              {d.suggestions.map((s: any) => (
                <tr key={`${s.product_id}-${s.location_id}`}>
                  <td>
                    <Dot tone={s.available <= 0 ? "bad" : "warn"} />
                  </td>
                  <td>
                    <div className="font-medium">{s.product_name}</div>
                    <div className="mono text-ink-400">{s.sku_code}</div>
                  </td>
                  <td><Pill>{s.location_code}</Pill></td>
                  <td className={`num tnum ${s.available <= 0 ? "text-rose-600 font-semibold" : ""}`}>
                    {s.available}
                  </td>
                  <td className="num tnum text-ink-500">{s.reorder_point}</td>
                  <td className="num tnum text-lg font-bold">{s.suggested_qty}</td>
                  <td>
                    {s.source_code
                      ? <Pill tone="info">{s.source_code}</Pill>
                      : <span className="meta">nowhere spare</span>}
                  </td>
                  <td className="text-ink-700">{s.urgency}</td>
                  <td className="whitespace-nowrap">
                    <Link href={`/planning/${s.sku_code}?loc=${s.location_code}`}
                          className="text-sm text-teal-700 hover:underline">
                      show working
                    </Link>
                    {canRaise && s.source_location_id && (
                      <form action={raiseFromSuggestion} className="mt-1">
                        <input type="hidden" name="product_id" value={s.product_id} />
                        <input type="hidden" name="location_id" value={s.location_id} />
                        <input type="hidden" name="source_location_id" value={s.source_location_id} />
                        <input type="hidden" name="qty" value={s.suggested_qty} />
                        <button type="submit" className="btn btn-ghost px-2 py-1 text-xs">
                          Raise transfer
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        <Notice tone="info">
          <b>&ldquo;Nowhere spare&rdquo; is not a bug.</b> No location can give this up
          without dropping below its own reorder point — solving one shop&rsquo;s stockout by
          creating another&rsquo;s is not a solution. Those lines need a purchase order.
        </Notice>
      </Section>
    </>
  );
}
