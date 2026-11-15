-- Audit log: keeps a copy of every row that is deleted (and of every fragrance before it is
-- edited), so a mistaken delete or edit can be put back by hand. See "Applying 005 and 006" in
-- README.md for how to restore a row.
--
-- APPLY BY HAND: first run `npm run backup` (the project is on Supabase Free, which has no
-- platform backups), then paste this whole file into the Supabase SQL Editor and click Run.
--
-- Additive: no existing column, row or policy changes. Every app table gets an AFTER trigger
-- that copies OLD into public.audit_log. Cascaded deletes fire the triggers too, so deleting a
-- room logs the room and every invite, member, fragrance and ranking that went with it.
-- The log is invisible to the app: RLS is on with no policies and no grants to anon/authenticated.
-- Only the SQL Editor / service role can read it.

begin;

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid default auth.uid(),          -- null for SQL Editor / service-role / auth-admin deletes
  table_name  text not null,
  op          text not null check (op in ('UPDATE', 'DELETE')),
  old_row     jsonb not null
);

create index audit_log_table_at_idx on public.audit_log (table_name, at);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

create function public.audit_old_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, op, old_row) values (TG_TABLE_NAME, TG_OP, to_jsonb(old));
  return null;
end;
$$;

revoke execute on function public.audit_old_row() from public, anon, authenticated;

create trigger audit_rooms      after delete           on public.rooms      for each row execute function public.audit_old_row();
create trigger audit_invites    after delete           on public.invites    for each row execute function public.audit_old_row();
create trigger audit_members    after delete           on public.members    for each row execute function public.audit_old_row();
create trigger audit_rankings   after delete           on public.rankings   for each row execute function public.audit_old_row();
create trigger audit_fragrances after update or delete on public.fragrances for each row execute function public.audit_old_row();

commit;

-- ROLLBACK (export the log first if you want to keep it:
--   copy (select * from public.audit_log order by id) to stdout  -- or download it from the Table Editor):
--
-- begin;
-- drop trigger if exists audit_rooms      on public.rooms;
-- drop trigger if exists audit_invites    on public.invites;
-- drop trigger if exists audit_members    on public.members;
-- drop trigger if exists audit_rankings   on public.rankings;
-- drop trigger if exists audit_fragrances on public.fragrances;
-- drop function if exists public.audit_old_row();
-- drop table if exists public.audit_log;
-- commit;
