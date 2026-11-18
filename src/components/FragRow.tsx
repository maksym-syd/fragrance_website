import type { ReactNode } from 'react';
import type { Fragrance } from '../lib/types';

/** One fragrance as a button that opens its TierSheet; tiers or other detail sit on the right. */
export default function FragRow({
  f,
  onOpen,
  detail,
  children,
}: {
  f?: Fragrance;
  onOpen: (id: string) => void;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  if (!f) return null;
  return (
    <li>
      <button className="frag-row" onClick={() => onOpen(f.id)}>
        <span className="frag-row-text">
          <span className="frag-name">{f.name}</span>
          <span className="muted small">{f.house}</span>
          {detail}
        </span>
        {children && <span className="frag-row-tiers">{children}</span>}
      </button>
    </li>
  );
}
