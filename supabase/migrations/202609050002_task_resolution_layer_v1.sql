-- Personal OS V1.3: Resolve Before Create governance and Task execution graph.
-- Google Tasks remains the only source of truth for active Task content and completion.
-- Tables below contain semantic profiles, graph edges, and audit evidence only.

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.task_resolution_audit (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  intake_audit_id uuid references public.personal_os_intake_audit(id) on delete set null,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  original_intent text not null check (char_length(original_intent) between 1 and 10000),
  normalized_intent jsonb not null default '{}'::jsonb,
  decision text not null check (decision in (
    'NEW', 'DUPLICATE', 'UPDATE', 'MERGE', 'RELATED', 'DEPENDENCY',
    'PARENT_CHILD', 'GOAL_LINK', 'CONFLICT'
  )),
  confidence numeric(5, 4) not null check (confidence between 0 and 1),
  automatic_action text not null check (char_length(automatic_action) between 1 and 80),
  existing_task_id text check (existing_task_id is null or char_length(existing_task_id) between 1 and 1024),
  canonical_task_id text check (canonical_task_id is null or char_length(canonical_task_id) between 1 and 1024),
  result_task_ids text[] not null default '{}',
  candidate_snapshot jsonb not null default '[]'::jsonb,
  previous_state jsonb,
  new_state jsonb,
  related_object_ids jsonb not null default '{}'::jsonb,
  reason text not null check (char_length(reason) between 1 and 4000),
  status text not null default 'processing' check (status in ('processing', 'succeeded', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_resolution_audit_idempotency_unique
on public.task_resolution_audit (owner_id, idempotency_key)
where idempotency_key is not null;

create index if not exists task_resolution_audit_object_idx
on public.task_resolution_audit (owner_id, canonical_task_id, created_at desc)
where canonical_task_id is not null;

create index if not exists task_resolution_audit_decision_idx
on public.task_resolution_audit (owner_id, decision, created_at desc);

drop trigger if exists task_resolution_audit_set_updated_at on public.task_resolution_audit;
create trigger task_resolution_audit_set_updated_at
before update on public.task_resolution_audit
for each row execute function public.set_updated_at();

create table if not exists public.task_resolution_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  task_list_id text check (task_list_id is null or char_length(task_list_id) between 1 and 1024),
  canonical_task_id text not null check (char_length(canonical_task_id) between 1 and 1024),
  normalized_title text not null default '' check (char_length(normalized_title) <= 2000),
  semantic_key text not null default '' check (char_length(semantic_key) <= 2000),
  action text not null default 'act' check (char_length(action) between 1 and 80),
  entities text[] not null default '{}',
  topics text[] not null default '{}',
  resources text[] not null default '{}',
  read_resources text[] not null default '{}',
  write_resources text[] not null default '{}',
  resource_fields text[] not null default '{}',
  source_intent_ids uuid[] not null default '{}',
  goal_plan_id uuid references public.goals_plans(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  superseded_by text check (superseded_by is null or char_length(superseded_by) between 1 and 1024),
  resolution_confidence numeric(5, 4) check (resolution_confidence is null or resolution_confidence between 0 and 1),
  resolution_reason text check (resolution_reason is null or char_length(resolution_reason) <= 4000),
  created_from text not null default 'personal_os_intake' check (char_length(created_from) between 1 and 80),
  last_semantic_resolution_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, google_task_id),
  check (google_task_id <> superseded_by)
);

create index if not exists task_resolution_profiles_canonical_idx
on public.task_resolution_profiles (owner_id, canonical_task_id, updated_at desc);

create index if not exists task_resolution_profiles_goal_idx
on public.task_resolution_profiles (owner_id, goal_plan_id, project_id, updated_at desc);

create index if not exists task_resolution_profiles_normalized_trgm_idx
on public.task_resolution_profiles using gist (normalized_title extensions.gist_trgm_ops);

create index if not exists task_resolution_profiles_semantic_trgm_idx
on public.task_resolution_profiles using gist (semantic_key extensions.gist_trgm_ops);

create index if not exists task_resolution_profiles_topics_idx
on public.task_resolution_profiles using gin (topics);

create index if not exists task_resolution_profiles_entities_idx
on public.task_resolution_profiles using gin (entities);

create index if not exists task_resolution_profiles_resources_idx
on public.task_resolution_profiles using gin (resources);

drop trigger if exists task_resolution_profiles_set_updated_at on public.task_resolution_profiles;
create trigger task_resolution_profiles_set_updated_at
before update on public.task_resolution_profiles
for each row execute function public.set_updated_at();

create table if not exists public.task_relationships (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  from_task_id text not null check (char_length(from_task_id) between 1 and 1024),
  to_task_id text not null check (char_length(to_task_id) between 1 and 1024),
  relationship_type text not null check (relationship_type in (
    'DUPLICATE_OF', 'MERGED_INTO', 'RELATED_TO', 'DEPENDS_ON', 'PARENT_OF',
    'POTENTIAL_RELATION', 'CONFLICTS_WITH', 'SHARES_RESOURCE'
  )),
  confidence numeric(5, 4) not null check (confidence between 0 and 1),
  reason text not null check (char_length(reason) between 1 and 4000),
  source_intent_id uuid references public.task_resolution_audit(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  superseded_at timestamptz,
  check (from_task_id <> to_task_id),
  unique (owner_id, from_task_id, to_task_id, relationship_type)
);

create or replace function public.normalize_and_validate_task_relationship()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  swap_id text;
begin
  if new.relationship_type in ('RELATED_TO', 'POTENTIAL_RELATION', 'CONFLICTS_WITH', 'SHARES_RESOURCE')
     and new.from_task_id > new.to_task_id then
    swap_id := new.from_task_id;
    new.from_task_id := new.to_task_id;
    new.to_task_id := swap_id;
  end if;

  if new.relationship_type = 'DEPENDS_ON' then
    -- Serialize dependency mutations per owner so two concurrent agents cannot
    -- each pass cycle validation against a stale MVCC snapshot.
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
    if exists (
      with recursive dependency_path(task_id) as (
        select new.to_task_id
        union
        select relationship.to_task_id
        from public.task_relationships relationship
        join dependency_path path on relationship.from_task_id = path.task_id
        where relationship.owner_id = new.owner_id
          and relationship.relationship_type = 'DEPENDS_ON'
          and relationship.active
          and relationship.superseded_at is null
          and relationship.id <> new.id
      )
      select 1 from dependency_path where task_id = new.from_task_id
    ) then
      raise exception 'dependency would create a cycle';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists task_relationships_normalize_validate on public.task_relationships;
create trigger task_relationships_normalize_validate
before insert or update of owner_id, from_task_id, to_task_id, relationship_type, active, superseded_at
on public.task_relationships
for each row execute function public.normalize_and_validate_task_relationship();

create index if not exists task_relationships_from_idx
on public.task_relationships (owner_id, from_task_id, relationship_type)
where active and superseded_at is null;

create index if not exists task_relationships_to_idx
on public.task_relationships (owner_id, to_task_id, relationship_type)
where active and superseded_at is null;

create index if not exists task_relationships_dependency_idx
on public.task_relationships (owner_id, to_task_id, from_task_id)
where relationship_type = 'DEPENDS_ON' and active and superseded_at is null;

drop trigger if exists task_relationships_set_updated_at on public.task_relationships;
create trigger task_relationships_set_updated_at
before update on public.task_relationships
for each row execute function public.set_updated_at();

create table if not exists public.task_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  google_task_id text not null check (char_length(google_task_id) between 1 and 1024),
  resource_key text not null check (char_length(resource_key) between 1 and 200),
  access_type text not null check (access_type in ('read', 'write', 'read_write')),
  fields text[] not null default '{}',
  source_intent_id uuid references public.task_resolution_audit(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, google_task_id, resource_key)
);

create index if not exists task_resource_bindings_conflict_idx
on public.task_resource_bindings (owner_id, resource_key, access_type, google_task_id);

drop trigger if exists task_resource_bindings_set_updated_at on public.task_resource_bindings;
create trigger task_resource_bindings_set_updated_at
before update on public.task_resource_bindings
for each row execute function public.set_updated_at();

create or replace function public.search_task_resolution_profiles(
  target_owner uuid,
  query_text text,
  query_entities text[] default '{}',
  query_topics text[] default '{}',
  query_resources text[] default '{}',
  match_count integer default 20
)
returns table (
  google_task_id text,
  canonical_task_id text,
  normalized_title text,
  semantic_key text,
  action text,
  entities text[],
  topics text[],
  resources text[],
  read_resources text[],
  write_resources text[],
  resource_fields text[],
  goal_plan_id uuid,
  project_id uuid,
  candidate_score numeric
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with candidate_ids as (
    select id from (
      (
        select profile.id
        from public.task_resolution_profiles profile
        where profile.owner_id = target_owner
          and profile.superseded_by is null
          and coalesce(query_text, '') <> ''
        order by profile.normalized_title <-> coalesce(query_text, '')
        limit greatest(20, least(coalesce(match_count, 20) * 3, 100))
      )
      union
      (
        select profile.id
        from public.task_resolution_profiles profile
        where profile.owner_id = target_owner
          and profile.superseded_by is null
          and coalesce(query_text, '') <> ''
        order by profile.semantic_key <-> coalesce(query_text, '')
        limit greatest(20, least(coalesce(match_count, 20) * 3, 100))
      )
      union
      (
        select profile.id
        from public.task_resolution_profiles profile
        where profile.owner_id = target_owner
          and profile.superseded_by is null
          and (
            profile.entities && coalesce(query_entities, '{}')
            or profile.topics && coalesce(query_topics, '{}')
            or profile.resources && coalesce(query_resources, '{}')
          )
        order by profile.updated_at desc
        limit greatest(20, least(coalesce(match_count, 20) * 3, 100))
      )
      union
      (
        select profile.id
        from public.task_resolution_profiles profile
        where profile.owner_id = target_owner
          and profile.superseded_by is null
        order by profile.updated_at desc
        limit greatest(10, least(coalesce(match_count, 20), 50))
      )
    ) bounded_candidates
  ),
  scored as (
    select
      profile.*,
      greatest(
        similarity(profile.normalized_title, coalesce(query_text, '')),
        similarity(profile.semantic_key, coalesce(query_text, ''))
      ) * 0.60
      + case when cardinality(coalesce(query_entities, '{}')) > 0 and profile.entities && query_entities then 0.15 else 0 end
      + case when cardinality(coalesce(query_topics, '{}')) > 0 and profile.topics && query_topics then 0.15 else 0 end
      + case when cardinality(coalesce(query_resources, '{}')) > 0 and profile.resources && query_resources then 0.10 else 0 end
      as score
    from candidate_ids candidate
    join public.task_resolution_profiles profile on profile.id = candidate.id
    where profile.owner_id = target_owner
      and profile.superseded_by is null
  )
  select
    scored.google_task_id,
    scored.canonical_task_id,
    scored.normalized_title,
    scored.semantic_key,
    scored.action,
    scored.entities,
    scored.topics,
    scored.resources,
    scored.read_resources,
    scored.write_resources,
    scored.resource_fields,
    scored.goal_plan_id,
    scored.project_id,
    round(scored.score::numeric, 4) as candidate_score
  from scored
  order by scored.score desc, scored.updated_at desc
  limit greatest(1, least(coalesce(match_count, 20), 100));
$$;

create or replace function public.validate_task_resolution_profile_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  related_owner uuid;
  project_goal uuid;
begin
  if new.goal_plan_id is not null then
    select owner_id into related_owner from public.goals_plans where id = new.goal_plan_id;
    if related_owner is null or related_owner <> new.owner_id then
      raise exception 'goal_plan_id must belong to the same owner';
    end if;
  end if;
  if new.project_id is not null then
    select owner_id, goal_plan_id into related_owner, project_goal from public.projects where id = new.project_id;
    if related_owner is null or related_owner <> new.owner_id then
      raise exception 'project_id must belong to the same owner';
    end if;
    if new.goal_plan_id is not null and project_goal is distinct from new.goal_plan_id then
      raise exception 'project_id must belong to goal_plan_id';
    end if;
  end if;
  if exists (
    select 1
    from unnest(new.source_intent_ids) as source(source_id)
    left join public.task_resolution_audit audit on audit.id = source.source_id
    where audit.id is null or audit.owner_id <> new.owner_id
  ) then
    raise exception 'source_intent_ids must belong to the same owner';
  end if;
  return new;
end;
$$;

drop trigger if exists task_resolution_profiles_validate_owner on public.task_resolution_profiles;
create trigger task_resolution_profiles_validate_owner
before insert or update of owner_id, goal_plan_id, project_id, source_intent_ids on public.task_resolution_profiles
for each row execute function public.validate_task_resolution_profile_owner();

create or replace function public.validate_task_resolution_audit_owner_links()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  related_owner uuid;
  source_audit_id uuid;
begin
  if tg_table_name = 'task_resolution_audit' then
    source_audit_id := nullif(to_jsonb(new)->>'intake_audit_id', '')::uuid;
    if source_audit_id is not null then
      select owner_id into related_owner from public.personal_os_intake_audit where id = source_audit_id;
      if related_owner is null or related_owner <> new.owner_id then
        raise exception 'intake_audit_id must belong to the same owner';
      end if;
    end if;
  else
    source_audit_id := nullif(to_jsonb(new)->>'source_intent_id', '')::uuid;
    if source_audit_id is not null then
      select owner_id into related_owner from public.task_resolution_audit where id = source_audit_id;
      if related_owner is null or related_owner <> new.owner_id then
        raise exception 'source_intent_id must belong to the same owner';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists task_resolution_audit_validate_owner_links on public.task_resolution_audit;
create trigger task_resolution_audit_validate_owner_links
before insert or update of owner_id, intake_audit_id on public.task_resolution_audit
for each row execute function public.validate_task_resolution_audit_owner_links();

drop trigger if exists task_relationships_validate_owner_links on public.task_relationships;
create trigger task_relationships_validate_owner_links
before insert or update of owner_id, source_intent_id on public.task_relationships
for each row execute function public.validate_task_resolution_audit_owner_links();

drop trigger if exists task_resource_bindings_validate_owner_links on public.task_resource_bindings;
create trigger task_resource_bindings_validate_owner_links
before insert or update of owner_id, source_intent_id on public.task_resource_bindings
for each row execute function public.validate_task_resolution_audit_owner_links();

alter table public.personal_os_intake_audit
  add column if not exists resolution_audit_id uuid references public.task_resolution_audit(id) on delete set null,
  add column if not exists resolution_decision text,
  add column if not exists resolution_confidence numeric(5, 4),
  add column if not exists resolution_reason text;

alter table public.task_schedule_metadata
  add column if not exists canonical_task_id text,
  add column if not exists superseded_by text,
  add column if not exists resolution_confidence numeric(5, 4),
  add column if not exists resolution_reason text,
  add column if not exists created_from text not null default 'personal_os_intake',
  add column if not exists last_semantic_resolution_at timestamptz;

alter table public.task_resolution_audit enable row level security;
alter table public.task_resolution_audit force row level security;
alter table public.task_resolution_profiles enable row level security;
alter table public.task_resolution_profiles force row level security;
alter table public.task_relationships enable row level security;
alter table public.task_relationships force row level security;
alter table public.task_resource_bindings enable row level security;
alter table public.task_resource_bindings force row level security;

revoke all on table public.task_resolution_audit from public, anon, authenticated;
revoke all on table public.task_resolution_profiles from public, anon, authenticated;
revoke all on table public.task_relationships from public, anon, authenticated;
revoke all on table public.task_resource_bindings from public, anon, authenticated;
revoke all on function public.search_task_resolution_profiles(uuid, text, text[], text[], text[], integer) from public, anon, authenticated;

grant select, insert, update on table public.task_resolution_audit to service_role;
grant select, insert, update on table public.task_resolution_profiles to service_role;
grant select, insert, update on table public.task_relationships to service_role;
grant select, insert, update, delete on table public.task_resource_bindings to service_role;
grant execute on function public.search_task_resolution_profiles(uuid, text, text[], text[], text[], integer) to service_role;

comment on table public.task_resolution_profiles is
  'Semantic metadata for Google Tasks. It is not a second Task content or completion store.';
comment on table public.task_relationships is
  'Auditable Task graph edges used for related, dependency, hierarchy, conflict, and canonicalization decisions.';
comment on table public.task_resolution_audit is
  'Explainable Resolve-Before-Create decisions with before/after state and candidate evidence.';
comment on table public.task_resource_bindings is
  'Read/write resource awareness for conflict detection; a shared resource never implies merge by itself.';
comment on function public.search_task_resolution_profiles(uuid, text, text[], text[], text[], integer) is
  'Returns a bounded semantic candidate set. Provider truth must still be refreshed from Google Tasks before a write.';
