import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE } from "@/lib/session";
import { PageHeader, Tile, Pill, Dot, Card, Empty, Notice, TableWrap, Section, When } from "../ui";
import { param } from "@/lib/params";

export const dynamic = "force-dynamic";

const TONE: Record<string, "plain" | "good" | "warn" | "bad" | "info"> = {
  DRAFT: "plain", APPROVED: "info", PICKED: "info", DISPATCHED: "warn",
  IN_TRANSIT: "warn", RECEIVED: "warn", RECONCILED: "good",
  DISCREPANCY: "bad", RESOLVED: "good", CLOSED: "good", CANCELLED: "plain",
};

export default async function Movements({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; show?: string }>;
}) {
  const { error, show } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const rows = (await c.query(`
      select m.id, m.ticket_no, m.type, m.status, m.note, m.raised_at,
             src.code as source_code, dst.code as dest_code, p.name as partner_name,
             (select coalesce(sum(l.qty_ordered),0)::int from movement.line l
               where l.movement_id = m.id) as units,
             (select count(*)::int from movement.line l where l.movement_id = m.id) as lines
        from movement.movement m
        left join platform.location src on src.id = m.source_location_id
        left join platform.location dst on dst.id = m.dest_location_id
        left join partner.partner p on p.id = m.partner_id
       where ($1::text is null
              or ($1 = 'open'  and m.status not in ('CLOSED','CANCELLED'))
              or ($1 = 'stuck' and m.status = 'DISCREPANCY')
              or ($1 = 'road'  and m.status = 'IN_TRANSIT'))
       order by m.raised_at desc limit 80`, [param(show)])).rows;

    const transit = (await c.query(`
      select coalesce(sum(b.on_hand),0)::int as units,
             (select count(*)::int from movement.verify_transit()) as drift
        from stock.balance b join platform.location l on l.id = b.location_id
       where l.code = 'TRANSIT'`)).rows[0];

    const counts = (await c.query(`
      select count(*) filter (where status not in ('CLOSED','CANCELLED'))::int as open,
             count(*) filter (where status = 'DISCREPANCY')::int as stuck,
             count(*) filter (where status = 'IN_TRANSIT')::int  as road
        from movement.movement`)).rows[0];

    return { rows, transit, counts };
  });

  const canRaise = CAN_APPROVE.includes(me.role);
  const tab = (v: string | undefined, label: string, n?: number) => (
    <Link key={label} href={v ? `/movements?show=${v}` : "/movements"}
          className={`pill ${show === v || (!show && !v) ? "pill-info" : ""}`}>
      {label}{n !== undefined && <span className="tnum ml-1 opacity-70">{n}</span>}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Movements"
        lede="Import, export and transfer are one object with one state machine. What differs is what sits at each end — and whether a bill or a delivery note comes out."
        actions={canRaise ? (
          <Link href="/movements/new" className="btn">Raise a movement</Link>
        ) : undefined}
      />

      {d.transit.drift > 0 ? (
        <Notice tone="bad" title={`${d.transit.drift} product(s) in transit that no open ticket claims.`}>
          Stock is on the road with nothing accounting for it.
        </Notice>
      ) : (
        <Notice tone="info" title="Transit is square.">
          What is on the road matches exactly what open tickets say. <b>Goods in transit
          belong to nobody</b> — they have left the source and not reached the destination,
          so they are sellable from neither.
        </Notice>
      )}

      {error && <div className="mt-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile n={d.counts.open} label="Open tickets" />
        <Tile n={d.transit.units.toLocaleString("en-IN")} label="Units on the road" tone={d.transit.units ? "warn" : "plain"} />
        <Tile n={d.counts.road} label="In transit" />
        <Tile n={d.counts.stuck} label="Need explaining" tone={d.counts.stuck ? "bad" : "good"} />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {tab(undefined, "everything")}
        {tab("open", "open", d.counts.open)}
        {tab("road", "on the road", d.counts.road)}
        {tab("stuck", "need explaining", d.counts.stuck)}
      </div>

      <div className="mt-4">
        {d.rows.length === 0 ? (
          <Card>
            <Empty>
              {show ? "Nothing matches that filter." : "No movements yet."}
              {canRaise && !show && (
                <> <Link href="/movements/new" className="text-teal-700 hover:underline">Raise one</Link>.</>
              )}
            </Empty>
          </Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Severity</span></th>
                <th>Ticket</th><th>Route</th>
                <th className="num">Lines</th><th className="num">Units</th>
                <th>Status</th><th>Raised</th><th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <Dot tone={m.status === "DISCREPANCY" ? "bad"
                      : ["IN_TRANSIT", "DISPATCHED", "RECEIVED"].includes(m.status) ? "warn"
                      : m.status === "CLOSED" ? "good" : "plain"} />
                  </td>
                  <td>
                    <div className="mono font-medium">{m.ticket_no}</div>
                    <div className="meta lowercase">{m.type}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="mono">{m.source_code ?? m.partner_name ?? "—"}</span>
                    <span className="mx-1.5 text-ink-400">→</span>
                    <span className="mono">{m.dest_code ?? m.partner_name ?? "—"}</span>
                    {m.note && <div className="meta">{m.note}</div>}
                  </td>
                  <td className="num tnum">{m.lines}</td>
                  <td className="num tnum">{m.units.toLocaleString("en-IN")}</td>
                  <td>
                    <Pill tone={TONE[m.status] ?? "plain"}>
                      {m.status.toLowerCase().replace("_", " ")}
                    </Pill>
                  </td>
                  <td className="meta whitespace-nowrap"><When at={m.raised_at} relative /></td>
                  <td className="whitespace-nowrap">
                    <Link href={`/movements/${m.id}`} className="text-sm text-teal-700 hover:underline">
                      open
                    </Link>
                    {m.status === "IN_TRANSIT" && (
                      <>
                        <span className="mx-1 text-ink-200">·</span>
                        <Link href={`/receive/${m.id}`} className="text-sm font-semibold text-teal-700 hover:underline">
                          receive
                        </Link>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </>
  );
}
