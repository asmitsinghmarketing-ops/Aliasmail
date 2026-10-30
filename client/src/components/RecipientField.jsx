// To / Cc / Bcc as chips, like Gmail: type an address and press Enter (or space, comma, Tab), pick
// a suggestion, paste a whole list, drag a chip to another field. The value stays the plain
// "a@x.com, b@y.com" string that drafts and sending already use.
import { useEffect, useMemo, useRef, useState } from 'react';
import { colorFor, initial } from '../format.js';
import Icon from './Icon.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "Name <a@x.com>", or a bare address/word; separators are commas, semicolons, spaces, new lines.
const TOKEN = /"?([^"<>,;\n]*?)"?\s*<([^<>\s]+)>|([^\s,;<>"]+)/g;

/** Addresses in pasted or typed text, with any display names. */
export function parseAddresses(text) {
  const found = [];
  for (const m of String(text || '').matchAll(TOKEN)) {
    const address = (m[2] || m[3] || '').trim();
    if (address) found.push({ address, name: (m[1] || '').trim() });
  }
  return found;
}

const join = (list) => list.map((r) => r.address).join(', ');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export default function RecipientField({ label, value, onChange, contacts = [], autoFocus, placeholder, fieldKey, className = '', after }) {
  const [list, setList] = useState(() => parseAddresses(value));
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef(null);
  const emitted = useRef(value);

  // A new draft (or an undone send) replaces the value from outside.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setList(parseAddresses(value));
    setText('');
  }, [value]);

  // Pending text counts as a recipient too, so Ctrl+Enter right after typing still sends to it.
  const emit = (nextList, nextText = text) => {
    const s = [join(nextList), nextText.trim()].filter(Boolean).join(', ');
    emitted.current = s;
    onChange(s);
  };
  const names = useMemo(() => new Map(contacts.map((c) => [c.address.toLowerCase(), c])), [contacts]);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const chosen = new Set(list.map((r) => r.address.toLowerCase()));
    const score = (c) => {
      const name = (c.name || '').toLowerCase();
      const words = name.split(/\s+/);
      if (c.address.startsWith(q) || words.some((w) => w.startsWith(q))) return 2;
      return c.address.includes(q) || name.includes(q) ? 1 : 0;
    };
    return contacts
      .filter((c) => !chosen.has(c.address) && score(c) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 6);
  }, [text, contacts, list]);

  const add = (entries, rest = '') => {
    const next = [...list];
    for (const e of entries) if (!next.some((r) => same(r.address, e.address))) next.push(e);
    setList(next);
    setText(rest);
    setOpen(false);
    setActive(0);
    emit(next, rest);
  };
  const commit = () => text.trim() && add(parseAddresses(text));
  const remove = (address) => {
    const next = list.filter((r) => !same(r.address, address));
    setList(next);
    emit(next);
  };

  function onKeyDown(e) {
    const picking = open && suggestions.length > 0;
    if (picking && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if (picking && (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      add([suggestions[active]]);
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || ((e.key === 'Tab' || e.key === ' ' || e.key === ',' || e.key === ';') && text.trim())) {
      if (e.key === 'Enter' || text.trim()) e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !text && list.length) {
      e.preventDefault();
      remove(list[list.length - 1].address);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation(); // close the suggestions, not the compose window
      setOpen(false);
    }
  }

  function onPaste(e) {
    const pasted = e.clipboardData.getData('text');
    const found = parseAddresses(pasted);
    if (found.length > 1 || (found.length === 1 && /[,;\s<]/.test(pasted.trim()))) {
      e.preventDefault();
      add(found);
    }
  }

  const chip = (r) => {
    const contact = names.get(r.address.toLowerCase());
    const shown = r.name || contact?.name || r.address;
    const valid = EMAIL.test(r.address);
    return (
      <span
        key={r.address}
        className={`recipient-chip ${valid ? '' : 'invalid'}`}
        title={valid ? r.address : `“${r.address}” isn’t a valid email address`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-aliasmail-recipient', JSON.stringify({ address: r.address, name: r.name }));
          // Marks the field it came from, which is readable while dragging (the data isn't).
          e.dataTransfer.setData(`application/x-aliasmail-from-${fieldKey}`, '1');
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={(e) => e.dataTransfer.dropEffect === 'move' && remove(r.address)}
      >
        <span className="recipient-avatar" style={{ background: colorFor(r.address) }} aria-hidden="true">
          {valid ? initial({ name: shown }) : '!'}
        </span>
        <button
          type="button"
          className="recipient-text"
            onClick={() => {
            // Click to edit, like Gmail: the chip goes back into the text box.
            if (!text.trim()) {
              const next = list.filter((x) => !same(x.address, r.address));
              setList(next);
              setText(r.address);
              emit(next, r.address);
            }
            input.current?.focus();
          }}
        >
          {shown}
        </button>
        <button type="button" className="recipient-remove" aria-label={`Remove ${r.address}`} onClick={() => remove(r.address)}>
          <Icon name="close" size={14} />
        </button>
      </span>
    );
  };

  return (
    <div
      className={`recipient-field ${dragOver ? 'drag-over' : ''} ${className}`}
      onClick={(e) => e.target === e.currentTarget && input.current?.focus()}
      onDragOver={(e) => {
        const types = [...e.dataTransfer.types];
        if (!types.includes('application/x-aliasmail-recipient') || types.includes(`application/x-aliasmail-from-${fieldKey}`)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const data = e.dataTransfer.getData('application/x-aliasmail-recipient');
        if (!data) return;
        e.preventDefault();
        const { address, name } = JSON.parse(data);
        add([{ address, name }], text);
      }}
    >
      <span className="recipient-label">{label}</span>
      <div className="recipient-box">
        {list.map(chip)}
        <input
          ref={input}
          className="recipient-input"
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open && suggestions.length > 0}
          placeholder={list.length ? '' : placeholder}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            // Typing a separator after an address makes it a chip straight away.
            if (/[,;]\s*$/.test(v) && v.replace(/[,;\s]/g, '')) {
              add(parseAddresses(v));
              return;
            }
            setText(v);
            setOpen(true);
            setActive(0);
            emit(list, v);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={commit}
        />
      </div>
      {after}
      {open && suggestions.length > 0 && (
        <ul className="recipient-suggestions" role="listbox" aria-label="Suggestions">
          {suggestions.map((c, i) => (
            <li key={c.address} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={i === active ? 'active' : ''}
                onMouseDown={(e) => e.preventDefault() /* keep focus in the field */}
                onMouseEnter={() => setActive(i)}
                onClick={() => add([c])}
              >
                <span className="recipient-avatar big" style={{ background: colorFor(c.address) }} aria-hidden="true">
                  {initial(c)}
                </span>
                <span className="suggestion-text">
                  <span className="suggestion-name">{c.name || c.address}</span>
                  {c.name && <span className="suggestion-address">{c.address}</span>}
                </span>
                {c.team && <span className="suggestion-team">Team</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
