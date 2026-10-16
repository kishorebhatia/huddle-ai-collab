-- The operator room can ship its own change: merge the pull request once CI's evals pass. Safe to re-run.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('plan', 'research', 'review', 'prototype', 'host', 'improve', 'pr', 'ship'));
-- The operator room is backed by Huddle's own repository, not a room repository.
update public.rooms set repo = jsonb_build_object('owner', 'kishorebhatia', 'name', 'huddle-ai-collab', 'branch', 'redesign-v4',
  'html_url', 'https://github.com/kishorebhatia/huddle-ai-collab/tree/redesign-v4', 'self', true, 'private', false)
where id = 'huddle-operator' and (repo is null or not coalesce((repo->>'self')::boolean, false));
