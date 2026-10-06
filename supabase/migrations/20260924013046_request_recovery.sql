-- Extend the existing intake journal. Google Tasks remains the task truth source.
alter table public.personal_os_intake_audit
  add column if not exists request_payload jsonb,
  add column if not exists received_at timestamptz,
  add column if not exists account_subject text,
  add column if not exists target_object_id text,
  add column if not exists operation_version bigint,
  add column if not exists stage text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists lease_owner uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists recovery_version bigint not null default 0,
  add column if not exists provider_attempted boolean not null default false,
  add column if not exists error_code text,
  add column if not exists last_verified_at timestamptz;

update public.personal_os_intake_audit
set received_at = coalesce(received_at, created_at),
    operation_version = coalesce(operation_version, floor(extract(epoch from created_at) * 1000000)::bigint),
    stage = coalesce(stage, case when status = 'succeeded' and object_id is not null then 'task_verified' else 'needs_input' end)
where received_at is null or operation_version is null or stage is null;

alter table public.personal_os_intake_audit
  alter column received_at set default now(),
  alter column received_at set not null,
  alter column operation_version set not null,
  alter column stage set default 'received',
  alter column stage set not null;

create sequence if not exists public.personal_os_intake_operation_version_seq;
revoke all on sequence public.personal_os_intake_operation_version_seq from public, anon, authenticated;
grant usage, select on sequence public.personal_os_intake_operation_version_seq to service_role;
select setval('public.personal_os_intake_operation_version_seq',
  greatest(coalesce((select max(operation_version) from public.personal_os_intake_audit), 0),
    floor(extract(epoch from clock_timestamp()) * 1000000)::bigint));
alter table public.personal_os_intake_audit
  alter column operation_version set default nextval('public.personal_os_intake_operation_version_seq');

create or replace function public.personal_os_intake_advance_operation_version()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if new.request_payload is distinct from old.request_payload then
    new.operation_version := nextval('public.personal_os_intake_operation_version_seq');
  end if;
  return new;
end;
$$;
revoke all on function public.personal_os_intake_advance_operation_version() from public, anon, authenticated;
grant execute on function public.personal_os_intake_advance_operation_version() to service_role;
drop trigger if exists personal_os_intake_advance_operation_version on public.personal_os_intake_audit;
create trigger personal_os_intake_advance_operation_version
before update on public.personal_os_intake_audit
for each row execute function public.personal_os_intake_advance_operation_version();

alter table public.personal_os_intake_audit
  add constraint personal_os_intake_recovery_stage_check check (stage in (
    'received','needs_input','write_pending','outcome_unknown','task_verified',
    'projection_pending','reminder_verified','auth_required','missed',
    'unsupported','superseded','cancelled','request_verified'
  )),
  add constraint personal_os_intake_retry_count_check check (retry_count >= 0);

alter table public.personal_os_intake_audit
  drop constraint if exists personal_os_intake_audit_classification_check;
alter table public.personal_os_intake_audit
  add constraint personal_os_intake_audit_classification_check check (classification in (
    'task','goal','plan','long_term_item','financial_item','calendar_event',
    'project_data','contact','client','knowledge','gpt_job'
  ));

create index if not exists personal_os_intake_recovery_due_idx
on public.personal_os_intake_audit (owner_id, stage, next_retry_at, lease_expires_at);

create index if not exists personal_os_intake_target_version_idx
on public.personal_os_intake_audit (owner_id, target_object_id, operation_version desc)
where target_object_id is not null;
