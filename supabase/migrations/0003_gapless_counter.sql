-- ============================================================
-- 0003 — Gapless numbering
--
-- Ticket numbers and product codes must be gapless for audit: a
-- missing number is a question somebody has to answer.
--
-- A Postgres SEQUENCE will NOT do this. Sequences deliberately leak
-- numbers on rollback so concurrent writers never block each other,
-- which means a cancelled transaction leaves a permanent hole.
--
-- This uses a counter row locked with UPDATE ... RETURNING inside
-- the caller's transaction. It serialises briefly on that one row —
-- a real cost, and the right trade for a number an auditor reads.
-- ============================================================

create table platform.counter (
  name          text primary key,
  current_value bigint not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table platform.counter is
  'Gapless sequence sources. One row per number series. Locked per transaction — see next_number().';

-- Format: PREFIX-YYYY-NNNNNN  e.g. TRF-2026-000123
create or replace function platform.next_number(
  p_name   text,
  p_prefix text,
  p_width  int default 6
) returns text
language plpgsql
security definer
set search_path = platform, public
as $$
-- @no-scope-check: issues a number and touches no location data.
declare
  v_value bigint;
begin
  -- Atomic in both branches, and — unlike a sequence — the increment
  -- is rolled back with the transaction, which is what makes it gapless.
  insert into platform.counter as c (name, current_value)
       values (p_name, 1)
  on conflict (name) do update
      set current_value = c.current_value + 1,
          updated_at    = now()
    returning current_value into v_value;

  return p_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_value::text, p_width, '0');
end $$;

-- Read-only: what the next number would be, without consuming one.
create or replace function platform.peek_number(p_name text)
returns bigint language sql stable as $$
  select coalesce((select current_value from platform.counter where name = p_name), 0)
$$;

alter table platform.counter enable row level security;

-- Nobody reads or writes counters directly; next_number() is the
-- only door, and it runs as definer.
create policy counter_admin_read on platform.counter
  for select using (platform.current_role_name() = 'admin');
