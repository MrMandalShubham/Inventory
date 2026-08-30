import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN } from "@/lib/session";
import { PageHeader, Pill, Card, Empty, TableWrap } from "../ui";

export const dynamic = "force-dynamic";

export default async function Products({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const me = await currentClaims();
  const term = (q ?? "").trim();

  const d = await withSession(me, async (c) => {
    const t0 = performance.now();
    const rows = term
      ? (await c.query(
          `select s.sku_code, s.name, s.category, s.match_kind, s.score,
                  p.tracking_mode, p.is_weighed, u.code as uom,
                  i.thumb_key, i.storage_key, i.alt_text
             from catalog.search_products($1, 60) s
             join catalog.product p on p.id = s.id
             join catalog.uom u on u.id = p.base_uom_id
             left join catalog.product_image i
                    on i.product_id = p.id and i.is_primary`, [term])).rows
      : (await c.query(
          `select p.sku_code, p.name, p.category, null::text as match_kind, null::real as score,
                  p.tracking_mode, p.is_weighed, u.code as uom,
                  i.thumb_key, i.storage_key, i.alt_text
             from catalog.product p
             join catalog.uom u on u.id = p.base_uom_id
             left join catalog.product_image i
                    on i.product_id = p.id and i.is_primary
            where p.status = 'ACTIVE' order by p.sku_code limit 60`)).rows;
    const ms = performance.now() - t0;
    const total = (await c.query(
      "select count(*)::int as n from catalog.product where status='ACTIVE'")).rows[0].n;
    return { rows, ms, total };
  });

  return (
    <>
      <PageHeader
        title="Products"
        lede={
          <>
            The catalogue is global. A product code means the same thing at every location —
            which is what makes &ldquo;how much of this across all shops&rdquo; answerable at
            all. No location filter appears on this page.
          </>
        }
        actions={CAN_PLAN.includes(me.role) ? (
          <>
            <Link href="/products/labels" className="btn btn-ghost">Print labels</Link>
            <Link href="/products/new" className="btn">Add product</Link>
          </>
        ) : undefined}
      />

      <Card>
        <form action="/products" method="get" className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label className="label" htmlFor="q">Search by name, code or barcode</label>
            <input id="q" name="q" defaultValue={term} className="field"
                   placeholder="toor · PRD-2026-000001 · 8901234500011" />
          </div>
          <button type="submit" className="btn">Search</button>
          {term && <Link href="/products" className="btn btn-ghost">Clear</Link>}
        </form>
      </Card>

      <div className="mt-4">
        {d.rows.length === 0 ? (
          <Card>
            <Empty>
              {term ? <>Nothing matched &ldquo;{term}&rdquo;.</> : "No products yet."}
            </Empty>
          </Card>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>Code</th><th>Product</th><th>Category</th>
                <th>Unit</th><th>Tracking</th>{term && <th>Match</th>}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((p: any) => (
                <tr key={p.sku_code}>
                  <td className="mono">
                    <Link href={`/products/${p.sku_code}`} className="text-teal-700 hover:underline">
                      {p.sku_code}
                    </Link>
                  </td>
                  <td>
                    <div className="flex items-center gap-2.5">
                      {/* A catalogue without pictures is a spreadsheet. The
                          gap where one is missing should be visible, so an
                          absent photo gets a placeholder rather than
                          collapsing the row. */}
                      {p.storage_key ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/images/${p.thumb_key ?? p.storage_key}`}
                          alt={p.alt_text ?? ""}
                          className="size-9 shrink-0 rounded bg-ink-50 object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <span
                          aria-hidden
                          title="no photograph"
                          className="grid size-9 shrink-0 place-items-center rounded border
                                     border-dashed border-ink-200 text-[10px] text-ink-400"
                        >
                          —
                        </span>
                      )}
                      <Link href={`/products/${p.sku_code}`} className="font-medium link">
                        {p.name}
                      </Link>
                      {p.is_weighed && <Pill tone="warn"><span className="ml-0">by weight</span></Pill>}
                    </div>
                  </td>
                  <td className="text-ink-700">{p.category ?? "—"}</td>
                  <td className="mono">{p.uom}</td>
                  <td>
                    <Pill tone={p.tracking_mode === "NONE" ? "plain" : "info"}>
                      {p.tracking_mode.toLowerCase()}
                    </Pill>
                  </td>
                  {term && (
                    <td>
                      <Pill tone={p.match_kind === "EXACT" ? "good" : "plain"}>
                        {p.match_kind === "EXACT" ? "exact" : `name ${(p.score ?? 0).toFixed(2)}`}
                      </Pill>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <p className="meta mt-2">
          {d.rows.length} of {d.total.toLocaleString("en-IN")} · {Math.round(d.ms)}ms
          {term && " · an exact match on code or barcode ranks above a fuzzy name match, because that is what a scan produces"}
        </p>
      </div>
    </>
  );
}
