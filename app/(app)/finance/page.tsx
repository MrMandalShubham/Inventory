import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, CAN_SEE_MONEY } from "@/lib/session";
import { PageHeader, Tile, Pill, Card, Section, Empty, Notice, TableWrap, Money, When } from "../ui";

export const dynamic = "force-dynamic";

/**
 * The money screen.
 *
 * Everything here is READ OUT OF THE BOOKS. Not one figure on this
 * page is recalculated from a price list — the valuation comes from
 * the weighted average carried on the balance, the margins come from
 * the same balanced journal entries the trial balance is made of.
 *
 * That is the whole design. A margin report that does its own
 * arithmetic will eventually disagree with the accounts, and when it
 * does, nobody in the business can say which one is lying.
 *
 * The tie check at the top is deliberately the first thing you see.
 * If the shelves and the books ever drift apart, that is not a detail
 * to find on page three.
 */
export default async function Finance() {
  const me = await currentClaims();
  const canSeeBooks = CAN_SEE_MONEY.includes(me.role);

  const d = await withSession(me, async (c) => {
    const valuation = (await c.query("select * from stock.valuation()")).rows;

    const trial = (await c.query(
      "select * from ledger.trial_balance()")).rows;

    const unbalanced = (await c.query(
      "select * from ledger.verify_balanced()")).rows;

    // Margin on everything dispatched recently. One row per order,
    // straight from the entries.
    const margins = (await c.query(
      `select m.id, m.ticket_no, m.dispatched_at, p.name as customer,
              om.revenue_paise, om.cogs_paise, om.margin_paise, om.margin_pct
         from movement.movement m
         left join partner.partner p on p.id = m.partner_id
         -- LEFT, so an order that posted nothing still appears with
         -- blanks rather than vanishing from the list entirely.
         left join lateral movement.order_margin(m.id) om on true
        where m.type = 'EXPORT' and m.dispatched_at is not null
        order by m.dispatched_at desc
        limit 25`)).rows;

    const payables = (await c.query(
      `select p.name, p.id,
              (sum(e.credit_paise) - sum(e.debit_paise))::bigint as owed_paise
         from ledger.entry e
         join partner.partner p on p.id = e.partner_id
        where e.account_code = 'SUPPLIER_PAYABLE'
        group by p.id, p.name
       having sum(e.credit_paise) - sum(e.debit_paise) <> 0
        order by 3 desc`)).rows;

    const receivables = (await c.query(
      `select p.name, p.id,
              (sum(e.debit_paise) - sum(e.credit_paise))::bigint as due_paise
         from ledger.entry e
         join partner.partner p on p.id = e.partner_id
        where e.account_code = 'CUSTOMER_RECEIVABLE'
        group by p.id, p.name
       having sum(e.debit_paise) - sum(e.credit_paise) <> 0
        order by 3 desc`)).rows;

    // Where value is leaking. Wastage and count variance are the two
    // accounts a shopkeeper should look at every week.
    const leakage = (await c.query(
      `select e.account_code, l.code as location_code,
              (sum(e.debit_paise) - sum(e.credit_paise))::bigint as amount_paise
         from ledger.entry e
         left join platform.location l on l.id = e.location_id
        where e.account_code in ('WASTAGE','STOCK_ADJUSTMENT')
        group by e.account_code, l.code
       having sum(e.debit_paise) - sum(e.credit_paise) <> 0
        order by 3 desc`)).rows;

    return { valuation, trial, unbalanced, margins, payables, receivables, leakage };
  });

  const shelfValue = d.valuation.reduce((a, v: any) => a + Number(v.value_paise), 0);
  const bookValue = Number(
    d.trial.find((t: any) => t.account_code === "INVENTORY")?.balance_paise ?? 0);
  const ties = shelfValue === bookValue;

  const revenue = d.margins.reduce((a, m: any) => a + Number(m.revenue_paise), 0);
  const cogs = d.margins.reduce((a, m: any) => a + Number(m.cogs_paise), 0);
  const owed = d.payables.reduce((a, p: any) => a + Number(p.owed_paise), 0);

  return (
    <>
      <PageHeader
        eyebrow="Cost and value"
        title="Finance"
        lede={
          <>
            What the stock is worth and what the orders earned — read out of the
            accounts, not recalculated from a price list.
          </>
        }
      />

      {!canSeeBooks && (
        <Notice tone="warn" title="Partial view.">
          Cost and margin are restricted to finance and admin. Some figures below
          will be blank for your role — that is the policy working, not a fault.
        </Notice>
      )}

      {d.unbalanced.length > 0 && (
        <Notice tone="bad" title="The books do not balance.">
          {d.unbalanced.length} journal{d.unbalanced.length === 1 ? "" : "s"} where
          debits and credits differ. This should be impossible — the balance check is
          a database constraint. Treat every figure on this page as unreliable until
          it is explained.
        </Notice>
      )}

      {d.trial.length > 0 && !ties && (
        <Notice tone="bad" title="Stock and books have drifted apart.">
          The shelves are worth <Money paise={shelfValue} /> and the inventory
          account says <Money paise={bookValue} />. Nothing is meant to change one
          without the other.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile n={<Money paise={shelfValue} />} label="Stock on hand, at landed cost" />
        <Tile n={<Money paise={revenue} />} label="Revenue, recent orders" />
        <Tile
          n={<Money paise={revenue - cogs} />}
          label={revenue > 0
            ? `Gross margin — ${((revenue - cogs) * 100 / revenue).toFixed(1)}%`
            : "Gross margin"}
          tone={revenue > 0 && revenue - cogs > 0 ? "good" : "plain"}
        />
        <Tile n={<Money paise={owed} />} label="Owed to suppliers" href="#payables" />
      </div>

      {d.trial.length > 0 && ties && (
        <p className="meta mt-3">
          ✓ The inventory account and the sum of the shelves agree exactly, at{" "}
          <Money paise={bookValue} />.
        </p>
      )}

      {/* ─────────────── valuation ─────────────── */}

      <Section title="What each location is holding">
        <TableWrap>
          <thead>
            <tr>
              <th>Location</th>
              <th className="num">Lines</th>
              <th className="num">Units</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {d.valuation.map((v: any) => (
              <tr key={v.location_id}>
                <td className="font-medium">{v.location_code}</td>
                <td className="num">{v.lines}</td>
                <td className="num tnum">{Number(v.units).toLocaleString("en-IN")}</td>
                <td className="num"><Money paise={v.value_paise} /></td>
              </tr>
            ))}
            {d.valuation.length === 0 && (
              <tr><td colSpan={4}><Empty what="stock valuation">
                No stock at any location you can see.
              </Empty></td></tr>
            )}
          </tbody>
          {d.valuation.length > 1 && (
            <tfoot>
              <tr>
                <td className="font-semibold">Total</td>
                <td /><td />
                <td className="num font-semibold"><Money paise={shelfValue} /></td>
              </tr>
            </tfoot>
          )}
        </TableWrap>
        <p className="meta mt-2">
          Valued at weighted average landed cost — the invoice price plus that
          line&rsquo;s share of the freight, fixed at the moment the goods were
          counted in.
        </p>
      </Section>

      {/* ─────────────── margin ─────────────── */}

      <Section title="Margin, by order">
        <TableWrap>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Customer</th>
              <th>Dispatched</th>
              <th className="num">Revenue</th>
              <th className="num">Cost of goods</th>
              <th className="num">Margin</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {d.margins.map((m: any) => {
              const pct = m.margin_pct === null ? null : Number(m.margin_pct);
              return (
                <tr key={m.id}>
                  <td>
                    <Link href={`/movements/${m.id}`} className="link font-medium">
                      {m.ticket_no}
                    </Link>
                  </td>
                  <td>{m.customer ?? <span className="text-ink-400">—</span>}</td>
                  <td className="meta"><When at={m.dispatched_at} /></td>
                  <td className="num"><Money paise={m.revenue_paise} /></td>
                  <td className="num"><Money paise={m.cogs_paise} /></td>
                  <td className="num"><Money paise={m.margin_paise} signed /></td>
                  <td className="num">
                    {pct === null ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <Pill tone={pct < 0 ? "bad" : pct < 10 ? "warn" : "good"}>
                        {pct.toFixed(2)}%
                      </Pill>
                    )}
                  </td>
                </tr>
              );
            })}
            {d.margins.length === 0 && (
              <tr><td colSpan={7}>
                <Empty denied={!canSeeBooks} what="order margin">
                  No orders dispatched yet. Margin appears the moment goods leave on
                  an invoice.
                </Empty>
              </td></tr>
            )}
          </tbody>
        </TableWrap>
        <p className="meta mt-2">
          Revenue is what the invoice said; cost of goods is the weighted average
          those units left at. Both come from the accounting entries — a transfer
          between our own shops appears nowhere here, because it is not a sale.
        </p>
      </Section>

      {/* ─────────────── who owes whom ─────────────── */}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Owed to suppliers">
          <div id="payables">
            <TableWrap>
              <thead>
                <tr><th>Supplier</th><th className="num">Owed</th></tr>
              </thead>
              <tbody>
                {d.payables.map((p: any) => (
                  <tr key={p.id}>
                    <td className="font-medium">{p.name}</td>
                    <td className="num"><Money paise={p.owed_paise} /></td>
                  </tr>
                ))}
                {d.payables.length === 0 && (
                  <tr><td colSpan={2}>
                    <Empty denied={!canSeeBooks} what="supplier payables">
                      Nothing outstanding.
                    </Empty>
                  </td></tr>
                )}
              </tbody>
            </TableWrap>
          </div>
        </Section>

        <Section title="Owed by customers">
          <TableWrap>
            <thead>
              <tr><th>Customer</th><th className="num">Due</th></tr>
            </thead>
            <tbody>
              {d.receivables.map((p: any) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td className="num"><Money paise={p.due_paise} /></td>
                </tr>
              ))}
              {d.receivables.length === 0 && (
                <tr><td colSpan={2}>
                  <Empty denied={!canSeeBooks} what="customer receivables">
                    Nothing outstanding.
                  </Empty>
                </td></tr>
              )}
            </tbody>
          </TableWrap>
        </Section>
      </div>

      {/* ─────────────── leakage ─────────────── */}

      {d.leakage.length > 0 && (
        <Section title="Where value went that nobody sold">
          <TableWrap>
            <thead>
              <tr><th>Account</th><th>Location</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {d.leakage.map((l: any, i: number) => (
                <tr key={i}>
                  <td>
                    <Pill tone={l.account_code === "WASTAGE" ? "bad" : "warn"}>
                      {l.account_code === "WASTAGE" ? "Wastage" : "Count variance"}
                    </Pill>
                  </td>
                  <td>{l.location_code ?? <span className="text-ink-400">—</span>}</td>
                  <td className="num"><Money paise={l.amount_paise} signed /></td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <p className="meta mt-2">
            Wastage is stock that spoiled. Count variance is stock the shelf and the
            system disagreed about. A large balance in the second is a process
            problem, not an accounting one.
          </p>
        </Section>
      )}

      {/* ─────────────── the books themselves ─────────────── */}

      <Section title="Trial balance">
        <TableWrap>
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th className="num">Debits</th>
              <th className="num">Credits</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {d.trial.map((t: any) => (
              <tr key={t.account_code}>
                <td className="font-medium">{t.account_name}</td>
                <td className="meta">{t.account_type.toLowerCase()}</td>
                <td className="num"><Money paise={t.debit_paise} /></td>
                <td className="num"><Money paise={t.credit_paise} /></td>
                <td className="num"><Money paise={t.balance_paise} signed /></td>
              </tr>
            ))}
            {d.trial.length === 0 && (
              <tr><td colSpan={5}>
                <Empty denied={!canSeeBooks} what="the trial balance">
                  No account has moved yet.
                </Empty>
              </td></tr>
            )}
          </tbody>
          {d.trial.length > 0 && (
            <tfoot>
              <tr>
                <td className="font-semibold" colSpan={2}>Total</td>
                <td className="num font-semibold">
                  <Money paise={d.trial.reduce((a: number, t: any) => a + Number(t.debit_paise), 0)} />
                </td>
                <td className="num font-semibold">
                  <Money paise={d.trial.reduce((a: number, t: any) => a + Number(t.credit_paise), 0)} />
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </TableWrap>
        <p className="meta mt-2">
          Balances are signed the way each account normally runs, so a healthy
          figure is positive on every line. Debits and credits must total the same;
          the database refuses to commit a journal where they do not.
        </p>
      </Section>
    </>
  );
}
