import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { PageHeader, Card, Notice, TableWrap, Section, Pill } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * Show your working.
 *
 * docs/03 §4: a suggestion that was CAPPED by a constraint should say
 * so, because the planner needs to know the shortfall exists. And a
 * derivation is not decoration — it is the difference between a
 * number a planner acts on and one they override.
 */
export default async function ShowWorking({
  params, searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ loc?: string }>;
}) {
  const { sku } = await params;
  const { loc } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const row = (await c.query(
      `select p.id as product_id, p.name, p.sku_code, u.code as uom,
              l.id as location_id, l.code as location_code, l.name as location_name
         from catalog.product p
         join catalog.uom u on u.id = p.base_uom_id
         cross join platform.location l
        where p.sku_code = $1 and l.code = $2`,
      [decodeURIComponent(sku), loc ?? ""])).rows[0];
    if (!row) return null;

    let steps: any[] = [];
    let err: string | null = null;
    try {
      steps = (await c.query("select * from insight.explain_reorder($1,$2)",
        [row.product_id, row.location_id])).rows;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    const metric = (await c.query(
      `select * from insight.product_metric where product_id=$1 and location_id=$2`,
      [row.product_id, row.location_id])).rows[0];

    const daily = (await c.query(
      `select day, units, was_open from insight.demand_daily($1,$2,
              (now() - interval '28 days')::date, (now() - interval '1 day')::date)`,
      [row.product_id, row.location_id])).rows;

    return { row, steps, err, metric, daily };
  });

  if (!d) notFound();
  const { row, steps, err, metric, daily } = d;

  const peak = Math.max(1, ...daily.map((x: any) => x.units));

  return (
    <>
      <PageHeader
        eyebrow={`${row.sku_code} · ${row.location_code}`}
        title={row.name}
        lede={`How the reorder point for ${row.location_name} was worked out — every step, in order.`}
        actions={
          <Link href={`/stock/${row.sku_code}?loc=${row.location_code}`} className="btn btn-ghost">
            Ledger
          </Link>
        }
      />

      {err ? (
        <Notice tone="warn" title="Nothing calculated yet.">{err}</Notice>
      ) : (
        <>
          <Section title="The arithmetic">
            <TableWrap>
              <thead>
                <tr><th className="w-48">Step</th><th className="num w-28">Value</th><th>Where it comes from</th></tr>
              </thead>
              <tbody>
                {steps.map((s: any, i: number) => {
                  const headline = s.step === s.step.toUpperCase();
                  return (
                    <tr key={i} className={headline ? "bg-teal-50/60" : ""}>
                      <td className={headline ? "font-bold" : "font-medium"}>{s.step}</td>
                      <td className={`num tnum ${headline ? "text-lg font-bold" : ""}`}>{s.value}</td>
                      <td className="mono text-ink-500">{s.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
            <Notice tone="info">
              Two ceilings, applied in that order, deliberately — so a planner with a
              calculator gets the same answer. Change the order and every historic
              suggestion becomes unexplainable.
            </Notice>
          </Section>

          {metric && (
            <Section title="Demand across the window">
              <Card>
                <div className="flex h-28 items-end gap-[3px]" role="img"
                     aria-label={`Daily demand over ${daily.length} days, peaking at ${peak} units`}>
                  {daily.map((x: any, i: number) => (
                    <div key={i} className="flex-1"
                         title={`${new Date(x.day).toLocaleDateString("en-GB")}: ${x.units}${x.was_open ? "" : " (closed)"}`}>
                      <div
                        className={x.was_open ? "bg-teal-500" : "bg-ink-200"}
                        style={{ height: `${Math.max((x.units / peak) * 100, x.units > 0 ? 4 : 1)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-400">
                  <span>peak {peak}</span>
                  <span>{metric.open_days} open days</span>
                  <span>closed days shown grey — excluded from the divisor</span>
                </div>
              </Card>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Card>
                  <div className="eyebrow">Classification</div>
                  <div className="mt-1 flex gap-2">
                    <Pill tone={metric.abc === "A" ? "bad" : metric.abc === "B" ? "warn" : "plain"}>
                      {metric.abc ?? "—"} by volume
                    </Pill>
                    <Pill tone={metric.xyz === "X" ? "good" : metric.xyz === "Y" ? "warn" : "bad"}>
                      {metric.xyz ?? "—"} by steadiness
                    </Pill>
                  </div>
                  <p className="meta mt-2">
                    A-lines are the 20% that move most here. Z-lines are erratic and need
                    more buffer for the same average.
                  </p>
                </Card>
                <Card>
                  <div className="eyebrow">Days of cover</div>
                  <div className="tile-n mt-1">{metric.days_of_cover ?? "—"}</div>
                  <p className="meta mt-1">
                    At the current rate. Lead time is {metric.lead_time_days} days.
                  </p>
                </Card>
                <Card>
                  <div className="eyebrow">Last movement</div>
                  <div className="tile-n mt-1">
                    {metric.days_since_movement ?? "—"}
                    <span className="ml-1.5 text-base font-normal text-ink-400">
                      day{metric.days_since_movement === 1 ? "" : "s"} ago
                    </span>
                  </div>
                  <p className="meta mt-1">
                    Nothing for 60 days and the cash is trapped.
                  </p>
                </Card>
              </div>
            </Section>
          )}
        </>
      )}

      <p className="mt-6">
        <Link href="/planning" className="text-sm text-teal-700 hover:underline">
          ← Back to replenishment
        </Link>
      </p>
    </>
  );
}
