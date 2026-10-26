import type { PostgrestError, RealtimePostgresChangesPayload, User } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dedupeKey } from '../lib/normalize';
import { db } from '../lib/supabase';
import type { Fragrance, Invite, Member, NewFragrance, Ranking, Room, Tier } from '../lib/types';

export type RoomStatus = 'loading' | 'not-invited' | 'join' | 'ready' | 'error';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface RoomData {
  room: Room | null;
  members: Member[];
  fragrances: Fragrance[];
  rankings: Ranking[];
  invites: Invite[];
}

const EMPTY: RoomData = { room: null, members: [], fragrances: [], rankings: [], invites: [] };

const rankKey = (r: Pick<Ranking, 'member_id' | 'fragrance_id'>) => `${r.member_id}:${r.fragrance_id}`;

function upsertBy<T>(list: T[], item: T, key: (t: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function friendlyError(err: PostgrestError | Error | null | undefined): string {
  if (!err) return 'Something went wrong';
  const code = 'code' in err ? err.code : undefined;
  if (code === '23505') return 'That already exists in this room';
  if (code === 'P0002') return 'Room not found or invite-only';
  if (code === '42501') return "You don't have permission to do that";
  return err.message || 'Something went wrong';
}

export function useRoom(code: string, user: User) {
  const [status, setStatus] = useState<RoomStatus>('loading');
  const [data, setData] = useState<RoomData>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveStatus>('idle');
  const saveTimer = useRef<number>();
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const client = db();
    const { data: room, error: roomErr } = await client.from('rooms').select('*').eq('code', code).maybeSingle();
    if (roomErr) {
      setError(friendlyError(roomErr));
      setStatus('error');
      return;
    }
    if (!room) {
      // RLS hides rooms you aren't invited to, so "doesn't exist" and "not invited" look the same.
      setData(EMPTY);
      setStatus('not-invited');
      return;
    }
    const isOwner = room.owner_id === user.id;
    const [m, f, r, inv] = await Promise.all([
      client.from('members').select('*').eq('room_id', room.id).order('joined_at'),
      client.from('fragrances').select('*').eq('room_id', room.id).order('created_at'),
      client.from('rankings').select('*').eq('room_id', room.id),
      isOwner
        ? client.from('invites').select('*').eq('room_id', room.id).order('created_at')
        : Promise.resolve({ data: [] as Invite[], error: null }),
    ]);
    const firstErr = m.error || f.error || r.error || inv.error;
    if (firstErr) {
      setError(friendlyError(firstErr));
      setStatus('error');
      return;
    }
    const members = (m.data ?? []) as Member[];
    setData({
      room,
      members,
      fragrances: (f.data ?? []) as Fragrance[],
      rankings: (r.data ?? []) as Ranking[],
      invites: (inv.data ?? []) as Invite[],
    });
    setStatus(members.some((x) => x.user_id === user.id) ? 'ready' : 'join');
  }, [code, user.id]);

  useEffect(() => {
    setStatus('loading');
    load();
  }, [load]);

  // Refetch when the tab regains focus, in case realtime missed something while asleep.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const roomId = data.room?.id;

  // Realtime: inserts/updates are filtered by room and RLS. Deletes can't be filtered by
  // Supabase and only carry primary keys, so we match them against local state.
  useEffect(() => {
    if (!roomId || status !== 'ready') return;
    const client = db();
    const filter = `room_id=eq.${roomId}`;
    type Row = Record<string, unknown>;

    const onChange = (table: 'members' | 'fragrances' | 'rankings') => (p: RealtimePostgresChangesPayload<Row>) => {
      if (p.eventType === 'DELETE') {
        const old = p.old as Row;
        setData((d) => {
          if (table === 'rankings') {
            const k = rankKey(old as unknown as Ranking);
            return { ...d, rankings: d.rankings.filter((x) => rankKey(x) !== k) };
          }
          if (table === 'fragrances') {
            return {
              ...d,
              fragrances: d.fragrances.filter((x) => x.id !== old.id),
              rankings: d.rankings.filter((x) => x.fragrance_id !== old.id),
            };
          }
          return {
            ...d,
            members: d.members.filter((x) => x.id !== old.id),
            rankings: d.rankings.filter((x) => x.member_id !== old.id),
          };
        });
        // If *my* membership disappeared (uninvited), reload to show the right screen.
        if (table === 'members' && old.id === myIdRef.current) load();
        return;
      }
      const row = p.new as Row;
      if (row.room_id !== roomId) return;
      setData((d) => {
        if (table === 'rankings') return { ...d, rankings: upsertBy(d.rankings, row as unknown as Ranking, rankKey) };
        if (table === 'fragrances') return { ...d, fragrances: upsertBy(d.fragrances, row as unknown as Fragrance, (x) => x.id) };
        return { ...d, members: upsertBy(d.members, row as unknown as Member, (x) => x.id) };
      });
    };

    let channel = client.channel(`room:${roomId}`);
    for (const table of ['members', 'fragrances', 'rankings'] as const) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, onChange(table))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, onChange(table))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, onChange(table));
    }
    let subscribedOnce = false;
    channel.subscribe((s) => {
      // After a reconnect, catch up on anything we missed.
      if (s === 'SUBSCRIBED') {
        if (subscribedOnce) load();
        subscribedOnce = true;
      }
    });
    return () => {
      client.removeChannel(channel);
    };
  }, [roomId, status, load]);

  const me = data.members.find((m) => m.user_id === user.id) ?? null;
  myIdRef.current = me?.id ?? null;
  const isOwner = !!data.room && data.room.owner_id === user.id;

  /** Wrap a write: show Saving…/Saved, and on failure resync from the server. */
  const track = useCallback(
    async <T,>(fn: () => PromiseLike<{ data?: T | null; error: PostgrestError | null }>): Promise<{ ok: boolean; data?: T | null; message?: string }> => {
      window.clearTimeout(saveTimer.current);
      setSave('saving');
      const { data: result, error: err } = await fn();
      if (err) {
        setSave('error');
        load();
        return { ok: false, message: friendlyError(err) };
      }
      setSave('saved');
      saveTimer.current = window.setTimeout(() => setSave('idle'), 2000);
      return { ok: true, data: result };
    },
    [load],
  );

  const setTier = useCallback(
    async (fragranceId: string, tier: Tier | null) => {
      if (!me || !roomId) return;
      const key = rankKey({ member_id: me.id, fragrance_id: fragranceId });
      const row: Ranking = {
        room_id: roomId,
        member_id: me.id,
        fragrance_id: fragranceId,
        tier: tier ?? 'C',
        updated_at: new Date().toISOString(),
      };
      setData((d) => ({
        ...d,
        rankings: tier ? upsertBy(d.rankings, row, rankKey) : d.rankings.filter((x) => rankKey(x) !== key),
      }));
      return track(() =>
        tier
          ? db().from('rankings').upsert(row, { onConflict: 'member_id,fragrance_id' })
          : db().from('rankings').delete().eq('member_id', me.id).eq('fragrance_id', fragranceId),
      );
    },
    [me, roomId, track],
  );

  const addFragrance = useCallback(
    async (f: NewFragrance) => {
      if (!me || !roomId) return { ok: false, message: 'Not in a room' };
      const key = dedupeKey(f.name, f.house);
      if (data.fragrances.some((x) => dedupeKey(x.name, x.house) === key)) {
        return { ok: false, message: `${f.name} by ${f.house} is already in this room` };
      }
      const res = await track<Fragrance>(() =>
        db()
          .from('fragrances')
          .insert({ ...f, name: f.name.trim(), house: f.house.trim(), room_id: roomId, added_by: me.id })
          .select()
          .single(),
      );
      if (res.ok && res.data) {
        const created = res.data;
        setData((d) => ({ ...d, fragrances: upsertBy(d.fragrances, created, (x) => x.id) }));
      }
      return res;
    },
    [me, roomId, data.fragrances, track],
  );

  const removeFragrance = useCallback(
    async (id: string) => {
      setData((d) => ({
        ...d,
        fragrances: d.fragrances.filter((x) => x.id !== id),
        rankings: d.rankings.filter((x) => x.fragrance_id !== id),
      }));
      return track(() => db().from('fragrances').delete().eq('id', id));
    },
    [track],
  );

  const join = useCallback(
    async (displayName: string) => {
      if (!roomId) return { ok: false, message: 'Room not found' };
      const { error: err } = await db().from('members').insert({ room_id: roomId, display_name: displayName.trim() });
      if (err) {
        return {
          ok: false,
          message: err.code === '23505' ? 'Someone in this room already uses that name' : friendlyError(err),
        };
      }
      await load();
      return { ok: true };
    },
    [roomId, load],
  );

  /** Join via the room code alone (works when the owner allows it). */
  const joinByCode = useCallback(
    async (displayName: string) => {
      const { error: err } = await db().rpc('join_room_by_code', { p_code: code, p_display_name: displayName.trim() });
      if (err) {
        return {
          ok: false,
          inviteOnly: err.code === 'P0002',
          message: err.code === '23505' ? 'Someone in this room already uses that name' : friendlyError(err),
        };
      }
      await load();
      return { ok: true, inviteOnly: false };
    },
    [code, load],
  );

  const setJoinByCode = useCallback(
    async (open: boolean) => {
      if (!roomId) return { ok: false };
      setData((d) => (d.room ? { ...d, room: { ...d.room, join_by_code: open } } : d));
      return track(() => db().from('rooms').update({ join_by_code: open }).eq('id', roomId));
    },
    [roomId, track],
  );

  const rename = useCallback(
    async (displayName: string) => {
      if (!me) return { ok: false };
      const res = await track(() => db().from('members').update({ display_name: displayName.trim() }).eq('id', me.id));
      if (res.ok) {
        setData((d) => ({
          ...d,
          members: d.members.map((m) => (m.id === me.id ? { ...m, display_name: displayName.trim() } : m)),
        }));
      } else if (res.message === 'That already exists in this room') {
        res.message = 'Someone in this room already uses that name';
      }
      return res;
    },
    [me, track],
  );

  const addInvite = useCallback(
    async (email: string) => {
      if (!roomId) return { ok: false };
      const res = await track<Invite>(() => db().from('invites').insert({ room_id: roomId, email }).select().single());
      if (res.ok && res.data) {
        const created = res.data;
        setData((d) => ({ ...d, invites: [...d.invites, created] }));
      } else if (res.message === 'That already exists in this room') {
        res.message = `${email} is already invited`;
      }
      return res;
    },
    [roomId, track],
  );

  const removeInvite = useCallback(
    async (email: string) => {
      if (!roomId) return { ok: false };
      const res = await track(() => db().from('invites').delete().eq('room_id', roomId).eq('email', email));
      // Server-side trigger also removes their membership and rankings; reflect that.
      if (res.ok) await load();
      return res;
    },
    [roomId, track, load],
  );

  const deleteRoom = useCallback(async () => {
    if (!roomId) return { ok: false };
    return track(() => db().from('rooms').delete().eq('id', roomId));
  }, [roomId, track]);

  return {
    status,
    error,
    save,
    ...data,
    me,
    isOwner,
    reload: load,
    setTier,
    addFragrance,
    removeFragrance,
    join,
    joinByCode,
    setJoinByCode,
    rename,
    addInvite,
    removeInvite,
    deleteRoom,
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
