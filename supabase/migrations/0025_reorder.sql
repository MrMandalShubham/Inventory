-- ============================================================
-- 0025 — Reorder points and replenishment
--
-- ── The arithmetic, stated once ──
--
--   avg_daily     = demand in the window ÷ OPEN days in the window
--   stddev_daily  = sample stddev of daily demand across open days
--   safety_stock  = ceil( z × stddev_daily × √lead_time )
--   reorder_point = ceil( avg_daily × lead_time ) + safety_stock
--
--   suggested_qty = reorder_point
--                 + ceil( avg_daily × review_period )
--                 − on_hand − in_transit − on_order
--
-- Two ceilings, applied in that order, deliberately. The Phase 6 gate
-- is that a planner reproduces these numbers with a calculator, and
-- that is only possible if the rounding is stated rather than
-- emergent. Change the order and every historic suggestion becomes
-- unexplainable.
--
-- ── Why in_transit and on_order are subtracted ──
--
-- Invariant 4 as a planning rule. Omit them and the system re-suggests
-- goods that are already coming, and somebody orders the same pallet
-- twice. That is the single most common failure in replenishment.
-- ============================================================

create table insight.policy (
  product_id        uuid not null references catalog.product(id) on delete cascade,
  location_id       uuid not null references platform.location(id) on delete cascade,

  -- All nullable: a null means "use the global setting". A per-line
  -- policy should be an exception somebody chose, not a row that has
  -- to exist before the maths works.
  service_level_z   numeric,
  review_period_days integer,
  safety_stock_override integer,
  min_order_qty     integer,
  max_cover_days    integer,

  -- Some products should never be auto-suggested — a seasonal line
  -- being run down, or something being delisted.
  suggest           boolean not null default true,
  note              text,
  updated_at        timestamptz not null default now(),

  primary key (product_id, location_id)
);

alter table insight.policy enable row level security;
create policy policy_read on insight.policy
  for select using (platform.can_access_location(location_id));
create policy policy_write on insight.policy
  for all using (platform.current_role_name() in ('planner','admin'))
  with check (platform.current_role_name() in ('planner','admin'));

-- ─────────────── the materialised view of demand ───────────────
--
-- Recomputed nightly rather than per request: the window scan is over
-- the ledger, which is the largest table in the system and only ever
-- grows.

create table insight.product_metric (
  product_id     uuid not null references catalog.product(id) on delete cascade,
  location_id    uuid not null references platform.location(id) on delete cascade,

  window_days    integer not null,
  open_days      integer not null,
  demand_units   integer not null,
  avg_daily      numeric(12,4) not null,
  stddev_daily   numeric(12,4) not null,

  lead_time_days numeric(6,2) not null,
  safety_stock   integer not null,
  reorder_point  integer not null,

  on_hand        integer not null,
  in_transit     integer not null,
  on_order       integer not null,
  available      integer not null,

  days_of_cover  numeric(8,2),
  days_since_movement integer,

  abc            char(1),
  xyz            char(1),

  computed_at    timestamptz not null default now(),
  primary key (product_id, location_id)
);

create index metric_reorder_idx on insight.product_metric (location_id)
  where available <= reorder_point;
create index metric_cover_idx   on insight.product_metric (location_id, days_of_cover);

alter table insight.product_metric enable row level security;
create policy metric_read on insight.product_metric
  for select using (platform.can_access_location(location_id));

-- ─────────────────── the refresh ───────────────────

create or replace function insight.refresh_metrics(p_location uuid default null)
returns integer
language plpgsql
security definer
set search_path = insight, stock, catalog, movement, platform, public
as $$
-- @no-scope-check: a scheduled recomputation over every location. It
-- writes only derived numbers, and every read of the result goes
-- through insight.product_metric's own location policy.
declare
  v_window  integer := insight.setting('window_days')::integer;
  v_from    date := (now() - make_interval(days => v_window))::date;
  v_to      date := (now() - interval '1 day')::date;
  v_rows    integer;
begin
  with lines as (
    select b.product_id, b.location_id, b.on_hand, b.available
      from stock.balance b
      join platform.location l on l.id = b.location_id
     where l.type <> 'VIRTUAL'
       and (p_location is null or b.location_id = p_location)
       and b.batch_id is null
  ),
  daily as (
    select li.product_id, li.location_id, d.day, d.units, d.was_open
      from lines li
      cross join lateral insight.demand_daily(li.product_id, li.location_id, v_from, v_to) d
  ),
  agg as (
    select product_id, location_id,
           count(*) filter (where was_open)::integer                    as open_days,
           coalesce(sum(units) filter (where was_open), 0)::integer     as demand_units,
           -- Sample stddev across OPEN days, zeros included. A day
           -- with no sales is a real zero and it is exactly what makes
           -- a spiky product risky.
           coalesce(stddev_samp(units) filter (where was_open), 0)      as stddev_daily
      from daily group by product_id, location_id
  ),
  pipeline as (
    select l.product_id, l.location_id, l.on_hand, l.available,
           coalesce((select sum(ml.qty_dispatched - coalesce(ml.qty_received,0))::integer
                       from movement.line ml join movement.movement mm on mm.id = ml.movement_id
                      where ml.product_id = l.product_id
                        and mm.dest_location_id = l.location_id
                        and mm.status in ('IN_TRANSIT','DISCREPANCY')), 0) as in_transit,
           coalesce((select sum(ml.qty_ordered)::integer
                       from movement.line ml join movement.movement mm on mm.id = ml.movement_id
                      where ml.product_id = l.product_id
                        and mm.dest_location_id = l.location_id
                        and mm.status in ('DRAFT','APPROVED','PICKED')), 0) as on_order,
           (select max(sl.occurred_at) from stock.ledger sl
             where sl.product_id = l.product_id and sl.location_id = l.location_id) as last_move
      from lines l
  ),
  computed as (
    select p.product_id, p.location_id,
           v_window as window_days,
           a.open_days,
           a.demand_units,
           case when a.open_days > 0
                then round(a.demand_units::numeric / a.open_days, 4)
                else 0 end                                             as avg_daily,
           round(a.stddev_daily, 4)                                    as stddev_daily,
           insight.lead_time_days(p.location_id)                       as lead_time,
           coalesce(pol.service_level_z, insight.setting('service_level_z')) as z,
           coalesce(pol.review_period_days,
                    insight.setting('review_period_days')::integer)    as review_days,
           pol.safety_stock_override,
           p.on_hand, p.available, p.in_transit, p.on_order, p.last_move
      from pipeline p
      join agg a on a.product_id = p.product_id and a.location_id = p.location_id
      left join insight.policy pol
             on pol.product_id = p.product_id and pol.location_id = p.location_id
  ),
  final as (
    select c.*,
           coalesce(c.safety_stock_override,
                    ceil(c.z * c.stddev_daily * sqrt(c.lead_time))::integer) as safety_stock
      from computed c
  )
  insert into insight.product_metric as m (
    product_id, location_id, window_days, open_days, demand_units,
    avg_daily, stddev_daily, lead_time_days, safety_stock, reorder_point,
    on_hand, in_transit, on_order, available, days_of_cover,
    days_since_movement, computed_at)
  select f.product_id, f.location_id, f.window_days, f.open_days, f.demand_units,
         f.avg_daily, f.stddev_daily, f.lead_time, f.safety_stock,
         -- The reorder point. Two ceilings, in this order.
         ceil(f.avg_daily * f.lead_time)::integer + f.safety_stock,
         f.on_hand, f.in_transit, f.on_order, f.available,
         case when f.avg_daily > 0 then round(f.available / f.avg_daily, 2) end,
         case when f.last_move is not null
              then extract(day from now() - f.last_move)::integer end,
         now()
    from final f
  on conflict (product_id, location_id) do update set
    window_days = excluded.window_days, open_days = excluded.open_days,
    demand_units = excluded.demand_units, avg_daily = excluded.avg_daily,
    stddev_daily = excluded.stddev_daily, lead_time_days = excluded.lead_time_days,
    safety_stock = excluded.safety_stock, reorder_point = excluded.reorder_point,
    on_hand = excluded.on_hand, in_transit = excluded.in_transit,
    on_order = excluded.on_order, available = excluded.available,
    days_of_cover = excluded.days_of_cover,
    days_since_movement = excluded.days_since_movement,
    computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;

  -- ABC by value moved, XYZ by demand volatility. Ranked within a
  -- location, because a product can be an A-line in one shop and a
  -- C-line in another.
  with ranked as (
    select product_id, location_id,
           cume_dist() over (partition by location_id order by demand_units desc) as value_rank,
           case when avg_daily > 0 then stddev_daily / avg_daily else null end    as cv
      from insight.product_metric
     where p_location is null or location_id = p_location
  )
  update insight.product_metric m
     set abc = case when r.value_rank <= 0.20 then 'A'
                    when r.value_rank <= 0.50 then 'B' else 'C' end,
         xyz = case when r.cv is null then 'Z'
                    when r.cv <= 0.5 then 'X'
                    when r.cv <= 1.0 then 'Y' else 'Z' end
    from ranked r
   where m.product_id = r.product_id and m.location_id = r.location_id;

  return v_rows;
end $$;

comment on function insight.refresh_metrics is
  'Recomputes demand, reorder points and ABC/XYZ. Run nightly via pg_cron; safe to run at any time.';

-- ─────────────────── the suggestion ───────────────────

create or replace function insight.suggestions(p_location uuid default null)
returns table (
  product_id     uuid,
  location_id    uuid,
  sku_code       text,
  product_name   text,
  location_code  text,
  available      integer,
  reorder_point  integer,
  suggested_qty  integer,
  source_location_id uuid,
  source_code    text,
  capped         boolean,
  urgency        text
)
language sql stable
security definer
set search_path = insight, stock, catalog, platform, public
as $$
  -- @no-scope-check: reads insight.product_metric, whose own policy is
  -- location-scoped, and platform.location. Returns nothing a caller
  -- could not already read.
  with need as (
    select m.*, p.sku_code, p.name as product_name, l.code as location_code,
           coalesce(pol.review_period_days,
                    insight.setting('review_period_days')::integer) as review_days,
           coalesce(pol.min_order_qty, 1)                           as moq,
           coalesce(pol.suggest, true)                              as suggest
      from insight.product_metric m
      join catalog.product p on p.id = m.product_id
      join platform.location l on l.id = m.location_id
      left join insight.policy pol
             on pol.product_id = m.product_id and pol.location_id = m.location_id
     where (p_location is null or m.location_id = p_location)
       and m.available <= m.reorder_point
       and coalesce(pol.suggest, true)
  ),
  sized as (
    select n.*,
           -- Cover has to last until the NEXT replenishment run, not
           -- merely until this delivery lands.
           greatest(
             n.reorder_point + ceil(n.avg_daily * n.review_days)::integer
               - n.on_hand - n.in_transit - n.on_order,
             0) as raw_qty
      from need n
  ),
  -- Where it should come from: a location holding more than it can
  -- reasonably sell, that will still be above its own reorder point
  -- after giving some up. Rule 3 in docs/03 §2.3 — solving one shop's
  -- stockout by creating another's is not a solution.
  sourced as (
    select s.*,
           (select src.location_id from insight.product_metric src
              join platform.location sl on sl.id = src.location_id
             where src.product_id = s.product_id
               and src.location_id <> s.location_id
               and sl.type <> 'VIRTUAL'
               and src.available - greatest(s.raw_qty, 0) >= src.reorder_point
             order by case when sl.type = 'HUB' then 0 else 1 end,
                      src.days_of_cover desc nulls last
             limit 1) as src_id
      from sized s
  )
  select so.product_id, so.location_id, so.sku_code, so.product_name, so.location_code,
         so.available, so.reorder_point,
         greatest(ceil(so.raw_qty::numeric / so.moq) * so.moq, so.moq)::integer,
         so.src_id,
         (select code from platform.location where id = so.src_id),
         so.src_id is null,
         case when so.available <= 0 then 'out of stock'
              when so.avg_daily > 0 and so.available < so.avg_daily * so.lead_time_days
                   then 'will run out before stock arrives'
              else 'below reorder point' end
    from sourced so
   where so.raw_qty > 0
   order by so.available <= 0 desc, so.location_code, so.sku_code;
$$;

-- ─────────────────── show your work ───────────────────
--
-- A planner who cannot reconstruct why the system suggested 240 will
-- override it, and once they start overriding they stop reading. So
-- every suggestion can produce its own derivation, line by line.

create or replace function insight.explain_reorder(p_product uuid, p_location uuid)
returns table (step text, value text, detail text)
language plpgsql stable
security definer
set search_path = insight, stock, catalog, platform, public
as $$
declare m insight.product_metric%rowtype; v_review integer; v_moq integer;
begin
  if not platform.can_access_location(p_location) then
    raise exception 'FORBIDDEN_LOCATION' using errcode = '42501';
  end if;

  select * into m from insight.product_metric
   where product_id = p_product and location_id = p_location;
  if not found then
    raise exception 'NO_METRIC: run insight.refresh_metrics() first' using errcode = 'P0002';
  end if;

  select coalesce(pol.review_period_days, insight.setting('review_period_days')::integer),
         coalesce(pol.min_order_qty, 1)
    into v_review, v_moq
    from (select 1) x
    left join insight.policy pol
           on pol.product_id = p_product and pol.location_id = p_location;

  return query values
    ('Demand in window', m.demand_units::text,
     format('units that left to meet demand over %s days', m.window_days)),
    ('Open days', m.open_days::text,
     'closures excluded — dividing by calendar days understates demand'),
    ('Sell-through', m.avg_daily::text, 'demand ÷ open days'),
    ('Daily variability', m.stddev_daily::text,
     'sample stddev across open days, zeros included'),
    ('Lead time', m.lead_time_days::text,
     'median of the last six receipts into this location'),
    ('Safety stock', m.safety_stock::text,
     format('ceil(%s × %s × √%s)', insight.setting('service_level_z'),
            m.stddev_daily, m.lead_time_days)),
    ('REORDER POINT', m.reorder_point::text,
     format('ceil(%s × %s) + %s', m.avg_daily, m.lead_time_days, m.safety_stock)),
    ('On hand', m.on_hand::text, 'physically here'),
    ('In transit', m.in_transit::text, 'already dispatched to here — not ordered twice'),
    ('On order', m.on_order::text, 'approved but not yet dispatched'),
    ('Available', m.available::text, 'what can actually be sold'),
    ('Review period', v_review::text, 'cover must last until the next replenishment run'),
    ('SUGGESTED', greatest(m.reorder_point + ceil(m.avg_daily * v_review)::integer
                           - m.on_hand - m.in_transit - m.on_order, 0)::text,
     format('%s + ceil(%s × %s) − %s − %s − %s',
            m.reorder_point, m.avg_daily, v_review, m.on_hand, m.in_transit, m.on_order));
end $$;
