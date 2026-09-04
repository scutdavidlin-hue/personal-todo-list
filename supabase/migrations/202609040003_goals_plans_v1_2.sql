-- Personal OS V1.2: durable goals, plans, projects, and task context.
-- Google Tasks remains the only source of truth for task content and completion.

create table if not exists public.goals_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 20000),
  why text not null default '' check (char_length(why) <= 10000),
  type text not null default 'Goal'
    check (type in ('Goal', 'Plan', 'LongTermItem', 'FinancialItem', 'Idea', 'LifePlan', 'BusinessPlan', 'FamilyPlan')),
  category text not null default 'Personal'
    check (category in ('Career', 'Business', 'Finance', 'Family', 'Health', 'Travel', 'Learning', 'Property', 'Personal', 'Relationship', 'Other')),
  status text not null default 'Inbox'
    check (status in ('Inbox', 'Thinking', 'Planning', 'Active', 'Paused', 'Completed', 'Dropped', 'Archived')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  progress_percent smallint not null default 0 check (progress_percent between 0 and 100),
  target_date date,
  target_month text check (target_month is null or target_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  target_year smallint check (target_year is null or target_year between 2000 and 2200),
  start_date date,
  review_date date,
  deadline date,
  amount_total numeric(18, 2) check (amount_total is null or amount_total >= 0),
  amount_completed numeric(18, 2) not null default 0 check (amount_completed >= 0),
  amount_remaining numeric(18, 2) generated always as (
    case when amount_total is null then null else amount_total - amount_completed end
  ) stored,
  currency text not null default 'CNY' check (currency ~ '^[A-Z]{3}$'),
  counterparty text check (counterparty is null or char_length(counterparty) <= 200),
  financial_type text
    check (financial_type is null or financial_type in ('Receivable', 'Payable', 'Budget', 'SavingGoal', 'InvestmentGoal')),
  client_id uuid,
  contact_id uuid,
  company_id uuid,
  notes text not null default '' check (char_length(notes) <= 20000),
  original_input text not null check (char_length(original_input) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, owner_id),
  check (amount_total is null or amount_completed <= amount_total),
  check (target_date is null or target_month is null),
  check (target_date is null or target_year is null),
  check (target_month is null or target_year is null)
);

create index if not exists goals_plans_owner_status_idx
on public.goals_plans (owner_id, status, updated_at desc);

create index if not exists goals_plans_review_idx
on public.goals_plans (owner_id, review_date)
where review_date is not null and status not in ('Completed', 'Dropped', 'Archived');

create index if not exists goals_plans_financial_idx
on public.goals_plans (owner_id, financial_type)
where financial_type is not null;

drop trigger if exists goals_plans_set_updated_at on public.goals_plans;
create trigger goals_plans_set_updated_at
before update on public.goals_plans
for each row execute function public.set_updated_at();

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  goal_plan_id uuid references public.goals_plans(id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 20000),
  status text not null default 'Planning'
    check (status in ('Planning', 'Active', 'Paused', 'Completed', 'Dropped', 'Archived')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  progress_percent smallint not null default 0 check (progress_percent between 0 and 100),
  start_date date,
  target_date date,
  original_input text not null default '' check (char_length(original_input) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists projects_goal_idx
on public.projects (owner_id, goal_plan_id, status, updated_at desc);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create table if not exists public.task_context_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  goal_plan_id uuid references public.goals_plans(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, google_task_id),
  check (goal_plan_id is not null or project_id is not null)
);

create index if not exists task_context_goal_idx
on public.task_context_links (owner_id, goal_plan_id);

create index if not exists task_context_project_idx
on public.task_context_links (owner_id, project_id)
where project_id is not null;

drop trigger if exists task_context_links_set_updated_at on public.task_context_links;
create trigger task_context_links_set_updated_at
before update on public.task_context_links
for each row execute function public.set_updated_at();

create or replace function public.validate_personal_os_relation_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  related_owner uuid;
  project_goal uuid;
  related_project_id uuid;
begin
  if new.goal_plan_id is not null then
    select owner_id into related_owner from public.goals_plans where id = new.goal_plan_id;
    if related_owner is null or related_owner <> new.owner_id then
      raise exception 'goal_plan_id must belong to the same owner';
    end if;
  end if;

  related_project_id := nullif(to_jsonb(new)->>'project_id', '')::uuid;
  if tg_table_name = 'task_context_links' and related_project_id is not null then
    select owner_id, goal_plan_id into related_owner, project_goal from public.projects where id = related_project_id;
    if related_owner is null or related_owner <> new.owner_id then
      raise exception 'project_id must belong to the same owner';
    end if;
    if new.goal_plan_id is not null and project_goal is distinct from new.goal_plan_id then
      raise exception 'project_id must belong to goal_plan_id';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_validate_owner on public.projects;
create trigger projects_validate_owner
before insert or update of owner_id, goal_plan_id on public.projects
for each row execute function public.validate_personal_os_relation_owner();

drop trigger if exists task_context_links_validate_owner on public.task_context_links;
create trigger task_context_links_validate_owner
before insert or update of owner_id, goal_plan_id, project_id on public.task_context_links
for each row execute function public.validate_personal_os_relation_owner();

alter table public.goals_plans enable row level security;
alter table public.goals_plans force row level security;
alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.task_context_links enable row level security;
alter table public.task_context_links force row level security;

drop policy if exists "Users read own goals" on public.goals_plans;
create policy "Users read own goals" on public.goals_plans
for select to authenticated using (owner_id = auth.uid());
drop policy if exists "Users create own goals" on public.goals_plans;
create policy "Users create own goals" on public.goals_plans
for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "Users update own goals" on public.goals_plans;
create policy "Users update own goals" on public.goals_plans
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "Users read own projects" on public.projects;
create policy "Users read own projects" on public.projects
for select to authenticated using (owner_id = auth.uid());
drop policy if exists "Users create own projects" on public.projects;
create policy "Users create own projects" on public.projects
for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "Users update own projects" on public.projects;
create policy "Users update own projects" on public.projects
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "Users read own task context" on public.task_context_links;
create policy "Users read own task context" on public.task_context_links
for select to authenticated using (owner_id = auth.uid());
drop policy if exists "Users create own task context" on public.task_context_links;
create policy "Users create own task context" on public.task_context_links
for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "Users update own task context" on public.task_context_links;
create policy "Users update own task context" on public.task_context_links
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "Users delete own task context" on public.task_context_links;
create policy "Users delete own task context" on public.task_context_links
for delete to authenticated using (owner_id = auth.uid());

revoke all on table public.goals_plans, public.projects, public.task_context_links from public, anon, authenticated;
grant select, insert, update on table public.goals_plans, public.projects to authenticated;
grant select, insert, update, delete on table public.task_context_links to authenticated;
grant all on table public.goals_plans, public.projects, public.task_context_links to service_role;

alter table public.personal_os_intake_audit
drop constraint if exists personal_os_intake_audit_classification_check;
alter table public.personal_os_intake_audit
add constraint personal_os_intake_audit_classification_check
check (classification in (
  'task', 'goal', 'plan', 'long_term_item', 'financial_item',
  'calendar_event', 'project_data', 'contact', 'client', 'knowledge', 'gpt_job'
));

comment on table public.goals_plans is
  'Durable Personal OS goals, plans, ideas, and long-term financial facts. Never a second task table.';
comment on table public.task_context_links is
  'Context relation for Google Tasks. Task status remains exclusively in Google Tasks.';
