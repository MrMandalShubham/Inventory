import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { PageHeader, Tile, Pill, Dot, Card, Empty, Notice, TableWrap, Section, When } from "../../ui";
import { param } from "@/lib/params";

export const dynamic = "force-dynamic";

/**
 * The answer screen.
 *
 * The Phase 5 gate is a manager finding WHY one product is short at
 * one location. This page is the end of that path, so it leads with
 * the arithmetic — opening position, what came in, what went out,
 * where it stands — and only then shows the individual entries.
 *
 * A raw list of movements is evidence. A reconciliation is an answer.
 */
export default async function ProductLedger({
  params, searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ loc?: string }>;
}) {
  const { sku } = await params;
  const { loc } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const product = (await c.query(
      `select p.id, p.sku_code, p.name, p.category, p.tracking_mode, p.is_weighed,
              u.code as uom
         from catalog.product p join catalog.uom u on u.id = p.base_uom_id
        where p.sku_code = $1`, [decodeURIComponent(sku)])).rows[0];
    if (!product) return null;

    const positions = (await c.query(
      `select l.code, l.name, b.on_hand, b.reserved, b.damaged, b.available,
              bt.lot_no, bt.expiry_date
         from stock.balance b
         join platform.location l on l.id = b.location_id
         left join stock.batch bt on bt.id = b.batch_id
        where b.product_id = $1 and l.type <> 'VIRTUAL'
        order by l.code`, [product.id])).rows;

    // The reconciliation: what the movements add up to, by direction.
    const summary = (await c.query(
      `select coalesce(sum(l.qty_delta) filter (where r.code = 'OPENING'), 0)::int  as opening,
              coalesce(sum(l.qty_delta) filter (where l.qty_delta > 0 and r.code <> 'OPENING'), 0)::int as came_in,
              coalesce(sum(l.qty_delta) filter (where l.qty_delta < 0 and not r.is_wastage), 0)::int   as went_out,
              coalesce(sum(l.qty_delta) filter (where r.is_wastage), 0)::int        as wasted,
              coalesce(sum(l.qty_delta), 0)::int                                    as net
         from stock.ledger l
         join stock.reason r on r.code = l.reason_code
         join platform.location loc on loc.id = l.location_id
        where l.product_id = $1 and ($2::text is null or loc.code = $2)`,
      [product.id, param(loc)])).rows[0];

    const entries = (await c.query(
      `select l.id, l.qty_delta, l.balance_after, l.reason_code, l.note,
              l.occurred_at, l.recorded_at, l.movement_id,
              loc.code as location_code, bt.lot_no,
              coalesce(u.full_name, 'system') as actor,
              r.label as reason_label, r.is_wastage,
              m.ticket_no
         from stock.ledger l
         join platform.location loc on loc.id = l.location_id
         join stock.reason r on r.code = l.reason_code
         left join stock.batch bt on bt.id = l.batch_id
         left join platform.app_user u on u.id = l.actor_id
         left join movement.movement m on m.id = l.movement_id
        where l.product_id = $1 and ($2::text is null or loc.code = $2)
        order by l.occurred_at desc, l.id desc
        limit 100`, [product.id, param(loc)])).rows;

    return { product, positions, summary, entries };
  });

  if (!d) notFound();
  const { product, positions, summary, entries } = d;
  const here = loc ? positions.find((p: any) => p.code === loc) : null;

  return (
    <>
      <PageHeader
        eyebrow={product.sku_code}
        title={product.name}
        lede={
          <>
            {product.category ?? "Uncategorised"} · counted in {product.uom}
            {product.tracking_mode !== "NONE" && <> · tracked by {product.tracking_mode.toLowerCase()}</>}
            {loc && <> · showing <b>{loc}</b> only</>}
          </>
        }
        actions={
          loc ? (
            <Link href={`/stock/${product.sku_code}`} className="btn btn-ghost">
              All locations
            </Link>
          ) : undefined
        }
      />

      {/* ── the arithmetic, first ── */}
      <Section title={loc ? `How ${loc} got here` : "How this adds up"}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Tile n={summary.opening.toLocaleString("en-IN")} label="Opened with" />
          <Tile n={`+${summary.came_in.toLocaleString("en-IN")}`} label="Came in" tone="good" />
          <Tile n={summary.went_out.toLocaleString("en-IN")} label="Sold or sent" />
          <Tile n={summary.wasted.toLocaleString("en-IN")} label="Wasted"
                tone={summary.wasted < 0 ? "warn" : "plain"} />
          <Tile n={summary.net.toLocaleString("en-IN")} label="Should be on hand"
                tone={here && here.on_hand !== summary.net ? "bad" : "plain"} />
        </div>

        {here && (
          <div className="mt-3">
            {here.on_hand === summary.net ? (
              <Notice tone="info" title="The shelf and the ledger agree.">
                {here.on_hand} on hand at {loc}, of which {here.reserved} held for orders
                {here.damaged > 0 && ` and ${here.damaged} unsellable`} —{" "}
                <b>{here.available} sellable</b>.
              </Notice>
            ) : (
              <Notice tone="bad" title="The shelf and the ledger disagree.">
                The balance says {here.on_hand} but the movements add up to {summary.net}.
                That should be impossible — raise it.
              </Notice>
            )}
          </div>
        )}
      </Section>

      {/* ── where it sits ── */}
      {positions.length > 0 && (
        <Section title="Where it is">
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Severity</span></th>
                <th>Location</th><th>Lot</th>
                <th className="num">On hand</th><th className="num">Held</th>
                <th className="num">Unsellable</th><th className="num">Sellable</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any, i: number) => (
                <tr key={i} className={loc === p.code ? "bg-teal-50/60" : ""}>
                  <td><Dot tone={p.available <= 0 ? "bad" : p.damaged > 0 ? "warn" : "good"} /></td>
                  <td>
                    <span className="font-medium">{p.code}</span>
                    <span className="meta ml-2">{p.name}</span>
                  </td>
                  <td className="mono text-ink-500">
                    {p.lot_no ?? "—"}
                    {p.expiry_date && (
                      <span className="ml-2 text-amber-600">
                        {new Date(p.expiry_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                      </span>
                    )}
                  </td>
                  <td className="num tnum">{p.on_hand}</td>
                  <td className="num tnum text-ink-500">{p.reserved || "—"}</td>
                  <td className={`num tnum ${p.damaged ? "text-amber-600" : "text-ink-400"}`}>
                    {p.damaged || "—"}
                  </td>
                  <td className={`num tnum font-semibold ${p.available <= 0 ? "text-rose-600" : ""}`}>
                    {p.available}
                  </td>
                  <td>
                    {loc !== p.code && (
                      <Link href={`/stock/${product.sku_code}?loc=${p.code}`}
                            className="text-sm text-teal-700 hover:underline">only this</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Section>
      )}

      {/* ── the evidence ── */}
      <Section title="Every movement">
        {entries.length === 0 ? (
          <Card><Empty denied={!loc} what="this product">No movements recorded.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>Happened</th><th>Where</th><th>What</th>
                <th className="num">Change</th><th className="num">Became</th>
                <th>Who</th><th>Note</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any) => {
                const late = new Date(e.recorded_at).getTime() - new Date(e.occurred_at).getTime() > 3_600_000;
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">
                      <When at={e.occurred_at} />
                      {late && (
                        <div className="meta text-amber-600">
                          entered <When at={e.recorded_at} relative />
                        </div>
                      )}
                    </td>
                    <td><Pill>{e.location_code}</Pill></td>
                    <td>
                      <Pill tone={e.is_wastage ? "bad" : e.qty_delta > 0 ? "good" : "plain"}>
                        {e.reason_label}
                      </Pill>
                      {e.ticket_no && (
                        <Link href={`/movements/${e.movement_id}`}
                              className="mono ml-2 text-teal-700 hover:underline">
                          {e.ticket_no}
                        </Link>
                      )}
                    </td>
                    <td className={`num tnum font-semibold ${e.qty_delta > 0 ? "text-moss-600" : "text-rose-600"}`}>
                      {e.qty_delta > 0 ? "+" : ""}{e.qty_delta.toLocaleString("en-IN")}
                    </td>
                    <td className="num tnum">{e.balance_after.toLocaleString("en-IN")}</td>
                    <td className="text-ink-700">{e.actor}</td>
                    <td className="text-ink-500">{e.note ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}

        <p className="meta mt-2">
          Append-only. A correction is a new line that explains itself, never a rewrite of
          an old one. Where <b>entered</b> appears, the event was recorded later than it
          happened — a delivery taken at 6am and keyed at 11am is one event with two times.
        </p>
      </Section>

      <p className="mt-6">
        <Link href="/stock" className="text-sm text-teal-700 hover:underline">← All stock</Link>
      </p>
    </>
  );
}
