import { useMemo, useState, type FormEvent } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { normalizeNote } from '../lib/overlap';
import { dedupeKey, parseNotes } from '../lib/normalize';
import { POPULAR } from '../lib/popular';
import { CONCENTRATIONS, type Concentration, type NewFragrance } from '../lib/types';

export default function AddFragrance({ api, onOpen }: { api: RoomApi; onOpen: (id: string) => void }) {
  const [name, setName] = useState('');
  const [house, setHouse] = useState('');
  const [concentration, setConcentration] = useState<Concentration | ''>('');
  const [notesText, setNotesText] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const existing = useMemo(() => new Set(api.fragrances.map((f) => dedupeKey(f.name, f.house))), [api.fragrances]);
  const quick = POPULAR.filter((p) => !existing.has(dedupeKey(p.name, p.house)));
  const notes = parseNotes(notesText);
  const knownNotes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of api.fragrances) for (const n of f.notes) counts.set(normalizeNote(n), (counts.get(normalizeNote(n)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 14);
  }, [api.fragrances]);
  const isDuplicate = name.trim() && house.trim() && existing.has(dedupeKey(name, house));

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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !house.trim() || isDuplicate) return;
    const ok = await add({ name, house, concentration: concentration || null, notes });
    if (ok) {
      setName('');
      setHouse('');
      setConcentration('');
      setNotesText('');
    }
  }

  function toggleNote(n: string) {
    const next = notes.includes(n) ? notes.filter((x) => x !== n) : [...notes, n];
    setNotesText(next.join(', '));
  }

  return (
    <div className="add-layout">
      <form className="card stack-sm" onSubmit={onSubmit}>
        <h2 className="h2">Add a fragrance</h2>
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="f-name">Name</label>
            <input id="f-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Aventus" required />
          </div>
          <div className="field">
            <label className="label" htmlFor="f-house">House</label>
            <input id="f-house" value={house} maxLength={60} onChange={(e) => setHouse(e.target.value)} placeholder="Creed" required />
          </div>
        </div>

        <fieldset className="field">
          <legend className="label">Concentration · optional</legend>
          <div className="segmented" role="radiogroup">
            {CONCENTRATIONS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={concentration === c}
                className={concentration === c ? 'is-on' : ''}
                onClick={() => setConcentration(concentration === c ? '' : c)}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="label" htmlFor="f-notes">Notes · comma separated</label>
          <input id="f-notes" value={notesText} onChange={(e) => setNotesText(e.target.value)} placeholder="vanilla, tobacco, oud" />
          {knownNotes.length > 0 && (
            <div className="tags">
              {knownNotes.map((n) => (
                <button type="button" key={n} className={`tag tag-btn ${notes.includes(n) ? 'is-on' : ''}`} onClick={() => toggleNote(n)}>
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>

        {isDuplicate && <p className="error small">Already in this room.</p>}
        <button className="btn btn-primary" disabled={busy || !name.trim() || !house.trim() || !!isDuplicate}>
          {busy ? 'Adding…' : 'Add fragrance'}
        </button>
        {message && (
          <p className={message.kind} role="status">
            {message.text}{' '}
            {message.id && (
              <button type="button" className="btn-link" onClick={() => onOpen(message.id!)}>Rank it now</button>
            )}
          </p>
        )}
      </form>

      <section className="stack-sm">
        <header className="section-head">
          <h2 className="h2">Quick add</h2>
          <span className="label">{quick.length} popular picks</span>
        </header>
        {quick.length === 0 ? (
          <p className="muted">You’ve added every one of them. Impressive shelf.</p>
        ) : (
          <ul className="quick-list">
            {quick.map((p) => (
              <li key={dedupeKey(p.name, p.house)}>
                <button className="quick-item" disabled={busy} onClick={() => add(p)}>
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
