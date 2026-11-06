import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useCatalog } from '../hooks/useCatalog';
import { searchCatalog, suggestTerms, type CatalogEntry } from '../lib/catalog';
import {
  applyEntry, draftToFragrance, EMPTY_DRAFT, nameOptions, popularEntries, roomVocab, validYear, withPending,
  type Draft, type NameOption, type TokenKey,
} from '../lib/details';
import { dedupeKey } from '../lib/normalize';
import { POPULAR } from '../lib/popular';
import { looseKey } from '../lib/reference';
import { CONCENTRATIONS, type Fragrance, type FragrancePatch } from '../lib/types';
import Combobox from './Combobox';
import TokenInput from './TokenInput';

interface Props {
  idPrefix: string;
  fragrances: Fragrance[];
  initial?: Draft;
  /** The row being edited: it can't count as its own duplicate. */
  editingId?: string;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (fragrance: FragrancePatch) => Promise<boolean>;
  /** Picking a bottle already in the room opens it. Add mode only. */
  onOpen?: (id: string) => void;
  onCancel?: () => void;
}

export function CatalogCredit() {
  return (
    <p className="fine muted">
      Suggestions use data from <a href="https://www.parfumo.com/">Parfumo</a>, via the{' '}
      <a href="https://github.com/rfordatascience/tidytuesday/tree/main/data/2024/2024-12-10">TidyTuesday</a> dataset.
      It stops at 2024 and has gaps, so check what it fills in.
    </p>
  );
}

function describe(e: CatalogEntry) {
  return [e.brand, e.year, e.concentration].filter(Boolean).join(' · ');
}

export default function FragranceForm({ idPrefix, fragrances, initial = EMPTY_DRAFT, editingId, submitLabel, busyLabel, onSubmit, onOpen, onCancel }: Props) {
  const { catalog, status } = useCatalog();
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, setPending] = useState<Partial<Record<TokenKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const lastPick = useRef<CatalogEntry | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const vocab = useMemo(() => roomVocab(fragrances), [fragrances]);
  const others = useMemo(() => fragrances.filter((f) => f.id !== editingId), [fragrances, editingId]);
  const taken = useMemo(
    () => new Set(others.flatMap((f) => [dedupeKey(f.name, f.house), looseKey(f.name, f.house)])),
    [others],
  );

  const options = useMemo(() => {
    const found = catalog ? searchCatalog(catalog, draft.name) : [];
    const entries = [...found, ...popularEntries(POPULAR, draft.name, catalog)];
    return nameOptions(draft.name, others, entries, !!onOpen);
  }, [catalog, draft.name, others, onOpen]);

  const houses = useMemo(
    () => suggestTerms(draft.house, vocab.houses, catalog?.brands ?? []),
    [draft.house, vocab.houses, catalog],
  );

  const named = draft.name.trim() && draft.house.trim();
  const isDuplicate = !!named && (taken.has(dedupeKey(draft.name, draft.house)) || taken.has(looseKey(draft.name, draft.house)));
  const yearOk = validYear(draft.year);

  function pickName(option: NameOption) {
    if (option.kind === 'room') {
      onOpen?.(option.fragrance.id);
      return;
    }
    setDraft(applyEntry(draft, option.entry, lastPick.current));
    lastPick.current = option.entry;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!named || isDuplicate || !yearOk) return;
    setBusy(true);
    const ok = await onSubmit(draftToFragrance(withPending(draft, pending)));
    setBusy(false);
    if (ok && !editingId) {
      setDraft(EMPTY_DRAFT);
      setPending({});
      lastPick.current = null;
    }
  }

  const tokenProps = (key: TokenKey) => ({
    id: `${idPrefix}-${key}`,
    tokens: draft[key],
    onChange: (v: string[]) => set(key, v),
    text: pending[key] ?? '',
    onTextChange: (text: string) => setPending((p) => ({ ...p, [key]: text })),
  });

  const tokenField = (key: 'accords' | 'top' | 'heart' | 'base' | 'other', label: string, placeholder: string) => {
    const isAccord = key === 'accords';
    return (
      <TokenInput
        {...tokenProps(key)}
        label={label}
        suggest={(q, chosen) => suggestTerms(
          q,
          isAccord ? vocab.accords : vocab.notes,
          (isAccord ? catalog?.accords : catalog?.notes) ?? [],
          chosen,
        )}
        placeholder={placeholder}
      />
    );
  };

  return (
    <form className="stack-sm" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-name`}>Name</label>
          <Combobox
            id={`${idPrefix}-name`}
            value={draft.name}
            onValueChange={(v) => set('name', v)}
            options={options}
            optionKey={(o) => (o.kind === 'room' ? `room:${o.fragrance.id}` : `cat:${o.entry.name}|${o.entry.brand}|${o.entry.year}|${o.entry.concentration}`)}
            renderOption={(o) => (o.kind === 'room' ? (
              <>
                <span className="combo-main">{o.fragrance.name}</span>
                <span className="combo-sub">{o.fragrance.house} · in this room</span>
              </>
            ) : (
              <>
                <span className="combo-main">{o.entry.name}</span>
                <span className="combo-sub">{describe(o.entry)}</span>
              </>
            ))}
            onPick={pickName}
            maxLength={80}
            placeholder="Start typing: Aventus"
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-house`}>House</label>
          <Combobox
            id={`${idPrefix}-house`}
            value={draft.house}
            onValueChange={(v) => set('house', v)}
            options={houses}
            optionKey={(o) => o}
            renderOption={(o) => o}
            onPick={(o) => set('house', o)}
            maxLength={60}
            placeholder="Creed"
            required
          />
        </div>
      </div>

      {status === 'failed' && (
        <p className="muted small" role="status">Suggestions aren’t available right now. You can still type everything in.</p>
      )}

      <fieldset className="field">
        <legend className="label">Concentration · optional</legend>
        <div className="segmented" role="radiogroup">
          {CONCENTRATIONS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={draft.concentration === c}
              className={draft.concentration === c ? 'is-on' : ''}
              onClick={() => set('concentration', draft.concentration === c ? '' : c)}
            >
              {c}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-year`}>Year · optional</label>
          <input
            id={`${idPrefix}-year`}
            inputMode="numeric"
            maxLength={4}
            value={draft.year}
            onChange={(e) => set('year', e.target.value)}
            aria-invalid={!yearOk}
            placeholder="2010"
          />
          {!yearOk && <p className="error small">Use a four-digit year.</p>}
        </div>
        <TokenInput
          {...tokenProps('perfumers')}
          label="Perfumers · optional"
          suggest={(q, chosen) => suggestTerms(q, vocab.perfumers, catalog?.perfumers ?? [], chosen)}
          placeholder="Add a name"
          lowercase={false}
        />
      </div>

      {tokenField('accords', 'Accords · the overall character', 'woody, fresh')}
      {tokenField('top', 'Top notes', 'bergamot')}
      {tokenField('heart', 'Heart notes', 'jasmine')}
      {tokenField('base', 'Base notes', 'vanilla')}
      {tokenField('other', 'Other notes · not sure where they sit', 'Anything else')}

      {isDuplicate && <p className="error small">Already in this room.</p>}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn btn-primary" disabled={busy || !named || isDuplicate || !yearOk}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
      <CatalogCredit />
    </form>
  );
}
