-- Deleting a huddle: one call removes the room and everything kept for it, in an order the foreign keys allow.
-- Only the delete-room function (service role) calls it; it checks who is asking first. Safe to re-run.
-- Kept on purpose: lessons (shared across rooms, only unlinked from this room's jobs), the waitlist, and any
-- GitHub repository the room published to.
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
