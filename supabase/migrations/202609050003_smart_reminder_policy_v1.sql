-- Smart Reminder Policy V1.0.
-- Reminder state is attached to the existing one-to-one Schedule row. It is not a Task store.

alter table public.task_schedule_metadata
  add column if not exists deadline_time time without time zone,
  add column if not exists reminder_policy text not null default 'none',
  add column if not exists reminder_policy_source text not null default 'system_default',
  add column if not exists reminder_reason text,
  add column if not exists reminder_at timestamp without time zone,
  add column if not exists reminder_offset_minutes integer,
  add column if not exists reminder_type text,
  add column if not exists reminders jsonb not null default '[]'::jsonb,
  add column if not exists reminder_context jsonb not null default '{}'::jsonb,
  add column if not exists notification_channel text not null default 'google_calendar_popup',
  add column if not exists notification_status text not null default 'not_required';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_deadline_time_requires_date'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_deadline_time_requires_date
      check (deadline_time is null or deadline is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_policy_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_policy_valid
      check (reminder_policy in ('none', 'smart', 'custom'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_source_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_source_valid
      check (reminder_policy_source in ('user_explicit', 'ai_inferred', 'system_default'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_type_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_type_valid
      check (reminder_type is null or reminder_type in ('preparation', 'departure', 'event'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_offset_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_offset_valid
      check (reminder_offset_minutes is null or reminder_offset_minutes between 0 and 40320);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_primary_consistent'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_primary_consistent
      check (
        (reminder_at is null and reminder_offset_minutes is null and reminder_type is null)
        or
        (reminder_at is not null and reminder_offset_minutes is not null and reminder_type is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminders_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminders_valid
      check (jsonb_typeof(reminders) = 'array' and jsonb_array_length(reminders) <= 3);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_reminder_context_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_reminder_context_valid
      check (jsonb_typeof(reminder_context) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_notification_channel_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_notification_channel_valid
      check (notification_channel in ('google_calendar_popup', 'google_calendar_email'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_schedule_metadata'::regclass
      and conname = 'task_schedule_notification_status_valid'
  ) then
    alter table public.task_schedule_metadata
      add constraint task_schedule_notification_status_valid
      check (notification_status in ('not_required', 'pending_projection', 'projected', 'projection_failed', 'disabled'));
  end if;
end
$$;

create index if not exists task_schedule_next_reminder_idx
on public.task_schedule_metadata (owner_id, reminder_at)
where reminder_at is not null
  and notification_status in ('pending_projection', 'projected');

comment on column public.task_schedule_metadata.deadline_time is
  'Exact hard-deadline wall-clock time. This is distinct from Task due date and scheduled execution time.';
comment on column public.task_schedule_metadata.reminder_policy is
  'none, smart, or custom policy attached to this canonical Schedule.';
comment on column public.task_schedule_metadata.reminder_policy_source is
  'Policy precedence source: user_explicit, ai_inferred, or system_default.';
comment on column public.task_schedule_metadata.reminders is
  'At most three Calendar reminder override specs; never independent Tasks or Events.';
comment on column public.task_schedule_metadata.notification_status is
  'Calendar projection status only. It does not claim that an iPhone displayed or delivered the notification.';
