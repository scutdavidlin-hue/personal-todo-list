-- Expand the existing Schedule-backed recurrence model without creating a
-- second Task store. Google Tasks remains content/completion truth.
alter table public.task_schedule_series
  drop constraint if exists task_schedule_series_recurrence_kind_check,
  drop constraint if exists task_schedule_series_status_check;

alter table public.task_schedule_series
  add column if not exists rrule text,
  add column if not exists recurrence_interval integer not null default 1,
  add column if not exists by_weekday smallint,
  add column if not exists by_month_day smallint,
  add column if not exists by_month smallint,
  add column if not exists next_date_override date,
  add column if not exists skip_date date,
  add column if not exists paused_at timestamptz,
  add column if not exists resumed_at timestamptz;

alter table public.task_schedule_series alter column local_time drop not null;

update public.task_schedule_series
set rrule = case recurrence_kind
  when 'daily' then 'FREQ=DAILY'
  when 'weekly' then 'FREQ=WEEKLY;BYDAY=' ||
    (array['SU','MO','TU','WE','TH','FR','SA'])[extract(dow from "current_date")::integer + 1]
  else rrule
end,
by_weekday = case when recurrence_kind = 'weekly' then extract(dow from "current_date")::smallint else by_weekday end
where rrule is null;

alter table public.task_schedule_series
  alter column rrule set not null,
  add constraint task_schedule_series_recurrence_kind_check check (recurrence_kind in ('daily', 'weekly', 'monthly', 'yearly')),
  add constraint task_schedule_series_status_check check (status in ('active', 'paused', 'cancelled')),
  add constraint task_schedule_series_recurrence_interval_check check (recurrence_interval between 1 and 365),
  add constraint task_schedule_series_by_weekday_check check (by_weekday is null or by_weekday between 0 and 6),
  add constraint task_schedule_series_by_month_day_check check (by_month_day is null or by_month_day between 1 and 31),
  add constraint task_schedule_series_by_month_check check (by_month is null or by_month between 1 and 12),
  add constraint task_schedule_series_next_override_check check (next_date_override is null or next_date_override > "current_date"),
  add constraint task_schedule_series_skip_date_check check (skip_date is null or skip_date > "current_date");

alter table public.task_schedule_occurrence
  alter column google_task_id drop not null,
  add column if not exists instance_status text not null default 'task',
  add column if not exists recurring_rule_id uuid generated always as (series_id) stored,
  add column if not exists recurrence_instance_date date generated always as (occurrence_date) stored;

alter table public.task_schedule_occurrence
  add constraint task_schedule_occurrence_instance_status_check check (instance_status in ('task', 'skipped')),
  add constraint task_schedule_occurrence_task_shape_check check (
    (instance_status = 'task' and google_task_id is not null)
    or (instance_status = 'skipped' and google_task_id is null)
  );

create unique index if not exists task_schedule_occurrence_rule_instance_uidx
  on public.task_schedule_occurrence (recurring_rule_id, recurrence_instance_date);

create or replace function public.finish_task_schedule_occurrence(
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
  insert into public.task_schedule_occurrence(series_id, owner_id, occurrence_date, google_task_id, instance_status)
  values (target_series, target_owner, row_value.pending_date, next_task, 'task')
  on conflict (series_id, occurrence_date) do nothing;
  if not exists (select 1 from public.task_schedule_occurrence
    where series_id = target_series and occurrence_date = row_value.pending_date
      and google_task_id = next_task and instance_status = 'task') then
    return jsonb_build_object('finished', false);
  end if;
  update public.task_schedule_series set current_task_id = next_task,
    "current_date" = row_value.pending_date, pending_date = null,
    skip_date = case when skip_date is not null and skip_date <= row_value.pending_date then null else skip_date end,
    next_date_override = null,
    creation_started = false, lease_token = null, lease_until = null
  where id = target_series;
  return jsonb_build_object('finished', true, 'occurrence_date', row_value.pending_date);
end $$;

revoke all on function public.finish_task_schedule_occurrence(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_task_schedule_occurrence(uuid, uuid, uuid, text) to service_role;
