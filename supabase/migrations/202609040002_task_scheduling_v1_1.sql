-- V1.1 schedule metadata for Google Tasks.
-- This table deliberately does not store task title, notes, completion state, or completed_at.

create table if not exists public.task_schedule_metadata (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  scheduled_date date,
  scheduled_start time without time zone,
  scheduled_end time without time zone,
  timezone text not null default 'Asia/Shanghai' check (char_length(timezone) between 1 and 80),
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 720),
  scheduling_status text not null default 'unscheduled'
    check (scheduling_status in ('unscheduled', 'scheduled', 'rescheduled', 'backlog', 'waiting', 'cancelled')),
  scheduling_source text not null default 'gpt_inferred'
    check (scheduling_source in ('explicit_user', 'gpt_inferred', 'morning_plan', 'rescheduled')),
  calendar_id text not null default 'primary' check (char_length(calendar_id) between 1 and 1024),
  calendar_event_id text,
  fixed_time boolean not null default false,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  deadline date,
  previous_scheduled_date date,
  rescheduled_at timestamptz,
  cancelled_at timestamptz,
  sync_required boolean not null default true,
  last_sync_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, google_task_id),
  check ((scheduled_start is null and scheduled_end is null) or
         (scheduled_date is not null and scheduled_start is not null and scheduled_end is not null and scheduled_end > scheduled_start)),
  check (calendar_event_id is null or char_length(calendar_event_id) between 5 and 1024)
);

create unique index if not exists task_schedule_calendar_event_unique
on public.task_schedule_metadata (owner_id, calendar_id, calendar_event_id)
where calendar_event_id is not null;

create index if not exists task_schedule_due_idx
on public.task_schedule_metadata (owner_id, scheduled_date, scheduling_status);

create index if not exists task_schedule_sync_idx
on public.task_schedule_metadata (owner_id, sync_required)
where sync_required = true;

drop trigger if exists task_schedule_metadata_set_updated_at on public.task_schedule_metadata;
create trigger task_schedule_metadata_set_updated_at
before update on public.task_schedule_metadata
for each row execute function public.set_updated_at();

alter table public.task_schedule_metadata enable row level security;
alter table public.task_schedule_metadata force row level security;
revoke all on table public.task_schedule_metadata from public, anon, authenticated;
grant select, insert, update on table public.task_schedule_metadata to service_role;

comment on table public.task_schedule_metadata is
  'One-to-one scheduling metadata for Google Tasks. Google Tasks remains the task and completion source of truth.';
