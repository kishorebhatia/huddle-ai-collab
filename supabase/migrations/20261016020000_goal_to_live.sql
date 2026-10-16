-- Goal → live link: a planning stage, multi-file builds with a backend, and secrets the room supplies.
-- Safe to re-run.

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('plan', 'research', 'review', 'prototype', 'host'));

-- A build's files ({path: content}); output_html stays the page the viewer previews.
alter table public.jobs add column if not exists files jsonb;

-- Secrets a build needs (e.g. ELEVENLABS_API_KEY). Encrypted by the server; no browser can read them.
-- Saved to a signed-in user's account: usable in every room that user owns.
create table if not exists public.user_secrets (
  user_id     bigint not null references public.users(id),
  name        text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value_enc   text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, name)
);
-- Entered for one room (anyone in a public room can supply one; nobody can read it back).
create table if not exists public.room_secrets (
  room_id     text not null,
  name        text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value_enc   text not null,
  set_by      bigint references public.users(id),
  updated_at  timestamptz not null default now(),
  primary key (room_id, name)
);
alter table public.user_secrets enable row level security;
alter table public.room_secrets enable row level security;
revoke all on public.user_secrets, public.room_secrets from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.user_secrets, public.room_secrets to service_role;
  end if;
end $$;
