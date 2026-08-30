-- ============================================================
-- 0007 — Partners
--
-- Suppliers, customers and carriers. One table, because the same
-- business is often two of them: you buy rice from a wholesaler and
-- sell them cleaning supplies. Two tables would mean two records for
-- one company, and two versions of their address.
--
-- Lead time lives here and is LEARNED, not typed. Doc 06 §2.2:
-- median of the last six receipts, so one supplier disaster does not
-- permanently inflate a three-day lead time — but three of them do.
-- ============================================================

create schema if not exists partner;

create table partner.partner (
  id            uuid primary key default gen_random_uuid(),

  code          text not null unique,      -- minted below: SUP-2026-000001
  name          text not null,
  legal_name    text,

  -- A partner may be several things at once.
  kinds         text[] not null
                check (kinds <@ array['SUPPLIER','CUSTOMER','CARRIER']
                       and array_length(kinds, 1) >= 1),

  -- Statutory identifiers. Nullable: a mandi trader has no GSTIN,
  -- and requiring one would mean the purchase never gets recorded.
  gstin         text,
  pan           text,
  fssai_licence text,

  phone         text,
  email         text,
  address       jsonb not null default '{}',

  -- Commercial terms (supplier side)
  credit_days   integer check (credit_days >= 0),
  -- Typed at onboarding as a starting assumption; replaced by the
  -- measured median once six receipts exist. See docs/06 §2.2.
  lead_time_days integer check (lead_time_days >= 0),

  -- Commercial terms (customer side)
  credit_limit_paise bigint check (credit_limit_paise >= 0),
  price_tier    text,

  status        text not null default 'ACTIVE' check (status in ('ACTIVE','ON_HOLD','ARCHIVED')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column partner.partner.lead_time_days is
  'Onboarding assumption only. Phase 6 replaces it with the median of the last six actual receipts.';

-- ─────────────────────────── code minting ───────────────────────────
--
-- Prefix follows the primary kind, so a code is readable on sight.

create or replace function partner.assign_partner_code()
returns trigger language plpgsql as $$
declare v_prefix text;
begin
  if new.code is null or btrim(new.code) = '' then
    v_prefix := case
      when 'SUPPLIER' = any (new.kinds) then 'SUP'
      when 'CUSTOMER' = any (new.kinds) then 'CUS'
      else 'CAR'
    end;
    new.code := platform.next_number('partner_' || lower(v_prefix), v_prefix);
  end if;
  return new;
end $$;

create trigger partner_assign_code
  before insert on partner.partner
  for each row execute function partner.assign_partner_code();

create index partner_name_trgm  on partner.partner using gin (name gin_trgm_ops);
create index partner_kinds_idx  on partner.partner using gin (kinds);
create index partner_status_idx on partner.partner (status);
create index partner_gstin_idx  on partner.partner (gstin) where gstin is not null;

-- ─────────────────────────── RLS ───────────────────────────
--
-- Partners are global like the catalogue. Operators need to read them
-- (a delivery arrives from a named supplier); planner, finance and
-- admin maintain them.

alter table partner.partner enable row level security;

create policy partner_read on partner.partner
  for select using (platform.current_role_name() <> '');

create policy partner_write on partner.partner
  for all using (platform.current_role_name() in ('planner','finance','admin'))
  with check (platform.current_role_name() in ('planner','finance','admin'));

-- The audit trail covers partners: credit terms and bank details are
-- exactly the fields worth changing quietly.
create trigger partner_audit
  after insert or update or delete on partner.partner
  for each row execute function platform.record_audit();

create trigger product_audit
  after insert or update or delete on catalog.product
  for each row execute function platform.record_audit();
