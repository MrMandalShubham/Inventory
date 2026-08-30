import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_SEE_MONEY } from "@/lib/session";
import { PageHeader, Tile, Pill, Dot, Card, Empty, Notice, TableWrap, Section } from "../ui";

export const dynamic = "force-dynamic";

/**
 * The reports pack.
 *
 * Boring, and the first thing anyone asks for. Each one answers a
 * question somebody actually has rather than presenting a table and
 * leaving the reader to find the story in it.
 */
export default async function Reports({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  const { loc } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const locations = (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows;
    const locId = loc ? (locations.find((l: any) => l.code === loc)?.id ?? null) : null;

    const dead = (await c.query(
      `select p.sku_code, p.name, l.code as location_code,
              m.on_hand, m.days_since_movement
         from insight.product_metric m
         join catalog.product p on p.id = m.product_id
         join platform.location l on l.id = m.location_id
        where m.on_hand > 0
          and m.days_since_movement > insight.setting('dead_stock_days')::integer
          and ($1::uuid is null or m.location_id = $1)
        order by m.days_since_movement desc, m.on_hand desc limit 40`, [locId])).rows;

    const over = (await c.query(
      `select p.sku_code, p.name, l.code as location_code,
              m.on_hand, m.days_of_cover, m.avg_daily
         from insight.product_metric m
         join catalog.product p on p.id = m.product_id
         join platform.location l on l.id = m.location_id
        where m.days_of_cover > insight.setting('cover_ceiling_days')::numeric
          and ($1::uuid is null or m.location_id = $1)
        order by m.days_of_cover desc limit 40`, [locId])).rows;

    // ABC × XYZ. The 20% that move most, crossed with how predictable
    // they are — which together say where control is worth spending.
    const matrix = (await c.query(
      `select abc, xyz, count(*)::int as n, coalesce(sum(on_hand),0)::int as units
         from insight.product_metric
        where abc is not null and ($1::uuid is null or location_id = $1)
        group by abc, xyz`, [locId])).rows;

    const wastage = (await c.query(
      `select coalesce(p.category, 'Uncategorised') as category,
              l.code as location_code,
              -sum(sl.qty_delta)::int as units,
              count(*)::int as events
         from stock.ledger sl
         join stock.reason r on r.code = sl.reason_code
         join catalog.product p on p.id = sl.product_id
         join platform.location l on l.id = sl.location_id
        where r.is_wastage
          and sl.occurred_at > now() - interval '90 days'
          and ($1::uuid is null or sl.location_id = $1)
        group by 1, 2 order by 3 desc limit 20`, [locId])).rows;

    const ageing = (await c.query(
      `select l.code as location_code, p.sku_code, p.name,
              bt.lot_no, bt.expiry_date, b.on_hand,
              (bt.expiry_date - current_date) as days_left
         from stock.balance b
         join stock.batch bt on bt.id = b.batch_id
         join catalog.product p on p.id = b.product_id
         join platform.location l on l.id = b.location_id
        where bt.expiry_date is not null and b.on_hand > 0
          and ($1::uuid is null or b.location_id = $1)
        order by bt.expiry_date limit 30`, [locId])).rows;

    return { locations, dead, over, matrix, wastage, ageing };
  });

  const cell = (a: string, x: string) =>
    d.matrix.find((m: any) => m.abc === a && m.xyz === x);

  return (
    <>
      <PageHeader
        title="Reports"
        lede="Where the cash is stuck, what is about to be lost, and which lines are worth watching closely."
      />

      <Card>
        <form action="/reports" method="get" className="flex flex-wrap items-end gap-3">
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

      {/* ── dead stock ── */}
      <Section title={`Dead stock (${d.dead.length})`}>
        <p className="lede -mt-2 mb-3">
          Cash that has been spent and not yet earned back, sitting still. This is the report
          that pays for the system.
        </p>
        {d.dead.length === 0 ? (
          <Card><Empty>Nothing has been sitting untouched. Unusual.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr><th>Product</th><th>Where</th><th className="num">Units</th>
                  <th className="num">Days still</th><th></th></tr>
            </thead>
            <tbody>
              {d.dead.map((r: any, i: number) => (
                <tr key={i}>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    <div className="mono text-ink-400">{r.sku_code}</div>
                  </td>
                  <td><Pill>{r.location_code}</Pill></td>
                  <td className="num tnum">{r.on_hand.toLocaleString("en-IN")}</td>
                  <td className="num tnum font-semibold text-amber-600">{r.days_since_movement}</td>
                  <td>
                    <Link href={`/stock/${r.sku_code}?loc=${r.location_code}`}
                          className="text-sm text-teal-700 hover:underline">Why? →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      {/* ── expiry ageing ── */}
      <Section title="Expiring soonest">
        {d.ageing.length === 0 ? (
          <Card><Empty>No dated stock on hand.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr><th className="w-8"></th><th>Product</th><th>Where</th><th>Lot</th>
                  <th className="num">Units</th><th className="num">Days left</th></tr>
            </thead>
            <tbody>
              {d.ageing.map((r: any, i: number) => (
                <tr key={i}>
                  <td><Dot tone={r.days_left <= 2 ? "bad" : r.days_left <= 7 ? "warn" : "good"} /></td>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    <div className="mono text-ink-400">{r.sku_code}</div>
                  </td>
                  <td><Pill>{r.location_code}</Pill></td>
                  <td className="mono text-ink-500">{r.lot_no}</td>
                  <td className="num tnum">{r.on_hand}</td>
                  <td className={`num tnum font-semibold ${
                    r.days_left <= 2 ? "text-rose-600" : r.days_left <= 7 ? "text-amber-600" : ""}`}>
                    {r.days_left}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      {/* ── ABC × XYZ ── */}
      <Section title="Where control is worth spending">
        <p className="lede -mt-2 mb-3">
          <b>A</b> lines are the 20% that move most here. <b>X</b> lines are steady and
          predictable; <b>Z</b> lines are erratic. AX runs itself. <b>AZ is where the money
          is lost</b> — high volume you cannot predict.
        </p>
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th className="num">X — steady</th>
                <th className="num">Y — moderate</th>
                <th className="num">Z — erratic</th>
              </tr>
            </thead>
            <tbody>
              {["A", "B", "C"].map((a) => (
                <tr key={a}>
                  <th className="text-left">{a} — {a === "A" ? "top 20% by volume" : a === "B" ? "next 30%" : "the long tail"}</th>
                  {["X", "Y", "Z"].map((x) => {
                    const m = cell(a, x);
                    const hot = a === "A" && x === "Z";
                    return (
                      <td key={x} className={`num ${hot ? "bg-rose-50" : ""}`}>
                        <div className={`tnum font-semibold ${hot ? "text-rose-700" : ""}`}>
                          {m?.n ?? 0}
                        </div>
                        <div className="meta">{(m?.units ?? 0).toLocaleString("en-IN")} units</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── wastage ── */}
      <Section title="Wastage, last 90 days">
        <p className="lede -mt-2 mb-3">
          Posted daily, per location, per category — never a month-end plug. In fruit and
          veg it decides whether the category earns anything at all.
        </p>
        {d.wastage.length === 0 ? (
          <Card><Empty>No wastage recorded. Either genuinely none, or nobody is posting it.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr><th>Category</th><th>Where</th><th className="num">Units lost</th><th className="num">Events</th></tr>
            </thead>
            <tbody>
              {d.wastage.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="font-medium">{r.category}</td>
                  <td><Pill>{r.location_code}</Pill></td>
                  <td className="num tnum font-semibold text-rose-600">{r.units.toLocaleString("en-IN")}</td>
                  <td className="num tnum text-ink-500">{r.events}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      {/* ── overstock ── */}
      <Section title={`More cover than they can sell (${d.over.length})`}>
        {d.over.length === 0 ? (
          <Card><Empty>Nothing is carrying excessive cover.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr><th>Product</th><th>Where</th><th className="num">Units</th>
                  <th className="num">Sells/day</th><th className="num">Days of cover</th></tr>
            </thead>
            <tbody>
              {d.over.map((r: any, i: number) => (
                <tr key={i}>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    <div className="mono text-ink-400">{r.sku_code}</div>
                  </td>
                  <td><Pill>{r.location_code}</Pill></td>
                  <td className="num tnum">{r.on_hand.toLocaleString("en-IN")}</td>
                  <td className="num tnum text-ink-500">{r.avg_daily}</td>
                  <td className="num tnum font-semibold text-amber-600">{r.days_of_cover}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <Notice tone="info">
          These are candidates to give up. The replenishment run already prefers them as a
          source — but only where doing so leaves them above their own reorder point.
        </Notice>
      </Section>

      {!CAN_SEE_MONEY.includes(me.role) && (
        <div className="mt-6">
          <Notice tone="warn" title="Values are not shown to your role.">
            Cost and margin arrive in Phase 7 and will be visible to finance and admin only.
            Quantities are visible to everyone who holds the location.
          </Notice>
        </div>
      )}
    </>
  );
}
