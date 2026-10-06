-- Recurrence is Schedule metadata. Google Tasks remains the only source of
-- task content and completion; each occurrence owns one ordinary Google Task.
create table public.task_schedule_series (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  anchor_task_id text not null check (char_length(anchor_task_id) between 1 and 1024),
  current_task_id text not null check (char_length(current_task_id) between 1 and 1024),
  "current_date" date not null,
  recurrence_kind text not null check (recurrence_kind in ('daily', 'weekly')),
  timezone text not null check (char_length(timezone) between 1 and 80),
  local_time time without time zone not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  pending_date date,
  creation_started boolean not null default false,
  lease_token uuid,
  lease_until timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, anchor_task_id),
  unique (id, owner_id),
  check (pending_date is null or pending_date > "current_date")
);

create table public.task_schedule_occurrence (
  series_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  occurrence_date date not null,
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  created_at timestamptz not null default now(),
  primary key (series_id, occurrence_date),
  unique (owner_id, google_task_id),
  foreign key (series_id, owner_id) references public.task_schedule_series(id, owner_id) on delete cascade
);

create index task_schedule_series_current_idx on public.task_schedule_series (owner_id, current_task_id) where status = 'active';
create index task_schedule_series_pending_idx on public.task_schedule_series (owner_id, pending_date) where pending_date is not null;

create trigger task_schedule_series_set_updated_at before update on public.task_schedule_series
for each row execute function public.set_updated_at();

alter table public.task_schedule_series enable row level security;
alter table public.task_schedule_series force row level security;
alter table public.task_schedule_occurrence enable row level security;
alter table public.task_schedule_occurrence force row level security;
revoke all on public.task_schedule_series, public.task_schedule_occurrence from public, anon, authenticated;
grant select, insert, update on public.task_schedule_series, public.task_schedule_occurrence to service_role;

create function public.claim_task_schedule_series(
  target_owner uuid, target_series uuid, expected_task text, proposed_date date, claim_token uuid
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare row_value public.task_schedule_series%rowtype;
begin
  update public.task_schedule_series as s
  set pending_date = coalesce(s.pending_date, proposed_date),
      lease_token = claim_token,
      lease_until = now() + interval '90 seconds'
  where s.id = target_series and s.owner_id = target_owner and s.status = 'active'
    and s.current_task_id = expected_task and proposed_date > s."current_date"
    and (s.lease_until is null or s.lease_until < now() or s.lease_token = claim_token)
  returning s.* into row_value;
  if not found then return jsonb_build_object('claimed', false); end if;
  return to_jsonb(row_value) || jsonb_build_object('claimed', true);
end $$;

create function public.mark_task_schedule_creation_started(
  target_owner uuid, target_series uuid, claim_token uuid
) returns boolean language plpgsql security invoker set search_path = public as $$
begin
  update public.task_schedule_series
  set creation_started = true
  where id = target_series and owner_id = target_owner and status = 'active'
    and lease_token = claim_token and lease_until > now() and pending_date is not null
    and creation_started = false;
  return found;
end $$;

create function public.finish_task_schedule_occurrence(
  target_owner uuid, target_series uuid, claim_token uuid, next_task text
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare row_value public.task_schedule_series%rowtype;
begin
  select * into row_value from public.task_schedule_series
  where id = target_series and owner_id = target_owner for update;
  if not found or row_value.status <> 'active' or row_value.lease_token is distinct from claim_token
    or row_value.pending_date is null or row_value.lease_until <= now() then
    return jsonb_build_object('finished', false);
  end if;
  insert into public.task_schedule_occurrence(series_id, owner_id, occurrence_date, google_task_id)
  values (target_series, target_owner, row_value.pending_date, next_task)
  on conflict (series_id, occurrence_date) do nothing;
  if not exists (select 1 from public.task_schedule_occurrence
    where series_id = target_series and occurrence_date = row_value.pending_date and google_task_id = next_task) then
    return jsonb_build_object('finished', false);
  end if;
  update public.task_schedule_series set current_task_id = next_task,
    "current_date" = row_value.pending_date, pending_date = null,
    creation_started = false, lease_token = null, lease_until = null
  where id = target_series;
  return jsonb_build_object('finished', true, 'occurrence_date', row_value.pending_date);
end $$;

revoke all on function public.claim_task_schedule_series(uuid, uuid, text, date, uuid) from public, anon, authenticated;
revoke all on function public.mark_task_schedule_creation_started(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_task_schedule_occurrence(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_task_schedule_series(uuid, uuid, text, date, uuid) to service_role;
grant execute on function public.mark_task_schedule_creation_started(uuid, uuid, uuid) to service_role;
grant execute on function public.finish_task_schedule_occurrence(uuid, uuid, uuid, text) to service_role;
