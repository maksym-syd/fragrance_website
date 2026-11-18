import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { confidence, formatScore, MIN_COMMON, TIER_VALUE, TIERS, type PairMatch, type RankIndex, type Tier } from '../lib/overlap';
import { AXIS, defaultFriend, versus, versusSummary } from '../lib/taste';
import type { Fragrance, Member } from '../lib/types';
import FragRow from './FragRow';
import { SectionHead } from './ui';

const axisLabel = (t: Tier) => `${t} ${formatScore(TIER_VALUE[t])}`;
const bottles = (n: number) => (n === 0 ? 'no bottles' : n === 1 ? '1 bottle' : `${n} bottles`);

/** Mark size: area follows the count, with a floor so a single bottle is still a visible dot. */
const MAX_DOT = 86;
const MIN_DOT = 30;
const dotSize = (count: number, max: number) => Math.max(MIN_DOT, MAX_DOT * Math.sqrt(count / max));

/**
 * You against one friend: each shared bottle placed by your tier (across) and theirs (up). Only 25
 * places exist, so it's a grid of counts rather than a scatter of overlapping dots.
 */
export default function VersusChart({
  meId,
  members,
  pairs,
  idx,
  fragById,
  onOpen,
}: {
  meId: string;
  members: Member[];
  pairs: PairMatch[];
  idx: RankIndex;
  fragById: Map<string, Fragrance>;
  onOpen: (id: string) => void;
}) {
  const others = members.filter((m) => m.id !== meId);
  const fallback = useMemo(() => defaultFriend(meId, members.map((m) => m.id), pairs), [meId, members, pairs]);
  const [picked, setPicked] = useState<string | null>(null);
  const friend = others.find((m) => m.id === picked) ?? others.find((m) => m.id === fallback) ?? others[0];
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<[number, number]>([2, 2]);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  const nameOfFrag = (id: string) => fragById.get(id)?.name ?? '—';
  const v = useMemo(
    () => (friend ? versus(meId, friend.id, idx, nameOfFrag) : null),
    [meId, friend?.id, idx, fragById],
  );
  if (!friend || !v) return null;

  const pair = pairs.find((p) => (p.a === meId && p.b === friend.id) || (p.b === meId && p.a === friend.id));
  const name = friend.display_name;
  const pick = (id: string) => {
    setPicked(id);
    setSel(null);
  };

  const move = (e: KeyboardEvent, r: number, c: number) => {
    const d: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Home: [0, -c],
      End: [0, 4 - c],
    };
    const step = d[e.key];
    if (!step) return;
    e.preventDefault();
    const next: [number, number] = [Math.min(4, Math.max(0, r + step[0])), Math.min(4, Math.max(0, c + step[1]))];
    setFocus(next);
    cells.current[next[0] * 5 + next[1]]?.focus();
  };

  const selected = sel ? v.rows[sel[0]][sel[1]] : null;

  return (
    <section className="stack-sm">
      <SectionHead title="You vs friend" hint="Each shared bottle, your tier against theirs" />

      {others.length > 1 && (
        <div className="seg seg-scroll" role="group" aria-label="Compare with">
          {others.map((m) => (
            <button key={m.id} type="button" aria-pressed={m.id === friend.id} onClick={() => pick(m.id)}>
              {m.display_name}
            </button>
          ))}
        </div>
      )}

      {v.common < MIN_COMMON ? (
        <div className="nose-card">
          <p className="muted">
            You and {name} have ranked {v.common === 0 ? 'none of the same bottles' : 'only 1 bottle in common'} so far.
            The chart needs {MIN_COMMON}+. <Link to=".." className="btn-link">Rank fragrances</Link>
          </p>
        </div>
      ) : (
        <div className="nose-card stack-sm">
          <p className="small muted num">
            {pair?.score != null && <>{pair.score}% match · </>}
            {v.common} shared · <span className={`conf conf-${confidence(v.common)}`}>{confidence(v.common)}</span>
          </p>
          <p className="vs-summary">{versusSummary(v, name, nameOfFrag)}</p>

          <div className="vs-plot" role="group" aria-label={`Your tier against ${name}’s, ${v.common} shared bottles`}>
            <p className="vs-ytitle" aria-hidden>
              ↑ {name}
            </p>
            <div className="vs-row vs-head" aria-hidden>
              <span />
              <span className="vs-corner">They love, you don’t</span>
            </div>
            {v.rows.map((row, r) => (
              <div className="vs-row" key={TIERS[r]}>
                <span className="vs-ylab" aria-hidden>{axisLabel(TIERS[r])}</span>
                {row.map((cell, c) => {
                  const n = cell.ids.length;
                  const isSel = sel?.[0] === r && sel?.[1] === c;
                  const diag = cell.mine === cell.theirs;
                  return (
                    <button
                      key={cell.mine}
                      ref={(el) => {
                        cells.current[r * 5 + c] = el;
                      }}
                      type="button"
                      className={`vs-cell${diag ? ' vs-diag' : ''}`}
                      tabIndex={focus[0] === r && focus[1] === c ? 0 : -1}
                      aria-pressed={isSel}
                      aria-label={`You ${cell.mine}, ${name} ${cell.theirs}: ${bottles(n)}`}
                      title={`${bottles(n).replace(/^n/, 'N')}: you ${cell.mine}, ${name} ${cell.theirs}`}
                      onFocus={() => setFocus([r, c])}
                      onKeyDown={(e) => move(e, r, c)}
                      onClick={() => setSel(isSel ? null : [r, c])}
                    >
                      {n > 0 && (
                        <>
                          <span className="vs-dot" style={{ width: `${dotSize(n, v.max)}%` }} aria-hidden />
                          <span className="vs-count num" aria-hidden>{n}</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="vs-row vs-xaxis" aria-hidden>
              <span />
              {AXIS.map((t) => <span key={t} className="vs-xlab">{axisLabel(t)}</span>)}
            </div>
            <div className="vs-row vs-foot" aria-hidden>
              <span />
              <span className="vs-xtitle">You →</span>
              <span className="vs-corner">You love, they don’t</span>
            </div>
          </div>

          <ul className="heat-legend" aria-label="Chart key">
            <li><span className="vs-key vs-key-diag" aria-hidden /> Agree: same tier</li>
            <li><span className="vs-key vs-key-dot" aria-hidden /> Bigger dot, more bottles</li>
          </ul>

          <div aria-live="polite">
            {!selected ? (
              <p className="muted small">Tap a square to list its bottles.</p>
            ) : (
              <div className="stack-sm">
                <p className="small">
                  <strong>You {selected.mine}, {name} {selected.theirs}</strong>{' '}
                  <span className="muted">· {bottles(selected.ids.length)}</span>
                </p>
                {selected.ids.length > 0 && (
                  <ul className="frag-list">
                    {selected.ids.map((fid) => <FragRow key={fid} f={fragById.get(fid)} onOpen={onOpen} />)}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
