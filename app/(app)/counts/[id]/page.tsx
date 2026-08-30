import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE } from "@/lib/session";
import { PageHeader, Pill, Card, Empty, Notice, TableWrap, Section } from "../../ui";
import { recordCount, submitCountSheet, approveCountSheet } from "../../stock/actions";

export const dynamic = "force-dynamic";

export default async function CountSheet({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const sheet = (await c.query(`
      select cs.*, l.code as location_code, l.name as location_name,
             counter.full_name as counted_by_name, approver.full_name as approved_by_name
        from stock.count_sheet cs
        join platform.location l on l.id = cs.location_id
        left join platform.app_user counter  on counter.id  = cs.counted_by
        left join platform.app_user approver on approver.id = cs.approved_by
       where cs.id = $1`, [id])).rows[0];
    if (!sheet) return null;

    // What the counter sees. No expected column exists in this result.
    const blind = (await c.query("select * from stock.count_sheet_lines_blind($1)", [id])).rows;

    // What a reviewer sees. Returns nothing for an operator — there is
    // no SELECT policy on count_line for that role.
    const review = (await c.query(`
      select cl.id, cl.expected_qty, cl.counted_qty, cl.variance, cl.reason_note,
             p.sku_code, p.name
        from stock.count_line cl
        join catalog.product p on p.id = cl.product_id
       where cl.count_sheet_id = $1 order by p.sku_code`, [id])).rows;

    return { sheet, blind, review };
  });

  if (!d) notFound();
  const { sheet, blind, review } = d;

  const counting = sheet.status === "COUNTING";
  const submitted = sheet.status === "SUBMITTED";
  const isCounter = sheet.counted_by === me.sub;
  const canApprove = CAN_APPROVE.includes(me.role);
  const uncounted = blind.filter((l: any) => l.counted_qty === null).length;

  return (
    <>
      <PageHeader
        eyebrow={sheet.code}
        title={`${sheet.location_code} — ${sheet.location_name}`}
        lede={
          <>
            {sheet.scope_note ?? "Full count"} ·{" "}
            <Pill tone={sheet.status === "POSTED" ? "good" : "warn"}>
              {sheet.status.toLowerCase()}
            </Pill>
          </>
        }
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mb-4"><Notice tone="info" title="Done:">{ok}</Notice></div>}

      {counting && (
        <>
          <Notice tone="warn" title="You are counting blind.">
            The expected quantity is not in this result set — not hidden by CSS, not filtered
            by the page. The function that produced this table has no such column, and the
            raw table has no read policy for operators.
            {uncounted > 0 && ` ${uncounted} line(s) still to count.`}
          </Notice>

          <div className="mt-4">
            <TableWrap>
              <thead>
                <tr><th>Product</th><th>Lot</th><th className="num">Counted</th><th className="w-40">Record</th></tr>
              </thead>
              <tbody>
                {blind.map((l: any) => (
                  <tr key={l.line_id}>
                    <td>
                      <div className="font-medium">{l.product_name}</div>
                      <div className="mono text-ink-400">{l.sku_code}</div>
                    </td>
                    <td className="mono text-ink-500">{l.lot_no ?? "—"}</td>
                    <td className="num tnum">
                      {l.counted_qty === null
                        ? <span className="text-ink-300">—</span>
                        : <span className="font-semibold">{l.counted_qty}</span>}
                    </td>
                    <td>
                      <form action={recordCount} className="flex gap-2">
                        <input type="hidden" name="line_id" value={l.line_id} />
                        <input type="hidden" name="sheet_id" value={sheet.id} />
                        <input name="counted_qty" type="number" min="0" required
                               inputMode="numeric" defaultValue={l.counted_qty ?? ""}
                               className="field w-24 text-right tnum" />
                        <button type="submit" className="btn btn-ghost">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>

          <div className="mt-4">
            <form action={submitCountSheet}>
              <input type="hidden" name="sheet_id" value={sheet.id} />
              <button type="submit" className="btn">Submit count</button>
              <span className="meta ml-3">A sheet with uncounted lines is refused.</span>
            </form>
          </div>
        </>
      )}

      {!counting && (
        <Section title="Variances">
          {review.length === 0 ? (
            <Card><Empty denied what="this count sheet" /></Card>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">System said</th><th className="num">Counted</th>
                  <th className="num">Variance</th><th>Cause</th>
                </tr>
              </thead>
              <tbody>
                {review.map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      <div className="font-medium">{l.name}</div>
                      <div className="mono text-ink-400">{l.sku_code}</div>
                    </td>
                    <td className="num tnum">{l.expected_qty}</td>
                    <td className="num tnum">{l.counted_qty ?? "—"}</td>
                    <td className={`num tnum font-bold ${
                      !l.variance ? "text-ink-400"
                        : l.variance > 0 ? "text-moss-600" : "text-rose-600"}`}>
                      {l.variance === null ? "—" : `${l.variance > 0 ? "+" : ""}${l.variance}`}
                    </td>
                    <td className="text-ink-500">{l.reason_note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>
      )}

      {submitted && canApprove && (
        <Section title="Approve">
          {isCounter ? (
            <Notice tone="bad" title="You counted this sheet.">
              Separation of duties means someone else must approve the variance. Try anyway
              — the refusal comes from the database.
              <form action={approveCountSheet} className="mt-3">
                <input type="hidden" name="sheet_id" value={sheet.id} />
                <button type="submit" className="btn">Approve and post</button>
              </form>
            </Notice>
          ) : (
            <Card>
              <form action={approveCountSheet}>
                <input type="hidden" name="sheet_id" value={sheet.id} />
                <button type="submit" className="btn">Approve and post to the ledger</button>
                <span className="meta ml-3">
                  Each variance becomes a ledger entry with your name on it.
                </span>
              </form>
            </Card>
          )}
        </Section>
      )}

      {sheet.status === "POSTED" && (
        <div className="mt-5">
          <Notice tone="info" title="Posted.">
            Counted by {sheet.counted_by_name ?? "—"}, approved by {sheet.approved_by_name ?? "—"}.
            Every variance is now a ledger entry with a reason and an approver, and this
            sheet stays reproducible for as long as the records are kept.
          </Notice>
        </div>
      )}

      <p className="mt-6">
        <Link href="/counts" className="text-sm text-teal-700 hover:underline">← All count sheets</Link>
      </p>
    </>
  );
}
