-- Task-bound conversation proposals, immutable history, and request idempotency.
-- Google Tasks remains the sole Task content/status source of truth. These
-- tables store only interaction control state and audit evidence.

create table if not exists public.task_conversation_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 1024),
  request_id text not null check (char_length(request_id) between 1 and 160),
  request_hash text not null check (char_length(request_hash) = 64),
  status text not null default 'processing' check (status in ('processing', 'succeeded', 'failed')),
  response_status integer,
  response jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, request_id)
);

create table if not exists public.task_conversation_pending_changes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 1024),
  task_version text not null check (char_length(task_version) between 1 and 10000),
  task_snapshot jsonb not null,
  intent text not null check (char_length(intent) between 1 and 80),
  confidence numeric(5, 4) check (confidence is null or confidence between 0 and 1),
  proposed_changes jsonb not null default '{}'::jsonb,
  changes jsonb not null default '{}'::jsonb,
  raw_input text not null check (char_length(raw_input) between 1 and 10000),
  message text,
  request_id text not null check (char_length(request_id) between 1 and 160),
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'committing', 'applied', 'discarded', 'superseded', 'failed')),
  executor_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_conversation_one_active_change
on public.task_conversation_pending_changes (owner_id, task_id)
where status in ('awaiting_confirmation', 'committing', 'failed');

create index if not exists task_conversation_pending_history
on public.task_conversation_pending_changes (owner_id, task_id, created_at desc);

create table if not exists public.task_conversation_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 1024),
  event_type text not null check (event_type in (
    'proposal_created', 'clarification_requested', 'proposal_discarded',
    'execution_succeeded', 'execution_failed', 'context_appended', 'no_change'
  )),
  source text not null check (source in ('text', 'voice')),
  raw_input text not null check (char_length(raw_input) between 1 and 10000),
  transcript text,
  parsed_intent jsonb,
  confidence numeric(5, 4) check (confidence is null or confidence between 0 and 1),
  before_state jsonb,
  proposed_state jsonb,
  confirmation boolean,
  after_state jsonb,
  executor_result jsonb,
  proposal_id uuid references public.task_conversation_pending_changes(id) on delete set null,
  request_id text not null check (char_length(request_id) between 1 and 160),
  message text,
  created_at timestamptz not null default now()
);

create index if not exists task_conversation_events_timeline
on public.task_conversation_events (owner_id, task_id, created_at, id);

drop trigger if exists task_conversation_requests_set_updated_at on public.task_conversation_requests;
create trigger task_conversation_requests_set_updated_at
before update on public.task_conversation_requests
for each row execute function public.set_updated_at();

drop trigger if exists task_conversation_pending_set_updated_at on public.task_conversation_pending_changes;
create trigger task_conversation_pending_set_updated_at
before update on public.task_conversation_pending_changes
for each row execute function public.set_updated_at();

create or replace function public.reject_task_conversation_event_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'task_conversation_events is immutable';
end;
$$;

drop trigger if exists task_conversation_events_immutable on public.task_conversation_events;
create trigger task_conversation_events_immutable
before update or delete on public.task_conversation_events
for each row execute function public.reject_task_conversation_event_mutation();

alter table public.task_conversation_requests enable row level security;
alter table public.task_conversation_requests force row level security;
alter table public.task_conversation_pending_changes enable row level security;
alter table public.task_conversation_pending_changes force row level security;
alter table public.task_conversation_events enable row level security;
alter table public.task_conversation_events force row level security;

drop policy if exists task_conversation_requests_owner_select on public.task_conversation_requests;
create policy task_conversation_requests_owner_select on public.task_conversation_requests
for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists task_conversation_pending_owner_select on public.task_conversation_pending_changes;
create policy task_conversation_pending_owner_select on public.task_conversation_pending_changes
for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists task_conversation_events_owner_select on public.task_conversation_events;
create policy task_conversation_events_owner_select on public.task_conversation_events
for select to authenticated using ((select auth.uid()) = owner_id);

revoke all on table public.task_conversation_requests from public, anon, authenticated;
revoke all on table public.task_conversation_pending_changes from public, anon, authenticated;
revoke all on table public.task_conversation_events from public, anon, authenticated;
grant select on table public.task_conversation_requests to authenticated;
grant select on table public.task_conversation_pending_changes to authenticated;
grant select on table public.task_conversation_events to authenticated;
grant select, insert, update on table public.task_conversation_requests to service_role;
grant select, insert, update on table public.task_conversation_pending_changes to service_role;
grant select, insert on table public.task_conversation_events to service_role;

create or replace function public.begin_task_conversation_request(
  target_owner uuid,
  target_task_id text,
  target_request_id text,
  target_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.task_conversation_requests;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_owner::text || ':' || target_request_id, 0));
  select * into existing
  from public.task_conversation_requests
  where owner_id = target_owner and request_id = target_request_id
  for update;

  if found then
    if existing.request_hash <> target_request_hash then
      return jsonb_build_object('state', 'conflict');
    end if;
    if existing.status = 'succeeded' then
      return jsonb_build_object(
        'state', 'replay',
        'response', existing.response,
        'response_status', existing.response_status
      );
    end if;
    if existing.status = 'failed' then
      update public.task_conversation_requests
      set status = 'processing', response_status = null, response = null, error = null
      where id = existing.id;
      return jsonb_build_object('state', 'retry');
    end if;
    return jsonb_build_object('state', 'processing');
  end if;

  insert into public.task_conversation_requests (
    owner_id, task_id, request_id, request_hash, status
  ) values (
    target_owner, target_task_id, target_request_id, target_request_hash, 'processing'
  );
  return jsonb_build_object('state', 'new');
end;
$$;

create or replace function public.finish_task_conversation_request(
  target_owner uuid,
  target_request_id text,
  target_status text,
  target_response_status integer,
  target_response jsonb,
  target_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if target_status not in ('succeeded', 'failed') then
    raise exception 'invalid request terminal status';
  end if;
  update public.task_conversation_requests
  set status = target_status,
      response_status = target_response_status,
      response = target_response,
      error = target_error
  where owner_id = target_owner and request_id = target_request_id and status = 'processing';
  if not found then raise exception 'conversation request is not processing'; end if;
end;
$$;

create or replace function public.replace_task_conversation_pending(
  target_owner uuid,
  target_proposal_id uuid,
  target_task_id text,
  target_task_version text,
  target_task_snapshot jsonb,
  target_intent text,
  target_confidence numeric,
  target_proposed_changes jsonb,
  target_changes jsonb,
  target_raw_input text,
  target_request_id text,
  target_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
  created public.task_conversation_pending_changes;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_owner::text || ':' || target_task_id, 0));
  select status into current_status
  from public.task_conversation_pending_changes
  where owner_id = target_owner and task_id = target_task_id
    and status in ('awaiting_confirmation', 'committing', 'failed')
  for update;
  if current_status = 'committing' then raise exception 'a proposal is already committing'; end if;

  update public.task_conversation_pending_changes
  set status = 'superseded', executor_result = jsonb_build_object('reason', 'replaced_by_new_proposal')
  where owner_id = target_owner and task_id = target_task_id
    and status in ('awaiting_confirmation', 'failed');

  insert into public.task_conversation_pending_changes (
    id, owner_id, task_id, task_version, task_snapshot, intent, confidence,
    proposed_changes, changes, raw_input, request_id, message
  ) values (
    target_proposal_id, target_owner, target_task_id, target_task_version,
    target_task_snapshot, target_intent, target_confidence,
    coalesce(target_proposed_changes, '{}'::jsonb), coalesce(target_changes, '{}'::jsonb),
    target_raw_input, target_request_id, target_message
  ) returning * into created;
  return to_jsonb(created);
end;
$$;

create or replace function public.claim_task_conversation_pending(
  target_owner uuid,
  target_proposal_id uuid,
  target_task_id text,
  target_task_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.task_conversation_pending_changes;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_owner::text || ':' || target_task_id, 0));
  select * into existing
  from public.task_conversation_pending_changes
  where id = target_proposal_id and owner_id = target_owner and task_id = target_task_id
  for update;
  if not found then return jsonb_build_object('state', 'stale'); end if;
  if existing.task_version <> target_task_version then return jsonb_build_object('state', 'stale'); end if;
  if existing.status = 'applied' then return jsonb_build_object('state', 'applied', 'pending', to_jsonb(existing)); end if;
  if existing.status = 'committing' then return jsonb_build_object('state', 'processing', 'pending', to_jsonb(existing)); end if;
  if existing.status not in ('awaiting_confirmation', 'failed') then return jsonb_build_object('state', 'stale'); end if;

  update public.task_conversation_pending_changes
  set status = 'committing'
  where id = existing.id
  returning * into existing;
  return jsonb_build_object('state', 'claimed', 'pending', to_jsonb(existing));
end;
$$;

create or replace function public.finalize_task_conversation_pending(
  target_owner uuid,
  target_proposal_id uuid,
  target_status text,
  target_executor_result jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.task_conversation_pending_changes;
begin
  if target_status not in ('applied', 'discarded', 'superseded', 'failed') then
    raise exception 'invalid proposal terminal status';
  end if;
  select * into existing
  from public.task_conversation_pending_changes
  where id = target_proposal_id and owner_id = target_owner
  for update;
  if not found then raise exception 'proposal not found'; end if;
  if existing.status = 'applied' then return to_jsonb(existing); end if;
  if existing.status = 'committing' and target_status in ('discarded', 'superseded') then raise exception 'cannot discard a committing proposal'; end if;
  if (target_status in ('applied', 'failed') and existing.status <> 'committing')
    or (target_status in ('discarded', 'superseded') and existing.status not in ('awaiting_confirmation', 'failed')) then
    raise exception 'proposal is already terminal';
  end if;
  update public.task_conversation_pending_changes
  set status = target_status, executor_result = target_executor_result
  where id = existing.id
  returning * into existing;
  return to_jsonb(existing);
end;
$$;

revoke all on function public.begin_task_conversation_request(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.finish_task_conversation_request(uuid, text, text, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.replace_task_conversation_pending(uuid, uuid, text, text, jsonb, text, numeric, jsonb, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_task_conversation_pending(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finalize_task_conversation_pending(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_task_conversation_request(uuid, text, text, text) to service_role;
grant execute on function public.finish_task_conversation_request(uuid, text, text, integer, jsonb, text) to service_role;
grant execute on function public.replace_task_conversation_pending(uuid, uuid, text, text, jsonb, text, numeric, jsonb, jsonb, text, text, text) to service_role;
grant execute on function public.claim_task_conversation_pending(uuid, uuid, text, text) to service_role;
grant execute on function public.finalize_task_conversation_pending(uuid, uuid, text, jsonb) to service_role;

alter table public.task_activity_log drop constraint if exists task_activity_log_action_check;
alter table public.task_activity_log
  add constraint task_activity_log_action_check
  check (action in ('update', 'complete', 'reopen', 'cancel', 'delete'));

comment on table public.task_conversation_pending_changes is
  'Uncommitted Task conversation proposals only; never a second Task content/status store.';
comment on table public.task_conversation_events is
  'Immutable Task conversation and execution audit timeline.';
