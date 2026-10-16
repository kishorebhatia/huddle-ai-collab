-- Operator v2: Huddle can change any part of itself (triage → change → review → pr → ship), and admins can
-- give the production server new keys (e.g. a different model provider) without touching git. Safe to re-run.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('plan', 'research', 'review', 'prototype', 'host', 'improve', 'pr', 'ship', 'triage', 'change'));

-- Server environment set by an admin from the operator room. Encrypted; loaded into the server's environment
-- at start (and immediately when set). Browsers can never read it.
create table if not exists public.server_secrets (
  name        text primary key check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value_enc   text not null,
  set_by      bigint references public.users(id),
  updated_at  timestamptz not null default now()
);
alter table public.server_secrets enable row level security;
revoke all on public.server_secrets from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant all on public.server_secrets to service_role; end if;
end $$;
