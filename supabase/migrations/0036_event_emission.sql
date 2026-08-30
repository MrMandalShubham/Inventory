-- ============================================================
-- 0036 — Something actually raises the events
--
-- 0035 built the delivery machinery. This connects it to the four
-- events the subscription table has advertised since migration 0020:
--
--   stock.changed         a balance moved
--   stock.low             a low-stock alert opened
--   movement.closed       a ticket reached its end state
--   reservation.expired   a hold lapsed and stock went back
--
-- Emitted by TRIGGERS, for the same reason the accounting entries are
-- (migration 0029): a code path written next year that moves stock
-- without knowing webhooks exist still raises the event. Anything
-- that depends on being remembered eventually is not.
--
-- ── Every emit carries an event key ──
--
-- The ledger id, the movement id, the reservation id. Re-running a
-- job, replaying a migration, or a retry that reaches this twice
-- produces ONE delivery. Deduplicating at the queue is the only
-- place it can be done reliably — a subscriber cannot tell a
-- duplicate from a genuine second event.
--
-- ── Cost when nobody is listening ──
--
-- emit_event() inserts by SELECT over the subscriptions, so with no
-- active subscriber it inserts zero rows. The overhead on a business
-- with no integrations is one indexed lookup per movement.
-- ============================================================

-- ─────────────── stock.changed ───────────────

create or replace function platform.emit_stock_changed()
returns trigger
language plpgsql
security definer
set search_path = platform, stock, catalog, public
as $$
-- @no-scope-check: a trigger on stock.ledger. Everything reaching it
-- has already passed stock.post_movement(), which checks the
-- location. It queues a notification and reads no stock of its own.
declare
  v_code     text;
  v_location text;
  v_avail    integer;
begin
  -- Only bother building a payload if somebody is listening. On a
  -- deployment with no integrations this is the whole cost.
  if not exists (select 1 from platform.webhook_subscription
                  where event = 'stock.changed' and status = 'ACTIVE') then
    return null;
  end if;

  select sku_code into v_code from catalog.product where id = new.product_id;
  select code into v_location from platform.location where id = new.location_id;

  select on_hand - reserved - allocated - damaged into v_avail
    from stock.balance
   where product_id = new.product_id and location_id = new.location_id
     and batch_id is not distinct from new.batch_id;

  perform platform.emit_event(
    'stock.changed',
    jsonb_build_object(
      'product_id',   new.product_id,
      'sku_code',     v_code,
      'location_id',  new.location_id,
      'location_code',v_location,
      'qty_delta',    new.qty_delta,
      'on_hand',      new.balance_after,
      -- What a selling app actually needs: not what is on the shelf,
      -- but what it may promise a customer.
      'available',    coalesce(v_avail, new.balance_after),
      'reason',       new.reason_code,
      'movement_id',  new.movement_id,
      'occurred_at',  new.occurred_at),
    -- One event per ledger row, forever.
    'ledger:' || new.id);

  return null;
end $$;

create trigger stock_emits_changed
  after insert on stock.ledger
  for each row execute function platform.emit_stock_changed();

-- ─────────────── movement.closed ───────────────

create or replace function platform.emit_movement_closed()
returns trigger
language plpgsql
security definer
set search_path = platform, movement, public
as $$
-- @no-scope-check: a trigger on movement.movement, reached only
-- through the lifecycle functions, each of which checks its location.
begin
  if new.status not in ('CLOSED','CANCELLED') then return null; end if;
  if old.status = new.status then return null; end if;

  perform platform.emit_event(
    'movement.closed',
    jsonb_build_object(
      'movement_id', new.id,
      'ticket_no',   new.ticket_no,
      'type',        new.type,
      'status',      new.status,
      'source_location_id', new.source_location_id,
      'dest_location_id',   new.dest_location_id,
      'partner_id',  new.partner_id,
      'closed_at',   coalesce(new.closed_at, now())),
    'movement:' || new.id || ':' || new.status);

  return null;
end $$;

create trigger movement_emits_closed
  after update on movement.movement
  for each row execute function platform.emit_movement_closed();

-- ─────────────── stock.low ───────────────

create or replace function platform.emit_stock_low()
returns trigger
language plpgsql
security definer
set search_path = platform, alerting, catalog, public
as $$
-- @no-scope-check: a trigger on alerting.alert, written only by
-- alerting.evaluate(), which is a scheduled whole-estate sweep.
declare v_code text;
begin
  -- Only the rules a selling app can act on. An expiry warning is for
  -- a shop manager; a stockout is for whatever is taking orders.
  if new.rule_code not in ('WILL_RUN_OUT','BELOW_REORDER','OUT_OF_STOCK') then
    return null;
  end if;

  select sku_code into v_code from catalog.product where id = new.product_id;

  perform platform.emit_event(
    'stock.low',
    jsonb_build_object(
      'alert_id',    new.id,
      'rule',        new.rule_code,
      'severity',    new.severity,
      'title',       new.title,
      'product_id',  new.product_id,
      'sku_code',    v_code,
      'location_id', new.location_id,
      'detail',      new.detail,
      'raised_at',   new.raised_at),
    'alert:' || new.id);

  return null;
end $$;

create trigger alert_emits_stock_low
  after insert on alerting.alert
  for each row execute function platform.emit_stock_low();

-- ─────────────── reservation.expired ───────────────
--
-- The one event a selling app most needs. A hold that lapsed means
-- stock came back and can be sold again — and if the app never hears,
-- it goes on showing the item as unavailable.

create or replace function platform.emit_reservation_expired()
returns trigger
language plpgsql
security definer
set search_path = platform, stock, public
as $$
-- @no-scope-check: a trigger on stock.reservation. The sweep that
-- fires it runs over every location by design.
begin
  if new.status <> 'RELEASED' or old.status = 'RELEASED' then return null; end if;
  if coalesce(new.released_reason, '') <> 'expired' then return null; end if;

  perform platform.emit_event(
    'reservation.expired',
    jsonb_build_object(
      'reservation_id', new.id,
      'order_ref',      new.order_ref,
      'product_id',     new.product_id,
      'location_id',    new.location_id,
      'quantity',       new.quantity,
      'released_at',    now()),
    'reservation:' || new.id || ':expired');

  return null;
end $$;

create trigger reservation_emits_expired
  after update on stock.reservation
  for each row execute function platform.emit_reservation_expired();
