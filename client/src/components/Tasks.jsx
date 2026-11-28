import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { ask } from './Dialog.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import { downloadTaskTemplate, readTaskSpreadsheet } from '../taskSpreadsheet.js';
import { BUCKETS, addDays, bucketOf, dayLabel, fromIso, iso, parseQuickAdd, todayIso, weekStart } from '../taskPlanner.js';
import '../tasks.css';

const STATUSES = [
  { id: 'backlog', label: 'Someday' },
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];
const PRIORITIES = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];
const COLORS = ['#0b5cd5', '#7048e8', '#d6336c', '#e8590c', '#2b8a3e', '#0c8599', '#495057'];
const statusLabel = (id) => STATUSES.find((status) => status.id === id)?.label || id;
const isLate = (task) => task.status !== 'done' && task.dueDate && task.dueDate < todayIso();
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const timeAgo = (value) => {
  const minutes = Math.round((Date.now() - new Date(value)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return dayLabel(iso(new Date(value)));
};

function Ring({ percent, size = 44 }) {
  const radius = size / 2 - 4;
  const length = 2 * Math.PI * radius;
  return (
    <svg className="pl-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} />
      <circle cx={size / 2} cy={size / 2} r={radius} strokeDasharray={length} strokeDashoffset={length * (1 - percent / 100)} />
    </svg>
  );
}

function Check({ task, onToggle }) {
  const done = task.status === 'done';
  return (
    <button
      type="button"
      className={`pl-check pr-${task.priority}${done ? ' on' : ''}`}
      onClick={(event) => { event.stopPropagation(); onToggle(task); }}
      aria-label={done ? `Mark “${task.title}” not done` : `Complete “${task.title}”`}
      title={done ? 'Mark not done' : 'Complete'}
    ><Icon name="check" size={14} /></button>
  );
}

function TaskRow({ task, project, person, selected, compact, onOpen, onToggle }) {
  const steps = task.checklist || [];
  const stepsDone = steps.filter((step) => step.done).length;
  return (
    <div
      className={`pl-row${task.status === 'done' ? ' is-done' : ''}${selected ? ' selected' : ''}${compact ? ' compact' : ''}`}
      style={{ '--project': project?.color || '#868e96' }}
      draggable
      onDragStart={(event) => { event.dataTransfer.setData('text/task-id', task.id); event.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => onOpen(task.id)}
      onKeyDown={(event) => event.key === 'Enter' && onOpen(task.id)}
      tabIndex={0}
      role="button"
    >
      <Check task={task} onToggle={onToggle} />
      <div className="pl-row-main">
        <strong>{task.title}</strong>
        <div className="pl-row-meta">
          {project && <span className="pl-tag"><i />{project.name}</span>}
          {task.status === 'doing' && <span className="pl-pill doing">In progress</span>}
          {task.status === 'backlog' && <span className="pl-pill">Someday</span>}
          {steps.length > 0 && <span className={stepsDone === steps.length ? 'pl-meta-ok' : ''}><Icon name="checkCircle" size={13} />{stepsDone}/{steps.length}</span>}
          {task.comments?.length > 0 && <span><Icon name="chat" size={13} />{task.comments.length}</span>}
          {!compact && task.dueDate && <span className={isLate(task) ? 'pl-late' : ''}><Icon name="event" size={13} />{dayLabel(task.dueDate)}</span>}
        </div>
      </div>
      {person ? <Avatar url={person.avatarUrl} person={{ name: person.name, address: person.address }} color={person.color} size="xs" /> : <span className="pl-nobody" title="Unassigned"><Icon name="person" size={13} /></span>}
    </div>
  );
}

function QuickAdd({ inputRef, projects, team, me, defaults, onCreate }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseQuickAdd(text, { projects, team, me }), [text, projects, team, me]);
  const projectId = parsed.projectId || defaults.projectId;
  const project = projects.find((item) => item.id === projectId);
  const person = team.find((item) => item.address === (parsed.assignee ?? defaults.assignee));
  const due = parsed.dueDate ?? defaults.dueDate;

  const submit = async (event) => {
    event.preventDefault();
    if (!parsed.title || !projectId || busy) return;
    setBusy(true);
    const ok = await onCreate({
      title: parsed.title, projectId, priority: parsed.priority || 'medium', status: 'todo',
      assignee: parsed.assignee ?? defaults.assignee ?? '', dueDate: due || '',
    });
    setBusy(false);
    if (ok) setText('');
  };

  return (
    <form className={`pl-quick${text ? ' typing' : ''}`} onSubmit={submit}>
      <span className="pl-quick-plus"><Icon name="add" size={20} /></span>
      <input
        ref={inputRef}
        aria-label="Add a task"
        placeholder="Add a task — e.g. Send report #project @name !high fri"
        value={text}
        maxLength={300}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setText('')}
      />
      {text && (
        <div className="pl-quick-chips" aria-live="polite">
          {project && <span className="pl-chip" style={{ '--project': project.color }}><i />{project.name}</span>}
          {person && <span className="pl-chip"><Icon name="person" size={13} />{person.address === me ? 'Me' : person.name || person.address}</span>}
          {due && <span className="pl-chip"><Icon name="event" size={13} />{dayLabel(due)}</span>}
          {parsed.priority && <span className={`pl-chip pr-${parsed.priority}`}><Icon name="important" size={13} />{parsed.priority}</span>}
          <button type="submit" className="btn btn-primary" disabled={!parsed.title || busy}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      )}
    </form>
  );
}

function Checklist({ steps, onChange }) {
  const [text, setText] = useState('');
  const done = steps.filter((step) => step.done).length;
  const add = (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onChange([...steps, { id: crypto.randomUUID(), text: value, done: false }]);
    setText('');
  };
  return (
    <section className="pl-section">
      <h3>Checklist {steps.length > 0 && <span>{done}/{steps.length}</span>}</h3>
      {steps.length > 0 && <div className="pl-bar"><b style={{ width: `${(done / steps.length) * 100}%` }} /></div>}
      <ul className="pl-steps">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={step.done} onChange={() => onChange(steps.map((item) => item.id === step.id ? { ...item, done: !item.done } : item))} />
              <span>{step.text}</span>
            </label>
            <button type="button" className="icon-btn" onClick={() => onChange(steps.filter((item) => item.id !== step.id))} aria-label={`Remove ${step.text}`}><Icon name="close" size={15} /></button>
          </li>
        ))}
      </ul>
      {steps.length < 50 && (
        <form className="pl-step-add" onSubmit={add}>
          <Icon name="add" size={16} />
          <input placeholder="Add a step" maxLength={200} value={text} onChange={(event) => setText(event.target.value)} />
        </form>
      )}
    </section>
  );
}

const ACTIVITY_TEXT = { 'task-created': 'created this task', 'task-status': 'changed the status', 'task-updated': 'edited the task' };

function Discussion({ task, activity, me, isAdmin, people, onComment, onDeleteComment }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const name = (address) => address === me ? 'You' : people[address]?.name || address;
  const thread = useMemo(() => [
    ...(task.comments || []).map((comment) => ({ ...comment, kind: 'comment' })),
    ...activity.filter((item) => item.taskId === task.id && ACTIVITY_TEXT[item.action]).map((item) => ({ ...item, kind: 'event', author: item.actor })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [task, activity]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await onComment(text.trim())) setText('');
    setBusy(false);
  };

  return (
    <section className="pl-section">
      <h3>Discussion {task.comments?.length > 0 && <span>{task.comments.length}</span>}</h3>
      <ol className="pl-thread">
        {thread.map((item) => item.kind === 'event' ? (
          <li key={item.id} className="pl-event"><i />{name(item.author)} {ACTIVITY_TEXT[item.action]} · {timeAgo(item.at)}</li>
        ) : (
          <li key={item.id} className="pl-comment">
            <Avatar url={people[item.author]?.avatarUrl} person={{ name: people[item.author]?.name, address: item.author }} color={people[item.author]?.color} size="xs" />
            <div>
              <header><strong>{name(item.author)}</strong><time>{timeAgo(item.at)}</time>
                {(item.author === me || isAdmin) && <button type="button" className="link" onClick={() => onDeleteComment(item.id)}>Delete</button>}
              </header>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="pl-composer">
        <textarea
          rows="2"
          maxLength={4000}
          placeholder="Write a comment… (Ctrl+Enter to send)"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }}
        />
        <button type="button" className="btn btn-primary" disabled={!text.trim() || busy} onClick={send}><Icon name="send" size={16} /> Send</button>
      </div>
    </section>
  );
}

function TaskPanel({ task, projects, team, me, isAdmin, activity, onPatch, onComment, onDeleteComment, onDelete, onClose }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  useEffect(() => { setTitle(task.title); setDescription(task.description || ''); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = useMemo(() => Object.fromEntries(team.map((person) => [person.address, person])), [team]);
  const project = projects.find((item) => item.id === task.projectId);
  const now = new Date();
  const saveTitle = () => {
    const value = title.trim();
    if (!value) setTitle(task.title);
    else if (value !== task.title) onPatch(task, { title: value });
  };

  return (
    <aside className="pl-panel" style={{ '--project': project?.color || 'var(--brand)' }} aria-label="Task details">
      <header className="pl-panel-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="close" /></button>
        <span className="pl-tag"><i />{project?.name}</span>
        <span className="push-right" />
        <button type="button" className="icon-btn danger" onClick={onDelete} aria-label="Delete task" title="Delete task"><Icon name="trash" size={19} /></button>
      </header>
      <div className="pl-panel-body">
        <div className="pl-title-row">
          <Check task={task} onToggle={() => onPatch(task, { status: task.status === 'done' ? 'todo' : 'done' })} />
          <textarea
            className="pl-title"
            rows="1"
            aria-label="Task name"
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value.replace(/\n/g, ''))}
            onBlur={saveTitle}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          />
        </div>

        <div className="pl-seg" role="radiogroup" aria-label="Status">
          {STATUSES.map((status) => <button type="button" key={status.id} role="radio" aria-checked={task.status === status.id} className={`${task.status === status.id ? 'on' : ''} st-${status.id}`} onClick={() => onPatch(task, { status: status.id })}>{status.label}</button>)}
        </div>

        <dl className="pl-props">
          <dt><Icon name="event" size={17} />Due</dt>
          <dd>
            <input type="date" value={task.dueDate || ''} className={isLate(task) ? 'pl-late' : ''} onChange={(event) => onPatch(task, { dueDate: event.target.value || null })} />
            <span className="pl-date-quick">
              <button type="button" onClick={() => onPatch(task, { dueDate: iso(now) })}>Today</button>
              <button type="button" onClick={() => onPatch(task, { dueDate: iso(addDays(now, 1)) })}>Tomorrow</button>
              <button type="button" onClick={() => onPatch(task, { dueDate: iso(addDays(weekStart(now), 7)) })}>Next week</button>
              {task.dueDate && <button type="button" onClick={() => onPatch(task, { dueDate: null })}>Clear</button>}
            </span>
          </dd>
          <dt><Icon name="person" size={17} />Owner</dt>
          <dd><select value={task.assignee || ''} onChange={(event) => onPatch(task, { assignee: event.target.value })}><option value="">Unassigned</option>{team.map((person) => <option key={person.address} value={person.address}>{person.address === me ? `${person.name || person.address} (you)` : person.name || person.address}</option>)}</select></dd>
          <dt><Icon name="important" size={17} />Priority</dt>
          <dd className="pl-prio">{PRIORITIES.map((priority) => <button type="button" key={priority.id} className={`pr-${priority.id}${task.priority === priority.id ? ' on' : ''}`} onClick={() => onPatch(task, { priority: priority.id })}><i />{priority.label}</button>)}</dd>
          <dt><Icon name="label" size={17} />Project</dt>
          <dd><select value={task.projectId} onChange={(event) => onPatch(task, { projectId: event.target.value })}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></dd>
        </dl>

        <section className="pl-section">
          <h3>Notes</h3>
          <textarea
            className="pl-notes"
            rows="4"
            maxLength={10000}
            placeholder="Add context, links or acceptance criteria…"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => description !== (task.description || '') && onPatch(task, { description })}
          />
        </section>

        <Checklist steps={task.checklist || []} onChange={(checklist) => onPatch(task, { checklist })} />
        <Discussion task={task} activity={activity} me={me} isAdmin={isAdmin} people={people} onComment={onComment} onDeleteComment={onDeleteComment} />
        <p className="pl-footnote">Created by {task.createdBy === me ? 'you' : people[task.createdBy]?.name || task.createdBy} · {dayLabel(iso(new Date(task.createdAt)))}{task.completedAt && ` · Completed ${dayLabel(iso(new Date(task.completedAt)))}`}</p>
      </div>
    </aside>
  );
}

function TaskImport({ preview, projectsById, peopleByAddress, importing, error, onImport, onChoose, onTemplate, onClose }) {
  return (
    <div className="task-drawer-backdrop task-import-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="task-import" role="dialog" aria-label="Import tasks from spreadsheet">
        <header>
          <div><span className="muted small">Spreadsheet import</span><h2>{preview ? `${plural(preview.tasks.length, 'task')} ready` : 'Import tasks from a spreadsheet'}</h2></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        {preview ? <div className="task-import-file"><Icon name="upload" size={22} /><div><strong>{preview.fileName}</strong><span>Excel, CSV and TSV are supported</span></div><button type="button" className="btn btn-outline" onClick={onChoose}>Choose another</button></div> : (
          <div className="task-import-start">
            <span className="task-import-start-icon"><Icon name="upload" size={30} /></span>
            <div><h3>Upload your completed spreadsheet</h3><p>Use an Excel, CSV or TSV file. The first row must contain column names.</p></div>
            <button type="button" className="btn btn-primary" onClick={onChoose}><Icon name="upload" size={17} /> Choose spreadsheet</button>
            <button type="button" className="btn btn-outline" onClick={onTemplate}><Icon name="download" size={17} /> Download sample CSV</button>
          </div>
        )}
        {error && <div className="task-import-error" role="alert">{error}</div>}
        <div className={`task-import-preview ${preview ? '' : 'sample'}`}>
          <table><thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead><tbody>
            {preview ? preview.tasks.slice(0, 10).map((task, index) => <tr key={`${task.title}-${index}`}><td>{task.title}</td><td>{projectsById[task.projectId]?.name}</td><td>{peopleByAddress[task.assignee]?.name || task.assignee || 'Unassigned'}</td><td>{task.priority}</td><td>{statusLabel(task.status)}</td><td>{task.dueDate || '—'}</td></tr>) : <tr><td>Prepare project update</td><td>Website launch</td><td>mary@example.com</td><td>high</td><td>To do</td><td>2026-12-15</td></tr>}
          </tbody></table>
          {preview?.tasks.length > 10 && <p>And {preview.tasks.length - 10} more tasks…</p>}
        </div>
        <div className="task-import-help"><strong>Expected columns</strong><span>Task, Project, Assignee, Priority, Status, Due date, Description. Project and assignee names or emails are matched automatically.</span><button type="button" className="link" onClick={onTemplate}>Download CSV template</button></div>
        <footer><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>{preview && <button type="button" className="btn btn-primary" disabled={importing} onClick={onImport}><Icon name="upload" size={17} /> {importing ? 'Importing…' : `Import ${plural(preview.tasks.length, 'task')}`}</button>}</footer>
      </section>
    </div>
  );
}

function DropZone({ className, onDropTask, children, ...rest }) {
  const [over, setOver] = useState(false);
  return (
    <section
      {...rest}
      className={`${className}${over ? ' drop' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget) && setOver(false)}
      onDrop={(event) => { event.preventDefault(); setOver(false); onDropTask(event.dataTransfer.getData('text/task-id')); }}
    >{children}</section>
  );
}

export default function Tasks({ user, startTask, onClose }) {
  const [data, setData] = useState({ me: '', team: [], projects: [], tasks: [], activity: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lens, setLens] = useState('all');
  const [view, setView] = useState('agenda');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [week, setWeek] = useState(() => weekStart());
  const [importPreview, setImportPreview] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const spreadsheetPicker = useRef(null);
  const quickInput = useRef(null);
  const requestSeq = useRef({});

  const load = () => api('/tasks').then(setData).catch((err) => setError(err.message)).finally(() => setLoading(false));
  useEffect(() => {
    load();
    const refresh = () => document.visibilityState === 'visible' && load();
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { window.removeEventListener('focus', refresh); clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!startTask || !data.tasks.length) return;
    if (data.tasks.some((task) => task.id === startTask)) setSelectedId(startTask);
    const url = new URL(window.location.href);
    url.searchParams.delete('task');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [startTask, data.tasks]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (event.key === 'n' || event.key === 'q') { event.preventDefault(); quickInput.current?.focus(); }
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const me = data.me;
  const today = todayIso();
  const projectsById = useMemo(() => Object.fromEntries(data.projects.map((project) => [project.id, project])), [data.projects]);
  const peopleByAddress = useMemo(() => Object.fromEntries(data.team.map((person) => [person.address, person])), [data.team]);
  const lensProject = lens.startsWith('project:') ? projectsById[lens.slice(8)] : null;
  const doneToday = (task) => task.status === 'done' && task.completedAt && iso(new Date(task.completedAt)) === today;

  const inLens = (task, which = lens) => {
    if (which === 'today') return task.assignee === me && ((task.status !== 'done' && task.dueDate && task.dueDate <= today) || doneToday(task));
    if (which === 'mine') return task.assignee === me && task.status !== 'done';
    if (which === 'done') return task.status === 'done';
    if (which.startsWith('project:')) return task.projectId === which.slice(8);
    return true;
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.tasks.filter((task) => inLens(task) && (!needle || `${task.title} ${task.description} ${projectsById[task.projectId]?.name || ''}`.toLowerCase().includes(needle)));
  }, [data.tasks, lens, query, projectsById, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => ({
    today: data.tasks.filter((task) => task.status !== 'done' && inLens(task, 'today')).length,
    mine: data.tasks.filter((task) => inLens(task, 'mine')).length,
    all: data.tasks.filter((task) => task.status !== 'done').length,
    done: data.tasks.filter((task) => task.status === 'done').length,
  }), [data.tasks, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = useMemo(() => {
    const done = visible.filter((task) => task.status === 'done').length;
    return { done, total: visible.length, open: visible.length - done, late: visible.filter(isLate).length, percent: visible.length ? Math.round((done / visible.length) * 100) : 0 };
  }, [visible]);

  const groups = useMemo(() => {
    const byPriority = { high: 0, medium: 1, low: 2 };
    const order = (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || byPriority[a.priority] - byPriority[b.priority] || a.title.localeCompare(b.title);
    if (lens === 'done') {
      const done = [...visible].sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
      const map = new Map();
      for (const task of done) {
        const day = task.completedAt ? iso(new Date(task.completedAt)) : '';
        const label = day ? (day >= iso(addDays(new Date(), -1)) ? dayLabel(day) : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(fromIso(day))) : 'Earlier';
        if (!map.has(label)) map.set(label, []);
        map.get(label).push(task);
      }
      return [...map].map(([label, tasks]) => ({ id: label, label, tasks }));
    }
    const open = visible.filter((task) => task.status !== 'done');
    const sections = BUCKETS.map((bucket) => ({ ...bucket, tasks: open.filter((task) => bucketOf(task.dueDate) === bucket.id).sort(order) })).filter((section) => section.tasks.length);
    const finished = visible.filter(doneToday);
    if (finished.length) sections.push({ id: 'finished', label: 'Done today', tasks: finished });
    return sections;
  }, [visible, lens]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceLocal = (updated) => setData((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === updated.id ? updated : task) }));
  // Later edits can finish before earlier ones; only the newest server answer per task is kept.
  const send = async (id, path, options) => {
    const seq = (requestSeq.current[id] || 0) + 1;
    requestSeq.current[id] = seq;
    const saved = await api(path, options);
    if (requestSeq.current[id] === seq) replaceLocal(saved);
    return saved;
  };

  const patchTask = async (task, patch) => {
    const before = data.tasks.find((item) => item.id === task.id) || task;
    const nextStatus = patch.status ?? before.status;
    replaceLocal({ ...before, ...patch, completedAt: nextStatus === 'done' ? before.completedAt || new Date().toISOString() : null });
    try { await send(task.id, `/tasks/items/${task.id}`, { method: 'PATCH', body: patch }); }
    catch (err) { replaceLocal(before); setError(err.message); }
  };
  const toggle = (task) => patchTask(task, { status: task.status === 'done' ? 'todo' : 'done' });

  const createTask = async (body) => {
    setError('');
    try {
      const saved = await api('/tasks/items', { method: 'POST', body });
      setData((current) => ({ ...current, tasks: [saved, ...current.tasks] }));
      if (!inLens(saved)) setNotice(`Added “${saved.title}” to ${projectsById[saved.projectId]?.name || 'its project'}.`);
      return true;
    } catch (err) { setError(err.message); return false; }
  };

  const createProject = async () => {
    const name = await ask({ title: 'New project', input: { label: 'Project name', placeholder: 'e.g. Website launch', maxLength: 80 }, confirmLabel: 'Create project' });
    if (!name) return;
    try {
      const color = COLORS[data.projects.length % COLORS.length];
      const project = await api('/tasks/projects', { method: 'POST', body: { name, color } });
      setData((current) => ({ ...current, projects: [...current.projects, project].sort((a, b) => a.name.localeCompare(b.name)) }));
      setLens(`project:${project.id}`);
    } catch (err) { setError(err.message); }
  };

  const recolorProject = async (project) => {
    const color = COLORS[(COLORS.indexOf(project.color) + 1) % COLORS.length];
    try {
      const saved = await api(`/tasks/projects/${project.id}`, { method: 'PATCH', body: { color } });
      setData((current) => ({ ...current, projects: current.projects.map((item) => item.id === saved.id ? saved : item) }));
    } catch (err) { setError(err.message); }
  };

  const removeProject = async (project) => {
    const number = data.tasks.filter((task) => task.projectId === project.id).length;
    if (!(await ask({ title: `Delete ${project.name}?`, message: `${plural(number, 'task')} in this project will also be permanently deleted.`, confirmLabel: 'Delete project', danger: true }))) return;
    try {
      await api(`/tasks/projects/${project.id}`, { method: 'DELETE' });
      setData((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== project.id), tasks: current.tasks.filter((task) => task.projectId !== project.id) }));
      setLens('all');
    } catch (err) { setError(err.message); }
  };

  const selected = data.tasks.find((task) => task.id === selectedId);
  const deleteTask = async () => {
    if (!(await ask({ title: `Delete “${selected.title}”?`, message: 'This task, its checklist and comments will be permanently deleted.', confirmLabel: 'Delete task', danger: true }))) return;
    try {
      await api(`/tasks/items/${selected.id}`, { method: 'DELETE' });
      setData((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== selected.id) }));
      setSelectedId(null);
    } catch (err) { setError(err.message); }
  };
  const comment = async (text) => {
    try { await send(selected.id, `/tasks/items/${selected.id}/comments`, { method: 'POST', body: { text } }); return true; }
    catch (err) { setError(err.message); return false; }
  };
  const deleteComment = async (commentId) => {
    try { await send(selected.id, `/tasks/items/${selected.id}/comments/${commentId}`, { method: 'DELETE' }); }
    catch (err) { setError(err.message); }
  };

  const dropOn = (dueDate) => (id) => {
    const task = data.tasks.find((item) => item.id === id);
    if (task && task.dueDate !== dueDate) patchTask(task, { dueDate });
  };

  const defaultProject = lensProject || data.projects[0];
  const quickDefaults = { projectId: defaultProject?.id, assignee: lens === 'today' || lens === 'mine' ? me : '', dueDate: lens === 'today' ? today : '' };

  const chooseSpreadsheet = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError('');
    try { setImportPreview({ fileName: file.name, tasks: await readTaskSpreadsheet(file, { projects: data.projects, team: data.team, defaultProjectId: defaultProject?.id }) }); }
    catch (err) { setImportError(err.message); }
  };
  const importTasks = async () => {
    setImporting(true); setImportError('');
    try {
      const result = await api('/tasks/items/import', { method: 'POST', body: { tasks: importPreview.tasks } });
      setData((current) => ({ ...current, tasks: [...result.tasks, ...current.tasks] }));
      setImportPreview(null); setImportOpen(false); setLens('all'); setQuery('');
      setNotice(`${plural(result.imported, 'task')} imported.`);
    } catch (err) { setImportError(err.message); }
    finally { setImporting(false); }
  };

  const heading = lens === 'today' ? 'My day' : lens === 'mine' ? 'Assigned to me' : lens === 'done' ? 'Completed' : lensProject ? lensProject.name : 'Everything';
  const subheading = lens === 'today'
    ? new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
    : lens === 'done' ? `${plural(progress.total, 'task')} finished` : `${plural(progress.open, 'open task')}${progress.late ? ` · ${progress.late} overdue` : ''}`;
  const rowProps = (task) => ({ task, project: projectsById[task.projectId], person: peopleByAddress[task.assignee], selected: task.id === selectedId, onOpen: setSelectedId, onToggle: toggle });
  const lenses = [
    { id: 'today', label: 'My day', icon: 'spotlight' },
    { id: 'mine', label: 'Assigned to me', icon: 'person' },
    { id: 'all', label: 'Everything', icon: 'viewList' },
    { id: 'done', label: 'Completed', icon: 'checkCircle' },
  ];
  const weekDays = Array.from({ length: 7 }, (_, index) => iso(addDays(week, index)));
  const unscheduled = visible.filter((task) => task.status !== 'done' && (!task.dueDate || (task.dueDate < today && task.dueDate < weekDays[0])));

  return (
    <div className={`tasks-app planner${selected ? ' has-panel' : ''}`}>
      <header className="tasks-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Tasks</strong>
        <label className="tasks-search"><Icon name="search" size={19} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <NotificationCenter onNavigate={(notification) => { if (data.tasks.some((task) => task.id === notification.entity?.id)) setSelectedId(notification.entity.id); }} />
        <div className="pl-views" role="tablist" aria-label="Layout">
          <button type="button" role="tab" aria-selected={view === 'agenda'} className={view === 'agenda' ? 'on' : ''} onClick={() => setView('agenda')}><Icon name="viewList" size={17} /><span>Agenda</span></button>
          <button type="button" role="tab" aria-selected={view === 'week'} className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}><Icon name="viewWeek" size={17} /><span>Week</span></button>
        </div>
        <input ref={spreadsheetPicker} className="task-spreadsheet-input" type="file" accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values" onChange={chooseSpreadsheet} />
        <button type="button" className="icon-btn" onClick={() => data.projects.length ? setImportOpen(true) : createProject()} title="Import from spreadsheet" aria-label="Import from spreadsheet"><Icon name="upload" size={20} /></button>
        <button type="button" className="btn btn-primary task-create-btn" onClick={() => data.projects.length ? quickInput.current?.focus() : createProject()} aria-label="New task"><Icon name="add" size={22} /><span>New task</span></button>
      </header>

      <div className="pl-layout">
        <aside className="pl-lenses">
          <nav aria-label="Views">
            {lenses.map((item) => (
              <button type="button" key={item.id} className={lens === item.id ? 'on' : ''} onClick={() => setLens(item.id)}>
                <Icon name={item.icon} size={18} /><span>{item.label}</span>{counts[item.id] > 0 && <b>{counts[item.id]}</b>}
              </button>
            ))}
          </nav>
          <div className="pl-lenses-head"><span>Projects</span><button type="button" className="icon-btn" onClick={createProject} title="New project" aria-label="New project"><Icon name="add" size={17} /></button></div>
          <nav className="pl-projects" aria-label="Projects">
            {data.projects.map((project) => {
              const all = data.tasks.filter((task) => task.projectId === project.id);
              const done = all.filter((task) => task.status === 'done').length;
              const canManage = user?.role === 'admin' || project.createdBy === me;
              return (
                <div key={project.id} className={lens === `project:${project.id}` ? 'on' : ''} style={{ '--project': project.color }}>
                  <button type="button" onClick={() => setLens(`project:${project.id}`)}>
                    <span className="pl-dot" /><span>{project.name}</span>
                    <small>{all.length ? `${done}/${all.length}` : ''}</small>
                  </button>
                  {canManage && <span className="pl-project-tools">
                    <button type="button" onClick={() => recolorProject(project)} title="Change colour" aria-label={`Change colour of ${project.name}`}><Icon name="formatColor" size={14} /></button>
                    <button type="button" onClick={() => removeProject(project)} title="Delete project" aria-label={`Delete ${project.name}`}><Icon name="trash" size={14} /></button>
                  </span>}
                  <i style={{ width: `${all.length ? (done / all.length) * 100 : 0}%` }} />
                </div>
              );
            })}
          </nav>
          {!data.projects.length && !loading && <p className="pl-lenses-empty">Create a project to start planning.</p>}
          <p className="pl-hint"><kbd>N</kbd> new task · <kbd>Esc</kbd> close</p>
        </aside>

        <main className={`pl-main${view === 'week' ? ' wide' : ''}`}>
          {loading ? <PanelSkeleton /> : !data.projects.length ? (
            <div className="pl-empty-state">
              <span><Icon name="checkCircle" size={34} /></span>
              <h2>Plan your team’s work</h2>
              <p>Projects hold your tasks. Create one, then type tasks straight into the planner — dates, owners and priority are picked up from what you write.</p>
              <button type="button" className="btn btn-primary" onClick={createProject}><Icon name="add" size={18} /> Create a project</button>
            </div>
          ) : (
            <>
              <div className="pl-hero" style={{ '--project': lensProject?.color || 'var(--brand)' }}>
                <div>
                  <span>{subheading}</span>
                  <h1>{heading}</h1>
                  {lensProject?.description && <p>{lensProject.description}</p>}
                </div>
                {lens !== 'done' && progress.total > 0 && (
                  <div className="pl-progress" title={`${progress.done} of ${progress.total} done`}>
                    <Ring percent={progress.percent} size={52} />
                    <div><strong>{progress.percent}%</strong><span>{progress.done} of {progress.total} done</span></div>
                  </div>
                )}
              </div>

              {lens !== 'done' && <QuickAdd inputRef={quickInput} projects={data.projects} team={data.team} me={me} defaults={quickDefaults} onCreate={createTask} />}
              {error && <div className="alert"><span>{error}</span><button type="button" className="link" onClick={() => setError('')}>Dismiss</button></div>}
              {notice && <div className="alert ok"><span>{notice}</span><button type="button" className="link" onClick={() => setNotice('')}>Dismiss</button></div>}

              {view === 'agenda' ? (
                <div className="pl-agenda">
                  {groups.map((group) => (
                    <section key={group.id} className={`pl-group g-${group.id}`}>
                      <h2><span>{group.label}</span><b>{group.tasks.length}</b></h2>
                      <div className="pl-group-rows">{group.tasks.map((task) => <TaskRow key={task.id} {...rowProps(task)} />)}</div>
                    </section>
                  ))}
                  {!groups.length && (
                    <div className="pl-clear">
                      <Icon name="checkCircle" size={30} />
                      <strong>{query ? 'No tasks match your search' : lens === 'today' ? 'Nothing due today' : lens === 'done' ? 'Nothing completed yet' : 'All clear'}</strong>
                      <span>{query ? 'Try a different word.' : lens === 'today' ? 'Tasks assigned to you that are due today or overdue show up here.' : 'Add a task above to get started.'}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="pl-week">
                  <div className="pl-week-nav">
                    <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><Icon name="chevronLeft" /></button>
                    <strong>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(week)} – {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(addDays(week, 6))}</strong>
                    <button type="button" className="icon-btn" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><Icon name="chevronRight" /></button>
                    <button type="button" className="btn btn-outline" onClick={() => setWeek(weekStart())}>This week</button>
                    <span className="pl-week-tip">Drag a task onto a day to reschedule it</span>
                  </div>
                  <div className="pl-week-grid">
                    <DropZone className="pl-day pl-tray" onDropTask={dropOn(null)}>
                      <header><strong>Unscheduled</strong><span>No date or overdue</span></header>
                      <div>{unscheduled.map((task) => <TaskRow key={task.id} {...rowProps(task)} compact />)}</div>
                    </DropZone>
                    {weekDays.map((day) => {
                      const tasks = visible.filter((task) => task.dueDate === day);
                      const date = fromIso(day);
                      return (
                        <DropZone key={day} className={`pl-day${day === today ? ' today' : ''}${day < today ? ' past' : ''}`} onDropTask={dropOn(day)}>
                          <header><span>{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)}</span><strong>{date.getDate()}</strong>{tasks.length > 0 && <b>{tasks.length}</b>}</header>
                          <div>{tasks.sort((a, b) => (a.status === 'done') - (b.status === 'done')).map((task) => <TaskRow key={task.id} {...rowProps(task)} compact />)}</div>
                        </DropZone>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </main>

        {selected && (
          <>
            <div className="pl-scrim" onClick={() => setSelectedId(null)} />
            <TaskPanel
              key={selected.id}
              task={selected}
              projects={data.projects}
              team={data.team}
              me={me}
              isAdmin={user?.role === 'admin'}
              activity={data.activity}
              onPatch={patchTask}
              onComment={comment}
              onDeleteComment={deleteComment}
              onDelete={deleteTask}
              onClose={() => setSelectedId(null)}
            />
          </>
        )}
      </div>
      {importOpen && <TaskImport preview={importPreview} projectsById={projectsById} peopleByAddress={peopleByAddress} importing={importing} error={importError} onImport={importTasks} onChoose={() => spreadsheetPicker.current?.click()} onTemplate={() => downloadTaskTemplate(defaultProject?.name, me)} onClose={() => { setImportOpen(false); setImportPreview(null); setImportError(''); }} />}
    </div>
  );
}
