-- Huddle improving Huddle: an operator room's pipelines edit the prompts and open a pull request. Safe to re-run.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('plan', 'research', 'review', 'prototype', 'host', 'improve', 'pr'));
