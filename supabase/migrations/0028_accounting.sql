-- ============================================================
-- 0028 — Double-entry accounting
--
-- ── The point of this migration ──
--
-- NOTHING CHANGES STOCK WITHOUT ALSO CHANGING THE BOOKS.
--
-- So the value of stock on the shelf and the value of stock in the
-- accounts cannot drift. Without that, "what is our inventory worth"
-- has two answers and no way to tell which is right — which is
-- exactly the several-versions-of-the-truth problem the whole system
-- exists to eliminate, reappearing one layer up.
--
-- ── Balanced, enforced ──
--
-- Debits equal credits per journal, checked by a deferred constraint
-- trigger. Deferred because a journal is written line by line and is
-- only meant to balance once it is complete; checking per row would
-- make it impossible to write at all.
--
-- ── Invariant 8, in the accounts ──
--
-- An internal transfer moves value between INVENTORY accounts via
-- INVENTORY_IN_TRANSIT. It touches no revenue account and no tax
-- account, because you cannot sell to yourself. Getting this wrong
-- inflates revenue and corrupts stock valuation at the same time.
-- ============================================================

create schema if not exists ledger;

create table ledger.account (
  code       text primary key,
  name       text not null,
  type       text not null check (type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  -- Which way this account increases. Stated rather than inferred,
  -- because getting it backwards is silent and expensive.
  normal_side text not null check (normal_side in ('DEBIT','CREDIT')),
  by_location boolean not null default false,
  by_partner  boolean not null default false,
  note       text
);

insert into ledger.account (code, name, type, normal_side, by_location, by_partner, note) values
  ('INVENTORY',            'Inventory',              'ASSET',     'DEBIT',  true,  false,
   'Stock on hand, at landed cost. One balance per location.'),
  ('INVENTORY_IN_TRANSIT', 'Inventory in transit',   'ASSET',     'DEBIT',  false, false,
   'Value that has left one location and not reached another. Belongs to nobody.'),
  ('GST_INPUT_CREDIT',     'GST input credit',       'ASSET',     'DEBIT',  false, false,
   'Tax paid on purchases, recoverable.'),
  ('SUPPLIER_PAYABLE',     'Supplier payable',       'LIABILITY', 'CREDIT', false, true,
   'What we owe, per supplier.'),
  ('CUSTOMER_RECEIVABLE',  'Customer receivable',    'ASSET',     'DEBIT',  false, true,
   'What we are owed, per customer.'),
  ('GST_OUTPUT_TAX',       'GST output tax',         'LIABILITY', 'CREDIT', false, false,
   'Tax charged on sales, payable.'),
  ('REVENUE',              'Revenue',                'REVENUE',   'CREDIT', true,  false,
   'Goods sold, excluding tax.'),
  ('COGS',                 'Cost of goods sold',     'EXPENSE',   'DEBIT',  true,  false,
   'What the goods sold actually cost us — the landed cost they left at.'),
  ('WASTAGE',              'Wastage',                'EXPENSE',   'DEBIT',  true,  false,
   'Stock damaged, expired or spoiled. Posted daily, never a month-end plug.'),
  ('STOCK_ADJUSTMENT',     'Stock adjustment',       'EXPENSE',   'DEBIT',  true,  false,
   'Count variances and corrections. A large balance here is a process problem.');

create table ledger.journal (
  id           uuid primary key default gen_random_uuid(),
  -- What caused it. Every journal traces back to a real event.
  source_kind  text not null check (source_kind in
                 ('STOCK_MOVEMENT','GOODS_RECEIPT','SALE','TRANSFER','ADJUSTMENT','MANUAL')),
  source_id    text,
  stock_ledger_id bigint,

  description  text not null,
  occurred_at  timestamptz not null default now(),
  posted_at    timestamptz not null default now(),
  posted_by    uuid
);

create table ledger.entry (
  id           bigint generated always as identity primary key,
  journal_id   uuid not null references ledger.journal(id) on delete cascade,

  account_code text not null references ledger.account(code),
  location_id  uuid references platform.location(id),
  partner_id   uuid references partner.partner(id),
  product_id   uuid references catalog.product(id),

  -- Exactly one side carries a value. Storing both as positive
  -- numbers keeps every report a plain SUM rather than a CASE over
  -- account types that somebody will eventually get backwards.
  debit_paise  bigint not null default 0 check (debit_paise  >= 0),
  credit_paise bigint not null default 0 check (credit_paise >= 0),

  note         text,

  constraint one_side_only check (
    (debit_paise > 0 and credit_paise = 0) or
    (credit_paise > 0 and debit_paise = 0) or
    (debit_paise = 0 and credit_paise = 0))
);

create index entry_journal_idx  on ledger.entry (journal_id);
create index entry_account_idx  on ledger.entry (account_code, location_id);
create index entry_partner_idx  on ledger.entry (partner_id) where partner_id is not null;
create index journal_source_idx on ledger.journal (source_kind, source_id);
create index journal_stock_idx  on ledger.journal (stock_ledger_id) where stock_ledger_id is not null;

-- ─────────────── balanced, or it does not commit ───────────────

create or replace function ledger.assert_balanced()
returns trigger language plpgsql as $$
declare v_diff bigint;
begin
  select coalesce(sum(debit_paise), 0) - coalesce(sum(credit_paise), 0)
    into v_diff
    from ledger.entry where journal_id = coalesce(new.journal_id, old.journal_id);

  if v_diff <> 0 then
    raise exception 'UNBALANCED_JOURNAL: debits and credits differ by % paise', v_diff
      using errcode = '23514';
  end if;
  return null;
end $$;

-- DEFERRED: a journal is written line by line and is only meant to
-- balance once complete. Checking per row would make it unwritable.
create constraint trigger entry_balanced
  after insert or update or delete on ledger.entry
  deferrable initially deferred
  for each row execute function ledger.assert_balanced();

-- Append-only, like the stock ledger. A correction is a new journal.
create trigger journal_no_update
  before update on ledger.journal
  for each row execute function platform.refuse_mutation();
create trigger journal_no_delete
  before delete on ledger.journal
  for each row execute function platform.refuse_mutation();

-- ─────────────── posting ───────────────

/**
 * Write one balanced journal.
 *
 * p_lines: [{account, debit?, credit?, location_id?, partner_id?,
 *            product_id?, note?}]
 */
create or replace function ledger.post(
  p_kind        text,
  p_description text,
  p_lines       jsonb,
  p_source_id   text default null,
  p_stock_id    bigint default null,
  p_occurred_at timestamptz default now()
) returns uuid
language plpgsql
security definer
set search_path = ledger, platform, public, extensions
as $$
-- @no-scope-check: writes accounting entries for a stock movement that
-- was already authorised at the point it happened. Reading the result
-- goes through ledger.entry's own policy, which is finance and admin.
declare
  v_id uuid;
  r    jsonb;
begin
  insert into ledger.journal (source_kind, source_id, stock_ledger_id,
                              description, occurred_at, posted_by)
       values (p_kind, p_source_id, p_stock_id, p_description, p_occurred_at,
               platform.current_user_id())
    returning id into v_id;

  for r in select * from jsonb_array_elements(p_lines) loop
    insert into ledger.entry (journal_id, account_code, location_id, partner_id,
                              product_id, debit_paise, credit_paise, note)
    values (v_id,
            r ->> 'account',
            nullif(r ->> 'location_id','')::uuid,
            nullif(r ->> 'partner_id','')::uuid,
            nullif(r ->> 'product_id','')::uuid,
            coalesce((r ->> 'debit')::bigint, 0),
            coalesce((r ->> 'credit')::bigint, 0),
            r ->> 'note');
  end loop;

  return v_id;
end $$;

-- ─────────────── reading the books ───────────────

create or replace function ledger.trial_balance(p_as_of timestamptz default now())
returns table (
  account_code text,
  account_name text,
  account_type text,
  debit_paise  bigint,
  credit_paise bigint,
  balance_paise bigint
)
language sql stable
security definer
set search_path = ledger, public, extensions
as $$
  -- @no-scope-check: whole-book totals, restricted to finance and
  -- admin by the guard in the WHERE clause below.
  select a.code, a.name, a.type,
         coalesce(sum(e.debit_paise), 0)::bigint,
         coalesce(sum(e.credit_paise), 0)::bigint,
         -- Signed the way the account normally runs, so a healthy
         -- balance is a positive number on every line.
         (case when a.normal_side = 'DEBIT'
               then coalesce(sum(e.debit_paise), 0) - coalesce(sum(e.credit_paise), 0)
               else coalesce(sum(e.credit_paise), 0) - coalesce(sum(e.debit_paise), 0)
          end)::bigint
    from ledger.account a
    left join ledger.entry e on e.account_code = a.code
    left join ledger.journal j on j.id = e.journal_id and j.occurred_at <= p_as_of
   where platform.current_role_name() in ('finance','admin')
   group by a.code, a.name, a.type, a.normal_side
   having coalesce(sum(e.debit_paise), 0) <> 0 or coalesce(sum(e.credit_paise), 0) <> 0
   order by a.type, a.code;
$$;

/** The books must balance in total, or something is very wrong. */
create or replace function ledger.verify_balanced()
returns table (journal_id uuid, description text, difference_paise bigint)
language sql stable
security definer
set search_path = ledger, public, extensions
as $$
  -- @no-scope-check: an integrity check reporting only imbalances.
  select j.id, j.description,
         (coalesce(sum(e.debit_paise),0) - coalesce(sum(e.credit_paise),0))::bigint
    from ledger.journal j
    join ledger.entry e on e.journal_id = j.id
   group by j.id, j.description
  having coalesce(sum(e.debit_paise),0) <> coalesce(sum(e.credit_paise),0);
$$;

-- ─────────────── RLS ───────────────
--
-- Money is role-restricted: operators never see cost or margin
-- (docs/08 §1). Location scoping applies on top, so a shop manager
-- who can see money sees only their own location's.

alter table ledger.account enable row level security;
alter table ledger.journal enable row level security;
alter table ledger.entry   enable row level security;

create policy account_read on ledger.account
  for select using (platform.current_role_name() <> '');

create policy journal_read on ledger.journal
  for select using (platform.current_role_name() in ('finance','admin','planner'));

create policy entry_read on ledger.entry
  for select using (
    platform.current_role_name() in ('finance','admin')
    or (platform.current_role_name() = 'planner'
        and (location_id is null or platform.can_access_location(location_id))));
