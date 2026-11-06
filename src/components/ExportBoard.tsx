import { toBlob } from 'html-to-image';
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
    // Let the portal mount and its fonts settle before capturing.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await document.fonts.ready;
    const node = boardRef.current;
    if (!node) return setState('error');
    const opts = {
      pixelRatio: safePixelRatio(node.offsetWidth, node.offsetHeight),
      backgroundColor: '#f6f3f8',
    };
    try {
      let blob: Blob | null;
      try {
        blob = await toBlob(node, opts);
      } catch {
        // Web fonts can fail to inline (CORS, offline); fall back to system fonts.
        blob = await toBlob(node, { ...opts, skipFonts: true });
      }
      if (!blob) throw new Error('Empty image');
      await saveImage(blob, `scent-tiers-${api.room!.code.toLowerCase()}.png`);
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

/** Mobile Safari refuses canvases past about 16.7 million pixels, which 6 long lists at 2x can reach. */
function safePixelRatio(width: number, height: number) {
  return Math.min(2, Math.sqrt(16_000_000 / (width * height)));
}

/** Phones get the share sheet (Save Image, Messages…), where a download link often goes nowhere. */
async function saveImage(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // they closed the sheet
      // Otherwise the browser refused (the render took too long after the tap): download instead.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
                          {items.length === 0 ? (
                            <span className="export-dash">—</span>
                          ) : (
                            items.map((f, i) => (
                              <span key={f!.id}>
                                <span className="export-item">{f!.name}{i < items.length - 1 && ' ·'}</span>{' '}
                              </span>
                            ))
                          )}
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
