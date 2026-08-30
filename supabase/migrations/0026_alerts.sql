-- ============================================================
-- 0026 — Alerts
--
-- ── The property that makes an alert list usable ──
--
-- ALERTS RESOLVE THEMSELVES.
--
-- A list that only ever grows is a list nobody reads, and an ignored
-- alert list is worse than none — it looks like coverage while
-- providing none. So evaluate() is a full reconciliation, not an
-- append: anything that no longer matches its rule is closed, with
-- the time it closed recorded.
--
-- ── And the property that stops it becoming noise ──
--
-- One open alert per rule per line, enforced by a partial unique
-- index. Running the evaluation every ten minutes must not produce
-- 144 copies of "Toor Dal is out of stock at Shop 1" a day.
-- ============================================================

create schema if not exists alerting;

create table alerting.rule (
  code        text primary key,
  label       text not null,
  severity    text not null check (severity in ('ACT_NOW','THIS_WEEK','WORTH_KNOWING')),
  description text not null,
  enabled     boolean not null default true
);

insert into alerting.rule (code, label, severity, description) values
  ('OUT_OF_STOCK',    'Out of stock',            'ACT_NOW',
   'A product this location normally carries has nothing sellable left.'),
  ('WILL_RUN_OUT',    'Will run out before stock arrives', 'ACT_NOW',
   'Cover is shorter than the lead time — ordering now is already late.'),
  ('EXPIRING_URGENT', 'Expiring within 2 days',  'ACT_NOW',
   'Sell it, move it or write it off today.'),
  ('TICKET_STUCK',    'Movement needs explaining','ACT_NOW',
   'A ticket has a variance and cannot close until somebody accounts for it.'),
  ('LEDGER_DRIFT',    'Records disagree with the ledger', 'ACT_NOW',
   'The projection and the event log do not reconcile. Every number is suspect.'),
  ('BELOW_REORDER',   'Below reorder point',     'THIS_WEEK',
   'Order now or this runs out before the next delivery.'),
  ('EXPIRING_SOON',   'Expiring within 7 days',  'THIS_WEEK',
   'Time to discount, or move it to a location that will sell it.'),
  ('DEAD_STOCK',      'Dead stock',              'WORTH_KNOWING',
   'No movement for a long time — cash is sitting still.'),
  ('OVERSTOCKED',     'More cover than it can sell', 'WORTH_KNOWING',
   'This location holds more than it can reasonably shift; another may want some.');

create table alerting.alert (
  id          bigint generated always as identity primary key,
  rule_code   text not null references alerting.rule(code),

  -- Nullable: a system-level alert such as ledger drift belongs to no
  -- single product or location.
  product_id  uuid references catalog.product(id) on delete cascade,
  location_id uuid references platform.location(id) on delete cascade,

  severity    text not null,
  title       text not null,
  detail      jsonb not null default '{}',

  state       text not null default 'OPEN'
              check (state in ('OPEN','ACKNOWLEDGED','RESOLVED')),

  raised_at        timestamptz not null default now(),
  acknowledged_by  uuid references platform.app_user(id),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  -- How it ended: the condition cleared, or a person dealt with it.
  resolution  text
);

-- One open alert per rule per line. Without this, an evaluation every
-- ten minutes produces 144 copies a day of the same sentence.
create unique index alert_one_open
  on alerting.alert (rule_code, coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
                     coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where state <> 'RESOLVED';

create index alert_open_idx on alerting.alert (severity, raised_at desc) where state <> 'RESOLVED';
create index alert_loc_idx  on alerting.alert (location_id) where state <> 'RESOLVED';

alter table alerting.rule  enable row level security;
alter table alerting.alert enable row level security;

create policy rule_read on alerting.rule
  for select using (platform.current_role_name() <> '');
create policy rule_write on alerting.rule
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

-- An alert about a location you cannot see is not yours. System-level
-- alerts (no location) go to everyone, because a ledger that does not
-- reconcile is everybody's problem.
create policy alert_read on alerting.alert
  for select using (location_id is null or platform.can_access_location(location_id));

create policy alert_ack on alerting.alert
  for update using (location_id is null or platform.can_access_location(location_id));

-- ─────────────────── the evaluation ───────────────────

create or replace function alerting.evaluate()
returns table (rule_code text, opened integer, resolved integer)
language plpgsql
security definer
set search_path = alerting, insight, stock, movement, catalog, platform, public
as $$
-- @no-scope-check: a scheduled sweep across every location. It writes
-- alert rows; reading them goes through alerting.alert's own policy.
declare
  r record;
  v_opened integer;
  v_resolved integer;
begin
  -- Everything the rules currently consider wrong, in one shape.
  create temporary table _current on commit drop as
  with m as (select * from insight.product_metric),
  batches as (
    select b.product_id, b.location_id, bt.expiry_date, b.on_hand
      from stock.balance b
      join stock.batch bt on bt.id = b.batch_id
     where bt.expiry_date is not null and b.on_hand > 0
  )
  select 'OUT_OF_STOCK' as rule_code, m.product_id, m.location_id,
         jsonb_build_object('available', m.available, 'reorder_point', m.reorder_point) as detail
    from m where m.available <= 0
  union all
  select 'WILL_RUN_OUT', m.product_id, m.location_id,
         jsonb_build_object('cover_days', m.days_of_cover, 'lead_time', m.lead_time_days)
    from m where m.available > 0 and m.avg_daily > 0
                 and m.days_of_cover < m.lead_time_days
  union all
  select 'BELOW_REORDER', m.product_id, m.location_id,
         jsonb_build_object('available', m.available, 'reorder_point', m.reorder_point)
    from m where m.available > 0 and m.available <= m.reorder_point
  union all
  select 'EXPIRING_URGENT', b.product_id, b.location_id,
         jsonb_build_object('expiry', b.expiry_date, 'units', b.on_hand)
    from batches b where b.expiry_date <= current_date + 2
  union all
  select 'EXPIRING_SOON', b.product_id, b.location_id,
         jsonb_build_object('expiry', b.expiry_date, 'units', b.on_hand)
    from batches b where b.expiry_date > current_date + 2
                     and b.expiry_date <= current_date + 7
  union all
  select 'DEAD_STOCK', m.product_id, m.location_id,
         jsonb_build_object('days_since_movement', m.days_since_movement,
                            'units', m.on_hand)
    from m where m.on_hand > 0
             and m.days_since_movement > insight.setting('dead_stock_days')::integer
  union all
  select 'OVERSTOCKED', m.product_id, m.location_id,
         jsonb_build_object('cover_days', m.days_of_cover)
    from m where m.days_of_cover > insight.setting('cover_ceiling_days')::numeric
  union all
  select 'TICKET_STUCK', null::uuid, mv.dest_location_id,
         jsonb_build_object('ticket', mv.ticket_no, 'status', mv.status)
    from movement.movement mv where mv.status = 'DISCREPANCY'
  union all
  select 'LEDGER_DRIFT', null::uuid, null::uuid,
         jsonb_build_object('lines', (select count(*) from stock.verify_balances()))
   where exists (select 1 from stock.verify_balances());

  for r in select code, label, severity from alerting.rule where enabled loop
    -- Open anything newly true.
    with wanted as (
      select c.product_id, c.location_id, c.detail
        from _current c where c.rule_code = r.code
    ),
    ins as (
      insert into alerting.alert (rule_code, product_id, location_id, severity, title, detail)
      select r.code, w.product_id, w.location_id, r.severity,
             r.label || coalesce(' — ' || p.name, '') || coalesce(' at ' || l.code, ''),
             w.detail
        from wanted w
        left join catalog.product p on p.id = w.product_id
        left join platform.location l on l.id = w.location_id
      on conflict do nothing
      returning 1
    )
    select count(*)::integer into v_opened from ins;

    -- Close anything no longer true. This is the half that makes the
    -- list worth reading.
    with gone as (
      update alerting.alert a
         set state = 'RESOLVED', resolved_at = now(),
             resolution = 'condition cleared'
       where a.rule_code = r.code
         and a.state <> 'RESOLVED'
         and not exists (
           select 1 from _current c
            where c.rule_code = r.code
              and c.product_id is not distinct from a.product_id
              and c.location_id is not distinct from a.location_id)
      returning 1
    )
    select count(*)::integer into v_resolved from gone;

    if v_opened > 0 or v_resolved > 0 then
      rule_code := r.code; opened := v_opened; resolved := v_resolved;
      return next;
    end if;
  end loop;
end $$;

comment on function alerting.evaluate is
  'Full reconciliation, not an append: opens what is newly true and closes what no longer is. Run every ten minutes.';

/** Acknowledge — "I have seen this and I am dealing with it". Distinct
 *  from resolved, which only the condition clearing can do. */
create or replace function alerting.acknowledge(p_id bigint)
returns void
language plpgsql security definer
set search_path = alerting, platform, public
as $$
declare v_loc uuid;
begin
  select location_id into v_loc from alerting.alert where id = p_id;
  if not found then raise exception 'NO_SUCH_ALERT' using errcode = 'P0002'; end if;

  if v_loc is not null and not platform.can_access_location(v_loc) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  update alerting.alert
     set state = 'ACKNOWLEDGED',
         acknowledged_by = platform.current_user_id(),
         acknowledged_at = now()
   where id = p_id and state = 'OPEN';
end $$;
