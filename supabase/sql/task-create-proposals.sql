-- DRAFT installable DDL; apply only to an authorized environment.
-- This task executes it ONLY in a disposable synthetic PostgreSQL database.
-- No schema is exposed to PostgREST and no role receives any new grant.
create schema if not exists task_create_private;
revoke all on schema task_create_private from public, anon, authenticated;

create table task_create_private.proposals (
  id uuid primary key,
  group_id uuid not null,
  version integer not null check (version > 0),
  preview_id uuid not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_subject text not null check (length(account_subject) between 1 and 300),
  conversation_id text not null check (length(conversation_id) between 1 and 300),
  execution_json text not null check (octet_length(execution_json) <= 65536),
  scope_digest text not null check (scope_digest = encode(sha256(convert_to(execution_json, 'UTF8')), 'hex')),
  intake_input jsonb not null,
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','claimed','dispatching','applied','rejected','unknown','revoked','superseded')),
  claim_token uuid,
  receipt jsonb,
  unique (group_id, version),
  check (status not in ('claimed','dispatching','applied','unknown') or claim_token is not null),
  check (jsonb_typeof(execution_json::jsonb) = 'object'),
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes')
);
create index proposal_owner_history on task_create_private.proposals (owner_id, account_subject, created_at desc);

create table task_create_private.reply_events (
  authority text not null,
  event_id text not null,
  proposal_id uuid not null references task_create_private.proposals(id),
  owner_id uuid not null,
  account_subject text not null,
  conversation_id text not null,
  preview_id uuid not null,
  proposal_version integer not null,
  approved_digest text not null,
  proof_digest text not null check (proof_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  disposition text not null check (disposition in ('approve_exact','change_scope','question','reject')),
  primary key (authority, event_id)
);

create function task_create_private.protect_proposal() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if (to_jsonb(new) - array['status','claim_token','receipt']) is distinct from
     (to_jsonb(old) - array['status','claim_token','receipt']) then
    raise exception 'immutable proposal binding';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pending' and new.status in ('claimed','revoked','superseded')) or
    (old.status = 'claimed' and new.status in ('dispatching','revoked','superseded','unknown')) or
    (old.status = 'dispatching' and new.status in ('applied','rejected','unknown'))
  ) then raise exception 'invalid proposal transition'; end if;
  if old.status in ('applied','rejected','unknown','revoked','superseded') and new is distinct from old then
    raise exception 'terminal proposal is immutable';
  end if;
  if old.status <> 'pending' and new.claim_token is distinct from old.claim_token then
    raise exception 'claim token is immutable';
  end if;
  if new.receipt is distinct from old.receipt and not (old.status = 'dispatching' and new.status in ('applied','rejected','unknown')) then
    raise exception 'receipt requires dispatch outcome';
  end if;
  return new;
end $$;
create trigger proposal_immutable before update on task_create_private.proposals
for each row execute function task_create_private.protect_proposal();

create function task_create_private.protect_reply() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
begin raise exception 'reply evidence is immutable'; end $$;
create trigger reply_immutable before update on task_create_private.reply_events
for each row execute function task_create_private.protect_reply();

alter table task_create_private.proposals enable row level security;
alter table task_create_private.reply_events enable row level security;
revoke all on all tables in schema task_create_private from public, anon, authenticated;
revoke all on all functions in schema task_create_private from public, anon, authenticated;
-- No SECURITY DEFINER, client policy, key, grant, cron, live migration or deploy.
-- The server adapter requires an explicitly approved existing owner connection.
