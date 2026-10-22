-- Who may start new huddles. Empty (the default): anyone, as before. On a personal server, ROOM_CREATORS
-- (comma-separated emails) fills this list at startup, and then only those people, signed in with their
-- email, can create rooms. Rooms that already exist work as before: public ones for anyone with the link,
-- private ones for the people on their list. Made-up or deleted room links lead nowhere. Safe to re-run.

create table if not exists public.room_creators (
  email text primary key check (email = lower(email))
);
alter table public.room_creators enable row level security;
revoke all on public.room_creators from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.room_creators to service_role;
  end if;
end $$;

create or replace function public.rooms_locked() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_creators)
$$;

create or replace function public.can_create_room() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.rooms_locked() or exists (select 1 from public.room_creators where email = public.huddle_email())
$$;

-- Unknown rooms count as visible (so a visitor can create one) only when anyone may create rooms.
create or replace function public.room_visible(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select rm.visibility = 'public'
        or coalesce(rm.owner_id = public.huddle_uid(), false)  -- null for anonymous callers, which must not mean "visible"
        or exists (select 1 from public.room_members m where m.room_id = r and m.user_id = public.huddle_uid())
        or exists (select 1 from public.room_people p where p.room_id = r and p.email = public.huddle_email())
        or coalesce(public.huddle_guest_room() = r, false)
    from public.rooms rm where rm.id = r
  ), public.can_create_room())
$$;

drop policy if exists "rooms insert" on public.rooms;
create policy "rooms insert" on public.rooms for insert to anon, authenticated with check (public.can_create_room());
