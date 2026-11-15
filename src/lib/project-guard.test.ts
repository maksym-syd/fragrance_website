import { describe, expect, it } from 'vitest';
import { checkProject, projectFlag, projectRef } from '../../scripts/lib/project-guard';

const PROD = 'https://abcdefghijklmnop.supabase.co';

describe('projectRef', () => {
  it('parses the ref from a supabase.co URL', () => {
    expect(projectRef(PROD)).toBe('abcdefghijklmnop');
    expect(projectRef('https://abcdefghijklmnop.supabase.co/')).toBe('abcdefghijklmnop');
  });
  it('treats localhost and 127.0.0.1 as local', () => {
    expect(projectRef('http://localhost:54321')).toBe('local');
    expect(projectRef('http://127.0.0.1:54321')).toBe('local');
  });
  it('rejects anything else', () => {
    expect(projectRef('https://api.example.com')).toBeNull();
    expect(projectRef('https://abc.supabase.co.evil.com')).toBeNull();
    expect(projectRef('https://a.b.supabase.co')).toBeNull();
    expect(projectRef('not a url')).toBeNull();
  });
});

describe('checkProject', () => {
  it('refuses a real project without --project', () => {
    const r = checkProject(PROD, ['node', 'seed.ts', '--yes']);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain('--project=abcdefghijklmnop');
  });
  it('refuses a mismatched --project', () => {
    expect(checkProject(PROD, ['--project=otherref'])).toMatchObject({ ok: false });
    expect(checkProject(PROD, ['--project='])).toMatchObject({ ok: false });
    expect(checkProject(PROD, ['--project', 'abcdefghijklmnop'])).toMatchObject({ ok: false });
  });
  it('allows a matching --project', () => {
    expect(checkProject(PROD, ['--yes', '--project=abcdefghijklmnop'])).toEqual({ ok: true, target: 'abcdefghijklmnop' });
  });
  it('allows localhost without the flag', () => {
    expect(checkProject('http://127.0.0.1:54321', [])).toEqual({ ok: true, target: 'local' });
  });
  it('refuses a missing or unrecognised URL', () => {
    expect(checkProject(undefined, ['--project=x'])).toMatchObject({ ok: false });
    expect(checkProject('https://db.example.com', ['--project=db'])).toMatchObject({ ok: false });
  });
  it('projectFlag reads only the = form', () => {
    expect(projectFlag(['--project=abc'])).toBe('abc');
    expect(projectFlag(['--project', 'abc'])).toBeUndefined();
  });
});
