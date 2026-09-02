-- GPT 晨会 × 今日任务云同步 V1
-- Safe to apply to a new Supabase project with `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  date date not null,
  time time without time zone,
  category text not null default '工作' check (char_length(category) between 1 and 40),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  duration integer not null default 30 check (duration between 0 and 1440),
  notes text not null default '' check (char_length(notes) <= 4000),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done boolean generated always as (status = 'done') stored,
  completed_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'gpt', 'carryover')),
  carried_from_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_completion_consistency check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null)
  ),
  constraint tasks_carryover_date_order check (
    carried_from_date is null or carried_from_date <= date
  )
);

create index if not exists tasks_owner_date_status_idx
  on public.tasks (owner_id, date, status);

create index if not exists tasks_owner_completed_idx
  on public.tasks (owner_id, completed_at desc)
  where status = 'done';

create table if not exists public.daily_reviews (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  note text not null default '' check (char_length(note) <= 10000),
  mood smallint check (mood between 1 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, date)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

drop trigger if exists daily_reviews_set_updated_at on public.daily_reviews;
create trigger daily_reviews_set_updated_at
before update on public.daily_reviews
for each row execute function public.set_updated_at();

alter table public.tasks enable row level security;
alter table public.tasks force row level security;
alter table public.daily_reviews enable row level security;
alter table public.daily_reviews force row level security;

drop policy if exists "Users read own tasks" on public.tasks;
create policy "Users read own tasks"
on public.tasks for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists "Users create own tasks" on public.tasks;
create policy "Users create own tasks"
on public.tasks for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users update own tasks" on public.tasks;
create policy "Users update own tasks"
on public.tasks for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users read own reviews" on public.daily_reviews;
create policy "Users read own reviews"
on public.daily_reviews for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists "Users create own reviews" on public.daily_reviews;
create policy "Users create own reviews"
on public.daily_reviews for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users update own reviews" on public.daily_reviews;
create policy "Users update own reviews"
on public.daily_reviews for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

-- Browser/user rollover. The same row is moved in place, so repeated calls are idempotent.
create or replace function public.rollover_open_tasks(target_date date)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  changed_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.tasks
  set carried_from_date = coalesce(carried_from_date, date),
      date = target_date,
      source = 'carryover'
  where owner_id = auth.uid()
    and status = 'open'
    and date < target_date;

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

-- Server-only rollover for the automation Edge Function.
create or replace function public.rollover_tasks_for_owner(target_owner uuid, target_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count integer;
begin
  update public.tasks
  set carried_from_date = coalesce(carried_from_date, date),
      date = target_date,
      source = 'carryover'
  where owner_id = target_owner
    and status = 'open'
    and date < target_date;

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.rollover_tasks_for_owner(uuid, date) from public;
revoke all on function public.rollover_tasks_for_owner(uuid, date) from anon;
revoke all on function public.rollover_tasks_for_owner(uuid, date) from authenticated;
grant execute on function public.rollover_tasks_for_owner(uuid, date) to service_role;

revoke all on table public.tasks from anon, authenticated;
revoke all on table public.daily_reviews from anon, authenticated;
revoke all on function public.rollover_open_tasks(date) from public;
revoke all on function public.rollover_open_tasks(date) from anon;

grant usage on schema public to authenticated;
grant select, insert, update on public.tasks to authenticated;
grant select, insert, update on public.daily_reviews to authenticated;
grant execute on function public.rollover_open_tasks(date) to authenticated;
