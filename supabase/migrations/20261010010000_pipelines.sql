-- Autonomous pipelines: research → review → prototype → review → host, with gates and budgets.

-- Room settings: autonomy mode, kill switch, budget
create table if not exists public.rooms (
  id                 text primary key,
  mode               text not null default 'auto' check (mode in ('suggest','auto','full')),
  paused             boolean not null default false,
  max_jobs_per_hour  int not null default 20,
  created_at         timestamptz not null default now()
);

-- A pipeline is one next step carried through several stages
create table if not exists public.pipelines (
  id               bigint generated always as identity primary key,
  room_id          text not null,
  title            text not null,
  goal             text not null,
  stages           text[] not null,
  current          int not null default 0,
  status           text not null default 'running'
                   check (status in ('proposed','running','waiting','done','failed','stopped')),
  gate             jsonb,                 -- {kind: 'publish'|'question'|'budget', question, stage}
  host_url         text,
  meta             jsonb not null default '{}'::jsonb,  -- {revisions:{stageIdx:n}, answers:[...]}
  created_by       text not null default 'huddle',
  origin_event_id  bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists pipelines_room_idx on public.pipelines (room_id, id);

-- Jobs become pipeline stages
alter table public.jobs add column if not exists pipeline_id bigint references public.pipelines(id);
alter table public.jobs add column if not exists stage_index int;
alter table public.jobs add column if not exists review jsonb;
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('research','prototype','review','host'));

-- Never two active jobs for the same stage of a pipeline (guards orchestrator races)
create unique index if not exists jobs_one_active_stage
  on public.jobs (pipeline_id, stage_index)
  where pipeline_id is not null and status in ('proposed','running');

alter publication supabase_realtime add table public.pipelines;
alter publication supabase_realtime add table public.rooms;

alter table public.rooms     enable row level security;
alter table public.pipelines enable row level security;

create policy "rooms read"   on public.rooms for select to anon, authenticated using (true);
create policy "rooms insert" on public.rooms for insert to anon, authenticated with check (true);
create policy "rooms update" on public.rooms for update to anon, authenticated using (true) with check (true);
create policy "pipelines read" on public.pipelines for select to anon, authenticated using (true);
-- pipelines are created/advanced by Edge Functions (service role); browsers act via the orchestrate function
