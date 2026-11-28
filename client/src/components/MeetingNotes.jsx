// Full-page meeting notes: a big editor with formatting shortcuts, a live preview, and a side
// column that pulls out the action items, the timeline and the outline. Opens in its own tab
// (/notes/<id>) from a call, or full screen inside the Android app. Notes stay on this device.
import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { hideBoot } from './Loading.jsx';
import { readMeta, readNotes, watchNotes, writeMeta, writeNotes } from '../meetingNotes.js';
import '../meeting-notes.css';

const TEMPLATE = '## Agenda\n- \n\n## Notes\n\n\n## Decisions\n- \n\n## Action items\n- [ ] \n';
const LIST = /^(\s*)(- \[[ xX]\] |[-*] |\d+\. )(.*)$/;
const TIME = /^\[(\d{1,2}:\d{2}(?:\s?[AP]M)?)\]\s*/i;
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ----------------------------- a small Markdown preview ----------------------------- */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*|https?:\/\/[^\s<]+)/g;

function inline(text, key) {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`;
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
    if (/^(_.+_|\*.+\*)$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
    if (/^https?:\/\//.test(part)) return <a key={k} href={part} target="_blank" rel="noreferrer noopener">{part}</a>;
    return part;
  });
}

function withTime(text, key) {
  const time = TIME.exec(text);
  if (!time) return inline(text, key);
  return [<span key={`${key}-t`} className="mn-time">{time[1]}</span>, ...inline(text.slice(time[0].length), key)];
}

function Preview({ text, onToggle }) {
  const lines = text.split('\n');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(list.ordered ? <ol key={`l${out.length}`}>{list.items}</ol> : <ul key={`l${out.length}`} className={list.checks ? 'mn-checks' : ''}>{list.items}</ul>); list = null; } };
  lines.forEach((line, index) => {
    const check = /^\s*- \[([ xX])\] (.*)$/.exec(line);
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    const number = /^\s*\d+\. (.*)$/.exec(line);
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (check) {
      if (!list || !list.checks) { flush(); list = { checks: true, items: [] }; }
      const done = check[1] !== ' ';
      list.items.push(
        <li key={index} className={done ? 'done' : ''}>
          <button type="button" role="checkbox" aria-checked={done} onClick={() => onToggle(index)} aria-label={done ? 'Mark as not done' : 'Mark as done'}>
            {done && <Icon name="check" size={14} />}
          </button>
          <span>{withTime(check[2], index)}</span>
        </li>,
      );
      return;
    }
    if (bullet || number) {
      const ordered = Boolean(number);
      if (!list || list.checks || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(<li key={index}>{withTime((bullet || number)[1], index)}</li>);
      return;
    }
    flush();
    if (heading) {
      const Tag = `h${heading[1].length + 1}`;
      out.push(<Tag key={index} id={`mn-h-${index}`}>{inline(heading[2], index)}</Tag>);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push(<hr key={index} />);
    } else if (line.trim()) {
      out.push(<p key={index}>{withTime(line, index)}</p>);
    }
  });
  flush();
  if (!out.length) return <p className="mn-empty-preview">Your formatted notes show here.</p>;
  return out;
}

/* ----------------------------------- the page ----------------------------------- */

function useNarrow() {
  const query = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setNarrow(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function MeetingNotes({ id, title: givenTitle, onClose }) {
  const meta = useMemo(() => readMeta(id), [id]);
  const title = givenTitle || meta.title || 'Meeting';
  const [text, setText] = useState(() => readNotes(id));
  const [savedAt, setSavedAt] = useState(null);
  const [chosenView, setView] = useState('split');
  const narrow = useNarrow();
  const view = narrow && chosenView === 'split' ? 'write' : chosenView; // no room for two columns
  const [size, setSize] = useState(() => Number(localStorage.getItem('nextspace:notes-size')) || 16);
  const [side, setSide] = useState(true);
  const [copied, setCopied] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const area = useRef(null);
  const fromOutside = useRef(false);

  useEffect(() => { if (!onClose) hideBoot(); }, [onClose]);
  useEffect(() => {
    if (onClose) return undefined;
    const before = document.title;
    document.title = `Notes · ${title}`;
    return () => { document.title = before; };
  }, [onClose, title]);
  useEffect(() => {
    writeMeta(id, { title });
  }, [id, title]);

  // Save shortly after typing stops; changes from the call's panel (or another tab) come in live.
  useEffect(() => {
    if (fromOutside.current) { fromOutside.current = false; return undefined; }
    const timer = setTimeout(() => {
      writeNotes(id, text);
      writeMeta(id, { updatedAt: new Date().toISOString() });
      setSavedAt(new Date());
    }, 300);
    return () => clearTimeout(timer);
  }, [id, text]);
  useEffect(() => watchNotes(id, (next) => setText((current) => {
    if (current === next) return current;
    fromOutside.current = true;
    return next;
  })), [id]);
  useEffect(() => { try { localStorage.setItem('nextspace:notes-size', String(size)); } catch { /* ignore */ } }, [size]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && onClose && !exportOpen) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, exportOpen]);

  /* --- editing helpers: work on the selected lines, keep the selection --- */
  const edit = (fn) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const result = fn(value, start, end);
    setText(result.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(result.start, result.end);
    });
  };
  const toggleLines = (marker, test) => edit((value, start, end) => {
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const toIndex = value.indexOf('\n', end);
    const to = toIndex === -1 ? value.length : toIndex;
    const lines = value.slice(from, to).split('\n');
    const all = lines.every((line) => test(line));
    const changed = lines.map((line, i) => {
      const bare = line.replace(/^(#{1,3} |- \[[ xX]\] |[-*] |\d+\. )/, '');
      if (all) return bare;
      return `${typeof marker === 'function' ? marker(i) : marker}${bare}`;
    }).join('\n');
    const next = value.slice(0, from) + changed + value.slice(to);
    // Nothing was selected: leave the cursor at the end of the line, ready to type.
    if (start === end) return { value: next, start: from + changed.length, end: from + changed.length };
    return { value: next, start: from, end: from + changed.length };
  });
  const wrap = (mark) => edit((value, start, end) => {
    const picked = value.slice(start, end) || 'text';
    const next = `${value.slice(0, start)}${mark}${picked}${mark}${value.slice(end)}`;
    return { value: next, start: start + mark.length, end: start + mark.length + picked.length };
  });
  const insert = (snippet) => edit((value, start, end) => {
    const before = value.slice(0, start);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const next = before + lead + snippet + value.slice(end);
    const caret = before.length + lead.length + snippet.length;
    return { value: next, start: caret, end: caret };
  });

  const tools = [
    { icon: 'heading', label: 'Heading', run: () => toggleLines('## ', (l) => /^#{1,3} /.test(l)) },
    { icon: 'bold', label: 'Bold (Ctrl+B)', run: () => wrap('**') },
    { icon: 'italic', label: 'Italic (Ctrl+I)', run: () => wrap('_') },
    { sep: true },
    { icon: 'bulletList', label: 'Bullet list', run: () => toggleLines('- ', (l) => /^[-*] (?!\[)/.test(l)) },
    { icon: 'numberList', label: 'Numbered list', run: () => toggleLines((i) => `${i + 1}. `, (l) => /^\d+\. /.test(l)) },
    { icon: 'checklist', label: 'Action item (Ctrl+Enter)', run: () => toggleLines('- [ ] ', (l) => /^- \[[ xX]\] /.test(l)) },
    { sep: true },
    { icon: 'clock', label: 'Add the time', run: () => insert(`[${nowTime()}] `) },
    { icon: 'divider', label: 'Divider', run: () => insert('---\n') },
  ];

  const onKeyDown = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'b') { event.preventDefault(); wrap('**'); return; }
    if (mod && event.key.toLowerCase() === 'i') { event.preventDefault(); wrap('_'); return; }
    if (mod && event.key === 'Enter') { event.preventDefault(); tools[6].run(); return; }
    if (event.key !== 'Enter' || event.shiftKey || mod) return;
    // Enter in a list carries the list on; Enter on an empty item ends it.
    const el = event.currentTarget;
    const { selectionStart: start, value } = el;
    if (start !== el.selectionEnd) return;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const line = value.slice(from, start);
    const match = LIST.exec(line);
    if (!match) return;
    event.preventDefault();
    if (!match[3].trim()) {
      edit((v) => ({ value: v.slice(0, from) + v.slice(start), start: from, end: from }));
      return;
    }
    const number = /^(\d+)\. $/.exec(match[2]);
    const next = number ? `${Number(number[1]) + 1}. ` : match[2].startsWith('- [') ? '- [ ] ' : match[2];
    edit((v) => {
      const add = `\n${match[1]}${next}`;
      return { value: v.slice(0, start) + add + v.slice(start), start: start + add.length, end: start + add.length };
    });
  };

  const toggleLine = (index) => setText((current) => {
    const lines = current.split('\n');
    lines[index] = lines[index].replace(/- \[([ xX])\]/, (_, mark) => (mark === ' ' ? '- [x]' : '- [ ]'));
    return lines.join('\n');
  });

  /* --- what the side column shows --- */
  const lines = text.split('\n');
  const actions = lines.map((line, index) => ({ index, m: /^\s*- \[([ xX])\] (.*)$/.exec(line) })).filter((x) => x.m && x.m[2].trim())
    .map(({ index, m }) => ({ index, done: m[1] !== ' ', text: m[2].replace(TIME, '') }));
  const timeline = lines.map((line) => TIME.exec(line.replace(/^\s*(- \[[ xX]\] |[-*] |\d+\. )/, '')) && line).filter(Boolean)
    .map((line) => { const bare = line.replace(/^\s*(- \[[ xX]\] |[-*] |\d+\. )/, ''); const t = TIME.exec(bare); return { time: t[1], text: bare.slice(t[0].length) }; });
  const outline = lines.map((line, index) => ({ index, m: /^(#{1,3}) (.*)$/.exec(line) })).filter((x) => x.m).map(({ index, m }) => ({ index, level: m[1].length, text: m[2] }));
  const open = actions.filter((a) => !a.done).length;
  const words = (text.match(/\S+/g) || []).length;

  const jumpTo = (index) => {
    if (view !== 'write') {
      document.getElementById(`mn-h-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (view === 'read') return;
    }
    const el = area.current;
    if (!el) return;
    const offset = lines.slice(0, index).reduce((sum, l) => sum + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(offset, offset + lines[index].length);
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.scrollTop = Math.max(0, index * lineHeight - el.clientHeight / 3);
  };

  /* --- export --- */
  const heading = `${title} · ${new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const fileBase = `${title.replace(/[^\w\- ]+/g, '').trim() || 'meeting'} notes`;
  const flash = (what) => { setCopied(what); setTimeout(() => setCopied(''), 1800); };
  const copy = async (what) => {
    const body = what === 'actions' ? actions.filter((a) => !a.done).map((a) => `- ${a.text}`).join('\n') : `${heading}\n\n${text}`;
    try { await navigator.clipboard.writeText(body); flash(what); } catch { /* no clipboard */ }
    setExportOpen(false);
  };
  const download = (ext) => {
    const body = ext === 'md' ? `# ${heading}\n\n${text}\n` : `${heading}\n\n${text}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: `${ext === 'md' ? 'text/markdown' : 'text/plain'};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportOpen(false);
  };
  const print = () => {
    setExportOpen(false);
    if (view === 'write') setView('read'); // printing uses the formatted view
    setTimeout(() => window.print(), 120);
  };

  const showEditor = view !== 'read';
  const showPreview = view !== 'write';

  return (
    <div className={`mn-page ${onClose ? 'overlay' : ''}`} style={{ '--mn-size': `${size}px` }}>
      <header className="mn-top">
        {onClose && (
          <button type="button" className="mn-icon" onClick={onClose} aria-label="Back to the call" title="Back to the call (Esc)"><Icon name="back" size={20} /></button>
        )}
        <div className="mn-title">
          <strong>{title}</strong>
          <span>
            {new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
            <i aria-hidden="true">·</i>
            {savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Saved on this device'}
            <i aria-hidden="true">·</i>
            {words} {words === 1 ? 'word' : 'words'}
          </span>
        </div>
        <div className="mn-seg" role="radiogroup" aria-label="View">
          {[['write', 'Write'], ['split', 'Split'], ['read', 'Preview']].map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={view === value} className={`${view === value ? 'on' : ''} ${value === 'split' ? 'mn-wide-only' : ''}`} onClick={() => setView(value)}>{label}</button>
          ))}
        </div>
        <div className="mn-size" role="group" aria-label="Text size">
          <button type="button" className="mn-icon" onClick={() => setSize((s) => Math.max(13, s - 1))} aria-label="Smaller text" title="Smaller text">A−</button>
          <button type="button" className="mn-icon" onClick={() => setSize((s) => Math.min(24, s + 1))} aria-label="Bigger text" title="Bigger text">A+</button>
        </div>
        <button type="button" className={`mn-icon mn-wide-only ${side ? 'on' : ''}`} onClick={() => setSide((s) => !s)} aria-pressed={side} aria-label="Action items and timeline" title="Action items and timeline"><Icon name="viewList" size={20} /></button>
        <div className="mn-export">
          <button type="button" className="mn-btn primary" onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}>
            <Icon name={copied ? 'check' : 'download'} size={18} /><span>{copied ? 'Copied' : 'Export'}</span>
          </button>
          {exportOpen && (
            <>
              <button type="button" className="mn-scrim" aria-label="Close" onClick={() => setExportOpen(false)} />
              <div className="mn-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => copy('all')} disabled={!text}><Icon name="copy" size={18} />Copy all notes</button>
                <button type="button" role="menuitem" onClick={() => copy('actions')} disabled={!open}><Icon name="checklist" size={18} />Copy open action items</button>
                <button type="button" role="menuitem" onClick={() => download('md')} disabled={!text}><Icon name="download" size={18} />Download Markdown (.md)</button>
                <button type="button" role="menuitem" onClick={() => download('txt')} disabled={!text}><Icon name="download" size={18} />Download text (.txt)</button>
                <button type="button" role="menuitem" onClick={print} disabled={!text}><Icon name="print" size={18} />Print or save as PDF</button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="mn-body">
        <div className={`mn-work view-${view}`}>
          {showEditor && (
            <section className="mn-editor" aria-label="Write">
              <div className="mn-tools" role="toolbar" aria-label="Formatting">
                {tools.map((tool, i) => (tool.sep
                  ? <span key={`s${i}`} className="mn-tools-sep" />
                  : <button key={tool.label} type="button" className="mn-tool" onMouseDown={(e) => e.preventDefault()} onClick={tool.run} title={tool.label} aria-label={tool.label}><Icon name={tool.icon} size={19} /></button>))}
                <span className="mn-tools-grow" />
                {!text.trim() && <button type="button" className="mn-btn small" onClick={() => setText(TEMPLATE)}><Icon name="sparkle" size={16} />Use meeting template</button>}
              </div>
              <textarea
                ref={area}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={'Start typing…\n\n## Heading   - bullet   - [ ] action item   [10:30] time'}
                aria-label="Your meeting notes"
                spellCheck
                autoFocus
                maxLength={100000}
              />
            </section>
          )}
          {showPreview && (
            <section className="mn-preview" aria-label="Preview">
              <h1 className="mn-print-title">{heading}</h1>
              <Preview text={text} onToggle={toggleLine} />
            </section>
          )}
        </div>

        {side && (
          <aside className="mn-side mn-wide-only" aria-label="Summary">
            <div className="mn-card">
              <h3><Icon name="checklist" size={18} />Action items <b>{open ? `${open} open` : actions.length ? 'All done' : ''}</b></h3>
              {actions.length ? (
                <ul className="mn-actions">
                  {actions.map((a) => (
                    <li key={a.index} className={a.done ? 'done' : ''}>
                      <button type="button" role="checkbox" aria-checked={a.done} onClick={() => toggleLine(a.index)} aria-label={a.done ? 'Mark as not done' : 'Mark as done'}>{a.done && <Icon name="check" size={13} />}</button>
                      <span>{inline(a.text, a.index)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="mn-hint">Lines starting with <code>- [ ]</code> show here. Press Ctrl+Enter to make one.</p>}
            </div>
            <div className="mn-card">
              <h3><Icon name="clock" size={18} />Timeline</h3>
              {timeline.length ? (
                <ol className="mn-timeline">
                  {timeline.map((t, i) => <li key={i}><time>{t.time}</time><span>{t.text ? inline(t.text, i) : '—'}</span></li>)}
                </ol>
              ) : <p className="mn-hint">Press the clock button to stamp the time on a line.</p>}
            </div>
            {outline.length > 0 && (
              <div className="mn-card">
                <h3><Icon name="heading" size={18} />Outline</h3>
                <ul className="mn-outline">
                  {outline.map((h) => <li key={h.index} style={{ paddingLeft: (h.level - 1) * 12 }}><button type="button" onClick={() => jumpTo(h.index)}>{h.text}</button></li>)}
                </ul>
              </div>
            )}
            <p className="mn-private"><Icon name="lock" size={14} />Only you can see these notes. They stay on this device.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
