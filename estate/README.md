# Estate tooling

Checks and views that span **all three** systems — Grocery, Inventory
Core and Logistics Core — which share one Supabase project.

They live here because Inventory is the system of record and holds the
most database tooling, not because they belong to it. The integration
plan's Phase 7 moves them to a dedicated `estate` repo alongside a
compose file and the paired secrets; until that exists, this is the
only versioned home they have.

Everything here is **read-only** except `estate-order-journey.sql`,
which creates one view.

| File | What |
|---|---|
| `estate-health.mjs` | Every integrity check the three systems ship, plus the cross-system ones none of them can run alone. PASS / WARN / FAIL per check. |
| `estate-db-audit.sql` | Unindexed foreign keys across all 14 schemas, RLS coverage, tables a browser role can reach, per-row `auth.uid()` policies, cross-system grants, exposed schemas, connection budget. |
| `estate-order-journey.sql` | Creates `estate.order_journey` — one order joined across all three systems. Service-role only. |

## Running the health check

```bash
npm i pg                       # if not already present
DATABASE_URL=postgresql://... node estate/estate-health.mjs
```

Use the Supabase **pooler** host on port 6543, not
`db.<ref>.supabase.co:5432` — that is IPv6-only and does not resolve
from many environments.

## Why it exists

Inventory ships four integrity functions and a `db:verify`. Logistics
ships its own `db:verify`. Grocery ships nothing. None of them can see
the other two, so the questions that matter most — is an order lost
between systems, is stock held under a parcel nobody is carrying, was
a parcel delivered without the sale reaching the ledger — had never
been answerable from one place.

The last of those found a real discrepancy on its first run.
