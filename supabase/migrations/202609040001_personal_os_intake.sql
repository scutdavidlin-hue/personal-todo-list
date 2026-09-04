-- Durable idempotency and audit trail for the Personal OS intake gateway.
-- Google Tasks remains the only source of truth for actionable task state.

create table if not exists public.personal_os_intake_audit (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  request_hash text not null check (char_length(request_hash) = 64),
  source text not null check (char_length(source) between 1 and 80),
  raw_text text not null check (char_length(raw_text) between 1 and 10000),
  classification text not null check (classification in ('task', 'calendar_event', 'project_data', 'knowledge', 'gpt_job')),
  destination text not null,
  object_id text,
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  error text,
  response_status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index if not exists personal_os_intake_audit_created_at_idx
on public.personal_os_intake_audit (created_at desc);

drop trigger if exists personal_os_intake_audit_set_updated_at on public.personal_os_intake_audit;
create trigger personal_os_intake_audit_set_updated_at
before update on public.personal_os_intake_audit
for each row execute function public.set_updated_at();

alter table public.personal_os_intake_audit enable row level security;
alter table public.personal_os_intake_audit force row level security;
revoke all on table public.personal_os_intake_audit from public, anon, authenticated;
grant select, insert, update on table public.personal_os_intake_audit to service_role;
