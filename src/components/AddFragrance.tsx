import { useMemo, useState } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { useCatalog } from '../hooks/useCatalog';
import { quickAddDetail } from '../lib/details';
import { dedupeKey } from '../lib/normalize';
import { POPULAR } from '../lib/popular';
import { looseKey } from '../lib/reference';
import type { NewFragrance } from '../lib/types';
import FragranceForm from './FragranceForm';

export default function AddFragrance({ api, onOpen }: { api: RoomApi; onOpen: (id: string) => void }) {
  const { catalog } = useCatalog();
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const existing = useMemo(
    () => new Set(api.fragrances.flatMap((f) => [dedupeKey(f.name, f.house), looseKey(f.name, f.house)])),
    [api.fragrances],
  );
  const available = POPULAR.filter((p) => !existing.has(dedupeKey(p.name, p.house)) && !existing.has(looseKey(p.name, p.house)));
  const q = search.trim().toLowerCase();
  const quick = q
    ? available.filter((p) => [p.name, p.house, ...p.notes].some((t) => t.toLowerCase().includes(q)))
    : available;

  async function add(f: NewFragrance) {
    setBusy(true);
    const res = await api.addFragrance(f);
    setBusy(false);
    if (res.ok) {
      const id = (res as { data?: { id: string } | null }).data?.id;
      setMessage({ kind: 'success', text: `Added ${f.name}.`, id });
      return true;
    }
    setMessage({ kind: 'error', text: res.message ?? 'Could not add' });
    return false;
  }

  return (
    <div className="add-layout">
      <div className="card stack-sm">
        <h2 className="h2">Add a fragrance</h2>
        <FragranceForm
          idPrefix="f"
          fragrances={api.fragrances}
          submitLabel="Add fragrance"
          busyLabel="Adding…"
          onSubmit={add}
          onOpen={onOpen}
        />
        {message && (
          <p className={message.kind} role="status">
            {message.text}{' '}
            {message.id && (
              <button type="button" className="btn-link" onClick={() => onOpen(message.id!)}>Rank it now</button>
            )}
          </p>
        )}
      </div>

      <section className="stack-sm">
        <header className="section-head">
          <h2 className="h2">Quick add</h2>
          <span className="label">{available.length} picks</span>
        </header>
        {available.length > 0 && (
          <input
            type="search"
            aria-label="Search quick add"
            placeholder="Search name, house or note (e.g. fig, Byredo)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {available.length === 0 ? (
          <p className="muted">You’ve added every one of them. Impressive shelf.</p>
        ) : quick.length === 0 ? (
          <p className="muted">No matches. Add it with the form instead.</p>
        ) : (
          <ul className="quick-list">
            {quick.map((p) => (
              <li key={dedupeKey(p.name, p.house)}>
                <button className="quick-item" disabled={busy} onClick={() => add(quickAddDetail(p, catalog))}>
                  <span className="frag-row-text">
                    <span className="frag-name">{p.name}</span>
                    <span className="muted small">{p.house}</span>
                  </span>
                  <span className="quick-plus" aria-hidden>+</span>
                  <span className="sr-only">Add</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
