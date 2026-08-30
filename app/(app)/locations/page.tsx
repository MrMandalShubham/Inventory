import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, seesEverything, locationList } from "@/lib/session";
import { PageHeader, Pill, Dot, Notice, TableWrap } from "../ui";

export const dynamic = "force-dynamic";

export default async function Locations() {
  const me = await currentClaims();

  const rows = await withSession(me, async (c) =>
    (await c.query(`
      select l.id, l.code, l.name, l.type, l.status,
             count(b.id)::int as stock_lines,
             coalesce(sum(b.on_hand), 0)::int as units,
             coalesce(sum(b.damaged), 0)::int as damaged
        from platform.location l
        left join stock.balance b on b.location_id = l.id
       group by l.id
       order by case l.type when 'HUB' then 1 when 'WAREHOUSE' then 2
                            when 'STORE' then 3 else 4 end, l.code`)).rows);

  const mine = new Set(locationList(me));
  const global = seesEverything(me);

  return (
    <>
      <PageHeader
        title="Locations"
        lede="Every place stock can sit, each with its own dashboard. The list is readable by anyone signed in — you need to know a shop exists to transfer to it. The stock figures are not."
      />

      <Notice tone={global ? "info" : "warn"}>
        {global ? (
          <>You hold <b>every location</b>, so all figures below are real.</>
        ) : (
          <>
            You hold <b>{mine.size || "no"} location(s)</b>. Rows outside that scope show zero
            — not because this page filtered them, but because the database returned nothing.
          </>
        )}
      </Notice>

      <div className="mt-4">
        <TableWrap>
          <thead>
            <tr>
              <th className="w-8"><span className="sr-only">Severity</span></th>
              <th>Code</th><th>Name</th><th>Type</th>
              <th className="num">Lines</th><th className="num">Units</th>
              <th className="num">Unsellable</th><th>Scope</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l: any) => {
              const visible = global || mine.has(l.id);
              return (
                <tr key={l.code} className={visible ? "" : "opacity-60"}>
                  <td><Dot tone={visible ? (l.damaged ? "warn" : "good") : "plain"} /></td>
                  <td className="mono font-medium">
                    <Link href={`/locations/${l.code}`} className="link">{l.code}</Link>
                  </td>
                  <td>
                    <Link href={`/locations/${l.code}`} className="link">{l.name}</Link>
                  </td>
                  <td><Pill>{l.type.toLowerCase()}</Pill></td>
                  <td className="num tnum">{l.stock_lines}</td>
                  <td className="num tnum">{l.units.toLocaleString("en-IN")}</td>
                  <td className={`num tnum ${l.damaged ? "text-amber-600" : "text-ink-400"}`}>
                    {l.damaged || "—"}
                  </td>
                  <td>
                    {visible
                      ? <Pill tone="good">in scope</Pill>
                      : <Pill>out of scope</Pill>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </div>

      <p className="meta mt-3">
        <b>TRANSIT</b> is a virtual location holding goods that have left one place and not
        arrived at another. They are sellable from neither end — which is invariant 4, made
        physical rather than kept in a flag.
      </p>
    </>
  );
}
