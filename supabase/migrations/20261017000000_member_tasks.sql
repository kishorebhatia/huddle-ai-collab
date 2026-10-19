-- Members' own AIs do the room's work: a stage can wait for a connected AI to claim it (MCP next_task /
-- claim_task / submit_work) instead of running on Huddle's models. Safe to re-run.

-- Who does the work in this room. auto (default): members' AIs get first claim while one of them has been
-- active in the room in the last hour, otherwise Huddle starts right away. huddle: Huddle's models only.
-- members_first: always offer to members' AIs first. members_only: never fall back to Huddle.
alter table public.rooms add column if not exists work_by text not null default 'auto';
alter table public.rooms alter column work_by set default 'auto';
alter table public.rooms drop constraint if exists rooms_work_by_check;
alter table public.rooms add constraint rooms_work_by_check check (work_by in ('auto', 'huddle', 'members_first', 'members_only'));
-- How long an open task waits for a member's AI before Huddle takes it (auto and members_first).
alter table public.rooms add column if not exists handoff_minutes int not null default 10;

-- open: waiting for a member's AI. claimed: a member's AI holds it until lease_until.
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('proposed', 'open', 'claimed', 'running', 'done', 'failed', 'dismissed'));
alter table public.jobs add column if not exists worker text;          -- display name, e.g. "Claude (Zain)"
alter table public.jobs add column if not exists worker_id text;       -- link:<id> or session:<id>; null = Huddle
alter table public.jobs add column if not exists claimed_at timestamptz;
alter table public.jobs add column if not exists lease_until timestamptz;
alter table public.jobs add column if not exists open_until timestamptz; -- null = no fallback to Huddle
create index if not exists mcp_links_active_idx on public.mcp_links (room_id, last_used_at) where revoked_at is null;
create index if not exists jobs_open_idx on public.jobs (room_id, status) where status in ('open', 'claimed');

-- Never two active jobs for the same stage, counting open and claimed ones too.
drop index if exists public.jobs_one_active_stage;
create unique index if not exists jobs_one_active_stage
  on public.jobs (pipeline_id, stage_index)
  where pipeline_id is not null and status in ('proposed', 'open', 'claimed', 'running');

-- catch_up: where each link last read the stream.
alter table public.mcp_links add column if not exists cursor_event_id bigint not null default 0;

-- Browsers change the room's work setting the same way they change its mode.
grant update (mode, paused, name, work_by) on public.rooms to anon, authenticated;
