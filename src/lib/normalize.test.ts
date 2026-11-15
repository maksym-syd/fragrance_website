import { describe, expect, it } from 'vitest';
import { extractRoomCode, normalizeCode } from './normalize';

describe('extractRoomCode', () => {
  it('takes the code from a full room link', () => {
    expect(extractRoomCode('https://scent-tiers.vercel.app/r/K7P2QX')).toBe('K7P2QX');
    expect(extractRoomCode('http://localhost:5173/r/K7P2QX')).toBe('K7P2QX');
  });

  it('ignores a trailing slash, a sub-page, a query string or a hash', () => {
    expect(extractRoomCode('https://x.app/r/K7P2QX/')).toBe('K7P2QX');
    expect(extractRoomCode('https://x.app/r/K7P2QX/overlap')).toBe('K7P2QX');
    expect(extractRoomCode('https://x.app/r/K7P2QX?utm=chat')).toBe('K7P2QX');
    expect(extractRoomCode('https://x.app/r/K7P2QX#try-next')).toBe('K7P2QX');
  });

  it('uppercases lowercase codes, in links and alone', () => {
    expect(extractRoomCode('https://x.app/r/k7p2qx')).toBe('K7P2QX');
    expect(extractRoomCode('k7p2qx')).toBe('K7P2QX');
  });

  it('handles links with surrounding text or whitespace', () => {
    expect(extractRoomCode('  join us: https://x.app/r/K7P2QX  ')).toBe('K7P2QX');
  });

  it('treats plain input as a code, as before', () => {
    expect(extractRoomCode('K7P2QX')).toBe('K7P2QX');
    expect(extractRoomCode(' k7p-2qx ')).toBe('K7P2QX');
    expect(extractRoomCode('K7P')).toBe('K7P');
    expect(extractRoomCode('')).toBe('');
  });

  it('does not take a 7+ character path segment as a code', () => {
    // Falls back to normalizeCode, which is what typing it would give.
    expect(extractRoomCode('https://x.app/r/K7P2QXZ')).toBe(normalizeCode('https://x.app/r/K7P2QXZ'));
  });
});
