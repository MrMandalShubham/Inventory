import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, seesEverything } from "@/lib/session";
import { PageHeader, Tile, Pill, Dot, Card, Section, Empty, Notice, TableWrap, When } from "./ui";

export const dynamic = "force-dynamic";

/**
 * The manager's landing screen.
 *
 * The Phase 5 gate says a manager finds why one product is short at
 * one location in UNDER THREE CLICKS. The way to win that is not a
 * faster search — it is to put the exceptions on the first screen,
 * each one linking straight to the ledger that explains it. From
 * here it is ONE click.
 *
 * So this page leads with what is wrong, not with what is fine.
 */
export default async function Overview() {
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const health = (await c.query(`
      select (select count(*)::int from stock.verify_balances())     as balance_drift,
             (select count(*)::int from movement.verify_transit())   as transit_drift,
             (select count(*)::int from stock.verify_reservations()) as reservation_drift
    `)).rows[0];

    const totals = (await c.query(`
      select count(*)::int                                   as lines,
             coalesce(sum(b.on_hand), 0)::int                as units,
             coalesce(sum(b.damaged), 0)::int                as damaged,
             count(distinct b.location_id)::int              as locations
        from stock.balance b
        join platform.location l on l.id = b.location_id
       where l.type <> 'VIRTUAL'`)).rows[0];

    // Everything that wants a human. One query, ranked by urgency, so
    // the first row on the screen is the first thing worth doing.
    const attention = (await c.query(`
      with expiring as (
        select b.product_id, b.location_id, p.sku_code, p.name, l.code as location_code,
               b.on_hand, bt.expiry_date,
               case when bt.expiry_date <= current_date + 2 then 1 else 2 end as rank,
               case when bt.expiry_date <= current_date + 2
                    then 'expires in ' || greatest(bt.expiry_date - current_date, 0) || ' day(s)'
                    else 'expires ' || to_char(bt.expiry_date, 'DD Mon') end as why,
               case when bt.expiry_date <= current_date + 2 then 'bad' else 'warn' end as tone
          from stock.balance b
          join stock.batch bt on bt.id = b.batch_id
          join catalog.product p on p.id = b.product_id
          join platform.location l on l.id = b.location_id
         where bt.expiry_date is not null
           and bt.expiry_date <= current_date + 7
           and b.on_hand > 0
      ),
      empty_shelf as (
        select b.product_id, b.location_id, p.sku_code, p.name, l.code as location_code,
               b.on_hand, null::date as expiry_date,
               1 as rank, 'out of stock' as why, 'bad' as tone
          from stock.balance b
          join catalog.product p on p.id = b.product_id
          join platform.location l on l.id = b.location_id
         where b.available <= 0 and l.type <> 'VIRTUAL'
      ),
      damaged as (
        select b.product_id, b.location_id, p.sku_code, p.name, l.code as location_code,
               b.on_hand, null::date as expiry_date,
               2 as rank, b.damaged || ' unsellable on the shelf' as why, 'warn' as tone
          from stock.balance b
          join catalog.product p on p.id = b.product_id
          join platform.location l on l.id = b.location_id
         where b.damaged > 0
      )
      select * from expiring
      union all select * from empty_shelf
      union all select * from damaged
      order by rank, location_code, sku_code
      limit 12`)).rows;

    const stuck = (await c.query(`
      select m.id, m.ticket_no, m.type, m.status, m.raised_at,
             src.code as source_code, dst.code as dest_code
        from movement.movement m
        left join platform.location src on src.id = m.source_location_id
        left join platform.location dst on dst.id = m.dest_location_id
       where m.status in ('DISCREPANCY','IN_TRANSIT','DRAFT')
       order by case m.status when 'DISCREPANCY' then 1 when 'IN_TRANSIT' then 2 else 3 end,
                m.raised_at
       limit 6`)).rows;

    return { health, totals, attention, stuck };
  });

  const drift = d.health.balance_drift + d.health.transit_drift + d.health.reservation_drift;
  const urgent = d.attention.filter((a: any) => a.tone === "bad").length;

  return (
    <>
      <PageHeader
        title="Overview"
        lede={
          seesEverything(me)
            ? "Every location. What needs a person comes first."
            : "Your locations. What needs a person comes first."
        }
      />

      {/* The invariant, checked live. Zero is the only acceptable
          answer — anything else makes every number on every screen
          suspect, so it goes above the fold rather than in a report. */}
      {drift > 0 ? (
        <Notice tone="bad" title="Stock records disagree with the ledger.">
          {d.health.balance_drift} balance line(s), {d.health.transit_drift} in transit,{" "}
          {d.health.reservation_drift} reservation line(s). This is an incident, not a
          metric — treat every number below as suspect until it is resolved.
        </Notice>
      ) : (
        <Notice tone="info" title="Records agree with the ledger.">
          Balances, transit and reservations all reconcile. Checked live by the same
          queries that run hourly in production.
        </Notice>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile n={d.totals.units.toLocaleString("en-IN")} label="Units on hand" />
        <Tile n={d.totals.lines.toLocaleString("en-IN")} label="Stock lines" href="/stock" />
        <Tile n={d.totals.locations} label="Locations" href="/locations" />
        <Tile n={urgent} label="Need action now" tone={urgent ? "bad" : "good"} />
        <Tile n={d.totals.damaged} label="Unsellable" tone={d.totals.damaged ? "warn" : "plain"} />
      </div>

      <Section
        title="Needs attention"
        action={<Link href="/stock" className="text-sm text-teal-700 hover:underline">All stock →</Link>}
      >
        {d.attention.length === 0 ? (
          <Card><Empty>Nothing is out of stock, expiring or unsellable. Unusual — enjoy it.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Severity</span></th>
                <th>Product</th>
                <th>Where</th>
                <th className="num">On hand</th>
                <th>Why</th>
                <th className="w-24"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {d.attention.map((a: any, i: number) => (
                <tr key={i}>
                  <td><Dot tone={a.tone} /></td>
                  <td>
                    <div className="font-medium">{a.name}</div>
                    <div className="mono text-ink-400">{a.sku_code}</div>
                  </td>
                  <td><Pill>{a.location_code}</Pill></td>
                  <td className="num tnum">{a.on_hand}</td>
                  <td className="text-ink-700">{a.why}</td>
                  <td>
                    {/* ONE click from here to the ledger that explains it. */}
                    <Link
                      href={`/stock/${a.sku_code}?loc=${a.location_code}`}
                      className="text-sm font-medium text-teal-700 hover:underline"
                    >
                      Why? →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section
        title="Open movements"
        action={<Link href="/movements" className="text-sm text-teal-700 hover:underline">All movements →</Link>}
      >
        {d.stuck.length === 0 ? (
          <Card><Empty>No tickets open.</Empty></Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.stuck.map((m: any) => (
              <Link key={m.id} href={`/movements/${m.id}`} className="card card-pad hover:border-ink-200">
                <div className="flex items-center gap-2">
                  <span className="mono font-medium">{m.ticket_no}</span>
                  <Pill tone={m.status === "DISCREPANCY" ? "bad" : m.status === "IN_TRANSIT" ? "warn" : "plain"}>
                    {m.status.toLowerCase().replace("_", " ")}
                  </Pill>
                </div>
                <div className="mt-1.5 text-sm text-ink-700">
                  {m.source_code ?? "—"} → {m.dest_code ?? "—"}
                </div>
                <div className="meta mt-1">
                  raised <When at={m.raised_at} relative />
                  {m.status === "DISCREPANCY" && " · cannot close until explained"}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
