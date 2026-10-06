-- Additive provider state. The credential row remains the only durable refresh-token store.
alter table public.google_tasks_credentials
  add column if not exists google_subject text;

create table if not exists public.google_auth_refresh_state (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  access_token_encrypted bytea,
  access_expires_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  tasks_health text not null default 'unknown',
  calendar_health text not null default 'unknown',
  capability_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint google_auth_tasks_health_check check (tasks_health in ('unknown', 'ok', 'scope_missing', 'unavailable')),
  constraint google_auth_calendar_health_check check (calendar_health in ('unknown', 'ok', 'scope_missing', 'unavailable'))
);

alter table public.google_auth_refresh_state enable row level security;
alter table public.google_auth_refresh_state force row level security;
revoke all on table public.google_auth_refresh_state from public, anon, authenticated;
grant select, insert, update on table public.google_auth_refresh_state to service_role;
grant select, insert, update on table public.google_tasks_credentials to service_role;

create function public.read_google_auth_credentials(target_owner uuid, encryption_key text)
returns table(refresh_token text, tasklist_id text, google_subject text,
              tasks_health text, calendar_health text, capability_checked_at timestamptz,
              last_success_at timestamptz, last_error_code text)
language sql stable security invoker set search_path = pg_catalog, extensions, public
as $$
  select pgp_sym_decrypt(c.refresh_token_encrypted, encryption_key), c.tasklist_id,
         c.google_subject, coalesce(s.tasks_health, 'unknown'),
         coalesce(s.calendar_health, 'unknown'), s.capability_checked_at,
         s.last_success_at, s.last_error_code
  from public.google_tasks_credentials c
  left join public.google_auth_refresh_state s on s.owner_id = c.owner_id
  where c.owner_id = target_owner and length(encryption_key) >= 32;
$$;

create function public.claim_google_auth_refresh(target_owner uuid, new_lease_id uuid, encryption_key text)
returns table(outcome text, access_token text, refresh_token text, tasklist_id text,
              google_subject text, retry_after_ms integer, tasks_health text,
              calendar_health text, capability_checked_at timestamptz,
              last_success_at timestamptz, last_error_code text)
language plpgsql security invoker set search_path = pg_catalog, extensions, public
as $$
declare s public.google_auth_refresh_state%rowtype;
declare c public.google_tasks_credentials%rowtype;
begin
  if target_owner is null or new_lease_id is null or length(encryption_key) < 32 then
    raise exception 'Invalid Google auth request';
  end if;
  insert into public.google_auth_refresh_state(owner_id) values(target_owner)
    on conflict (owner_id) do nothing;
  select * into s from public.google_auth_refresh_state where owner_id = target_owner for update;
  select * into c from public.google_tasks_credentials where owner_id = target_owner;
  if not found then
    return query select 'missing'::text, null::text, null::text, null::text, null::text, 0,
      s.tasks_health, s.calendar_health, s.capability_checked_at, s.last_success_at, s.last_error_code;
    return;
  end if;
  if s.access_token_encrypted is not null and s.access_expires_at > now() + interval '60 seconds' then
    return query select 'cached'::text, pgp_sym_decrypt(s.access_token_encrypted, encryption_key),
      null::text, c.tasklist_id, c.google_subject, 0,
      s.tasks_health, s.calendar_health, s.capability_checked_at, s.last_success_at, s.last_error_code;
    return;
  end if;
  if s.lease_id is not null and s.lease_expires_at > now() then
    return query select 'busy'::text, null::text, null::text, c.tasklist_id, c.google_subject,
      least(2000, greatest(100, (extract(epoch from (s.lease_expires_at - now())) * 1000)::integer)),
      s.tasks_health, s.calendar_health, s.capability_checked_at, s.last_success_at, s.last_error_code;
    return;
  end if;
  update public.google_auth_refresh_state
    set lease_id = new_lease_id, lease_expires_at = now() + interval '90 seconds', updated_at = now()
    where owner_id = target_owner;
  return query select 'claimed'::text, null::text,
    pgp_sym_decrypt(c.refresh_token_encrypted, encryption_key), c.tasklist_id, c.google_subject, 0,
    s.tasks_health, s.calendar_health, s.capability_checked_at, s.last_success_at, s.last_error_code;
end;
$$;

create function public.finish_google_auth_refresh(target_owner uuid, held_lease_id uuid,
  old_refresh_token text, new_refresh_token text, new_access_token text,
  expires_in_seconds integer, verified_google_subject text, encryption_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, extensions, public
as $$
declare c public.google_tasks_credentials%rowtype;
begin
  if target_owner is null or held_lease_id is null or old_refresh_token = ''
     or new_access_token = '' or length(encryption_key) < 32 then
    raise exception 'Invalid Google refresh result';
  end if;
  perform 1 from public.google_auth_refresh_state
    where owner_id = target_owner and lease_id = held_lease_id and lease_expires_at > now() for update;
  if not found then return false; end if;
  select * into c from public.google_tasks_credentials where owner_id = target_owner for update;
  if not found or pgp_sym_decrypt(c.refresh_token_encrypted, encryption_key) <> old_refresh_token
     or (c.google_subject is not null and verified_google_subject is not null
         and c.google_subject <> verified_google_subject) then
    return false;
  end if;
  update public.google_tasks_credentials
    set refresh_token_encrypted = case when nullif(new_refresh_token, '') is null
      then refresh_token_encrypted
      else pgp_sym_encrypt(new_refresh_token, encryption_key, 'cipher-algo=aes256') end,
      google_subject = coalesce(google_subject, nullif(verified_google_subject, '')),
      updated_at = now()
    where owner_id = target_owner;
  update public.google_auth_refresh_state
    set access_token_encrypted = pgp_sym_encrypt(new_access_token, encryption_key, 'cipher-algo=aes256'),
      access_expires_at = now() + make_interval(secs => greatest(1, least(3600, expires_in_seconds))),
      lease_id = null, lease_expires_at = null, last_success_at = now(), last_error_code = null,
      updated_at = now()
    where owner_id = target_owner;
  return true;
end;
$$;

create function public.fail_google_auth_refresh(target_owner uuid, held_lease_id uuid,
  safe_error_code text)
returns boolean language sql security invoker set search_path = pg_catalog, public
as $$
  with changed as (
    update public.google_auth_refresh_state
    set lease_id = null, lease_expires_at = null,
        last_error_code = left(coalesce(safe_error_code, 'GOOGLE_REFRESH_ERROR'), 80), updated_at = now()
    where owner_id = target_owner and lease_id = held_lease_id
    returning owner_id
  ) select exists(select 1 from changed);
$$;

-- Bind a legacy row only when this exact cached bearer token still belongs to
-- its current credential. A reconnect clears the cache under the same lock.
create function public.bind_google_auth_subject(target_owner uuid, expected_access_token text,
  verified_google_subject text, encryption_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, extensions, public
as $$
declare c public.google_tasks_credentials%rowtype;
declare s public.google_auth_refresh_state%rowtype;
begin
  if target_owner is null or expected_access_token = '' or verified_google_subject = ''
     or length(encryption_key) < 32 then
    raise exception 'Invalid Google account binding';
  end if;
  select * into s from public.google_auth_refresh_state where owner_id = target_owner for update;
  if not found or s.access_token_encrypted is null or s.access_expires_at <= now()
     or pgp_sym_decrypt(s.access_token_encrypted, encryption_key) <> expected_access_token then
    return false;
  end if;
  select * into c from public.google_tasks_credentials where owner_id = target_owner for update;
  if not found then return false; end if;
  if c.google_subject is not null then return c.google_subject = verified_google_subject; end if;
  update public.google_tasks_credentials
    set google_subject = verified_google_subject, updated_at = now()
    where owner_id = target_owner;
  return true;
end;
$$;

create function public.connect_google_auth_credentials(target_owner uuid, new_refresh_token text,
  new_tasklist_id text, new_google_subject text, old_refresh_token text,
  old_tasklist_id text, encryption_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, extensions, public
as $$
declare c public.google_tasks_credentials%rowtype;
begin
  if target_owner is null or new_refresh_token = '' or new_tasklist_id = ''
     or new_google_subject = '' or length(encryption_key) < 32 then
    raise exception 'Invalid Google connection';
  end if;
  insert into public.google_auth_refresh_state(owner_id) values(target_owner)
    on conflict (owner_id) do nothing;
  perform 1 from public.google_auth_refresh_state where owner_id = target_owner for update;
  select * into c from public.google_tasks_credentials where owner_id = target_owner for update;
  if found then
    if old_refresh_token is null or old_tasklist_id is null
       or pgp_sym_decrypt(c.refresh_token_encrypted, encryption_key) <> old_refresh_token
       or c.tasklist_id <> old_tasklist_id
       or (c.google_subject is not null and c.google_subject <> new_google_subject) then
      return false;
    end if;
    update public.google_tasks_credentials
      set refresh_token_encrypted = pgp_sym_encrypt(new_refresh_token, encryption_key, 'cipher-algo=aes256'),
          tasklist_id = new_tasklist_id, google_subject = new_google_subject, updated_at = now()
      where owner_id = target_owner;
  else
    if old_refresh_token is not null or old_tasklist_id is not null then return false; end if;
    insert into public.google_tasks_credentials(owner_id, refresh_token_encrypted, tasklist_id, google_subject)
      values(target_owner, pgp_sym_encrypt(new_refresh_token, encryption_key, 'cipher-algo=aes256'),
             new_tasklist_id, new_google_subject);
  end if;
  update public.google_auth_refresh_state
    set access_token_encrypted = null, access_expires_at = null,
        lease_id = null, lease_expires_at = null, last_error_code = null,
        tasks_health = 'unknown', calendar_health = 'unknown', capability_checked_at = null,
        updated_at = now()
    where owner_id = target_owner;
  return true;
end;
$$;

create function public.record_google_auth_capabilities(target_owner uuid,
  new_tasks_health text, new_calendar_health text)
returns void language plpgsql security invoker set search_path = pg_catalog, public
as $$
begin
  if new_tasks_health not in ('unknown', 'ok', 'scope_missing', 'unavailable')
    or new_calendar_health not in ('unknown', 'ok', 'scope_missing', 'unavailable') then
    raise exception 'Invalid Google capability state';
  end if;
  insert into public.google_auth_refresh_state(owner_id, tasks_health, calendar_health, capability_checked_at)
    values(target_owner, new_tasks_health, new_calendar_health, now())
    on conflict (owner_id) do update set tasks_health = excluded.tasks_health,
      calendar_health = excluded.calendar_health,
      capability_checked_at = now(), updated_at = now();
end;
$$;

revoke all on function public.read_google_auth_credentials(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_google_auth_refresh(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_google_auth_refresh(uuid, uuid, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.fail_google_auth_refresh(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.bind_google_auth_subject(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.connect_google_auth_credentials(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_google_auth_capabilities(uuid, text, text) from public, anon, authenticated;
grant execute on function public.read_google_auth_credentials(uuid, text) to service_role;
grant execute on function public.claim_google_auth_refresh(uuid, uuid, text) to service_role;
grant execute on function public.finish_google_auth_refresh(uuid, uuid, text, text, text, integer, text, text) to service_role;
grant execute on function public.fail_google_auth_refresh(uuid, uuid, text) to service_role;
grant execute on function public.bind_google_auth_subject(uuid, text, text, text) to service_role;
grant execute on function public.connect_google_auth_credentials(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.record_google_auth_capabilities(uuid, text, text) to service_role;

-- The legacy writer has no Google subject or compare-and-swap argument. Keep
-- legacy reads for rollback, but close its account-switch bypass at cutover.
revoke execute on function public.upsert_google_tasks_credentials(uuid, text, text, text)
  from service_role;
