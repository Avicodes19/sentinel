-- SENTINEL SIH MVP — Supabase/PostgreSQL schema
create extension if not exists pgcrypto;

create table if not exists operations (
  id text primary key,
  name text not null,
  disaster_type text not null,
  hazard text,
  country text not null,
  state text,
  authority text,
  source text,
  status text default 'active',
  updated_at timestamptz default now()
);
create table if not exists zones (
  id text primary key,
  operation_id text references operations(id) on delete cascade,
  name text not null,
  admin_level text default 'District',
  latitude double precision,
  longitude double precision,
  severity text check (severity in ('critical','high','moderate','low')),
  priority integer check (priority between 0 and 100),
  population integer default 0,
  missing integer default 0,
  rescued integer default 0,
  critical integer default 0,
  teams integer default 0,
  needs jsonb default '{}'::jsonb,
  last_delivery text,
  road text,
  brief text,
  updated_at timestamptz default now()
);
create table if not exists people (
  id text primary key,
  operation_id text references operations(id) on delete cascade,
  name text not null,
  age integer,
  sex text,
  status text not null default 'unaccounted',
  zone_id text references zones(id),
  last_seen text,
  needs jsonb default '[]'::jsonb,
  logged_at timestamptz default now(),
  created_at timestamptz default now()
);
create table if not exists verification_events (
  id uuid primary key default gen_random_uuid(),
  operation_id text references operations(id) on delete cascade,
  person_id text references people(id) on delete cascade,
  previous_status text,
  new_status text,
  verified_by text,
  source text,
  created_at timestamptz default now()
);
create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  operation_id text references operations(id) on delete cascade,
  name text not null,
  stock numeric default 0,
  unit text,
  reserved numeric default 0,
  updated_at timestamptz default now()
);
create table if not exists relief_dispatches (
  id text primary key,
  operation_id text references operations(id) on delete cascade,
  zone_id text references zones(id),
  resource text not null,
  quantity numeric not null,
  unit text,
  supplier_name text,
  transport_id text,
  eta timestamptz,
  status text not null default 'requested' check (status in ('requested','approved','assigned','dispatched','in_transit','arrived','delivered','verified','rejected','cancelled')),
  created_at timestamptz default now()
);
create table if not exists dispatch_events (
  id uuid primary key default gen_random_uuid(),
  dispatch_id text references relief_dispatches(id) on delete cascade,
  previous_status text,
  new_status text not null,
  actor_role text,
  notes text,
  created_at timestamptz default now()
);
create table if not exists response_teams (
  id uuid primary key default gen_random_uuid(),
  operation_id text references operations(id) on delete cascade,
  name text not null,
  status text default 'standby',
  current_zone text,
  updated_at timestamptz default now()
);
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  operation_id text references operations(id) on delete cascade,
  time timestamptz default now(),
  type text,
  source text,
  text text not null,
  zone_id text references zones(id),
  created_at timestamptz default now()
);
create table if not exists external_observations (
  id uuid primary key default gen_random_uuid(),
  operation_id text references operations(id) on delete cascade,
  provider text not null,
  external_id text,
  hazard text,
  warning_level text,
  payload jsonb,
  observed_at timestamptz default now()
);

-- Enable Realtime for operational tables in Supabase.
alter publication supabase_realtime add table zones;
alter publication supabase_realtime add table people;
alter publication supabase_realtime add table alerts;
alter publication supabase_realtime add table relief_dispatches;
alter publication supabase_realtime add table dispatch_events;
alter publication supabase_realtime add table resources;

-- Production: enable RLS and write policies based on authenticated authority roles.
alter table operations enable row level security;
alter table zones enable row level security;
alter table people enable row level security;
alter table verification_events enable row level security;
alter table resources enable row level security;
alter table relief_dispatches enable row level security;
alter table response_teams enable row level security;
alter table alerts enable row level security;
alter table external_observations enable row level security;

create policy "authenticated can read operations" on operations for select to authenticated using (true);
create policy "authenticated can read zones" on zones for select to authenticated using (true);
create policy "authenticated can read people" on people for select to authenticated using (true);
create policy "authenticated can read alerts" on alerts for select to authenticated using (true);
create policy "authenticated can read resources" on resources for select to authenticated using (true);
create policy "authenticated can read teams" on response_teams for select to authenticated using (true);
