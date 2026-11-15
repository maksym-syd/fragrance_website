-- Deleting a room owner's auth account no longer deletes their rooms (and everyone's rankings).
-- rooms.owner_id → auth.users becomes ON DELETE RESTRICT: the account delete fails while the
-- user still owns a room. Delete or hand over the room first.
--
-- APPLY BY HAND: first run `npm run backup`, then paste this whole file into the Supabase SQL
-- Editor and click Run. It doesn't depend on 005.
--
-- Unchanged: members.user_id → auth.users stays ON DELETE CASCADE, so deleting a user who owns
-- no rooms still removes their memberships and, by cascade, their rankings.
--
-- The constraint name is Postgres's default for 001's inline FK. Check it first in production:
--   select conname from pg_constraint where conrelid = 'public.rooms'::regclass and contype = 'f';
-- Expect exactly one row: rooms_owner_id_fkey. If the name differs, edit both lines below.

begin;

alter table public.rooms
  drop constraint rooms_owner_id_fkey,
  add constraint rooms_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete restrict;

commit;

-- ROLLBACK (restores 001's behaviour):
-- begin;
-- alter table public.rooms
--   drop constraint rooms_owner_id_fkey,
--   add constraint rooms_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete cascade;
-- commit;
