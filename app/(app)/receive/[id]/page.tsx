import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN, CAN_SEE_MONEY } from "@/lib/session";
import { PageHeader, Notice, Card, Empty } from "../../ui";
import { receiveMovement } from "../../movements/actions";
import { ReceiveForm, type Line } from "./receive-form";

export const dynamic = "force-dynamic";

export default async function Receive({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const m = (await c.query(`
      select m.id, m.ticket_no, m.type, m.status, m.note,
             src.code as source_code, dst.code as dest_code, dst.name as dest_name,
             p.name as partner_name
        from movement.movement m
        left join platform.location src on src.id = m.source_location_id
        left join platform.location dst on dst.id = m.dest_location_id
        left join partner.partner p on p.id = m.partner_id
       where m.id = $1`, [id])).rows[0];
    if (!m) return null;

    const lines = (await c.query(`
      select l.id, l.qty_ordered, l.qty_dispatched, p.sku_code, p.name,
             u.code as uom, bt.lot_no,
             (select b.barcode from catalog.product_barcode b
               where b.product_id = p.id and b.is_primary limit 1) as barcode
        from movement.line l
        join catalog.product p on p.id = l.product_id
        join catalog.uom u on u.id = p.base_uom_id
        left join stock.batch bt on bt.id = l.batch_id
       where l.movement_id = $1 order by p.sku_code`, [id])).rows;

    return { m, lines };
  });

  if (!d) notFound();
  const { m, lines } = d;
  const receivable = ["IN_TRANSIT", "APPROVED"].includes(m.status) && m.type !== "EXPORT";

  if (!receivable) {
    return (
      <>
        <PageHeader eyebrow={m.ticket_no} title="Not waiting to be received" />
        <Card>
          <Empty>
            This ticket is <b>{m.status.toLowerCase().replace("_", " ")}</b>.{" "}
            <Link href={`/movements/${m.id}`} className="text-teal-700 hover:underline">
              Open the ticket
            </Link>
          </Empty>
        </Card>
      </>
    );
  }

  const formLines: Line[] = lines.map((l: any) => ({
    id: l.id,
    sku_code: l.sku_code,
    name: l.name,
    uom: l.uom,
    lot_no: l.lot_no,
    barcode: l.barcode,
    expected: l.qty_dispatched ?? l.qty_ordered,
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow={`${m.type.toLowerCase()} · ${m.ticket_no}`}
        title={`Receiving at ${m.dest_code}`}
        lede={
          <>
            From {m.source_code ?? m.partner_name} · {m.dest_name}
            {m.note ? ` · ${m.note}` : ""}
          </>
        }
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}

      <ReceiveForm
        lines={formLines}
        action={receiveMovement}
        ticketNo={m.ticket_no}
        movementId={m.id}
        back={`/receive/${m.id}`}
        canCost={[...CAN_PLAN, ...CAN_SEE_MONEY].includes(me.role)}
        isTransfer={m.type === "TRANSFER"}
      />

      <p className="mt-6">
        <Link href={`/movements/${m.id}`} className="text-sm text-teal-700 hover:underline">
          ← Ticket detail
        </Link>
      </p>
    </div>
  );
}
