import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

interface Props<T> extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'role'> {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: T[];
  optionKey: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  onPick: (option: T) => void;
  /** Show options on focus, before anything is typed. */
  openOnFocus?: boolean;
  /** Enter with no option highlighted. Without this, Enter submits the form as usual. */
  onEnter?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/** Editable combobox with list autocomplete (WAI-ARIA 1.2). Free text always stays valid. */
export default function Combobox<T>({
  id, value, onValueChange, options, optionKey, renderOption, onPick, openOnFocus, onEnter, onKeyDown, onFocus, onBlur, ...input
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = `${id}-list`;
  const showing = open && options.length > 0;
  const current = showing && active < options.length ? active : -1;

  useEffect(() => {
    if (current >= 0) listRef.current?.children[current]?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function pick(option: T) {
    onPick(option);
    setOpen(false);
    setActive(-1);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showing) {
        setOpen(true);
        setActive(e.key === 'ArrowDown' ? 0 : options.length - 1);
      } else {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + options.length + (current === -1 && step === -1 ? 1 : 0)) % options.length);
      }
    } else if (e.key === 'Enter') {
      if (current >= 0) {
        e.preventDefault();
        pick(options[current]);
      } else {
        setOpen(false);
        onEnter?.(e);
      }
    } else if (e.key === 'Escape' && showing) {
      // Only closes the list. Without stopPropagation the sheet around it would close too.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
    onKeyDown?.(e);
  }

  return (
    <div className="combo">
      <input
        {...input}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? `${id}-opt-${current}` : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={handleKey}
        onFocus={(e) => {
          if (openOnFocus) setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          setActive(-1);
          onBlur?.(e);
        }}
      />
      {/* Stays mounted so aria-controls always points at something. */}
      <ul ref={listRef} id={listId} role="listbox" className="combo-list" hidden={!showing} aria-label="Suggestions">
        {showing && options.map((option, i) => (
          <li
            key={optionKey(option)}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === current}
            className={`combo-option ${i === current ? 'is-active' : ''}`}
            // mousedown would blur the input and close the list before the click landed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(option)}
          >
            {renderOption(option)}
          </li>
        ))}
      </ul>
      <span className="sr-only" role="status">
        {showing ? `${options.length} suggestion${options.length === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
}
