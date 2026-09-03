-- Personal OS daily review storage.
-- Actionable tasks live only in Google Tasks; this database does not keep a
-- second task pool.

create extension if not exists pgcrypto;

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

drop trigger if exists daily_reviews_set_updated_at on public.daily_reviews;
create trigger daily_reviews_set_updated_at
before update on public.daily_reviews
for each row execute function public.set_updated_at();

alter table public.daily_reviews enable row level security;
alter table public.daily_reviews force row level security;

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

revoke all on table public.daily_reviews from anon, authenticated;

grant usage on schema public to authenticated;
grant select, insert, update on public.daily_reviews to authenticated;
