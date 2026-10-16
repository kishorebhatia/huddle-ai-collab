-- Evals, lessons and per-job proof (Anchor live view, Daytona sandbox, Arize trace) for the AWS build.

-- Anything a job wants to show besides its output: {trace_id, live_view_url, sandbox_id, screenshot_url, evals:{name:{score,explanation}}}
alter table public.jobs add column if not exists meta jsonb not null default '{}'::jsonb;

-- Every eval score, also sent to Arize as a span annotation
create table if not exists public.evals (
  id           bigint generated always as identity primary key,
  room_id      text not null,
  job_id       bigint references public.jobs(id),
  pipeline_id  bigint references public.pipelines(id),
  name         text not null,
  score        double precision not null,
  explanation  text,
  trace_id     text,
  span_id      text,
  created_at   timestamptz not null default now()
);
create index if not exists evals_room_idx on public.evals (room_id, id);

-- One-line lessons distilled from low scores; later prompts for the same stage include the latest ones
create table if not exists public.lessons (
  id           bigint generated always as identity primary key,
  stage        text not null,
  text         text not null,
  eval_name    text,
  score        double precision,
  from_job_id  bigint references public.jobs(id),
  created_at   timestamptz not null default now()
);

alter table public.evals   enable row level security;
alter table public.lessons enable row level security;
create policy "evals read"   on public.evals   for select to anon, authenticated using (true);
create policy "lessons read" on public.lessons for select to anon, authenticated using (true);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.evals, public.lessons to service_role;
    grant select on public.evals, public.lessons to anon, authenticated;
  end if;
end $$;
