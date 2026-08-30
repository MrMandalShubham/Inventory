-- ============================================================
-- 0002 — The audit log
--
-- Invariant 2: nothing is ever deleted. This table records every
-- field change on every entity that is not a quantity (quantities
-- live in the stock ledger, built in Phase 2).
--
-- Append-only is enforced by a trigger, not by convention. Not even
-- an admin can rewrite history — the database refuses (docs/08 §3).
-- ============================================================

create table platform.audit_log (
  id            bigint generated always as identity primary key,

  entity_schema text not null,
  entity_table  text not null,
  entity_id     text not null,

  action        text not null check (action in ('INSERT','UPDATE','DELETE')),
  field         text,               -- null for INSERT and DELETE
  old_value     text,
  new_value     text,

  actor_id      uuid,               -- which human
  actor_app_id  uuid,               -- via which application
  occurred_at   timestamptz not null default now()
);

create index audit_entity_idx on platform.audit_log (entity_schema, entity_table, entity_id, occurred_at desc);
create index audit_actor_idx  on platform.audit_log (actor_id, occurred_at desc);

-- ───────────────── append-only, enforced ─────────────────

create or replace function platform.refuse_mutation()
returns trigger language plpgsql as $$
begin
  raise exception
    'APPEND_ONLY: % on %.% is refused — this table is the evidence base, corrections are new rows',
    tg_op, tg_table_schema, tg_table_name
    using errcode = '42501';
end $$;

create trigger audit_log_no_update
  before update on platform.audit_log
  for each row execute function platform.refuse_mutation();

create trigger audit_log_no_delete
  before delete on platform.audit_log
  for each row execute function platform.refuse_mutation();

-- ───────────────── the recording trigger ─────────────────
--
-- One row per changed field, so "who changed this setting" is a
-- lookup rather than a diff of two JSON blobs.

create or replace function platform.record_audit()
returns trigger language plpgsql security definer
set search_path = platform, public
as $$
-- @no-scope-check: a trigger has no location argument; it records
-- whatever change already passed the policies on its own table.
declare
  v_old jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_id  text  := coalesce(v_new ->> 'id', v_old ->> 'id');
  k     text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      -- updated_at changes on every write and says nothing
      if k = 'updated_at' then continue; end if;
      if v_old -> k is distinct from v_new -> k then
        insert into platform.audit_log
          (entity_schema, entity_table, entity_id, action, field, old_value, new_value, actor_id)
        values
          (tg_table_schema, tg_table_name, v_id, 'UPDATE', k,
           v_old ->> k, v_new ->> k, platform.current_user_id());
      end if;
    end loop;
  else
    insert into platform.audit_log
      (entity_schema, entity_table, entity_id, action, field, old_value, new_value, actor_id)
    values
      (tg_table_schema, tg_table_name, v_id, tg_op, null,
       nullif(v_old::text, '{}'), nullif(v_new::text, '{}'), platform.current_user_id());
  end if;
  return null;
end $$;

create trigger app_user_audit
  after insert or update or delete on platform.app_user
  for each row execute function platform.record_audit();

create trigger location_audit
  after insert or update or delete on platform.location
  for each row execute function platform.record_audit();

create trigger api_client_audit
  after insert or update or delete on platform.api_client
  for each row execute function platform.record_audit();

-- ───────────────── reading it ─────────────────

alter table platform.audit_log enable row level security;

-- Admin and finance may read the trail. Nobody may write it through
-- SQL — only the trigger, which runs as definer.
create policy audit_read on platform.audit_log
  for select using (platform.current_role_name() in ('admin','finance'));
