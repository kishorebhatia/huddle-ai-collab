-- Links that connect someone's own AI to a room over MCP (/mcp). Only a hash of each key is stored.
-- perms: {post, work, answer} — read is always allowed. Safe to re-run.
create table if not exists public.mcp_links (
  id            bigint generated always as identity primary key,
  token_hash    text not null unique,
  room_id       text not null,
  label         text,
  perms         jsonb not null default '{"post": true, "work": true, "answer": false}'::jsonb,
  created_by    bigint references public.users(id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists mcp_links_room_idx on public.mcp_links (room_id);
alter table public.mcp_links enable row level security;
revoke all on public.mcp_links from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.mcp_links to service_role;
  end if;
end $$;
