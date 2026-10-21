-- Private huddles by email: the owner lists who may get in; people sign in with a one-time code sent to
-- their email (or the link in their invite). Anyone else can ask to join and the owner lets them in.
-- People who were in the room when it went private may stay until they close the tab (a guest pass).
-- Only the people function (service role) writes these tables. Safe to re-run.

-- Who may open a private room. role owner: manages the list (kept here, not on rooms, which browsers can read).
-- joined_at: first sign-in.
create table if not exists public.room_people (
  room_id    text not null,
  email      text not null check (email = lower(email)),
  role       text not null default 'member' check (role in ('owner', 'member')),
  name       text,
  added_by   text,
  added_at   timestamptz not null default now(),
  joined_at  timestamptz,
  primary key (room_id, email)
);
create index if not exists room_people_email_idx on public.room_people (email);

-- One pending sign-in code per email. Only a hash is kept; attempts and sends are limited.
create table if not exists public.email_codes (
  email        text primary key,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  sends        int not null default 1,
  window_start timestamptz not null default now(),
  last_sent_at timestamptz not null default now()
);

-- Someone not on the list asked to get in (after proving their email).
create table if not exists public.join_requests (
  id          bigint generated always as identity primary key,
  room_id     text not null,
  email       text not null,
  name        text,
  status      text not null default 'pending' check (status in ('pending', 'admitted', 'declined')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create unique index if not exists join_requests_pending_idx on public.join_requests (room_id, email) where status = 'pending';

-- AI links remember which person made them, so removing the person turns their AIs off too.
alter table public.mcp_links add column if not exists created_by_email text;

alter table public.room_people   enable row level security;
alter table public.email_codes   enable row level security;
alter table public.join_requests enable row level security;
revoke all on public.room_people, public.email_codes, public.join_requests from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.room_people, public.email_codes, public.join_requests to service_role;
    grant usage, select on all sequences in schema public to service_role;
  end if;
end $$;

-- The email and guest room from the caller's Huddle token (null for anyone else).
create or replace function public.huddle_email() returns text language sql stable as $$
  select nullif(lower(nullif(current_setting('request.jwt.claims', true), '')::json->>'email'), '')
$$;
create or replace function public.huddle_guest_room() returns text language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'guest_room', '')
$$;

-- Can the current caller see this room? Public: anyone with the link. Private: the GitHub owner and members,
-- the people on its email list, and guests who were in it when it went private.
-- Unknown rooms count as visible so a visitor can create one.
create or replace function public.room_visible(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select rm.visibility = 'public'
        or coalesce(rm.owner_id = public.huddle_uid(), false)  -- null for anonymous callers, which must not mean "visible"
        or exists (select 1 from public.room_members m where m.room_id = r and m.user_id = public.huddle_uid())
        or exists (select 1 from public.room_people p where p.room_id = r and p.email = public.huddle_email())
        or coalesce(public.huddle_guest_room() = r, false)
    from public.rooms rm where rm.id = r
  ), true)
$$;

-- Deleting a room also removes its people and requests.
create or replace function public.delete_room(r text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from rooms where id = r) then return false; end if;
  update lessons set from_job_id = null where from_job_id in (select id from jobs where room_id = r);
  delete from evals where room_id = r;
  delete from jobs where room_id = r;
  delete from pipelines where room_id = r;
  delete from events where room_id = r;
  delete from brain where room_id = r;
  delete from board_items where room_id = r;
  delete from mcp_links where room_id = r;
  delete from room_secrets where room_id = r;
  delete from repo_files where room_id = r;
  delete from room_members where room_id = r;
  delete from room_people where room_id = r;
  delete from join_requests where room_id = r;
  delete from rooms where id = r;
  return true;
end $$;
revoke all on function public.delete_room(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.delete_room(text) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.delete_room(text) to service_role;
  end if;
end $$;
