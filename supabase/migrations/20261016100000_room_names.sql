-- Room names everyone in the room sees (and can change). Safe to re-run.
alter table public.rooms add column if not exists name text;
alter table public.rooms drop constraint if exists rooms_name_length;
alter table public.rooms add constraint rooms_name_length check (name is null or char_length(name) between 1 and 60);
