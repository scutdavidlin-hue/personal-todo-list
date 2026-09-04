-- Conversation-to-Goal bridge for the existing Goals & Plans model.
-- This migration extends public.goals_plans; it does not create another Goal store.

alter table public.goals_plans
add column if not exists horizon text;

update public.goals_plans
set horizon = 'medium'
where horizon is null;

alter table public.goals_plans
alter column horizon set default 'medium',
alter column horizon set not null;

alter table public.goals_plans
drop constraint if exists goals_plans_horizon_check;

alter table public.goals_plans
add constraint goals_plans_horizon_check
check (horizon in ('short', 'medium', 'long'));

create index if not exists goals_plans_owner_horizon_status_idx
on public.goals_plans (owner_id, horizon, status, updated_at desc);

comment on column public.goals_plans.horizon is
  'Semantic planning horizon: short (0-30 days), medium (1-6 months), or long (6+ months). Explicit user wording takes priority over date arithmetic.';
