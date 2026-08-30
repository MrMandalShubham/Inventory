import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_APPROVE } from "@/lib/session";
import { PageHeader, Pill, Dot, Card, Empty, Notice, TableWrap, When } from "../ui";
import { openCountSheet } from "../stock/actions";

export const dynamic = "force-dynamic";

const TONE: Record<string, "plain" | "good" | "warn" | "bad" | "info"> = {
  DRAFT: "plain", COUNTING: "warn", SUBMITTED: "warn",
  APPROVED: "info", POSTED: "good", REJECTED: "bad",
};

export default async function Counts({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => ({
    locations: (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows,
    sheets: (await c.query(`
      select cs.id, cs.code, cs.status, cs.scope_note, cs.opened_at,
             l.code as location_code,
             counter.full_name as counted_by, approver.full_name as approved_by,
             (select count(*)::int from stock.count_line cl where cl.count_sheet_id = cs.id) as lines
        from stock.count_sheet cs
        join platform.location l on l.id = cs.location_id
        left join platform.app_user counter  on counter.id  = cs.counted_by
        left join platform.app_user approver on approver.id = cs.approved_by
       order by cs.opened_at desc limit 50`)).rows,
  }));

  const canOpen = CAN_APPROVE.includes(me.role);

  return (
    <>
      <PageHeader
        title="Stock counts"
        lede="Counting is the only thing that proves the system agrees with the shelf. Every other check proves the system agrees with itself, which is a weaker claim."
      />

      <Notice tone="info" title="Counts are blind.">
        The counter never sees the expected quantity — show it and they write down what the
        system says, and the count measures nothing while looking like diligence. And{" "}
        <b>nobody approves their own count</b>: without that, one account can create a
        shortage and sign off the explanation.
      </Notice>

      {error && <div className="mt-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}

      {canOpen && (
        <Card className="mt-5">
          <form action={openCountSheet} className="flex flex-wrap items-end gap-3">
            <div className="min-w-44">
              <label className="label" htmlFor="location_id">Location</label>
              <select id="location_id" name="location_id" required className="field">
                {d.locations.map((l: any) => (
                  <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-52 flex-1">
              <label className="label" htmlFor="note">What is being counted</label>
              <input id="note" name="note" className="field"
                     placeholder="monthly cycle count — dairy" />
            </div>
            <button type="submit" className="btn">Open count sheet</button>
          </form>
        </Card>
      )}

      <div className="mt-4">
        {d.sheets.length === 0 ? (
          <Card><Empty>No count sheets yet.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Severity</span></th>
                <th>Sheet</th><th>Where</th><th>Scope</th>
                <th className="num">Lines</th><th>Status</th>
                <th>Counted by</th><th>Approved by</th><th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {d.sheets.map((s: any) => (
                <tr key={s.id}>
                  <td>
                    <Dot tone={s.status === "POSTED" ? "good"
                      : s.status === "REJECTED" ? "bad"
                      : ["COUNTING", "SUBMITTED"].includes(s.status) ? "warn" : "plain"} />
                  </td>
                  <td className="mono font-medium">{s.code}</td>
                  <td><Pill>{s.location_code}</Pill></td>
                  <td className="text-ink-700">{s.scope_note ?? "—"}</td>
                  <td className="num tnum">{s.lines}</td>
                  <td><Pill tone={TONE[s.status] ?? "plain"}>{s.status.toLowerCase()}</Pill></td>
                  <td className="text-ink-700">{s.counted_by ?? "—"}</td>
                  <td className="text-ink-700">{s.approved_by ?? "—"}</td>
                  <td>
                    <Link href={`/counts/${s.id}`} className="text-sm text-teal-700 hover:underline">
                      open
                    </Link>
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
