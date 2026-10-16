-- Grants PostgREST needs (Supabase sets these up by default); RLS policies still decide what anon can do.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

-- Realtime: every row change sends {t, op, pk}. aws/server reads the row and fans it out over WebSocket.
-- (Rows can exceed NOTIFY's 8 KB limit, so only the key travels.)
create or replace function public.huddle_notify() returns trigger language plpgsql as $$
declare j jsonb;
begin
  j := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  perform pg_notify('huddle_changes', json_build_object(
    't', tg_table_name, 'op', tg_op, 'pk', coalesce(j->>'id', j->>'room_id'))::text);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['events','brain','jobs','pipelines','rooms','board_items'] loop
    execute format('create trigger %I_notify after insert or update or delete on public.%I for each row execute function public.huddle_notify()', t, t);
  end loop;
end $$;
