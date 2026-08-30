import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN } from "@/lib/session";
import {
  PageHeader, Tile, Pill, Card, Section, Empty, Notice, TableWrap, When,
} from "../../ui";
import { ImageUpload } from "./image-upload";
import { makePrimary, deleteImage, moveImage } from "./actions";

export const dynamic = "force-dynamic";

/**
 * One product, everywhere it exists.
 *
 * This is also where photographs are managed, because a photograph is
 * a property of the PRODUCT and not of any one shop's stock of it —
 * the catalogue is global (docs/09), so a picture uploaded once is the
 * picture every location and every consuming app sees.
 */
export default async function ProductDetail({
  params, searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { sku } = await params;
  const { ok, error } = await searchParams;
  const me = await currentClaims();
  const canEdit = CAN_PLAN.includes(me.role);

  const d = await withSession(me, async (c) => {
    const product = (await c.query(
      `select p.*, u.code as uom, u.name as uom_name
         from catalog.product p
         join catalog.uom u on u.id = p.base_uom_id
        where p.sku_code = $1`, [sku])).rows[0];
    if (!product) return null;

    const images = (await c.query(
      `select id, storage_key, thumb_key, alt_text, width, height, byte_size,
              is_primary, position, created_at
         from catalog.product_image
        where product_id = $1
        order by position, created_at`, [product.id])).rows;

    const barcodes = (await c.query(
      "select barcode from catalog.product_barcode where product_id = $1", [product.id]))
      .rows.map((r: any) => r.barcode);

    // Where it is, across every location the reader may see. The
    // catalogue is global; the stock is not.
    const stock = (await c.query(
      `select l.code, l.name, b.on_hand, b.reserved, b.damaged,
              b.on_hand - b.reserved - b.allocated - b.damaged as available
         from stock.balance b
         join platform.location l on l.id = b.location_id
        where b.product_id = $1 and l.type <> 'VIRTUAL'
        order by l.code`, [product.id])).rows;

    return { product, images, barcodes, stock };
  });

  if (!d) notFound();
  const { product, images, barcodes, stock } = d;

  const totalUnits = stock.reduce((a: number, s: any) => a + Number(s.on_hand), 0);
  const missingAlt = images.filter((i: any) => !i.alt_text).length;

  return (
    <>
      <PageHeader
        eyebrow={product.sku_code}
        title={product.name}
        lede={product.description ?? undefined}
        actions={
          <Link href="/products" className="btn btn-ghost text-[13px] py-1.5">
            All products
          </Link>
        }
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}
      {ok && <div className="mb-4"><Notice tone="info">{ok}</Notice></div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile n={totalUnits.toLocaleString("en-IN")} label={`Units, all locations (${product.uom.toLowerCase()})`} />
        <Tile n={stock.length} label="Locations stocking it" />
        <Tile n={images.length} label="Photographs" tone={images.length ? "good" : "warn"} />
        <Tile n={<Pill>{product.tracking_mode.toLowerCase()}</Pill>} label="Tracking" />
      </div>

      {/* ─────────────── photographs ─────────────── */}

      <Section title="Photographs">
        {images.length === 0 ? (
          <Card pad>
            <Empty>
              No photograph yet. Until there is one, this product shows as a blank tile
              in any customer-facing app reading the catalogue through the API.
            </Empty>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {images.map((img: any, i: number) => (
                <Card key={img.id}>
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/images/${img.thumb_key ?? img.storage_key}`}
                      alt={img.alt_text ?? ""}
                      width={img.width ?? undefined}
                      height={img.height ?? undefined}
                      className="aspect-square w-full rounded-t-[5px] bg-ink-50 object-contain"
                      loading="lazy"
                    />
                    {img.is_primary && (
                      <span className="absolute left-2 top-2">
                        <Pill tone="good">primary</Pill>
                      </span>
                    )}
                  </div>

                  <div className="card-pad">
                    <div className="meta">
                      {img.width && img.height
                        ? <>{img.width}×{img.height}</>
                        : "dimensions unknown"}
                      {" · "}{(Number(img.byte_size) / 1024).toFixed(0)}KB
                      {" · "}<When at={img.created_at} relative />
                    </div>

                    {img.alt_text ? (
                      <p className="mt-1 text-sm">{img.alt_text}</p>
                    ) : (
                      <p className="mt-1 text-sm text-amber-600">
                        No description — a screen reader has nothing to read here.
                      </p>
                    )}

                    {canEdit && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {!img.is_primary && (
                          <form action={makePrimary}>
                            <input type="hidden" name="sku" value={sku} />
                            <input type="hidden" name="id" value={img.id} />
                            <button className="btn btn-ghost text-[13px] py-1">Make primary</button>
                          </form>
                        )}
                        {i > 0 && (
                          <form action={moveImage}>
                            <input type="hidden" name="sku" value={sku} />
                            <input type="hidden" name="product_id" value={product.id} />
                            <input type="hidden" name="id" value={img.id} />
                            <input type="hidden" name="dir" value="up" />
                            <button className="btn btn-ghost text-[13px] py-1" aria-label="Move earlier">←</button>
                          </form>
                        )}
                        {i < images.length - 1 && (
                          <form action={moveImage}>
                            <input type="hidden" name="sku" value={sku} />
                            <input type="hidden" name="product_id" value={product.id} />
                            <input type="hidden" name="id" value={img.id} />
                            <input type="hidden" name="dir" value="down" />
                            <button className="btn btn-ghost text-[13px] py-1" aria-label="Move later">→</button>
                          </form>
                        )}
                        <form action={deleteImage}>
                          <input type="hidden" name="sku" value={sku} />
                          <input type="hidden" name="id" value={img.id} />
                          <button className="btn btn-ghost text-[13px] py-1 text-rose-600">
                            Remove
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {missingAlt > 0 && (
              <Notice tone="warn" title="Descriptions missing.">
                {missingAlt} photograph{missingAlt === 1 ? " has" : "s have"} no
                description. That text is what a screen reader announces and what the
                customer app shows when an image will not load.
              </Notice>
            )}
          </>
        )}

        {canEdit && (
          <div className="mt-4">
            <h3 className="h-sect mb-2">Add a photograph</h3>
            <ImageUpload sku={sku} />
          </div>
        )}

        <p className="meta mt-3">
          The first photograph becomes the primary one automatically — a product with
          pictures and no primary would render blank. Images are served from{" "}
          <span className="mono">/images/&lt;hash&gt;</span>, cached permanently, and
          shared between products when the file is identical.
        </p>
      </Section>

      {/* ─────────────── where it is ─────────────── */}

      <Section title="Where it is">
        <TableWrap>
          <thead>
            <tr>
              <th>Location</th>
              <th className="num">On hand</th>
              <th className="num">Reserved</th>
              <th className="num">Available</th>
              <th className="num">Unsellable</th>
            </tr>
          </thead>
          <tbody>
            {stock.map((s: any) => (
              <tr key={s.code}>
                <td>
                  <Link href={`/locations/${s.code}`} className="link font-medium">{s.code}</Link>
                  <span className="meta ml-2">{s.name}</span>
                </td>
                <td className="num tnum">{Number(s.on_hand).toLocaleString("en-IN")}</td>
                <td className="num tnum">{Number(s.reserved).toLocaleString("en-IN")}</td>
                <td className="num tnum">{Number(s.available).toLocaleString("en-IN")}</td>
                <td className={`num tnum ${Number(s.damaged) ? "text-amber-600" : "text-ink-400"}`}>
                  {Number(s.damaged) || "—"}
                </td>
              </tr>
            ))}
            {stock.length === 0 && (
              <tr><td colSpan={5}>
                <Empty what="stock for this product">
                  Not stocked at any location you can see.
                </Empty>
              </td></tr>
            )}
          </tbody>
        </TableWrap>
      </Section>

      {/* ─────────────── the record ─────────────── */}

      <Section title="Catalogue record">
        <Card pad>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {[
              ["Code", <span className="mono">{product.sku_code}</span>],
              ["Category", product.category ?? "—"],
              ["Unit", `${product.uom_name} (${product.uom})`],
              ["Sold by weight", product.is_weighed ? "yes" : "no"],
              ["HSN code", product.hsn_code ?? "—"],
              ["Shelf life", product.shelf_life_days ? `${product.shelf_life_days} days` : "—"],
              ["Status", <Pill tone={product.status === "ACTIVE" ? "good" : "warn"}>
                {product.status.toLowerCase()}</Pill>],
              ["Barcodes", barcodes.length
                ? <span className="mono">{barcodes.join(", ")}</span>
                : "none"],
            ].map(([k, v], i) => (
              <div key={i} className="flex gap-3">
                <dt className="meta w-32 shrink-0">{k}</dt>
                <dd className="text-sm">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </Section>

      <p className="mt-6">
        <Link href={`/stock/${sku}`} className="text-sm text-teal-700 hover:underline">
          Movement history →
        </Link>
      </p>
    </>
  );
}
