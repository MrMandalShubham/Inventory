import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { PageHeader, Pill, Card, Empty, Notice, TableWrap } from "../ui";

export const dynamic = "force-dynamic";

export default async function Partners() {
  const me = await currentClaims();

  const rows = await withSession(me, async (c) =>
    (await c.query(
      `select code, name, kinds, gstin, phone, credit_days, lead_time_days, status
         from partner.partner order by code`)).rows);

  return (
    <>
      <PageHeader
        title="Partners"
        lede="Suppliers, customers and carriers in one table, because the same business is often two of them — you buy rice from a wholesaler and sell them cleaning supplies. Two tables would mean two records for one company, and two versions of their address."
      />

      <Notice tone="info" title="Lead time here is an assumption, not a fact.">
        From Phase 6 it is replaced by the median of the last six actual receipts — median,
        so one supplier disaster does not permanently inflate a three-day lead time, but
        three of them do.
      </Notice>

      <div className="mt-4">
        {rows.length === 0 ? (
          <Card><Empty>No partners yet.</Empty></Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Kinds</th><th>GSTIN</th>
                <th className="num">Credit</th><th className="num">Lead time</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: any) => (
                <tr key={p.code}>
                  <td className="mono">{p.code}</td>
                  <td>
                    <div className="font-medium">{p.name}</div>
                    {p.phone && <div className="meta">{p.phone}</div>}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {p.kinds.map((k: string) => (
                        <Pill key={k} tone="info">{k.toLowerCase()}</Pill>
                      ))}
                    </div>
                  </td>
                  <td className="mono text-ink-500">
                    {p.gstin ?? <span className="text-ink-400">none</span>}
                  </td>
                  <td className="num tnum">{p.credit_days ?? "—"}</td>
                  <td className="num tnum">
                    {p.lead_time_days != null ? `${p.lead_time_days}d` : "—"}
                  </td>
                  <td>
                    <Pill tone={p.status === "ACTIVE" ? "good" : "plain"}>
                      {p.status.toLowerCase().replace("_", " ")}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      <p className="meta mt-3">
        A mandi trader has no GSTIN, and requiring one would mean the purchase never gets
        recorded at all — so it is nullable by design.
      </p>
    </>
  );
}
