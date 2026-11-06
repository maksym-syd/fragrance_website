import { useEffect, useState, type ReactNode } from 'react';
import type { Tier } from '../lib/types';

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

/** Two-step destructive button: first click arms it, second click confirms. Never window.confirm. */
export function ConfirmButton({
  label,
  confirmLabel,
  prompt,
  onConfirm,
  className = 'btn btn-danger-ghost',
}: {
  label: string;
  confirmLabel: string;
  prompt: ReactNode;
  onConfirm: () => void | Promise<unknown>;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!armed) {
    return (
      <button type="button" className={className} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="alertdialog" aria-live="polite">
      <p className="confirm-prompt">{prompt}</p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setArmed(false)} disabled={busy}>
          Cancel
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
