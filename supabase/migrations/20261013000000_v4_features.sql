-- v4: endless board, private-space waitlist, voice notes / video / files, locked decisions, "forget last 2 minutes".

-- New kinds of things people can share
alter table public.events drop constraint if exists events_kind_check;
alter table public.events add constraint events_kind_check
  check (kind in ('speech','note','link','image','finding','feedback','system','voice','video','file'));

-- "Forget the last 2 minutes": erased lines keep their row (so everyone's stream updates live) but lose their content
alter table public.events add column if not exists forgotten boolean not null default false;

-- Decisions the team locked; the brief update keeps them word for word
alter table public.brain add column if not exists locked jsonb not null default '[]'::jsonb;

-- The endless board: every card has a position on one shared, unbounded surface
create table if not exists public.board_items (
  id          bigint generated always as identity primary key,
  room_id     text not null,
  kind        text not null check (kind in ('brief','note','sketch','event','output')),
  x           double precision not null default 0,
  y           double precision not null default 0,
  w           double precision not null default 260,
  data        jsonb not null default '{}'::jsonb,   -- note: {text} · sketch: {paths, w, h} · event: {event_id} · output: {job_id}
  removed     boolean not null default false,
  created_by  text not null default 'someone',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists board_items_room_idx on public.board_items (room_id, id);
alter publication supabase_realtime add table public.board_items;
alter table public.board_items enable row level security;
-- Open within a room link, like the rest of the hackathon build. Tighten with auth before real use.
create policy "board read"   on public.board_items for select to anon, authenticated using (true);
create policy "board insert" on public.board_items for insert to anon, authenticated with check (true);
create policy "board update" on public.board_items for update to anon, authenticated using (true) with check (true);

-- People asking for private spaces. Browsers can add an email but never read the list.
create table if not exists public.waitlist (
  id          bigint generated always as identity primary key,
  email       text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  room_id     text,
  created_at  timestamptz not null default now()
);
alter table public.waitlist enable row level security;
create policy "waitlist join" on public.waitlist for insert to anon, authenticated with check (true);
