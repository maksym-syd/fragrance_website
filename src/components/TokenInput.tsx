import { useState, type KeyboardEvent } from 'react';
import Combobox from './Combobox';

interface Props {
  id: string;
  label: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  /** Suggestions for the text so far, leaving out what's already chosen. */
  suggest: (query: string, chosen: string[]) => string[];
  placeholder?: string;
  /** Lowercase tokens to match how notes and accords are stored. Off for people's names. */
  lowercase?: boolean;
}

/** Chips plus a combobox. Enter or a comma adds what you typed, suggested or not. */
export default function TokenInput({ id, label, tokens, onChange, suggest, placeholder, lowercase = true }: Props) {
  const [text, setText] = useState('');
  const tidy = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    return lowercase ? t.toLowerCase() : t;
  };
  const add = (values: string[]) => {
    const next = [...tokens];
    for (const v of values.map(tidy)) if (v && !next.includes(v)) next.push(v);
    onChange(next);
    setText('');
  };

  function onValueChange(value: string) {
    // Covers pasted lists, and phone keyboards where keydown doesn't report the comma.
    if (/[,;\n]/.test(value)) add(value.split(/[,;\n]/));
    else setText(value);
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
          onBlur={() => text.trim() && add([text])}
          placeholder={placeholder}
          enterKeyHint="enter"
        />
      </div>
    </div>
  );
}
