import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE } from "@/lib/session";
import {
  PageHeader, Tile, Pill, Dot, Card, Empty, Notice, TableWrap, Section,
} from "../ui";
import { postAdjustment, recordWastage } from "./actions";
import { param } from "@/lib/params";

export const dynamic = "force-dynamic";

export default async function Stock({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; q?: string; only?: string; error?: string; ok?: string }>;
}) {
  const { loc, q, only, error, ok } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const locations = (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows;

    const rows = (await c.query(
      `select b.id, b.product_id, b.location_id, b.on_hand, b.reserved,
              b.allocated, b.damaged, b.available,
              p.sku_code, p.name, p.tracking_mode, u.code as uom,
              l.code as location_code, bt.lot_no, bt.expiry_date,
              (bt.expiry_date is not null and bt.expiry_date <= current_date + 7) as expiring_soon
         from stock.balance b
         join catalog.product p on p.id = b.product_id
         join catalog.uom u on u.id = p.base_uom_id
         join platform.location l on l.id = b.location_id
         left join stock.batch bt on bt.id = b.batch_id
        where l.type <> 'VIRTUAL'
          and ($1::text is null or l.code = $1)
          and ($2::text is null or p.name ilike '%'||$2||'%' or p.sku_code ilike '%'||$2||'%')
          and ($3::text is null
               or ($3 = 'empty'    and b.available <= 0)
               or ($3 = 'damaged'  and b.damaged > 0)
               or ($3 = 'expiring' and bt.expiry_date is not null
                                   and bt.expiry_date <= current_date + 7))
        order by l.code, p.sku_code
        limit 400`,
      [param(loc), param(q), param(only)])).rows;

    const totals = (await c.query(
      `select coalesce(sum(b.on_hand),0)::int  as units,
              coalesce(sum(b.reserved),0)::int as reserved,
              coalesce(sum(b.damaged),0)::int  as damaged,
              count(*) filter (where b.available <= 0)::int as empty
         from stock.balance b
         join platform.location l on l.id = b.location_id
        where l.type <> 'VIRTUAL' and ($1::text is null or l.code = $1)`,
      [param(loc)])).rows[0];

    const drift = (await c.query(
      "select count(*)::int as n from stock.verify_balances()")).rows[0].n;

    return { locations, rows, totals, drift };
  });

  const canAdjust = CAN_APPROVE.includes(me.role);
  const filterLink = (k: string, v?: string) => {
    const p = new URLSearchParams();
    if (loc) p.set("loc", loc);
    if (q) p.set("q", q);
    if (v) p.set(k, v);
    return `/stock${p.toString() ? "?" + p : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Stock"
        lede={
          <>
            A <b>projection</b>, not a record. Every number is the sum of the ledger entries
            behind it — nothing writes here directly, including this page.
          </>
        }
      />

      {d.drift > 0 && (
        <Notice tone="bad" title={`${d.drift} line(s) disagree with the ledger.`}>
          Treat these figures as suspect until it is resolved.
        </Notice>
      )}

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mb-4"><Notice tone="info" title="Done:">{ok}</Notice></div>}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile n={d.totals.units.toLocaleString("en-IN")} label="Units on hand" />
        <Tile n={d.totals.reserved.toLocaleString("en-IN")} label="Held for orders" />
        <Tile n={d.totals.empty} label="Nothing to sell" tone={d.totals.empty ? "bad" : "good"} />
        <Tile n={d.totals.damaged} label="Unsellable" tone={d.totals.damaged ? "warn" : "plain"} />
      </div>

      <div className="mt-5">
        <Card>
          <form action="/stock" method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-40">
              <label className="label" htmlFor="loc">Location</label>
              <select id="loc" name="loc" defaultValue={loc ?? ""} className="field">
                <option value="">All I can see</option>
                {d.locations.map((l: any) => (
                  <option key={l.code} value={l.code}>{l.code} — {l.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-52 flex-1">
              <label className="label" htmlFor="q">Product</label>
              <input id="q" name="q" defaultValue={q ?? ""} className="field"
                     placeholder="name or code" />
            </div>
            {only && <input type="hidden" name="only" value={only} />}
            <button type="submit" className="btn">Filter</button>
          </form>

          <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-100 pt-3">
            <span className="meta self-center">Show only:</span>
            {[["", "everything"], ["empty", "nothing to sell"],
              ["damaged", "unsellable"], ["expiring", "expiring in 7 days"]].map(([v, label]) => (
              <Link key={label} href={filterLink("only", v || undefined)}
                    className={`pill ${only === v || (!only && !v) ? "pill-info" : ""}`}>
                {label}
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-4">
        {d.rows.length === 0 ? (
          <Card><Empty>No stock matches that. Try clearing the filters.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Severity</span></th>
                <th>Product</th>
                <th>Where</th>
                <th>Lot</th>
                <th className="num">On hand</th>
                <th className="num">Held</th>
                <th className="num">Sellable</th>
                <th className="w-20"><span className="sr-only">Ledger</span></th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((b: any) => {
                const tone = b.available <= 0 ? "bad"
                  : b.expiring_soon || b.damaged > 0 ? "warn" : "good";
                return (
                  <tr key={b.id}>
                    <td><Dot tone={tone} /></td>
                    <td>
                      <div className="font-medium">{b.name}</div>
                      <div className="mono text-ink-400">
                        {b.sku_code}
                        {b.tracking_mode !== "NONE" && (
                          <span className="ml-2 lowercase">{b.tracking_mode}</span>
                        )}
                      </div>
                    </td>
                    <td><Pill>{b.location_code}</Pill></td>
                    <td className="mono text-ink-500">
                      {b.lot_no ?? "—"}
                      {b.expiry_date && (
                        <div className={b.expiring_soon ? "text-amber-600" : "text-ink-400"}>
                          {new Date(b.expiry_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                        </div>
                      )}
                    </td>
                    <td className="num tnum">
                      {b.on_hand.toLocaleString("en-IN")}
                      <span className="ml-1 text-ink-400">{b.uom}</span>
                    </td>
                    <td className="num tnum text-ink-500">{b.reserved || "—"}</td>
                    <td className={`num tnum font-semibold ${b.available <= 0 ? "text-rose-600" : ""}`}>
                      {b.available.toLocaleString("en-IN")}
                    </td>
                    <td>
                      <Link href={`/stock/${b.sku_code}?loc=${b.location_code}`}
                            className="text-sm font-medium text-teal-700 hover:underline">
                        Why? →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
        <p className="meta mt-2">
          Showing {d.rows.length} line(s). <b>Sellable</b> is on hand minus what is held,
          allocated or unsellable — sell against that, never against on hand.
        </p>
      </div>

      {canAdjust && d.rows.length > 0 && (
        <Section title="Correct a line">
          <Notice tone="warn">
            Both of these go through <span className="mono">stock.post_movement</span> and
            leave a ledger entry with your name on it. An adjustment without a reason is
            refused by the database, not by this form.
          </Notice>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card>
              <h3 className="h-sect mb-3">Adjust</h3>
              <form action={postAdjustment} className="space-y-3">
                <input type="hidden" name="back" value={loc ? `/stock?loc=${loc}` : "/stock"} />
                <div>
                  <label className="label" htmlFor="adj-line">Stock line</label>
                  <select id="adj-line" name="line" required className="field">
                    {d.rows.map((b: any) => (
                      <option key={b.id} value={`${b.product_id}|${b.location_id}`}>
                        {b.location_code} · {b.sku_code} · {b.name} ({b.on_hand})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3">
                  <div className="w-28">
                    <label className="label" htmlFor="delta">Change</label>
                    <input id="delta" name="delta" type="number" required
                           inputMode="numeric" placeholder="-5" className="field tnum" />
                  </div>
                  <div className="flex-1">
                    <label className="label" htmlFor="reason">Reason</label>
                    <input id="reason" name="reason" required className="field"
                           placeholder="recount after spillage" />
                  </div>
                </div>
                <button type="submit" className="btn">Post adjustment</button>
              </form>
            </Card>

            <Card>
              <h3 className="h-sect mb-3">Write off</h3>
              <form action={recordWastage} className="space-y-3">
                <input type="hidden" name="back" value={loc ? `/stock?loc=${loc}` : "/stock"} />
                <div>
                  <label className="label" htmlFor="wst-line">Stock line</label>
                  <select id="wst-line" name="line" required className="field">
                    {d.rows.map((b: any) => (
                      <option key={b.id} value={`${b.product_id}|${b.location_id}`}>
                        {b.location_code} · {b.sku_code} · {b.name} ({b.on_hand})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3">
                  <div className="w-28">
                    <label className="label" htmlFor="qty">Lost</label>
                    <input id="qty" name="qty" type="number" min="1" required
                           inputMode="numeric" placeholder="4" className="field tnum" />
                  </div>
                  <div className="flex-1">
                    <label className="label" htmlFor="note">What happened</label>
                    <input id="note" name="note" required className="field"
                           placeholder="spoiled on the shelf" />
                  </div>
                </div>
                <button type="submit" className="btn">Record wastage</button>
              </form>
              <p className="meta mt-2">
                Wastage is posted daily, per location — never discovered as a month-end plug.
              </p>
            </Card>
          </div>
        </Section>
      )}
    </>
  );
}
