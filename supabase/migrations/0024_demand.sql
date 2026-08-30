-- ============================================================
-- 0024 — Demand
--
-- Everything in Phase 6 rests on one number: how fast does this
-- product leave THIS location. Get it wrong and every reorder point,
-- every suggestion and every alert built on top is wrong too.
--
-- ── The mistake this migration exists to avoid ──
--
-- Averaging a week's sales over seven days when the shop opened five
-- understates demand by 29% — and a reorder point 29% too low is a
-- guaranteed stockout, arriving quietly, in the products that sell
-- best. So the divisor is OPEN days, not calendar days, and closures
-- have to be recorded rather than inferred.
--
-- A day with no sales is not a closed day. It is a real zero, and it
-- belongs in the variance calculation — a product selling 10 on
-- Monday and nothing else all week is far riskier than one selling 2
-- a day, at the same average.
-- ============================================================

create schema if not exists insight;

-- ─────────────────── when a location is open ───────────────────

alter table platform.location
  add column closed_weekdays integer[] not null default '{}';

comment on column platform.location.closed_weekdays is
  'ISO weekday numbers the location is normally shut (1=Monday … 7=Sunday). Empty means open every day.';

create table platform.location_closure (
  location_id uuid not null references platform.location(id) on delete cascade,
  closed_on   date not null,
  reason      text,
  primary key (location_id, closed_on)
);

alter table platform.location_closure enable row level security;

create policy closure_read on platform.location_closure
  for select using (platform.can_access_location(location_id));

create policy closure_write on platform.location_closure
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

/** How many days a location was actually trading in a window. */
create or replace function insight.open_days(
  p_location uuid, p_from date, p_to date
) returns integer
language sql stable as $$
  select count(*)::integer
    from generate_series(p_from, p_to, interval '1 day') d
    join platform.location l on l.id = p_location
   where not (extract(isodow from d)::integer = any (l.closed_weekdays))
     and not exists (select 1 from platform.location_closure c
                      where c.location_id = p_location and c.closed_on = d::date);
$$;

-- ─────────────────── settings ───────────────────
--
-- One row per knob, so changing a policy is a data change with an
-- audit trail rather than a deployment.

create table insight.setting (
  key   text primary key,
  value numeric not null,
  note  text
);

insert into insight.setting (key, value, note) values
  ('window_days',        28, 'Rolling window for sell-through. Long enough to smooth a quiet week, short enough to follow a real change.'),
  ('service_level_z',   2.05, 'z for a 98% service level. Raise it and safety stock rises with it.'),
  ('review_period_days',  7, 'How often replenishment is actually run. Cover has to last until the next run, not just until the delivery.'),
  ('cover_ceiling_days', 30, 'Above this, a location is holding more than it can sell in a reasonable time and may give some up.'),
  ('dead_stock_days',    60, 'No movement for this long and the cash is trapped.'),
  ('min_lead_time_days',  1, 'Nothing arrives instantly, so a measured zero is treated as one.'),
  ('default_lead_time_days', 3, 'Used until six real receipts exist to measure.');

alter table insight.setting enable row level security;
create policy setting_read on insight.setting
  for select using (platform.current_role_name() <> '');
create policy setting_write on insight.setting
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

create or replace function insight.setting(p_key text)
returns numeric language sql stable as $$
  select value from insight.setting where key = p_key
$$;

-- ─────────────────── what counts as demand ───────────────────
--
-- ISSUE      a sale, or goods leaving the business
-- TRANSFER_OUT  a shop drawing on the hub — that IS the hub's demand
--
-- WASTAGE is NOT demand. Nobody wanted those units; counting them
-- would have the system reorder to replace stock that rotted, which
-- is the opposite of the correction wanted.
--
-- ADJUST and COUNT are not demand either. A correction says the past
-- was recorded wrongly, not that anything was sold.

create or replace function insight.demand_daily(
  p_product uuid, p_location uuid, p_from date, p_to date
) returns table (day date, units integer, was_open boolean)
language sql stable as $$
  select d::date,
         coalesce(-sum(l.qty_delta) filter (
           where l.reason_code in ('ISSUE','TRANSFER_OUT')), 0)::integer,
         not (extract(isodow from d)::integer = any (loc.closed_weekdays))
           and not exists (select 1 from platform.location_closure c
                            where c.location_id = p_location and c.closed_on = d::date)
    from generate_series(p_from, p_to, interval '1 day') d
    cross join platform.location loc
    left join stock.ledger l
           on l.product_id = p_product
          and l.location_id = p_location
          and l.occurred_at >= d
          and l.occurred_at <  d + interval '1 day'
   where loc.id = p_location
   group by d, loc.closed_weekdays
   order by d;
$$;

comment on function insight.demand_daily is
  'One row per calendar day with the units that left to meet demand. Wastage is excluded — nobody wanted those units.';

-- ─────────────────── lead time, measured ───────────────────
--
-- Typed at onboarding as a starting assumption, then replaced by what
-- actually happens. MEDIAN, not mean: one supplier disaster should
-- not permanently inflate a three-day lead time, but three of them
-- should.

create or replace function insight.lead_time_days(p_location uuid)
returns numeric
language sql stable as $$
  select greatest(
    coalesce(
      (select percentile_cont(0.5) within group (
                order by extract(epoch from (m.received_at - coalesce(m.dispatched_at, m.approved_at))) / 86400)
         from (select * from movement.movement
                where dest_location_id = p_location
                  and received_at is not null
                  and coalesce(dispatched_at, approved_at) is not null
                order by received_at desc limit 6) m),
      insight.setting('default_lead_time_days')),
    insight.setting('min_lead_time_days'));
$$;

comment on function insight.lead_time_days is
  'Median of the last six real receipts into this location, floored at the minimum. Falls back to the default until six exist.';
