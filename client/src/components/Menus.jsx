// Small popover menus used by the mailbox: snooze / schedule-send time pickers and labels.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

/** A button that opens a floating panel. `children` gets a `close` function. */
export function Popover({ icon, title, label, className = '', align = 'left', children }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="popover-wrap" ref={wrap} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={className || 'icon-btn'} title={title} onClick={() => setOpen(!open)}>
        {icon && <Icon name={icon} size={label ? 18 : 20} />}
        {label}
      </button>
      {open && <div className={`popover ${align}`}>{children(() => setOpen(false))}</div>}
    </span>
  );
}

const at = (base, days, hour) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const nextWeekday = (weekday, hour) => {
  const now = new Date();
  const days = (weekday - now.getDay() + 7) % 7 || 7;
  return at(now, days, hour);
};

export function snoozeOptions() {
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3600e3);
  later.setMinutes(0, 0, 0);
  return [
    ['Later today', later],
    ['Tomorrow', at(now, 1, 8)],
    ['This weekend', nextWeekday(6, 8)],
    ['Next week', nextWeekday(1, 8)],
  ];
}

export function scheduleOptions() {
  const now = new Date();
  return [
    ['Tomorrow morning', at(now, 1, 8)],
    ['Tomorrow afternoon', at(now, 1, 13)],
    ['Monday morning', nextWeekday(1, 8)],
  ];
}

export const shortTime = (date) =>
  new Date(date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const localInputValue = (date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

/** Quick time choices plus a custom date & time. */
export function TimeMenu({ title, options, onPick, close }) {
  const [custom, setCustom] = useState('');
  const pick = (date) => {
    close();
    onPick(date);
  };
  return (
    <div className="menu">
      <div className="menu-title">{title}</div>
      {options.map(([label, date]) => (
        <button type="button" key={label} className="menu-item" onClick={() => pick(date)}>
          <span>{label}</span>
          <span className="muted small">{shortTime(date)}</span>
        </button>
      ))}
      <div className="menu-custom">
        <input type="datetime-local" value={custom} min={localInputValue(new Date())} onChange={(e) => setCustom(e.target.value)} />
        <button type="button" className="btn btn-primary" disabled={!custom || new Date(custom) <= new Date()} onClick={() => pick(new Date(custom))}>
          Save
        </button>
      </div>
    </div>
  );
}

/** Tick labels on/off for the chosen messages, or create a new one. */
export function LabelMenu({ labels, items, onToggle, onCreate, close }) {
  const [name, setName] = useState('');
  const has = (label) => items.length > 0 && items.every((i) => (i.labels || []).includes(label.id));
  return (
    <div className="menu">
      <div className="menu-title">Label as:</div>
      {labels.length === 0 && <div className="muted small menu-empty">No labels yet</div>}
      {labels.map((l) => (
        <label key={l.id} className="menu-item check-item">
          <input type="checkbox" checked={has(l)} onChange={() => onToggle(l, !has(l))} />
          <span className="swatch" style={{ background: l.color }} />
          <span className="grow">{l.name}</span>
        </label>
      ))}
      <form
        className="menu-custom"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await onCreate(name.trim());
          setName('');
        }}
      >
        <input placeholder="Create new label" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-outline" disabled={!name.trim()}>
          Add
        </button>
      </form>
      <button type="button" className="menu-done" onClick={close}>
        Done
      </button>
    </div>
  );
}
