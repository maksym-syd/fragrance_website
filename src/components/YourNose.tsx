import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatScore, SCALE_LEGEND, type RankIndex } from '../lib/overlap';
import { MIN_RANKED, MIN_STREAK, MIN_TAG, nose, type NoseItem, type Strictness } from '../lib/taste';
import type { Fragrance, Member } from '../lib/types';
import { SectionHead } from './ui';

/**
 * One person's taste, relative to their own habits: what pulls them in, what puts them off, how
 * generously they rank, and any perfumer or house streak. Thin data shows an empty state, not noise.
 */
export default function YourNose({
  meId,
  members,
  fragrances,
  idx,
}: {
  meId: string;
  members: Member[];
  fragrances: Fragrance[];
  idx: RankIndex;
}) {
  const [who, setWho] = useState(meId);
  const person = members.find((m) => m.id === who) ?? members[0];
  const isMe = person.id === meId;
  const n = useMemo(() => nose(person.id, fragrances, idx), [person.id, fragrances, idx]);

  // "you / your" for me, the name otherwise.
  const subject = isMe ? 'You' : person.display_name;
  const possessive = isMe ? 'your' : `${person.display_name}’s`;
  const own = isMe ? 'your' : 'their';

  return (
    <section className="stack-sm">
      <SectionHead title="Your nose" hint={n.enough ? `${n.ranked} ranked` : undefined} />

      {members.length > 1 && (
        <div className="seg seg-scroll" role="group" aria-label="Whose nose">
          {members.map((m) => (
            <button key={m.id} type="button" aria-pressed={m.id === person.id} onClick={() => setWho(m.id)}>
              {m.id === meId ? 'You' : m.display_name}
            </button>
          ))}
        </div>
      )}

      {!n.enough ? (
        <div className="nose-card">
          <p className="muted">
            {n.ranked === 0
              ? `${isMe ? 'You haven’t' : `${person.display_name} hasn’t`} ranked anything yet.`
              : `Rank ${MIN_RANKED - n.ranked} more to see ${possessive} nose.`}{' '}
            {isMe && <Link to=".." className="btn-link">Rank fragrances</Link>}
          </p>
        </div>
      ) : (
        <div className="nose-card stack-sm">
          {n.pulls.length === 0 && n.dislikes.length === 0 ? (
            <p className="muted">
              {n.tagged < 3
                ? `Most of ${possessive} ranked bottles have no notes or accords yet. Add them to see what pulls ${isMe ? 'you' : 'them'} in.`
                : `No strong pulls yet: ${possessive} tiers don’t lean towards any note or accord.`}
            </p>
          ) : (
            <div className="nose-grid">
              <NoseList title={isMe ? 'Draws you in' : 'Draws them in'} items={n.pulls} own={own} />
              <NoseList title={isMe ? 'Puts you off' : 'Puts them off'} items={n.dislikes} own={own} />
            </div>
          )}

          {n.strictness && <StrictnessLine s={n.strictness} subject={subject} />}

          {n.streaks.length > 0 && (
            <ul className="nose-streaks">
              {n.streaks.map((s) => (
                <li key={`${s.kind}:${s.label}`}>
                  <strong>{s.label}</strong> <span className="muted">({s.kind})</span>:{' '}
                  <span className="num">{s.count}</span> bottles, <span className="num">{formatScore(s.lift)}</span> above{' '}
                  {own} average
                </li>
              ))}
            </ul>
          )}

          <p className="scale-legend">
            Compared with {own} own average, in tiers ({SCALE_LEGEND}). Shows notes and accords on {MIN_TAG}+ bottles,
            perfumers and houses on {MIN_STREAK}+.
          </p>
        </div>
      )}
    </section>
  );
}

function NoseList({ title, items, own }: { title: string; items: NoseItem[]; own: string }) {
  return (
    <div className="nose-col">
      <h3 className="label">{title}</h3>
      {items.length === 0 ? (
        <p className="muted small">Nothing stands out yet.</p>
      ) : (
        <ul className="nose-list">
          {items.map((t) => (
            <li key={`${t.kind}:${t.label}`} title={`Average ${formatScore(t.avg)} over ${t.count}, ${formatScore(t.lift)} against ${own} own average`}>
              <span className="nose-tag">{t.label}</span>
              <span className="nose-kind">{t.kind}</span>
              <span className="nose-lift num">
                <span aria-hidden>{t.lift > 0 ? '▲' : '▼'}</span> {formatScore(t.lift)}
              </span>
              <span className="nose-count num muted">
                {t.count}
                <span className="sr-only"> bottles</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StrictnessLine({ s, subject }: { s: Strictness; subject: string }) {
  const avg = <span className="num">{formatScore(s.mean)}</span>;
  if (s.roomMean === null || s.verdict === null) {
    return <p className="small">{subject === 'You' ? 'Your' : `${subject}’s`} average tier: {avg}</p>;
  }
  const verb = subject === 'You' ? 'rank' : 'ranks';
  const how = { generous: 'more generously than the room', tough: 'more harshly than the room', typical: 'about as generously as the room' }[s.verdict];
  return (
    <p className="small">
      {subject} {verb} {how}: average {avg} <span className="muted">(room <span className="num">{formatScore(s.roomMean)}</span>)</span>
    </p>
  );
}
