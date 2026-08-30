import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE } from "@/lib/session";
import {
  PageHeader, Pill, Tile, Card, Empty, Notice, TableWrap, Section, Money, When,
} from "../../ui";
import {
  approveMovement, dispatchMovement, resolveDiscrepancy, cancelMovement,
} from "../actions";

export const dynamic = "force-dynamic";

const STAGES = ["DRAFT", "APPROVED", "IN_TRANSIT", "RECEIVED", "CLOSED"];

export default async function MovementDetail({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const m = (await c.query(`
      select m.*, src.code as source_code, dst.code as dest_code, p.name as partner_name,
             raiser.full_name as raised_by_name, appr.full_name as approved_by_name,
             recv.full_name as received_by_name, reso.full_name as resolved_by_name
        from movement.movement m
        left join platform.location src on src.id = m.source_location_id
        left join platform.location dst on dst.id = m.dest_location_id
        left join partner.partner p on p.id = m.partner_id
        left join platform.app_user raiser on raiser.id = m.raised_by
        left join platform.app_user appr   on appr.id   = m.approved_by
        left join platform.app_user recv   on recv.id   = m.received_by
        left join platform.app_user reso   on reso.id   = m.resolved_by
       where m.id = $1`, [id])).rows[0];
    if (!m) return null;

    const lines = (await c.query(`
      select l.*, p.sku_code, p.name, u.code as uom
        from movement.line l
        join catalog.product p on p.id = l.product_id
        join catalog.uom u on u.id = p.base_uom_id
       where l.movement_id = $1 order by p.sku_code`, [id])).rows;

    const docs = (await c.query(
      `select kind, doc_no, goods_value_paise, tax_paise, issued_at
         from movement.document where movement_id = $1`, [id])).rows;

    const ledger = (await c.query(`
      select l.qty_delta, l.reason_code, l.note, loc.code as location_code
        from stock.ledger l join platform.location loc on loc.id = l.location_id
       where l.movement_id = $1 order by l.id`, [id])).rows;

    // Margin, if this was a sale and the caller may see money. The
    // function returns no rows rather than an error for a role that
    // may not — so an empty result here means "not for you", which is
    // why the panel below says so instead of showing zeroes.
    const margin = m.type === "EXPORT"
      ? (await c.query("select * from movement.order_margin($1)", [id])).rows[0] ?? null
      : null;

    return { m, lines, docs, ledger, margin };
  });

  if (!d) notFound();
  const { m, lines, docs, ledger, margin } = d;

  const canAct = CAN_APPROVE.includes(me.role);
  const isRaiser = m.raised_by === me.sub;
  const isReceiver = m.received_by === me.sub;
  const stageIdx = STAGES.indexOf(m.status);

  return (
    <>
      <PageHeader
        eyebrow={`${m.type.toLowerCase()} · ${m.ticket_no}`}
        title={`${m.source_code ?? m.partner_name} → ${m.dest_code ?? m.partner_name}`}
        lede={m.note ?? undefined}
        actions={
          m.status === "IN_TRANSIT" || (m.status === "APPROVED" && m.type === "IMPORT") ? (
            <Link href={`/receive/${m.id}`} className="btn">Receive</Link>
          ) : undefined
        }
      />

      {/* Where the ticket is in its life */}
      <Card className="overflow-x-auto">
        <ol className="flex min-w-max items-center gap-2">
          {STAGES.map((s, i) => {
            const branched = ["RECONCILED", "DISCREPANCY", "RESOLVED"].includes(m.status);
            const reached = branched ? i <= 3 : stageIdx >= i;
            const current = m.status === s;
            return (
              <li key={s} className="flex items-center gap-2">
                <span className={`pill ${current ? "pill-info" : reached ? "pill-good" : ""}`}>
                  {s.toLowerCase().replace("_", " ")}
                </span>
                {i < STAGES.length - 1 && <span aria-hidden className="text-ink-200">→</span>}
              </li>
            );
          })}
          {m.status === "DISCREPANCY" && (
            <li><span className="pill pill-bad ml-2">discrepancy — cannot close</span></li>
          )}
          {m.status === "CANCELLED" && <li><span className="pill ml-2">cancelled</span></li>}
        </ol>
      </Card>

      {error && <div className="mt-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mt-4"><Notice tone="info" title="Done:">{ok}</Notice></div>}

      <Section title="Lines">
        <TableWrap>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Ordered</th><th className="num">Sent</th>
              <th className="num">Arrived</th><th className="num">Accepted</th>
              <th className="num">Rejected</th><th className="num">Lost</th><th>Why</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l: any) => (
              <tr key={l.id}>
                <td>
                  <div className="font-medium">{l.name}</div>
                  <div className="mono text-ink-400">{l.sku_code}</div>
                </td>
                <td className="num tnum">{l.qty_ordered}</td>
                <td className="num tnum">{l.qty_dispatched ?? "—"}</td>
                <td className="num tnum">{l.qty_received ?? "—"}</td>
                <td className="num tnum font-semibold text-moss-600">{l.qty_accepted ?? "—"}</td>
                <td className={`num tnum ${l.qty_rejected ? "text-rose-600 font-semibold" : "text-ink-400"}`}>
                  {l.qty_rejected ?? "—"}
                </td>
                <td className={`num tnum ${l.qty_lost ? "text-rose-600 font-semibold" : "text-ink-400"}`}>
                  {l.qty_lost ?? "—"}
                </td>
                <td className="text-ink-500">{l.reject_reason ?? l.loss_reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>

        <Notice tone="info">
          <b>Five quantities, because they genuinely differ.</b> Ordered is what was asked
          for. Sent is what actually left — the rest may already have been damaged on the
          shelf. Arrived is what was counted. Accepted joined usable stock; rejected arrived
          broken; lost left and never came. One <span className="mono">quantity</span> column
          would tell you none of it.
        </Notice>
      </Section>

      {/* ── actions ── */}
      {canAct && m.status === "DRAFT" && (
        <Section title="Approve">
          {isRaiser ? (
            <Notice tone="bad" title="You raised this ticket.">
              Someone else has to approve it. Try anyway — the refusal comes from the
              database, not this page.
              <form action={approveMovement} className="mt-3">
                <input type="hidden" name="id" value={m.id} />
                <button type="submit" className="btn">Approve</button>
              </form>
            </Notice>
          ) : (
            <Card>
              <form action={approveMovement}>
                <input type="hidden" name="id" value={m.id} />
                <button type="submit" className="btn">Approve</button>
              </form>
            </Card>
          )}
        </Section>
      )}

      {canAct && m.status === "APPROVED" && m.type !== "IMPORT" && (
        <Section title="Dispatch">
          <Card>
            <form action={dispatchMovement} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={m.id} />
              <input type="hidden" name="line_id" value={lines[0]?.id} />
              <div className="w-32">
                <label className="label" htmlFor="qty">Actually sending</label>
                <input id="qty" name="qty" type="number" min="0" max={lines[0]?.qty_ordered}
                       defaultValue={lines[0]?.qty_ordered} className="field tnum text-right" />
              </div>
              <button type="submit" className="btn">Dispatch</button>
            </form>
            <p className="meta mt-2">
              Stock leaves the source and enters transit. After this the ticket cannot be
              cancelled — the only way back is a reverse movement, which leaves its own trail.
            </p>
          </Card>
        </Section>
      )}

      {canAct && m.status === "DISCREPANCY" && (
        <Section title="Explain the variance">
          <Notice tone="warn">
            This ticket has no path to closed that skips a reason and an approver. The units
            that never arrived are still sitting in transit until this is done.
          </Notice>
          <div className="mt-3">
            {isReceiver ? (
              <Notice tone="bad" title="You received this delivery.">
                Someone else must approve the variance.
                <form action={resolveDiscrepancy} className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={m.id} />
                  <input name="reason" required className="field flex-1 min-w-52"
                         placeholder="carrier query raised" />
                  <button type="submit" className="btn">Resolve and close</button>
                </form>
              </Notice>
            ) : (
              <Card>
                <form action={resolveDiscrepancy} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="id" value={m.id} />
                  <div className="min-w-52 flex-1">
                    <label className="label" htmlFor="reason">What happened</label>
                    <input id="reason" name="reason" required className="field"
                           placeholder="carrier query raised, one unit lost" />
                  </div>
                  <button type="submit" className="btn">Resolve and close</button>
                </form>
              </Card>
            )}
          </div>
        </Section>
      )}

      {canAct && ["DRAFT", "APPROVED"].includes(m.status) && (
        <Section title="Cancel">
          <Card>
            <form action={cancelMovement} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={m.id} />
              <div className="min-w-52 flex-1">
                <label className="label" htmlFor="cancel_reason">Reason</label>
                <input id="cancel_reason" name="reason" required className="field"
                       placeholder="no longer needed" />
              </div>
              <button type="submit" className="btn btn-ghost">Cancel ticket</button>
            </form>
          </Card>
        </Section>
      )}

      {m.type === "EXPORT" && m.dispatched_at && (
        <Section title="What this order earned">
          {margin ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Tile n={<Money paise={margin.revenue_paise} />} label="Revenue" />
                <Tile n={<Money paise={margin.cogs_paise} />} label="Cost of goods sold" />
                <Tile
                  n={<Money paise={margin.margin_paise} signed />}
                  label="Gross margin"
                  tone={Number(margin.margin_paise) > 0 ? "good" : "bad"}
                />
                <Tile
                  n={margin.margin_pct === null ? "—" : `${Number(margin.margin_pct).toFixed(2)}%`}
                  label="Margin"
                />
              </div>
              <p className="meta mt-2">
                Both figures come from the accounting entries, not from a price list.
                Cost of goods is the weighted average landed cost these units left at —
                invoice price plus their share of the freight, fixed when they arrived.
              </p>
            </>
          ) : (
            <Card pad>
              <Empty denied what="this order's margin" />
            </Card>
          )}
        </Section>
      )}

      {docs.length > 0 && (
        <Section title="Documents">
          <TableWrap>
            <thead>
              <tr><th>Kind</th><th>Number</th><th className="num">Goods</th><th className="num">Tax</th><th>Issued</th></tr>
            </thead>
            <tbody>
              {docs.map((d2: any) => (
                <tr key={d2.doc_no}>
                  <td>
                    <Pill tone={d2.kind === "DELIVERY_CHALLAN" ? "info" : "warn"}>
                      {d2.kind.toLowerCase().replace("_", " ")}
                    </Pill>
                  </td>
                  <td className="mono">{d2.doc_no}</td>
                  <td className="num"><Money paise={d2.goods_value_paise} /></td>
                  <td className="num">
                    {d2.tax_paise === null
                      ? <span className="text-ink-400">none</span>
                      : <Money paise={d2.tax_paise} />}
                  </td>
                  <td className="meta"><When at={d2.issued_at} /></td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          {docs.some((x: any) => x.kind === "DELIVERY_CHALLAN") && (
            <Notice tone="info">
              <b>A delivery challan carries no tax</b> — you cannot sell to yourself. Only a
              movement to an outside party raises a tax invoice. Treating an internal
              transfer as a sale would inflate revenue and corrupt stock valuation at once.
            </Notice>
          )}
        </Section>
      )}

      {ledger.length > 0 && (
        <Section title="What this ticket did to stock">
          <TableWrap>
            <thead>
              <tr><th>Where</th><th>What</th><th className="num">Change</th><th>Note</th></tr>
            </thead>
            <tbody>
              {ledger.map((e: any, i: number) => (
                <tr key={i}>
                  <td><Pill>{e.location_code}</Pill></td>
                  <td className="lowercase text-ink-700">{e.reason_code.replace("_", " ")}</td>
                  <td className={`num tnum font-semibold ${e.qty_delta > 0 ? "text-moss-600" : "text-rose-600"}`}>
                    {e.qty_delta > 0 ? "+" : ""}{e.qty_delta}
                  </td>
                  <td className="text-ink-500">{e.note}</td>
                </tr>
              ))}
              <tr className="bg-ink-50">
                <td colSpan={2} className="font-semibold">Net across the legs you can see</td>
                <td className="num tnum font-bold">
                  {ledger.reduce((s: number, e: any) => s + e.qty_delta, 0)}
                </td>
                <td className="meta">
                  scoped to your locations — legs elsewhere are not listed, so this is
                  partial unless you hold both ends
                </td>
              </tr>
            </tbody>
          </TableWrap>
        </Section>
      )}

      <p className="meta mt-6">
        Raised by {m.raised_by_name ?? "—"}
        {m.approved_by_name && ` · approved by ${m.approved_by_name}`}
        {m.received_by_name && ` · received by ${m.received_by_name}`}
        {m.resolved_by_name && ` · resolved by ${m.resolved_by_name}`}
        {" · "}
        <Link href="/movements" className="text-teal-700 hover:underline">back to movements</Link>
      </p>
    </>
  );
}
