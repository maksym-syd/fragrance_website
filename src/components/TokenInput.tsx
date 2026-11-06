import type { KeyboardEvent } from 'react';
import Combobox from './Combobox';

interface Props {
  id: string;
  label: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  /** Typed but not yet a chip. The form owns it and includes it on submit. */
  text: string;
  onTextChange: (text: string) => void;
  /** Suggestions for the text so far, leaving out what's already chosen. */
  suggest: (query: string, chosen: string[]) => string[];
  placeholder?: string;
  /** Lowercase tokens to match how notes and accords are stored. Off for people's names. */
  lowercase?: boolean;
}

/**
 * Chips plus a combobox. Enter or a comma adds what you typed, suggested or not. Leaving the
 * field does not: a new chip would shift the layout between mousedown and mouseup on the
 * submit button and swallow the click. The form picks up leftover text when it submits.
 */
export default function TokenInput({ id, label, tokens, onChange, text, onTextChange, suggest, placeholder, lowercase = true }: Props) {
  const tidy = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    return lowercase ? t.toLowerCase() : t;
  };
  const add = (values: string[]) => {
    const next = [...tokens];
    for (const v of values.map(tidy)) if (v && !next.includes(v)) next.push(v);
    onChange(next);
    onTextChange('');
  };

  function onValueChange(value: string) {
    // Covers pasted lists, and phone keyboards where keydown doesn't report the comma.
    if (/[,;\n]/.test(value)) add(value.split(/[,;\n]/));
    else onTextChange(value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !text && tokens.length) onChange(tokens.slice(0, -1));
  }

  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="token-box">
        {tokens.length > 0 && (
          <ul className="tags" aria-label={`Chosen: ${label}`}>
            {tokens.map((t) => (
              <li key={t} className="token">
                <span>{t}</span>
                <button type="button" className="token-x" aria-label={`Remove ${t}`} onClick={() => onChange(tokens.filter((x) => x !== t))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <Combobox
          id={id}
          value={text}
          onValueChange={onValueChange}
          options={suggest(text, tokens)}
          optionKey={(o) => o}
          renderOption={(o) => o}
          onPick={(o) => add([o])}
          openOnFocus
          onEnter={(e) => {
            // Enter here means "add this", never "submit the form".
            if (text.trim()) {
              e.preventDefault();
              add([text]);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          enterKeyHint="enter"
        />
      </div>
    </div>
  );
}
