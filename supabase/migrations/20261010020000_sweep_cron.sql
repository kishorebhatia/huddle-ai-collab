-- Every minute, nudge stalled pipelines and fail jobs whose function died mid-run.
-- Before `supabase db push`, replace YOUR-PROJECT-REF below with your project ref.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule('huddle-sweep') where exists (select 1 from cron.job where jobname = 'huddle-sweep');
select cron.schedule(
  'huddle-sweep',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/orchestrate',
       headers := '{"content-type":"application/json"}'::jsonb,
       body := '{"sweep":true}'::jsonb) $$
);
