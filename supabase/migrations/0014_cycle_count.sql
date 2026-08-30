-- ============================================================
-- 0014 — Cycle counting, blind
--
-- Counting is the only thing that proves the system agrees with the
-- shelf. Every other check in this codebase proves the system agrees
-- with ITSELF, which is a different and weaker claim.
--
-- ── Blind, and why it is not negotiable ──
--
-- The counter must not see the expected quantity. Show it, and they
-- write down what the system says — and the count measures nothing
-- at all while looking like diligence.
--
-- Enforced structurally: stock.count_line has no SELECT policy for
-- operators. The only way an operator reaches a count sheet is
-- through open_count_sheet_for_counting(), which does not return the
-- expected column. Managers reviewing variances use a different
-- function that does.
-- ============================================================

create table stock.count_sheet (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  location_id  uuid not null references platform.location(id),

  -- DRAFT → COUNTING → SUBMITTED → APPROVED → POSTED
  --                              ↘ REJECTED
  status       text not null default 'DRAFT'
               check (status in ('DRAFT','COUNTING','SUBMITTED','APPROVED','REJECTED','POSTED')),

  scope_note   text,
  opened_by    uuid not null,
  counted_by   uuid,
  approved_by  uuid,

  opened_at    timestamptz not null default now(),
  submitted_at timestamptz,
  approved_at  timestamptz,
  posted_at    timestamptz,

  -- Nobody approves their own count. The person who counted is not
  -- the person who signs off the difference — without this, one
  -- account can create a shortage and approve the explanation, and
  -- no amount of logging detects it.
  constraint counter_is_not_approver
    check (approved_by is null or counted_by is null or approved_by <> counted_by)
);

create table stock.count_line (
  id             uuid primary key default gen_random_uuid(),
  count_sheet_id uuid not null references stock.count_sheet(id) on delete cascade,

  product_id     uuid not null references catalog.product(id),
  batch_id       uuid references stock.batch(id),

  -- Snapshotted when the sheet opens. NEVER shown to the counter.
  expected_qty   integer not null,
  counted_qty    integer check (counted_qty >= 0),

  variance       integer generated always as (counted_qty - expected_qty) stored,
  reason_note    text,

  counted_at     timestamptz,

  unique nulls not distinct (count_sheet_id, product_id, batch_id)
);

create index count_sheet_location_idx on stock.count_sheet (location_id, status);
create index count_line_sheet_idx     on stock.count_line (count_sheet_id);

-- ─────────────────── open a sheet ───────────────────

create or replace function stock.open_count_sheet(
  p_location uuid,
  p_note     text default null,
  p_products uuid[] default null      -- null = every line at that location
) returns uuid
language plpgsql security definer
set search_path = stock, platform, public, extensions
as $$
declare v_id uuid; v_code text;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not count at %', p_location
      using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not open a count sheet', platform.current_role_name()
      using errcode = '42501';
  end if;

  v_code := platform.next_number('count_sheet', 'CNT');

  insert into stock.count_sheet (code, location_id, scope_note, opened_by, status)
       values (v_code, p_location, p_note, platform.current_user_id(), 'COUNTING')
    returning id into v_id;

  -- Snapshot what the system believes, at this instant.
  insert into stock.count_line (count_sheet_id, product_id, batch_id, expected_qty)
  select v_id, b.product_id, b.batch_id, b.on_hand
    from stock.balance b
   where b.location_id = p_location
     and (p_products is null or b.product_id = any (p_products));

  return v_id;
end $$;

-- ─────────────────── count it, blind ───────────────────

/** What the counter sees. Note the absence of expected_qty. */
create or replace function stock.count_sheet_lines_blind(p_sheet uuid)
returns table (line_id uuid, sku_code text, product_name text, lot_no text, counted_qty integer)
language plpgsql stable security definer
set search_path = stock, catalog, platform, public, extensions
as $$
declare v_location uuid;
begin
  select location_id into v_location from stock.count_sheet where id = p_sheet;
  if not found then raise exception 'NO_SUCH_SHEET' using errcode = 'P0002'; end if;

  if not platform.can_access_location(v_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not count at this location'
      using errcode = '42501';
  end if;

  return query
    select cl.id, p.sku_code, p.name, bt.lot_no, cl.counted_qty
      from stock.count_line cl
      join catalog.product p on p.id = cl.product_id
      left join stock.batch bt on bt.id = cl.batch_id
     where cl.count_sheet_id = p_sheet
     order by p.sku_code;
end $$;

create or replace function stock.record_count(
  p_line uuid, p_counted integer
) returns void
language plpgsql security definer
set search_path = stock, platform, public, extensions
as $$
declare v_location uuid; v_status text; v_sheet uuid;
begin
  select cs.location_id, cs.status, cs.id into v_location, v_status, v_sheet
    from stock.count_line cl join stock.count_sheet cs on cs.id = cl.count_sheet_id
   where cl.id = p_line;

  if not found then raise exception 'NO_SUCH_LINE' using errcode = 'P0002'; end if;

  if not platform.can_access_location(v_location) then
    raise exception 'FORBIDDEN_LOCATION: caller may not count at this location'
      using errcode = '42501';
  end if;

  if v_status <> 'COUNTING' then
    raise exception 'SHEET_NOT_OPEN: this sheet is % and no longer accepts counts', v_status
      using errcode = '23514';
  end if;

  if p_counted < 0 then
    raise exception 'NEGATIVE_COUNT: you cannot count fewer than none' using errcode = '23514';
  end if;

  update stock.count_line
     set counted_qty = p_counted, counted_at = now()
   where id = p_line;

  update stock.count_sheet
     set counted_by = platform.current_user_id()
   where id = v_sheet;
end $$;

create or replace function stock.submit_count_sheet(p_sheet uuid)
returns integer
language plpgsql security definer
set search_path = stock, platform, public, extensions
as $$
declare v_location uuid; v_uncounted integer;
begin
  select location_id into v_location from stock.count_sheet where id = p_sheet;
  if not found then raise exception 'NO_SUCH_SHEET' using errcode = 'P0002'; end if;

  if not platform.can_access_location(v_location) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  select count(*) into v_uncounted
    from stock.count_line where count_sheet_id = p_sheet and counted_qty is null;

  if v_uncounted > 0 then
    raise exception 'INCOMPLETE_COUNT: % line(s) not yet counted', v_uncounted
      using errcode = '23514';
  end if;

  update stock.count_sheet
     set status = 'SUBMITTED', submitted_at = now()
   where id = p_sheet and status = 'COUNTING';

  return (select count(*)::integer from stock.count_line
           where count_sheet_id = p_sheet and counted_qty <> expected_qty);
end $$;

-- ─────────────── approve, and post the variance ───────────────
--
-- Every variance becomes a ledger entry with a named cause and a
-- named approver. A count that changed stock without leaving that
-- trail would be indistinguishable from theft.

create or replace function stock.approve_count_sheet(p_sheet uuid)
returns integer
language plpgsql security definer
set search_path = stock, platform, public, extensions
as $$
declare
  v_location uuid; v_status text; v_counted_by uuid;
  l record; v_posted integer := 0;
begin
  select location_id, status, counted_by
    into v_location, v_status, v_counted_by
    from stock.count_sheet where id = p_sheet;
  if not found then raise exception 'NO_SUCH_SHEET' using errcode = 'P0002'; end if;

  if not platform.can_access_location(v_location) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  if platform.current_role_name() not in ('shop_manager','planner','admin') then
    raise exception 'FORBIDDEN_ROLE: % may not approve a count', platform.current_role_name()
      using errcode = '42501';
  end if;

  -- Separation of duties, enforced rather than trusted.
  if v_counted_by is not null and v_counted_by = platform.current_user_id() then
    raise exception 'SELF_APPROVAL: the person who counted may not approve the variance'
      using errcode = '42501';
  end if;

  if v_status <> 'SUBMITTED' then
    raise exception 'NOT_SUBMITTED: sheet is %', v_status using errcode = '23514';
  end if;

  update stock.count_sheet
     set status = 'APPROVED', approved_by = platform.current_user_id(), approved_at = now()
   where id = p_sheet;

  for l in
    select cl.product_id, cl.batch_id, cl.variance, cl.reason_note, cs.code
      from stock.count_line cl join stock.count_sheet cs on cs.id = cl.count_sheet_id
     where cl.count_sheet_id = p_sheet and cl.variance <> 0
  loop
    perform stock.post_movement(
      l.product_id, v_location, l.variance, 'COUNT', l.batch_id,
      coalesce(l.reason_note, 'count variance on ' || l.code));
    v_posted := v_posted + 1;
  end loop;

  update stock.count_sheet set status = 'POSTED', posted_at = now() where id = p_sheet;

  return v_posted;
end $$;

-- ─────────────────────────── RLS ───────────────────────────

alter table stock.count_sheet enable row level security;
alter table stock.count_line  enable row level security;

create policy count_sheet_read on stock.count_sheet
  for select using (platform.can_access_location(location_id));

-- Deliberately NOT readable by operators. The blind function is the
-- only route for them, and it does not return expected_qty. Managers
-- and above may read the raw lines because reviewing a variance
-- means seeing both numbers.
create policy count_line_review on stock.count_line
  for select using (
    platform.current_role_name() in ('shop_manager','planner','finance','admin')
    and exists (
      select 1 from stock.count_sheet cs
       where cs.id = count_line.count_sheet_id
         and platform.can_access_location(cs.location_id))
  );

-- Managers may annotate a variance with its cause before approving.
create policy count_line_annotate on stock.count_line
  for update using (
    platform.current_role_name() in ('shop_manager','planner','admin')
    and exists (
      select 1 from stock.count_sheet cs
       where cs.id = count_line.count_sheet_id
         and platform.can_access_location(cs.location_id))
  );
