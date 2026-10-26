-- Scent Tiers — initial schema
-- Invite-only rooms. Access rules live here in Row Level Security, not in the frontend:
--   * a signed-in user can SEE a room if they own it or their email is on its invite list
--   * they can READ/WRITE room data only after joining (members row) and while still invited
--   * only the owner can manage invites or delete the room
-- Removing an invite revokes access immediately and removes that person's membership + rankings.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.invites (
  room_id     uuid not null references public.rooms (id) on delete cascade,
  email       text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  created_at  timestamptz not null default now(),
  primary key (room_id, email)
);

create table public.members (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email         text not null default lower(auth.email()),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 40),
  joined_at     timestamptz not null default now(),
  unique (room_id, user_id),
  unique (id, room_id) -- target for composite FKs below
);

-- Display names are unique per room, ignoring case and surrounding spaces.
create unique index members_room_name_key on public.members (room_id, lower(btrim(display_name)));

create table public.fragrances (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 80),
  house          text not null check (char_length(btrim(house)) between 1 and 60),
  concentration  text check (concentration in ('EDT', 'EDP', 'Parfum', 'Extrait')),
  notes          text[] not null default '{}',
  added_by       uuid,
  created_at     timestamptz not null default now(),
  unique (id, room_id),
  foreign key (added_by, room_id) references public.members (id, room_id) on delete set null (added_by)
);

-- No duplicates per room: name + house compared case-insensitively with all whitespace removed.
-- Keep in sync with dedupeKey() in src/lib/normalize.ts.
create unique index fragrances_room_dedupe_key on public.fragrances (
  room_id,
  lower(regexp_replace(name, '\s+', '', 'g')),
  lower(regexp_replace(house, '\s+', '', 'g'))
);

create table public.rankings (
  room_id       uuid not null references public.rooms (id) on delete cascade,
  member_id     uuid not null,
  fragrance_id  uuid not null,
  tier          text not null check (tier in ('S', 'A', 'B', 'C', 'D')),
  updated_at    timestamptz not null default now(),
  primary key (member_id, fragrance_id),
  -- Composite FKs guarantee member and fragrance belong to the same room as the ranking.
  foreign key (member_id, room_id) references public.members (id, room_id) on delete cascade,
  foreign key (fragrance_id, room_id) references public.fragrances (id, room_id) on delete cascade
);

create index rooms_owner_idx        on public.rooms (owner_id);
create index invites_email_idx      on public.invites (email);
create index members_user_idx       on public.members (user_id);
create index fragrances_room_idx    on public.fragrances (room_id);
create index rankings_room_idx      on public.rankings (room_id);
create index rankings_fragrance_idx on public.rankings (fragrance_id);

-- ---------------------------------------------------------------------------
-- Access helpers. SECURITY DEFINER so policies can consult other tables
-- without recursing through their RLS.
-- ---------------------------------------------------------------------------

create function public.is_room_owner(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rooms r where r.id = p_room and r.owner_id = auth.uid());
$$;

-- Owner, or email currently on the invite list.
create function public.can_access_room(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_room_owner(p_room)
      or exists (
        select 1 from public.invites i
        where i.room_id = p_room and i.email = lower(auth.email())
      );
$$;

-- Joined AND still allowed in.
create function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_access_room(p_room)
     and exists (
       select 1 from public.members m
       where m.room_id = p_room and m.user_id = auth.uid()
     );
$$;

-- The given member row belongs to the caller.
create function public.owns_member(p_member uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.id = p_member and m.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- RPC: create a room with a fresh 6-char code and join the creator as a member.
-- ---------------------------------------------------------------------------

create function public.create_room(p_name text, p_display_name text) returns public.rooms
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I
  v_code text;
  v_room public.rooms;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (code, name, owner_id)
  values (v_code, btrim(p_name), auth.uid())
  returning * into v_room;

  insert into public.members (room_id, user_id, email, display_name)
  values (v_room.id, auth.uid(), lower(auth.email()), btrim(p_display_name));

  return v_room;
end;
$$;

-- Uninviting someone also removes their membership (and, by cascade, their rankings).
create function public.remove_member_on_uninvite() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.members m
  using public.rooms r
  where m.room_id = old.room_id
    and r.id = old.room_id
    and m.email = old.email
    and m.user_id <> r.owner_id;
  return old;
end;
$$;

create trigger invites_remove_member
after delete on public.invites
for each row execute function public.remove_member_on_uninvite();

-- ---------------------------------------------------------------------------
-- Privileges. No anonymous access at all; authenticated users get only the
-- columns they need, and RLS narrows the rows.
-- ---------------------------------------------------------------------------

revoke all on public.rooms, public.invites, public.members, public.fragrances, public.rankings
  from anon, authenticated;

grant select, delete         on public.rooms      to authenticated;
grant update (name)          on public.rooms      to authenticated;
grant select, insert, delete on public.invites    to authenticated;
grant select, insert, delete on public.members    to authenticated;
grant update (display_name)  on public.members    to authenticated;
grant select, insert, delete on public.fragrances to authenticated;
grant update (name, house, concentration, notes) on public.fragrances to authenticated;
grant select, insert, update, delete on public.rankings to authenticated;

revoke execute on function public.create_room(text, text) from public, anon;
grant  execute on function public.create_room(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.rooms      enable row level security;
alter table public.invites    enable row level security;
alter table public.members    enable row level security;
alter table public.fragrances enable row level security;
alter table public.rankings   enable row level security;

-- rooms: visible to owner + invitees (so invitees can see the name before joining).
-- Created only through create_room().
create policy rooms_select on public.rooms for select to authenticated
  using (public.can_access_room(id));
create policy rooms_update on public.rooms for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy rooms_delete on public.rooms for delete to authenticated
  using (owner_id = auth.uid());

-- invites: the owner manages them; an invitee may see their own invite row.
create policy invites_select on public.invites for select to authenticated
  using (public.is_room_owner(room_id) or email = lower(auth.email()));
create policy invites_insert on public.invites for insert to authenticated
  with check (public.is_room_owner(room_id));
create policy invites_delete on public.invites for delete to authenticated
  using (public.is_room_owner(room_id));

-- members
create policy members_select on public.members for select to authenticated
  using (public.is_room_member(room_id));
create policy members_insert on public.members for insert to authenticated
  with check (
    user_id = auth.uid()
    and email = lower(auth.email())
    and public.can_access_room(room_id)
  );
create policy members_update on public.members for update to authenticated
  using (user_id = auth.uid() and public.is_room_member(room_id))
  with check (user_id = auth.uid());
create policy members_delete on public.members for delete to authenticated
  using (user_id = auth.uid() or public.is_room_owner(room_id));

-- fragrances: any current member can add, edit or remove for everyone.
create policy fragrances_select on public.fragrances for select to authenticated
  using (public.is_room_member(room_id));
create policy fragrances_insert on public.fragrances for insert to authenticated
  with check (
    public.is_room_member(room_id)
    and (added_by is null or public.owns_member(added_by))
  );
create policy fragrances_update on public.fragrances for update to authenticated
  using (public.is_room_member(room_id))
  with check (public.is_room_member(room_id));
create policy fragrances_delete on public.fragrances for delete to authenticated
  using (public.is_room_member(room_id));

-- rankings: everyone in the room can read; you can only write your own.
create policy rankings_select on public.rankings for select to authenticated
  using (public.is_room_member(room_id));
create policy rankings_insert on public.rankings for insert to authenticated
  with check (public.is_room_member(room_id) and public.owns_member(member_id));
create policy rankings_update on public.rankings for update to authenticated
  using (public.is_room_member(room_id) and public.owns_member(member_id))
  with check (public.is_room_member(room_id) and public.owns_member(member_id));
create policy rankings_delete on public.rankings for delete to authenticated
  using (public.is_room_member(room_id) and public.owns_member(member_id));

-- ---------------------------------------------------------------------------
-- Realtime (postgres_changes respects the SELECT policies above)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.members, public.fragrances, public.rankings;
  end if;
end;
$$;
