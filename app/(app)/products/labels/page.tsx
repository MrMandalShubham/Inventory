import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { PageHeader, Card, Empty, Notice } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * Shelf labels.
 *
 * A print stylesheet rather than a PDF generator: the browser already
 * knows how to lay out a page and talk to a printer, and a label that
 * needs a server round-trip is a label somebody prints from a
 * spreadsheet instead.
 *
 * The barcode is rendered as Code 128 in a font-free way — bars drawn
 * as divs — so it needs no asset and survives being printed on
 * whatever is in the shop.
 */

/** Code 128B encoder. Enough for SKU codes and EAN digits. */
function code128(value: string): number[] {
  const START_B = 104, STOP = 106;
  const codes: number[] = [START_B];
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32);
  const sum = codes.reduce((acc, c, i) => acc + c * (i === 0 ? 1 : i), 0);
  codes.push(sum % 103, STOP);
  return codes;
}

const PATTERNS = [
  "11011001100","11001101100","11001100110","10010011000","10010001100","10001001100",
  "10011001000","10011000100","10001100100","11001001000","11001000100","11000100100",
  "10110011100","10011011100","10011001110","10111001100","10011101100","10011100110",
  "11001110010","11001011100","11001001110","11011100100","11001110100","11101101110",
  "11101001100","11100101100","11100100110","11101100100","11100110100","11100110010",
  "11011011000","11011000110","11000110110","10100011000","10001011000","10001000110",
  "10110001000","10001101000","10001100010","11010001000","11000101000","11000100010",
  "10110111000","10110001110","10001101110","10111011000","10111000110","10001110110",
  "11101110110","11010001110","11000101110","11011101000","11011100010","11011101110",
  "11101011000","11101000110","11100010110","11101101000","11101100010","11100011010",
  "11101111010","11001000010","11110001010","10100110000","10100001100","10010110000",
  "10010000110","10000101100","10000100110","10110010000","10110000100","10011010000",
  "10011000010","10000110100","10000110010","11000010010","11001010000","11110111010",
  "11000010100","10001111010","10100111100","10010111100","10010011110","10111100100",
  "10011110100","10011110010","11110100100","11110010100","11110010010","11011011110",
  "11011110110","11110110110","10101111000","10100011110","10001011110","10111101000",
  "10111100010","11110101000","11110100010","10111011110","10111101110","11101011110",
  "11110101110","11010000100","11010010000","11010011100","11000111010",
];

function Barcode({ value }: { value: string }) {
  const bits = code128(value).map((c) => PATTERNS[c] ?? PATTERNS[0]).join("");
  return (
    <div className="flex h-9 items-stretch" aria-hidden>
      {[...bits].map((b, i) => (
        <span key={i} style={{ width: 1.1, background: b === "1" ? "#000" : "transparent" }} />
      ))}
    </div>
  );
}

export default async function Labels({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const me = await currentClaims();

  const rows = await withSession(me, async (c) =>
    (await c.query(
      `select p.sku_code, p.name, u.code as uom,
              (select b.barcode from catalog.product_barcode b
                where b.product_id = p.id and b.is_primary limit 1) as barcode
         from catalog.product p
         join catalog.uom u on u.id = p.base_uom_id
        where p.status = 'ACTIVE'
          and ($1::text is null or p.name ilike '%'||$1||'%' or p.sku_code ilike '%'||$1||'%')
        order by p.sku_code limit 60`, [q ?? null])).rows);

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Shelf labels"
          lede="Printed from the browser — no PDF, no server round trip. What you see is what comes out."
          actions={<Link href="/products" className="btn btn-ghost">Back to products</Link>}
        />

        <Card>
          <form action="/products/labels" method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label className="label" htmlFor="q">Filter</label>
              <input id="q" name="q" defaultValue={q ?? ""} className="field"
                     placeholder="name or code — blank prints the first 60" />
            </div>
            <button type="submit" className="btn btn-ghost">Filter</button>
          </form>
        </Card>

        <div className="mt-4">
          <Notice tone="info" title="Three to a row, on A4.">
            The barcode is Code 128 of the product code, so a scan in the receiving flow
            finds the line whether or not the manufacturer put a barcode on the pack.
          </Notice>
        </div>

        <p className="meta mt-4">
          Press <kbd className="mono rounded border border-ink-200 px-1.5 py-0.5">Ctrl</kbd>
          {" / "}<kbd className="mono rounded border border-ink-200 px-1.5 py-0.5">⌘</kbd>
          {" + "}<kbd className="mono rounded border border-ink-200 px-1.5 py-0.5">P</kbd>{" "}
          to print. Everything above this line is hidden on paper.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="no-print mt-4"><Card><Empty>Nothing matches that filter.</Empty></Card></div>
      ) : (
        <div className="label-sheet mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          {rows.map((p: any) => (
            <div key={p.sku_code} className="label card card-pad">
              <div className="text-[13px] font-semibold leading-tight">{p.name}</div>
              <div className="mono mt-0.5 text-ink-500">{p.sku_code} · per {p.uom}</div>
              <div className="mt-2"><Barcode value={p.sku_code} /></div>
              <div className="mono mt-1 text-center text-[11px] tracking-widest">
                {p.barcode ?? p.sku_code}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
