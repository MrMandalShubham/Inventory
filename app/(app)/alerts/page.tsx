import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { PageHeader, Tile, Pill, Dot, Card, Empty, Notice, Section, When } from "../ui";
import { acknowledgeAlert } from "../planning/actions";

export const dynamic = "force-dynamic";

const GROUPS = [
  { key: "ACT_NOW",       label: "Act now",       tone: "bad"  as const,
    blurb: "Today. Somebody is already unable to sell something, or is about to be." },
  { key: "THIS_WEEK",     label: "Plan this week", tone: "warn" as const,
    blurb: "Not yet a problem. It becomes one if nobody looks." },
  { key: "WORTH_KNOWING", label: "Worth knowing",  tone: "plain" as const,
    blurb: "Cash sitting still, or stock in the wrong place. No deadline." },
];

export default async function Alerts({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; show?: string }>;
}) {
  const { error, show } = await searchParams;
  const me = await currentClaims();

  const d = await withSession(me, async (c) => {
    const alerts = (await c.query(`
      select a.id, a.rule_code, a.severity, a.title, a.detail, a.state,
             a.raised_at, a.acknowledged_at,
             r.description,
             p.sku_code, l.code as location_code,
             ack.full_name as acknowledged_by_name
        from alerting.alert a
        join alerting.rule r on r.code = a.rule_code
        left join catalog.product p on p.id = a.product_id
        left join platform.location l on l.id = a.location_id
        left join platform.app_user ack on ack.id = a.acknowledged_by
       where a.state <> 'RESOLVED'
       order by case a.severity when 'ACT_NOW' then 1 when 'THIS_WEEK' then 2 else 3 end,
                a.raised_at
       limit 300`)).rows;

    const cleared = (await c.query(`
      select count(*)::int as n from alerting.alert
       where state = 'RESOLVED' and resolved_at > now() - interval '7 days'`)).rows[0].n;

    return { alerts, cleared };
  });

  const byGroup = (k: string) => d.alerts.filter((a: any) => a.severity === k);
  const visible = show ? GROUPS.filter((g) => g.key === show) : GROUPS;

  return (
    <>
      <PageHeader
        title="Alerts"
        lede="What the system noticed so nobody has to remember to check. Grouped by how soon it matters, not by which rule produced it."
      />

      {error && <div className="mb-4"><Notice tone="bad" title="Refused:">{error}</Notice></div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {GROUPS.map((g) => (
          <Tile key={g.key} n={byGroup(g.key).length} label={g.label}
                tone={byGroup(g.key).length ? g.tone : "good"}
                href={`/alerts?show=${g.key}`} />
        ))}
        <Tile n={d.cleared} label="Cleared this week" tone="good" />
      </div>

      <div className="mt-4">
        <Notice tone="info" title="Alerts close themselves.">
          When the condition clears — the shelf is refilled, the ticket is explained — the
          alert resolves with the time it cleared recorded. A list that only ever grows is a
          list nobody reads, and an ignored alert list is worse than none: it looks like
          coverage while providing none. <b>{d.cleared}</b> closed themselves this week.
        </Notice>
      </div>

      {show && (
        <p className="mt-3">
          <Link href="/alerts" className="text-sm text-teal-700 hover:underline">
            ← All severities
          </Link>
        </p>
      )}

      {visible.map((g) => {
        const rows = byGroup(g.key);
        return (
          <Section key={g.key} title={`${g.label} (${rows.length})`}>
            <p className="lede -mt-2 mb-3">{g.blurb}</p>

            {rows.length === 0 ? (
              <Card><Empty>Nothing in this group.</Empty></Card>
            ) : (
              <div className="grid gap-2">
                {rows.map((a: any) => (
                  <Card key={a.id} className="flex flex-wrap items-start gap-3">
                    <span className="mt-1"><Dot tone={g.tone === "plain" ? "plain" : g.tone} /></span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{a.title}</span>
                        {a.state === "ACKNOWLEDGED" && (
                          <Pill tone="info">
                            being handled{a.acknowledged_by_name ? ` — ${a.acknowledged_by_name}` : ""}
                          </Pill>
                        )}
                      </div>
                      <p className="meta mt-0.5">{a.description}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-ink-400">
                        <span>raised <When at={a.raised_at} relative /></span>
                        {Object.entries(a.detail ?? {}).map(([k, v]) => (
                          <span key={k} className="mono">
                            {k.replace(/_/g, " ")}: {String(v)}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {a.sku_code && a.location_code && (
                        <Link href={`/stock/${a.sku_code}?loc=${a.location_code}`}
                              className="text-sm text-teal-700 hover:underline">
                          Why? →
                        </Link>
                      )}
                      {a.state === "OPEN" && (
                        <form action={acknowledgeAlert}>
                          <input type="hidden" name="id" value={a.id} />
                          <button type="submit" className="btn btn-ghost px-2.5 py-1 text-xs">
                            I&rsquo;m on it
                          </button>
                        </form>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>
        );
      })}

      <p className="meta mt-6">
        &ldquo;I&rsquo;m on it&rdquo; acknowledges an alert — it says somebody is dealing
        with it. Only the condition actually clearing resolves one, which is why you cannot
        dismiss an out-of-stock alert without putting stock on the shelf.
      </p>
    </>
  );
}
