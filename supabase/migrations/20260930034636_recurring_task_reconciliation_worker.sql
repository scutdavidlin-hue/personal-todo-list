create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres;

create or replace function private.invoke_personal_os_task_scheduler()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault, private
as $$
declare
  project_url text;
  scheduler_api_key text;
  request_id bigint;
begin
  select decrypted_secret
    into project_url
    from vault.decrypted_secrets
   where name = 'personal_os_project_url'
   order by created_at desc
   limit 1;

  select decrypted_secret
    into scheduler_api_key
    from vault.decrypted_secrets
   where name = 'personal_os_scheduler_secret_key'
   order by created_at desc
   limit 1;

  if coalesce(project_url, '') = '' or coalesce(scheduler_api_key, '') = '' then
    raise exception 'Personal OS scheduler Vault secrets are not configured';
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/task-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', scheduler_api_key
    ),
    body := jsonb_build_object('action', 'run'),
    timeout_milliseconds := 30000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function private.invoke_personal_os_task_scheduler() from public, anon, authenticated;
grant execute on function private.invoke_personal_os_task_scheduler() to postgres;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
    from cron.job
   where jobname = 'personal-os-task-scheduler-5m'
   limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'personal-os-task-scheduler-5m',
    '*/5 * * * *',
    'select private.invoke_personal_os_task_scheduler();'
  );
end;
$$;
