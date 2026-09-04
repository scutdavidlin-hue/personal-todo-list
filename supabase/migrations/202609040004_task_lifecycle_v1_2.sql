-- Personal OS Task lifecycle metadata, durable idempotency, and audit history.
-- Google Tasks remains the only source of truth for active task content/status.

alter table public.task_schedule_metadata
  add column if not exists task_type text not null default 'task',
  add column if not exists parent_task_id text,
  add column if not exists follow_up_of text,
  add column if not exists follow_up_sequence integer not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text;

do $$
begin
  alter table public.task_schedule_metadata
    add constraint task_schedule_metadata_task_type_check
    check (task_type in ('task', 'follow_up'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.task_schedule_metadata
    add constraint task_schedule_metadata_follow_up_sequence_check
    check (follow_up_sequence between 1 and 99);
exception when duplicate_object then null;
end $$;

create index if not exists task_schedule_follow_up_idx
on public.task_schedule_metadata (owner_id, task_type, follow_up_of)
where deleted_at is null;

create index if not exists task_schedule_active_idx
on public.task_schedule_metadata (owner_id, google_task_id)
where deleted_at is null;

create table if not exists public.task_activity_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 1024),
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  action text not null check (action in ('update', 'complete', 'reopen', 'delete')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  request_hash text not null check (char_length(request_hash) = 64),
  source text not null default 'chatgpt' check (char_length(source) between 1 and 80),
  request_id text check (request_id is null or char_length(request_id) <= 200),
  old_value jsonb,
  new_value jsonb,
  status text not null default 'processing' check (status in ('processing', 'succeeded', 'failed')),
  response_status integer,
  response jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index if not exists task_activity_log_task_history_idx
on public.task_activity_log (owner_id, task_id, created_at desc);

drop trigger if exists task_activity_log_set_updated_at on public.task_activity_log;
create trigger task_activity_log_set_updated_at
before update on public.task_activity_log
for each row execute function public.set_updated_at();

alter table public.task_activity_log enable row level security;
alter table public.task_activity_log force row level security;
revoke all on table public.task_activity_log from public, anon, authenticated;
grant select, insert, update on table public.task_activity_log to service_role;

comment on table public.task_activity_log is
  'Durable idempotency ledger and Task lifecycle audit. Google Tasks remains the active task source of truth.';

comment on column public.task_schedule_metadata.deleted_at is
  'Soft-delete marker for inactive schedule/link metadata after the Google Task and Calendar projection are removed.';
