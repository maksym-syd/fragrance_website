import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { firstConnected, FOCUSABLE, trapTarget } from '../lib/focus';
import type { Tier } from '../lib/types';

/**
 * Dialog behaviour shared by the tier sheet and quick rank: focus moves in on open, Tab stays
 * inside, Escape calls onClose, the page behind doesn't scroll. On close, focus goes to
 * returnFocus() if it finds something, else back to whatever had it when the dialog opened, else
 * to fallback() when that element has left the page.
 * onClose and returnFocus are read when used, so they can change between renders.
 */
export function useModal(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  returnFocus?: () => HTMLElement | null,
  fallback?: () => HTMLElement | null,
) {
  const latest = useRef({ onClose, returnFocus, fallback });
  latest.current = { onClose, returnFocus, fallback };
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Kept across StrictMode's second mount, when focus is already on the dialog.
    if (!openerRef.current && document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
    const opener = openerRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return latest.current.onClose();
      const dialog = ref.current;
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const active = document.activeElement as HTMLElement | null;
      const target = trapTarget(items, active, e.shiftKey, dialog, !!active && dialog.contains(active));
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      const { returnFocus: preferred, fallback: lastResort } = latest.current;
      // Wait for the close to render: a chip that changed tier is a new element by then.
      requestAnimationFrame(() => {
        // Still on the page means it never really closed (StrictMode's mount, unmount, mount).
        if (ref.current?.isConnected) return;
        const el = firstConnected([preferred?.(), opener, lastResort?.()], (x) => x.isConnected);
        if (!el) return;
        // Headings and <main> can't take focus until they're given a tabindex.
        if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
        el.focus({ preventScroll: true });
      });
    };
    // Runs once: re-running would pull focus out of a form whenever a realtime update arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Sets the browser tab title; the app name always comes last. */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} – Scent Tiers` : 'Scent Tiers';
  }, [title]);
}

export function TierLetter({ tier, size = 'md', title }: { tier: Tier | null; size?: 'sm' | 'md'; title?: string }) {
  if (!tier) return <span className={`tier-letter tier-none ${size}`} title={title ?? "Haven't tried"}>·</span>;
  return <span className={`tier-letter tier-${tier.toLowerCase()} ${size}`} title={title}>{tier}</span>;
}

/** Section title with an optional hint. The id comes from the title, so jump links can target it. */
/** Somewhere on the board to land after a dialog whose opener is gone: a chip, the room title, or the page. */
export function boardFocusFallback(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.tier-board [data-frag-id]') ??
    document.querySelector<HTMLElement>('[data-frag-id]') ??
    document.querySelector<HTMLElement>('.room-head h1') ??
    document.querySelector<HTMLElement>('main')
  );
}

export function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="section-head" id={title.toLowerCase().replace(/\s+/g, '-')}>
      <h2 className="h2">{title}</h2>
      {hint && <span className="label">{hint}</span>}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden>✦</div>
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className = 'btn btn-ghost btn-sm' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed'); // clipboard blocked: say so rather than look like it worked
        }
        setTimeout(() => setState('idle'), 1800);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : label}
    </button>
  );
}

/**
 * Two-step destructive button: first click arms it, second click confirms. Never window.confirm.
 * Arming swaps the button for the prompt, so focus moves to the safe choice (Cancel), and goes
 * back to the button when the prompt closes without removing the thing.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  cancelLabel = 'Cancel',
  prompt,
  onConfirm,
  className = 'btn btn-danger-ghost',
}: {
  label: string;
  confirmLabel: string;
  cancelLabel?: string;
  prompt: ReactNode;
  onConfirm: () => void | Promise<unknown>;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const promptId = useId();
  const armRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasArmed = useRef(armed);

  useEffect(() => {
    if (wasArmed.current === armed) return;
    wasArmed.current = armed;
    (armed ? cancelRef : armRef).current?.focus();
  }, [armed]);

  if (!armed) {
    return (
      <button ref={armRef} type="button" className={className} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-labelledby={promptId}>
      <p id={promptId} className="confirm-prompt">{prompt}</p>
      <div className="confirm-actions">
        <button ref={cancelRef} type="button" className="btn btn-ghost btn-sm" onClick={() => setArmed(false)} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            setBusy(false);
            setArmed(false);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
