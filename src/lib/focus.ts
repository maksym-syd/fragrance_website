/** Things Tab can land on. Hidden ones are filtered out by the caller. */
export const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should send focus to keep it inside a dialog, or null to let the browser move it.
 * `inside` says whether the focused element is in the dialog: after a button unmounts, focus
 * sits on <body>, and the next Tab must come back in rather than walk the page behind.
 * Generic so it can be tested without a DOM.
 */
export function trapTarget<T>(items: T[], active: T | null, shift: boolean, container: T, inside: boolean): T | null {
  if (items.length === 0) return container;
  const first = items[0];
  const last = items[items.length - 1];
  if (!inside) return shift ? last : first;
  if (shift && (active === first || active === container)) return last;
  if (!shift && active === last) return first;
  return null;
}
