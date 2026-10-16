-- GitHub-backed rooms: sign-in with GitHub, room owners, private rooms with members, and the files
-- each room has published to its repository. Safe to re-run.

-- People who signed in with GitHub. The token is encrypted by the server; browsers never read this table.
create table if not exists public.users (
  id           bigint generated always as identity primary key,
  github_id    bigint not null unique,
  login        text not null,
  name         text,
  avatar_url   text,
  email        text,
  token_enc    text,              -- AES-GCM, key derived from the server's JWT secret
  scopes       text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.rooms add column if not exists name text;
alter table public.rooms add column if not exists owner_id bigint references public.users(id);
alter table public.rooms add column if not exists visibility text not null default 'public';
alter table public.rooms drop constraint if exists rooms_visibility_check;
alter table public.rooms add constraint rooms_visibility_check check (visibility in ('public', 'private'));
-- {owner, name, id, url, html_url, pages_url, private, last_commit, last_published_at}
alter table public.rooms add column if not exists repo jsonb;

create table if not exists public.room_members (
  room_id     text not null,
  user_id     bigint references public.users(id),
  login       text not null,      -- invited by GitHub login; user_id fills in when they sign in
  role        text not null default 'member' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (room_id, login)
);

-- What each publish wrote, so the next one only commits what changed.
create table if not exists public.repo_files (
  room_id      text not null,
  path         text not null,
  sha256       text not null,
  commit_sha   text,
  updated_at   timestamptz not null default now(),
  primary key (room_id, path)
);

-- The signed-in user, from the JWT PostgREST verified (null for anonymous visitors).
create or replace function public.huddle_uid() returns bigint language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::bigint
$$;

-- Can the current caller see this room? Public rooms: anyone with the link. Private: owner and members.
-- Unknown rooms count as visible so a visitor can create one.
create or replace function public.room_visible(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select rm.visibility = 'public'
        or coalesce(rm.owner_id = public.huddle_uid(), false)  -- null for anonymous callers, which must not mean "visible"
        or exists (select 1 from public.room_members m where m.room_id = r and m.user_id = public.huddle_uid())
    from public.rooms rm where rm.id = r
  ), true)
$$;

-- Replace the open policies with room-visibility checks.
do $$
declare
  t text;
begin
  foreach t in array array['events', 'brain', 'jobs', 'pipelines', 'board_items', 'evals'] loop
    execute coalesce((select string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' ')
             from pg_policies where schemaname = 'public' and tablename = t), 'select 1');
    execute format('create policy "%s read" on public.%I for select to anon, authenticated using (public.room_visible(room_id))', t, t);
  end loop;
end $$;
create policy "events write" on public.events for insert to anon, authenticated with check (public.room_visible(room_id));
create policy "jobs insert"  on public.jobs for insert to anon, authenticated with check (public.room_visible(room_id));
create policy "jobs update"  on public.jobs for update to anon, authenticated using (public.room_visible(room_id)) with check (public.room_visible(room_id));
create policy "board insert" on public.board_items for insert to anon, authenticated with check (public.room_visible(room_id));
create policy "board update" on public.board_items for update to anon, authenticated using (public.room_visible(room_id)) with check (public.room_visible(room_id));

drop policy if exists "rooms read" on public.rooms;
drop policy if exists "rooms insert" on public.rooms;
drop policy if exists "rooms update" on public.rooms;
create policy "rooms read"   on public.rooms for select to anon, authenticated using (public.room_visible(id));
create policy "rooms insert" on public.rooms for insert to anon, authenticated with check (true);
create policy "rooms update" on public.rooms for update to anon, authenticated using (public.room_visible(id)) with check (true);

-- Browsers may create a room and change its agent mode; owner, visibility and repo change only
-- through the github function, which checks who is asking.
revoke insert, update on public.rooms from anon, authenticated;
grant insert (id, name, mode) on public.rooms to anon, authenticated;
grant update (mode, paused, name) on public.rooms to anon, authenticated;

alter table public.users        enable row level security;
alter table public.room_members enable row level security;
alter table public.repo_files   enable row level security;
revoke all on public.users, public.room_members, public.repo_files from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.users, public.room_members, public.repo_files to service_role;
    grant usage, select on all sequences in schema public to service_role;
  end if;
end $$;
