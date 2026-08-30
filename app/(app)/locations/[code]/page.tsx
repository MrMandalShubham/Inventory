import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import {
  currentClaims, seesEverything, locationList, CAN_SEE_MONEY,
} from "@/lib/session";
import {
  PageHeader, Tile, Pill, Dot, Card, Section, Empty, Notice, TableWrap, Money, When,
} from "../../ui";

export const dynamic = "force-dynamic";

/**
 * One inventory, on its own.
 *
 * Until now a location was something you FILTERED other screens by.
 * That is not the same as a shop having a dashboard: a filter answers
 * "show me Shop 1's rows of this one thing", where a person running
 * Shop 1 wants "how is my shop". Those are different questions and
 * the second one was never asked anywhere.
 *
 * So this page is the shop. It leads with what is wrong here, then
 * what is selling and what is stuck, then everything on the shelf —
 * in that order, because the order is the answer to "what do I do
 * this morning".
 *
 * Money is role-restricted (docs/08 §1): an operator sees quantities
 * and never valuations, here as everywhere else.
 */

const SEVERITY = {
  ACT_NOW: { label: "Act now", tone: "bad" as const },
  THIS_WEEK: { label: "This week", tone: "warn" as const },
  WORTH_KNOWING: { label: "Worth knowing", tone: "plain" as const },
};

function coverTone(days: number | null) {
  if (days === null) return "plain" as const;
  if (days < 3) return "bad" as const;
  if (days < 7) return "warn" as const;
  if (days > 60) return "warn" as const;
  return "good" as const;
}

export default async function LocationDashboard({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const me = await currentClaims();
  const canSeeMoney = CAN_SEE_MONEY.includes(me.role);

  const d = await withSession(me, async (c) => {
    // platform.location is readable by anyone signed in — you have to
    // know a shop exists to transfer to it. Its STOCK is not.
    const loc = (await c.query(
      `select id, code, name, type, status from platform.location
        where upper(code) = upper($1)`, [code])).rows[0];
    if (!loc) return null;

    const siblings = (await c.query(
      `select code, name from platform.location
        where status = 'ACTIVE' and type <> 'VIRTUAL' order by
          case type when 'HUB' then 1 when 'WAREHOUSE' then 2 else 3 end, code`)).rows;

    const totals = (await c.query(`
      select count(*)::int                        as lines,
             coalesce(sum(on_hand), 0)::int       as units,
             coalesce(sum(reserved), 0)::int      as reserved,
             coalesce(sum(damaged), 0)::int       as damaged,
             count(*) filter (where on_hand = 0)::int as empty_lines
        from stock.balance where location_id = $1`, [loc.id])).rows[0];

    const value = canSeeMoney
      ? (await c.query("select * from stock.valuation($1)", [loc.id])).rows[0] ?? null
      : null;

    const alerts = (await c.query(`
      select a.id, a.rule_code, a.severity, a.title, a.raised_at,
             p.sku_code, p.name as product_name
        from alerting.alert a
        left join catalog.product p on p.id = a.product_id
       where a.location_id = $1 and a.state = 'OPEN'
       order by case a.severity when 'ACT_NOW' then 1 when 'THIS_WEEK' then 2 else 3 end,
                a.raised_at
       limit 20`, [loc.id])).rows;

    // The demand-and-supply picture for this shop.
    const metrics = (await c.query(`
      select m.*, p.sku_code, p.name
        from insight.product_metric m
        join catalog.product p on p.id = m.product_id
       where m.location_id = $1
       order by m.avg_daily desc`, [loc.id])).rows;

    // Thirty days of flow, so "is this shop busy" has an answer.
    const flow = (await c.query(`
      select coalesce(sum(qty_delta) filter (where qty_delta > 0), 0)::int as units_in,
             coalesce(abs(sum(qty_delta) filter (where qty_delta < 0)), 0)::int as units_out,
             count(*)::int as events
        from stock.ledger
       where location_id = $1 and occurred_at > now() - interval '30 days'`,
      [loc.id])).rows[0];

    const tickets = (await c.query(`
      select m.id, m.ticket_no, m.type, m.status, m.raised_at, m.expected_at,
             src.code as source_code, dst.code as dest_code,
             (m.dest_location_id = $1) as inbound
        from movement.movement m
        left join platform.location src on src.id = m.source_location_id
        left join platform.location dst on dst.id = m.dest_location_id
       where (m.source_location_id = $1 or m.dest_location_id = $1)
         and m.status not in ('CLOSED','CANCELLED')
       order by m.raised_at desc limit 12`, [loc.id])).rows;

    // Everything on the shelf here, keyed by the product's own code.
    const shelf = (await c.query(`
      select p.sku_code, p.name, p.category, u.code as uom,
             b.on_hand, b.reserved, b.allocated, b.damaged,
             b.on_hand - b.reserved - b.allocated - b.damaged as available,
             b.weighted_avg_cost,
             bt.lot_no, bt.expiry_date,
             m.avg_daily, m.days_of_cover, m.reorder_point, m.abc,
             m.days_since_movement
        from stock.balance b
        join catalog.product p on p.id = b.product_id
        join catalog.uom u on u.id = p.base_uom_id
        left join stock.batch bt on bt.id = b.batch_id
        left join insight.product_metric m
               on m.product_id = b.product_id and m.location_id = b.location_id
       where b.location_id = $1
       order by p.sku_code`, [loc.id])).rows;

    return { loc, siblings, totals, value, alerts, metrics, flow, tickets, shelf };
  });

  if (!d) notFound();
  const { loc, siblings, totals, value, alerts, metrics, flow, tickets, shelf } = d;

  const inScope = seesEverything(me) || locationList(me).includes(loc.id);
  const denied = !inScope && shelf.length === 0;

  // Cover buckets: the supply half of "demand and supply" in one line.
  const measured = metrics.filter((m: any) => Number(m.avg_daily) > 0);
  const buckets = {
    out: measured.filter((m: any) => Number(m.available) <= 0).length,
    critical: measured.filter((m: any) =>
      Number(m.available) > 0 && Number(m.days_of_cover) < 7).length,
    healthy: measured.filter((m: any) =>
      Number(m.days_of_cover) >= 7 && Number(m.days_of_cover) <= 60).length,
    excess: measured.filter((m: any) => Number(m.days_of_cover) > 60).length,
  };

  const belowReorder = metrics.filter(
    (m: any) => Number(m.avg_daily) > 0 && Number(m.available) <= Number(m.reorder_point));

  const dead = shelf.filter(
    (s: any) => Number(s.on_hand) > 0 && Number(s.days_since_movement ?? 0) > 60);

  return (
    <>
      <PageHeader
        eyebrow={`${loc.type.toLowerCase()} · ${loc.code}`}
        title={loc.name}
        lede={
          <>
            Everything this inventory holds, what it is selling, and what needs a
            decision here today.
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/stock?loc=${loc.code}`} className="btn btn-ghost text-[13px] py-1.5">
              Stock list
            </Link>
            <Link href={`/movements/new?dest=${loc.code}`} className="btn text-[13px] py-1.5">
              Move stock here
            </Link>
          </div>
        }
      />

      {/* Switching shops is the most common thing a regional manager
          does on this screen, so it is on the screen rather than a
          trip back to the list. */}
      {siblings.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {siblings.map((s: any) => (
            <Link
              key={s.code}
              href={`/locations/${s.code}`}
              className={s.code === loc.code
                ? "btn text-[13px] py-1"
                : "btn btn-ghost text-[13px] py-1"}
            >
              {s.code}
            </Link>
          ))}
        </div>
      )}

      {!inScope && (
        <Notice tone="warn" title="Outside your scope.">
          You do not hold {loc.code}. The figures below are empty because the database
          returned nothing — not because this page hid them.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile n={totals.lines} label="Lines stocked" />
        <Tile n={Number(totals.units).toLocaleString("en-IN")} label="Units on hand" />
        {canSeeMoney ? (
          <Tile n={<Money paise={value?.value_paise ?? 0} />} label="Value at landed cost" />
        ) : (
          <Tile
            n={Number(totals.reserved).toLocaleString("en-IN")}
            label="Reserved for orders"
          />
        )}
        <Tile
          n={alerts.length}
          label="Needs attention"
          tone={alerts.some((a: any) => a.severity === "ACT_NOW") ? "bad"
            : alerts.length ? "warn" : "good"}
          href={`/alerts?loc=${loc.code}`}
        />
      </div>

      {/* ─────────────── what is wrong here ─────────────── */}

      <Section
        title="Needs attention here"
        action={
          alerts.length > 0
            ? <Link href={`/alerts?loc=${loc.code}`} className="text-sm text-teal-700 hover:underline">
                All alerts →
              </Link>
            : undefined
        }
      >
        {alerts.length === 0 ? (
          <Card pad>
            <Empty denied={denied} what={`alerts at ${loc.code}`}>
              Nothing at {loc.code} needs a decision today.
            </Empty>
          </Card>
        ) : (
          <div className="grid gap-2">
            {alerts.map((a: any) => {
              const sev = SEVERITY[a.severity as keyof typeof SEVERITY] ?? SEVERITY.WORTH_KNOWING;
              return (
                <Card key={a.id} pad>
                  <div className="flex items-start gap-3">
                    <span className="mt-1"><Dot tone={sev.tone} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={sev.tone}>{sev.label}</Pill>
                        <span className="font-medium">{a.title}</span>
                      </div>
                      <div className="meta mt-1">
                        raised <When at={a.raised_at} relative />
                      </div>
                    </div>
                    {a.sku_code && (
                      <Link
                        href={`/stock/${a.sku_code}?loc=${loc.code}`}
                        className="btn btn-ghost text-[13px] py-1.5 whitespace-nowrap"
                      >
                        Why?
                      </Link>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {/* ─────────────── demand and supply ─────────────── */}

      <Section title="Demand and supply">
        {measured.length === 0 ? (
          <Card pad>
            <Empty denied={denied} what={`demand at ${loc.code}`}>
              Nothing here has sold in the measurement window, so there is no demand to
              measure yet. Metrics are computed by{" "}
              <span className="mono">insight.refresh_metrics()</span>.
            </Empty>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile n={buckets.out} label="Out of stock" tone={buckets.out ? "bad" : "good"} />
              <Tile
                n={buckets.critical}
                label="Under a week of cover"
                tone={buckets.critical ? "warn" : "good"}
              />
              <Tile n={buckets.healthy} label="Comfortable" tone="good" />
              <Tile
                n={buckets.excess}
                label="Over two months' cover"
                tone={buckets.excess ? "warn" : "good"}
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="h-sect mb-2">Selling fastest</h3>
                <TableWrap>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">A day</th>
                      <th className="num">Cover</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measured.slice(0, 6).map((m: any) => (
                      <tr key={m.product_id}>
                        <td>
                          <Link href={`/stock/${m.sku_code}?loc=${loc.code}`}
                                className="link font-medium">{m.name}</Link>
                          {m.abc && <span className="meta ml-2">{m.abc}</span>}
                        </td>
                        <td className="num tnum">
                          {Math.round(Number(m.avg_daily)).toLocaleString("en-IN")}
                        </td>
                        <td className="num">
                          <Pill tone={coverTone(m.days_of_cover === null ? null : Number(m.days_of_cover))}>
                            {m.days_of_cover === null ? "—" : `${Number(m.days_of_cover).toFixed(1)}d`}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </div>

              <div>
                <h3 className="h-sect mb-2">Below reorder point</h3>
                <TableWrap>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Available</th>
                      <th className="num">Reorder at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {belowReorder.slice(0, 6).map((m: any) => (
                      <tr key={m.product_id}>
                        <td>
                          <Link href={`/planning/${m.sku_code}?loc=${loc.code}`}
                                className="link font-medium">{m.name}</Link>
                        </td>
                        <td className="num tnum text-rose-600">
                          {Number(m.available).toLocaleString("en-IN")}
                        </td>
                        <td className="num tnum">
                          {Number(m.reorder_point).toLocaleString("en-IN")}
                        </td>
                      </tr>
                    ))}
                    {belowReorder.length === 0 && (
                      <tr><td colSpan={3}>
                        <Empty>Everything here is above its reorder point.</Empty>
                      </td></tr>
                    )}
                  </tbody>
                </TableWrap>
              </div>
            </div>

            <p className="meta mt-2">
              Cover is what is available divided by what this shop actually sells in a
              day — measured over its own open days, not the calendar. A shop shut on
              Monday has not had a bad Monday.
            </p>
          </>
        )}
      </Section>

      {/* ─────────────── movement ─────────────── */}

      <Section title="Last thirty days">
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile n={Number(flow.units_in).toLocaleString("en-IN")} label="Units in" />
          <Tile n={Number(flow.units_out).toLocaleString("en-IN")} label="Units out" />
          <Tile n={Number(flow.events).toLocaleString("en-IN")} label="Stock events" />
        </div>

        {tickets.length > 0 && (
          <div className="mt-4">
            <h3 className="h-sect mb-2">Open tickets</h3>
            <TableWrap>
              <thead>
                <tr>
                  <th>Ticket</th><th>Type</th><th>Direction</th>
                  <th>Status</th><th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t: any) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/movements/${t.id}`} className="link font-medium">
                        {t.ticket_no}
                      </Link>
                    </td>
                    <td><Pill>{t.type.toLowerCase()}</Pill></td>
                    <td className="meta">
                      {t.inbound
                        ? <>from {t.source_code ?? "outside"}</>
                        : <>to {t.dest_code ?? "outside"}</>}
                    </td>
                    <td>
                      <Pill tone={t.status === "IN_TRANSIT" ? "info"
                        : t.status === "DISCREPANCY" ? "bad" : "warn"}>
                        {t.status.toLowerCase().replace("_", " ")}
                      </Pill>
                    </td>
                    <td className="meta"><When at={t.raised_at} relative /></td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}
      </Section>

      {/* ─────────────── the shelf ─────────────── */}

      <Section
        title={`Everything at ${loc.code}`}
        action={
          <Link href={`/stock?loc=${loc.code}`}
                className="text-sm text-teal-700 hover:underline">
            Open in stock list →
          </Link>
        }
      >
        <TableWrap>
          <thead>
            <tr>
              <th>Code</th>
              <th>Product</th>
              <th className="num">On hand</th>
              <th className="num">Available</th>
              <th className="num">Sells / day</th>
              <th className="num">Cover</th>
              {canSeeMoney && <th className="num">Value</th>}
            </tr>
          </thead>
          <tbody>
            {shelf.map((s: any, i: number) => {
              const cover = s.days_of_cover === null ? null : Number(s.days_of_cover);
              const stale = Number(s.on_hand) > 0 && Number(s.days_since_movement ?? 0) > 60;
              return (
                <tr key={`${s.sku_code}-${s.lot_no ?? i}`}>
                  <td className="mono">
                    <Link href={`/stock/${s.sku_code}?loc=${loc.code}`} className="link">
                      {s.sku_code}
                    </Link>
                  </td>
                  <td>
                    <div className="font-medium">{s.name}</div>
                    <div className="meta">
                      {s.category ?? "uncategorised"}
                      {s.lot_no && <> · lot {s.lot_no}</>}
                      {s.expiry_date && <> · exp {new Date(s.expiry_date).toLocaleDateString("en-GB")}</>}
                      {stale && <> · <span className="text-amber-600">no movement in {s.days_since_movement}d</span></>}
                    </div>
                  </td>
                  <td className="num tnum">
                    {Number(s.on_hand).toLocaleString("en-IN")}
                    <span className="meta ml-1">{s.uom.toLowerCase()}</span>
                  </td>
                  <td className="num tnum">
                    {Number(s.available) < 0 ? (
                      <span className="text-rose-600">{Number(s.available).toLocaleString("en-IN")}</span>
                    ) : (
                      Number(s.available).toLocaleString("en-IN")
                    )}
                    {Number(s.damaged) > 0 && (
                      <div className="meta text-amber-600">{s.damaged} unsellable</div>
                    )}
                  </td>
                  <td className="num tnum">
                    {s.avg_daily && Number(s.avg_daily) > 0
                      ? Math.round(Number(s.avg_daily)).toLocaleString("en-IN")
                      : <span className="text-ink-400">—</span>}
                  </td>
                  <td className="num">
                    {cover === null ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <Pill tone={coverTone(cover)}>{cover.toFixed(1)}d</Pill>
                    )}
                  </td>
                  {canSeeMoney && (
                    <td className="num">
                      <Money paise={Math.round(Number(s.on_hand) * Number(s.weighted_avg_cost))} />
                    </td>
                  )}
                </tr>
              );
            })}
            {shelf.length === 0 && (
              <tr><td colSpan={canSeeMoney ? 7 : 6}>
                <Empty denied={denied} what={`stock at ${loc.code}`}>
                  Nothing is stocked here yet.
                </Empty>
              </td></tr>
            )}
          </tbody>
        </TableWrap>

        {dead.length > 0 && (
          <Notice tone="warn" title="Cash sitting still.">
            {dead.length} line{dead.length === 1 ? " has" : "s have"} not moved in over
            sixty days at {loc.code}. That stock is money this shop cannot spend.
          </Notice>
        )}
      </Section>

      <p className="mt-6">
        <Link href="/locations" className="text-sm text-teal-700 hover:underline">
          ← All locations
        </Link>
      </p>
    </>
  );
}
