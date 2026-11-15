import type { PostgrestError, RealtimePostgresChangesPayload, User } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dedupeKey } from '../lib/normalize';
import { looseKey } from '../lib/reference';
import {
  afterLoad,
  FRAGRANCE_REMOVE_BLOCKED,
  INVITE_REMOVE_BLOCKED,
  NOTICE_MS,
  requireRows,
  ROOM_DELETE_BLOCKED,
  shortName,
  tierFailLabel,
  unrankedLabel,
  type LoadOutcome,
  type LoadState,
  type Notice,
} from '../lib/roomState';
import { db } from '../lib/supabase';
import type { Fragrance, FragrancePatch, Invite, Member, NewFragrance, Ranking, Room, Tier } from '../lib/types';

export type { Notice, RoomStatus } from '../lib/roomState';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface RoomData {
  room: Room | null;
  members: Member[];
  fragrances: Fragrance[];
  rankings: Ranking[];
  invites: Invite[];
}

export interface WriteResult<T = unknown> {
  ok: boolean;
  data?: T | null;
  message?: string;
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

/** Rows from before migration 003 (or a stale realtime payload) may lack the detail columns. */
function withDetails(row: Fragrance): Fragrance {
  return {
    ...row,
    perfumers: row.perfumers ?? [],
    accords: row.accords ?? [],
    notes_top: row.notes_top ?? [],
    notes_heart: row.notes_heart ?? [],
    notes_base: row.notes_base ?? [],
    release_year: row.release_year ?? null,
  };
}

/** The same bottle already in `list`? Looser than the SQL index, so "Hermes" finds "Hermès". */
function findDuplicate(list: Fragrance[], name: string, house: string, ignoreId?: string): Fragrance | undefined {
  const strict = dedupeKey(name, house);
  const loose = looseKey(name, house);
  return list.find((x) => x.id !== ignoreId && (dedupeKey(x.name, x.house) === strict || looseKey(x.name, x.house) === loose));
}

export function friendlyError(err: PostgrestError | Error | null | undefined): string {
  if (!err) return 'Something went wrong';
  const code = 'code' in err ? err.code : undefined;
  if (code === '23505') return 'That already exists in this room';
  if (code === 'P0002') return 'Room not found or invite-only';
  if (code === '42501') return "You don't have permission to do that";
  return err.message || 'Something went wrong';
}

/** The error requireRows() reports when RLS silently deleted nothing. */
const blocked = (message: string) => () => ({ message }) as PostgrestError;

export function useRoom(code: string, user: User) {
  const [{ status, stale }, setLoadState] = useState<LoadState>({ status: 'loading', stale: false });
  const [data, setData] = useState<RoomData>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveStatus>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const saveTimer = useRef<number>();
  const noticeId = useRef(0);
  const myIdRef = useRef<string | null>(null);
  // Labels and undo read the latest rows without making every callback depend on them.
  const dataRef = useRef(data);
  dataRef.current = data;

  const finish = useCallback((outcome: LoadOutcome, message?: string) => {
    if (outcome.ok) setError(null);
    else setError(message ?? 'Something went wrong');
    setLoadState((prev) => afterLoad(prev, outcome));
  }, []);

  const load = useCallback(async () => {
    const fetchRoom = async () => {
      const client = db();
      const { data: room, error: roomErr } = await client.from('rooms').select('*').eq('code', code).maybeSingle();
      if (roomErr) {
        finish({ ok: false }, friendlyError(roomErr));
        return;
      }
      if (!room) {
        // RLS hides rooms you aren't invited to, so "doesn't exist" and "not invited" look the same.
        setData(EMPTY);
        finish({ ok: true, status: 'not-invited' });
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
        finish({ ok: false }, friendlyError(firstErr));
        return;
      }
      const members = (m.data ?? []) as Member[];
      setData({
        room,
        members,
        fragrances: ((f.data ?? []) as Fragrance[]).map(withDetails),
        rankings: (r.data ?? []) as Ranking[],
        invites: (inv.data ?? []) as Invite[],
      });
      finish({ ok: true, status: members.some((x) => x.user_id === user.id) ? 'ready' : 'join' });
    };
    try {
      await fetchRoom();
    } catch (e) {
      // A dropped connection can throw instead of returning an error object.
      finish({ ok: false }, friendlyError(e instanceof Error ? e : null));
    }
  }, [code, user.id, finish]);

  useEffect(() => {
    setLoadState({ status: 'loading', stale: false });
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
        if (table === 'fragrances') return { ...d, fragrances: upsertBy(d.fragrances, withDetails(row as unknown as Fragrance), (x) => x.id) };
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

  /** A toast. The newest replaces any older one; Room clears it after a while. */
  const showNotice = useCallback((n: Omit<Notice, 'id'>) => setNotice({ ...n, id: ++noticeId.current }), []);
  const dismissNotice = useCallback((id?: number) => setNotice((n) => (id === undefined || n?.id === id ? null : n)), []);

  /**
   * Wrap a write: show Saving…/Saved. On failure, say what failed (`label`), offer `retry` when
   * repeating the write is safe, and resync from the server.
   */
  const track = useCallback(
    async <T,>(
      label: string,
      fn: () => PromiseLike<{ data?: T | null; error: PostgrestError | null }>,
      retry?: () => void,
    ): Promise<WriteResult<T>> => {
      window.clearTimeout(saveTimer.current);
      setSave('saving');
      let res: { data?: T | null; error: PostgrestError | null };
      try {
        res = await fn();
      } catch (e) {
        res = { data: null, error: { message: e instanceof Error ? e.message : 'Network error' } as PostgrestError };
      }
      const { data: result, error: err } = res;
      if (err) {
        setSave('error');
        saveTimer.current = window.setTimeout(() => setSave('idle'), NOTICE_MS);
        showNotice({ tone: 'error', text: label, action: retry && { label: 'Retry', run: retry } });
        load();
        return { ok: false, message: friendlyError(err) };
      }
      setSave('saved');
      saveTimer.current = window.setTimeout(() => setSave('idle'), 2000);
      return { ok: true, data: result };
    },
    [load, showNotice],
  );

  type SetTier = (fragranceId: string, tier: Tier | null, opts?: { undo?: boolean }) => Promise<WriteResult | undefined>;
  const setTierRef = useRef<SetTier>();

  /**
   * Rank, re-rank or unrank one of my fragrances. Unranking deletes the row, so it offers Undo
   * unless the caller has its own (`{ undo: false }`, e.g. Quick rank stepping back).
   */
  const setTier = useCallback(
    async (fragranceId: string, tier: Tier | null, opts: { undo?: boolean } = {}): Promise<WriteResult | undefined> => {
      if (!me || !roomId) return;
      const key = rankKey({ member_id: me.id, fragrance_id: fragranceId });
      const name = dataRef.current.fragrances.find((f) => f.id === fragranceId)?.name;
      const previous = dataRef.current.rankings.find((x) => rankKey(x) === key)?.tier ?? null;
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
      if (!tier && previous && opts.undo !== false) {
        showNotice({
          tone: 'info',
          text: unrankedLabel(name),
          action: { label: 'Undo', run: () => setTierRef.current?.(fragranceId, previous, { undo: false }) },
        });
      }
      return track(
        tierFailLabel(name, tier),
        () =>
          tier
            ? db().from('rankings').upsert(row, { onConflict: 'member_id,fragrance_id' })
            : db().from('rankings').delete().eq('member_id', me.id).eq('fragrance_id', fragranceId),
        () => setTierRef.current?.(fragranceId, tier, { undo: false }),
      );
    },
    [me, roomId, track, showNotice],
  );
  setTierRef.current = setTier;

  const addFragrance = useCallback(
    async (f: NewFragrance) => {
      if (!me || !roomId) return { ok: false, message: 'Not in a room' };
      const dupe = findDuplicate(data.fragrances, f.name, f.house);
      if (dupe) return { ok: false, message: `${dupe.name} by ${dupe.house} is already in this room` };
      const res = await track<Fragrance>(`Couldn’t add ${shortName(f.name)}`, () =>
        db()
          .from('fragrances')
          .insert({ ...f, name: f.name.trim(), house: f.house.trim(), room_id: roomId, added_by: me.id })
          .select()
          .single(),
      );
      if (res.ok && res.data) {
        const created = withDetails(res.data);
        setData((d) => ({ ...d, fragrances: upsertBy(d.fragrances, created, (x) => x.id) }));
      }
      return res;
    },
    [me, roomId, data.fragrances, track],
  );

  /** Any member can edit. Other people's screens pick this up through the realtime UPDATE. */
  const updateFragrance = useCallback(
    async (id: string, patch: FragrancePatch) => {
      const dupe = findDuplicate(data.fragrances, patch.name, patch.house, id);
      if (dupe) return { ok: false, message: `${dupe.name} by ${dupe.house} is already in this room` };
      const name = dataRef.current.fragrances.find((x) => x.id === id)?.name ?? patch.name;
      const res = await track<Fragrance>(`Couldn’t save changes to ${shortName(name)}`, () =>
        db()
          .from('fragrances')
          .update({ ...patch, name: patch.name.trim(), house: patch.house.trim() })
          .eq('id', id)
          .select()
          .single(),
      );
      if (res.ok && res.data) {
        const updated = withDetails(res.data);
        setData((d) => ({ ...d, fragrances: upsertBy(d.fragrances, updated, (x) => x.id) }));
      }
      return res;
    },
    [data.fragrances, track],
  );

  /** Owner only, enforced by RLS. A blocked delete is 0 rows and no error, so count what came back. */

  const removeFragrance = useCallback(
    async (id: string) => {
      if (!isOwner) return { ok: false, message: FRAGRANCE_REMOVE_BLOCKED };
      const name = dataRef.current.fragrances.find((x) => x.id === id)?.name;
      setData((d) => ({
        ...d,
        fragrances: d.fragrances.filter((x) => x.id !== id),
        rankings: d.rankings.filter((x) => x.fragrance_id !== id),
      }));
      // A blocked delete is reported as a failure, so track() shows it and reloads, bringing the bottle back.
      return track(`Couldn’t remove ${shortName(name)}`, async () =>
        requireRows(await db().from('fragrances').delete().eq('id', id).select('id'), blocked(FRAGRANCE_REMOVE_BLOCKED)),
      );
    },
    [isOwner, track],
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

  const setJoinByCodeRef = useRef<(open: boolean) => unknown>();
  const setJoinByCode = useCallback(
    async (open: boolean) => {
      if (!roomId) return { ok: false };
      setData((d) => (d.room ? { ...d, room: { ...d.room, join_by_code: open } } : d));
      return track(
        open ? 'Couldn’t turn on joining by code' : 'Couldn’t turn off joining by code',
        () => db().from('rooms').update({ join_by_code: open }).eq('id', roomId),
        () => void setJoinByCodeRef.current?.(open),
      );
    },
    [roomId, track],
  );

  setJoinByCodeRef.current = setJoinByCode;

  const rename = useCallback(
    async (displayName: string) => {
      if (!me) return { ok: false };
      const res = await track('Couldn’t change your name', () => db().from('members').update({ display_name: displayName.trim() }).eq('id', me.id));
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
      const res = await track<Invite>(`Couldn’t invite ${email}`, () => db().from('invites').insert({ room_id: roomId, email }).select().single());
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
      const res = await track(`Couldn’t remove ${email}`, async () =>
        requireRows(
          await db().from('invites').delete().eq('room_id', roomId).eq('email', email).select('email'),
          blocked(INVITE_REMOVE_BLOCKED),
        ),
      );
      // Server-side trigger also removes their membership and rankings; reflect that.
      if (res.ok) await load();
      return res;
    },
    [roomId, track, load],
  );

  const deleteRoom = useCallback(async () => {
    if (!roomId) return { ok: false };
    return track('Couldn’t delete the room', async () =>
      requireRows(await db().from('rooms').delete().eq('id', roomId).select('id'), blocked(ROOM_DELETE_BLOCKED)),
    );
  }, [roomId, track]);

  return {
    status,
    /** A refetch failed after the room loaded; what's on screen is the last good copy. */
    stale,
    error,
    save,
    notice,
    dismissNotice,
    ...data,
    me,
    isOwner,
    reload: load,
    setTier,
    addFragrance,
    updateFragrance,
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
