-- Only the room owner can remove a fragrance. A member can't remove one even if they added it.
--
-- APPLY BY HAND: paste this whole file into the Supabase SQL Editor and click Run.
-- Do this BEFORE deploying the frontend. It doesn't depend on 003; either can go first.
--
-- Changes one policy and no data. Members keep add and edit. A blocked DELETE is not an error:
-- it affects 0 rows, which is why the app asks for the deleted row back. Safe to run twice.

begin;

drop policy if exists fragrances_delete on public.fragrances;
create policy fragrances_delete on public.fragrances for delete to authenticated
  using (public.is_room_owner(room_id));

commit;
