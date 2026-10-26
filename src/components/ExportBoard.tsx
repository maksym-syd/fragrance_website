import { toPng } from 'html-to-image';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomApi } from '../hooks/useRoom';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';

/** Renders every member's tier list off-screen and downloads it as a PNG. */
export default function ExportButton({ api }: { api: RoomApi }) {
  const [state, setState] = useState<'idle' | 'rendering' | 'error'>('idle');
  const boardRef = useRef<HTMLDivElement>(null);

  async function exportImage() {
    setState('rendering');
    // Let the portal mount before capturing.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const node = boardRef.current;
    if (!node) return setState('error');
    const opts = { pixelRatio: 2, cacheBust: true, backgroundColor: '#f6f3f8' };
    try {
      let url: string;
      try {
        url = await toPng(node, opts);
      } catch {
        // Web fonts can fail to inline (CORS, offline); fall back to system fonts.
        url = await toPng(node, { ...opts, skipFonts: true });
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = `scent-tiers-${api.room!.code.toLowerCase()}.png`;
      a.click();
      setState('idle');
    } catch {
      setState('error');
    }
  }

  return (
    <>
      <button className="btn btn-sm" onClick={exportImage} disabled={state === 'rendering'}>
        {state === 'rendering' ? 'Rendering…' : state === 'error' ? 'Export failed — retry' : 'Export image'}
      </button>
      {state === 'rendering' && createPortal(<Board api={api} innerRef={boardRef} />, document.body)}
    </>
  );
}

function Board({ api, innerRef }: { api: RoomApi; innerRef: React.Ref<HTMLDivElement> }) {
  const fragById = new Map(api.fragrances.map((f) => [f.id, f]));
  const members = api.members.filter((m) => api.rankings.some((r) => r.member_id === m.id));
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="export-stage" aria-hidden>
      <div ref={innerRef} className="export-board">
        <header className="export-head">
          <span className="export-brand">Scent Tiers</span>
          <h1 className="export-title">{api.room!.name}</h1>
          <span className="export-date">{date}</span>
        </header>
        {members.length === 0 ? (
          <p className="export-empty">Nobody has ranked anything yet.</p>
        ) : (
          <div className="export-grid" style={{ gridTemplateColumns: `repeat(${Math.min(members.length, 3)}, 1fr)` }}>
            {members.map((m) => {
              const mine = api.rankings.filter((r) => r.member_id === m.id);
              return (
                <section key={m.id} className="export-member">
                  <h2 className="export-name">{m.display_name}</h2>
                  {TIERS.map((t) => {
                    const items = mine.filter((r) => r.tier === t).map((r) => fragById.get(r.fragrance_id)).filter(Boolean);
                    return (
                      <div key={t} className="export-row">
                        <span className={`export-tier tier-${t.toLowerCase()}`} title={TIER_LABEL[t]}>{t}</span>
                        <span className="export-items">
                          {items.length === 0 ? <span className="export-dash">—</span> : items.map((f) => f!.name).join(' · ')}
                        </span>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
