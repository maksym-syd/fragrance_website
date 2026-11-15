import { describe, expect, it } from 'vitest';
import { afterLoad, requireRows, tierFailLabel, unrankedLabel, type LoadState } from './roomState';

const s = (status: LoadState['status'], stale = false): LoadState => ({ status, stale });

describe('afterLoad', () => {
  it('a failed first load is an error page', () => {
    expect(afterLoad(s('loading'), { ok: false })).toEqual(s('error'));
  });

  it('a failed refetch keeps a loaded room and marks it stale', () => {
    expect(afterLoad(s('ready'), { ok: false })).toEqual(s('ready', true));
    expect(afterLoad(s('join'), { ok: false })).toEqual(s('join', true));
    expect(afterLoad(s('ready', true), { ok: false })).toEqual(s('ready', true));
  });

  it('the next successful load clears stale', () => {
    expect(afterLoad(s('ready', true), { ok: true, status: 'ready' })).toEqual(s('ready'));
  });

  it('a successful load can still move to another screen (e.g. uninvited)', () => {
    expect(afterLoad(s('ready', true), { ok: true, status: 'not-invited' })).toEqual(s('not-invited'));
  });

  it('retrying from the error page stays an error until it works', () => {
    expect(afterLoad(s('error'), { ok: false })).toEqual(s('error'));
    expect(afterLoad(s('error'), { ok: true, status: 'ready' })).toEqual(s('ready'));
  });

  it('not-invited has no data to keep, so a failure there is an error', () => {
    expect(afterLoad(s('not-invited'), { ok: false })).toEqual(s('error'));
  });
});

describe('labels', () => {
  it('say what failed', () => {
    expect(tierFailLabel('Aventus', 'S')).toBe('Couldn’t move Aventus to S');
    expect(tierFailLabel('Aventus', null)).toBe('Couldn’t unrank Aventus');
    expect(unrankedLabel('Aventus')).toBe('Unranked Aventus');
  });

  it('cope with a missing or very long name', () => {
    expect(tierFailLabel(undefined, 'A')).toBe('Couldn’t move that fragrance to A');
    expect(unrankedLabel('x'.repeat(80))).toHaveLength('Unranked '.length + 40);
  });
});

describe('requireRows', () => {
  const blocked = () => ({ message: 'blocked' });

  it('treats 0 deleted rows (RLS said no, silently) as a failure', () => {
    expect(requireRows({ data: [], error: null }, blocked)).toEqual({ data: null, error: { message: 'blocked' } });
    expect(requireRows({ data: null, error: null }, blocked)).toEqual({ data: null, error: { message: 'blocked' } });
  });

  it('passes through a delete that removed rows', () => {
    const res = { data: [{ id: 'r1' }], error: null };
    expect(requireRows(res, blocked)).toBe(res);
  });

  it('keeps a real error rather than replacing it', () => {
    const res = { data: null, error: { message: 'network down' } };
    expect(requireRows(res, blocked)).toBe(res);
  });
});
