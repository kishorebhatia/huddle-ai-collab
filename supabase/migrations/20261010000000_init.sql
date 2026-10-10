-- Huddle: shared team workspace (hackathon schema: anyone with the room link can read/write)

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  room_id     text not null,
  author      text not null default 'someone',
  kind        text not null check (kind in ('speech','note','link','image','finding','feedback','system')),
  text        text,
  image_url   text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_room_idx on public.events (room_id, id);

create table if not exists public.brain (
  room_id        text primary key,
  state          jsonb not null default '{}'::jsonb,
  version        int not null default 0,
  last_event_id  bigint not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists public.jobs (
  id           bigint generated always as identity primary key,
  room_id      text not null,
  kind         text not null check (kind in ('research','prototype')),
  title        text not null,
  prompt       text not null,
  status       text not null default 'proposed' check (status in ('proposed','running','done','failed','dismissed')),
  created_by   text not null default 'huddle',
  parent_id    bigint references public.jobs(id),
  output_md    text,
  output_html  text,
  sources      jsonb not null default '[]'::jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists jobs_room_idx on public.jobs (room_id, id);

-- Realtime
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.brain;
alter publication supabase_realtime add table public.jobs;

-- RLS: open within a room link (hackathon). Tighten before real use.
alter table public.events enable row level security;
alter table public.brain  enable row level security;
alter table public.jobs   enable row level security;

create policy "events read"   on public.events for select to anon, authenticated using (true);
create policy "events write"  on public.events for insert to anon, authenticated with check (true);
create policy "brain read"    on public.brain  for select to anon, authenticated using (true);
create policy "jobs read"     on public.jobs   for select to anon, authenticated using (true);
create policy "jobs insert"   on public.jobs   for insert to anon, authenticated with check (true);
create policy "jobs update"   on public.jobs   for update to anon, authenticated using (true) with check (true);

-- Storage for whiteboard sketches, photos, screenshots
insert into storage.buckets (id, name, public) values ('board', 'board', true)
on conflict (id) do nothing;

create policy "board upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'board');
create policy "board read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'board');
