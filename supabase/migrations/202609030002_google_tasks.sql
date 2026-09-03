-- Google Tasks becomes the only source of truth for actionable tasks.
-- This table stores only encrypted OAuth credentials and the selected Google task list.

create table if not exists public.google_tasks_credentials (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token_encrypted bytea not null,
  tasklist_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_tasks_credentials enable row level security;
alter table public.google_tasks_credentials force row level security;
revoke all on table public.google_tasks_credentials from public, anon, authenticated;

create or replace function public.upsert_google_tasks_credentials(
  target_owner uuid,
  new_refresh_token text,
  new_tasklist_id text,
  encryption_key text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
begin
  if target_owner is null or new_refresh_token = '' or new_tasklist_id = '' or length(encryption_key) < 32 then
    raise exception 'Invalid Google credential input';
  end if;
  insert into public.google_tasks_credentials (owner_id, refresh_token_encrypted, tasklist_id)
  values (target_owner, pgp_sym_encrypt(new_refresh_token, encryption_key, 'cipher-algo=aes256'), new_tasklist_id)
  on conflict (owner_id) do update
    set refresh_token_encrypted = excluded.refresh_token_encrypted,
        tasklist_id = excluded.tasklist_id,
        updated_at = now();
end;
$$;

create or replace function public.read_google_tasks_credentials(
  target_owner uuid,
  encryption_key text
)
returns table(refresh_token text, tasklist_id text)
language sql
security definer
set search_path = pg_catalog, extensions, public
stable
as $$
  select pgp_sym_decrypt(c.refresh_token_encrypted, encryption_key), c.tasklist_id
  from public.google_tasks_credentials c
  where c.owner_id = target_owner;
$$;

revoke all on function public.upsert_google_tasks_credentials(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.read_google_tasks_credentials(uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_google_tasks_credentials(uuid, text, text, text) to service_role;
grant execute on function public.read_google_tasks_credentials(uuid, text) to service_role;
