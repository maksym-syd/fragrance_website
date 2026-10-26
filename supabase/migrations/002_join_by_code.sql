-- Let people join a room with just its code (still signed in), when the owner allows it.
-- Joining by code adds the joiner's email to the room's invite list, so every existing
-- RLS policy keeps working unchanged and the owner can still remove them.

alter table public.rooms add column join_by_code boolean not null default true;

grant update (name, join_by_code) on public.rooms to authenticated;

create function public.join_room_by_code(p_code text, p_display_name text) returns public.rooms
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(auth.email());
  v_room public.rooms;
begin
  if auth.uid() is null or v_email is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  -- Same error for "no such room" and "invite-only", so codes can't be probed for existence.
  if v_room.id is null or not (v_room.join_by_code or public.can_access_room(v_room.id)) then
    raise exception 'Room not found or invite-only' using errcode = 'P0002';
  end if;

  if v_room.owner_id <> auth.uid() then
    insert into public.invites (room_id, email) values (v_room.id, v_email)
    on conflict do nothing;
  end if;

  -- A taken display name raises unique_violation (23505), which the app reports.
  insert into public.members (room_id, user_id, email, display_name)
  values (v_room.id, auth.uid(), v_email, btrim(p_display_name))
  on conflict (room_id, user_id) do nothing;

  return v_room;
end;
$$;

revoke execute on function public.join_room_by_code(text, text) from public, anon;
grant  execute on function public.join_room_by_code(text, text) to authenticated;
