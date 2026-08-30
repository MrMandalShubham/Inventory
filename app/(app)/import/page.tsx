import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN } from "@/lib/session";
import { parseCsv } from "@/lib/csv";
import { PageHeader, Pill, Card, Notice, TableWrap, Section } from "../ui";

export const dynamic = "force-dynamic";

const SAMPLE = `name,category,base_uom,tracking_mode,shelf_life_days,hsn_code,barcode
Toor Dal 1kg,Staples,G,NONE,,0713,8901234500011
Basmati Rice 5kg,Staples,G,NONE,,1006,8901234500028
Full Cream Milk 500ml,Dairy,ML,BATCH,5,0401,8901234500035
Face Wash 100ml,Beauty,ML,BATCH,540,3304,8901234500042
Tomatoes,Fruit & Veg,G,BATCH,4,0702,
,Staples,G,NONE,,,
Mystery Item,Other,WIDGETS,NONE,,,
Curd 400g,Dairy,G,NONE,7,0403,`;

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ csv?: string }>;
}) {
  const { csv } = await searchParams;
  const me = await currentClaims();
  const canImport = CAN_PLAN.includes(me.role);

  let report: any[] | null = null;
  let fatal: string | null = null;

  if (csv && csv.trim()) {
    const rows = parseCsv(csv);
    if (rows.length === 0) {
      fatal = "No data rows found. The first line must be a header.";
    } else {
      try {
        report = await withSession(me, async (c) =>
          (await c.query("select * from catalog.import_products($1::jsonb)",
            [JSON.stringify(rows)])).rows);
      } catch (e) {
        fatal = e instanceof Error ? e.message : String(e);
      }
    }
  }

  const ok = report?.filter((r) => r.status !== "FAILED").length ?? 0;
  const bad = report?.filter((r) => r.status === "FAILED").length ?? 0;

  return (
    <>
      <PageHeader
        title="Import products"
        lede={
          <>
            Paste a CSV. The first row is the header, and the columns match the product
            fields: <span className="mono">name, category, base_uom, tracking_mode,
            shelf_life_days, hsn_code, tax_rate, barcode, sku_code</span>. Include{" "}
            <span className="mono">sku_code</span> to update rather than create.
          </>
        }
      />

      <Notice tone="info" title="One bad row never aborts the import.">
        Each row runs in its own sub-block, so the good rows land and the bad ones come back
        with a line number and a reason. A 5,000-row file always has bad rows — all-or-nothing
        would mean fixing one, re-running, and finding the next, five thousand times.
      </Notice>

      {!canImport && (
        <div className="mt-4">
          <Notice tone="bad" title={`${me.full_name} cannot import.`}>
            Only a planner or admin may. Try it anyway — the refusal comes from the database,
            not from this page.
          </Notice>
        </div>
      )}

      <Card className="mt-4">
        <form action="/import" method="get">
          <label className="label" htmlFor="csv">CSV</label>
          <textarea id="csv" name="csv" defaultValue={csv ?? SAMPLE} spellCheck={false}
                    rows={12}
                    className="field mono w-full resize-y" />
          <div className="mt-3 flex items-center gap-3">
            <button type="submit" className="btn">Import</button>
            <span className="meta">The sample above contains three deliberately broken rows.</span>
          </div>
        </form>
      </Card>

      {fatal && <div className="mt-4"><Notice tone="bad" title="Import refused:">{fatal}</Notice></div>}

      {report && (
        <Section title={`Result — ${ok} landed, ${bad} failed`}>
          <TableWrap>
            <thead>
              <tr><th className="num w-16">Row</th><th>Status</th><th>Code</th><th>Message</th></tr>
            </thead>
            <tbody>
              {report.map((r) => (
                <tr key={r.row_number}>
                  <td className="num tnum">{r.row_number}</td>
                  <td>
                    <Pill tone={r.status === "CREATED" ? "good" : r.status === "UPDATED" ? "info" : "bad"}>
                      {r.status.toLowerCase()}
                    </Pill>
                  </td>
                  <td className="mono">{r.sku_code ?? "—"}</td>
                  <td className={r.status === "FAILED" ? "text-rose-700" : "text-ink-500"}>
                    {r.message ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Section>
      )}
    </>
  );
}
