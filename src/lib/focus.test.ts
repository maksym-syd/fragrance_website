import { describe, expect, it } from 'vitest';
import { trapTarget } from './focus';

const items = ['first', 'middle', 'last'];

describe('trapTarget', () => {
  it('wraps Tab from the last item to the first', () => {
    expect(trapTarget(items, 'last', false, 'dialog', true)).toBe('first');
  });

  it('wraps Shift+Tab from the first item, or the dialog itself, to the last', () => {
    expect(trapTarget(items, 'first', true, 'dialog', true)).toBe('last');
    expect(trapTarget(items, 'dialog', true, 'dialog', true)).toBe('last');
  });

  it('leaves Tab between items to the browser', () => {
    expect(trapTarget(items, 'middle', false, 'dialog', true)).toBeNull();
    expect(trapTarget(items, 'middle', true, 'dialog', true)).toBeNull();
    expect(trapTarget(items, 'dialog', false, 'dialog', true)).toBeNull();
  });

  it('pulls focus back in when it fell outside (a focused button unmounted)', () => {
    expect(trapTarget(items, 'body', false, 'dialog', false)).toBe('first');
    expect(trapTarget(items, 'body', true, 'dialog', false)).toBe('last');
  });

  it('keeps focus on the dialog when nothing inside can take it', () => {
    expect(trapTarget([], 'body', false, 'dialog', false)).toBe('dialog');
  });
});
