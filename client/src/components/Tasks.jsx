import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { ask } from './Dialog.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import { downloadTaskTemplate, readTaskSpreadsheet } from '../taskSpreadsheet.js';

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: '#868e96' },
  { id: 'todo', label: 'To do', color: '#0b5cd5' },
  { id: 'doing', label: 'In progress', color: '#e8590c' },
  { id: 'done', label: 'Done', color: '#2b8a3e' },
];
const COLORS = ['#0b5cd5', '#7048e8', '#d6336c', '#e8590c', '#2b8a3e', '#0c8599', '#495057'];
const EMPTY = { title: '', description: '', projectId: '', status: 'todo', priority: 'medium', assignee: '', dueDate: '' };

const today = () => new Date().toISOString().slice(0, 10);
const overdue = (task) => task.dueDate && task.status !== 'done' && task.dueDate < today();
const initials = (value) => String(value || '?').split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const dateLabel = (value) => {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(value.slice(0, 4) !== String(new Date().getFullYear()) && { year: 'numeric' }) }).format(new Date(`${value}T12:00:00`));
};

function TaskCard({ task, project, person, onOpen }) {
  return (
    <article
      className={`task-card priority-${task.priority}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)}
      onClick={() => onOpen(task)}
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && onOpen(task)}
    >
      <div className="task-card-top">
        <span className={`task-priority ${task.priority}`}>{task.priority}</span>
        {project && <span className="task-project-dot" title={project.name} style={{ '--project': project.color }} />}
      </div>
      <strong>{task.title}</strong>
      {task.description && <p>{task.description}</p>}
      <div className="task-card-meta">
        {task.dueDate && <span className={overdue(task) ? 'task-overdue' : ''}><Icon name="event" size={15} /> {dateLabel(task.dueDate)}</span>}
        <span className="push-right" />
        {person ? <Avatar url={person.avatarUrl} person={{ name: person.name, address: person.address }} color={person.color} size="xs" /> : <span className="task-unassigned" title="Unassigned"><Icon name="person" size={15} /></span>}
      </div>
    </article>
  );
}

function TaskEditor({ draft, projects, team, saving, onChange, onSave, onDelete, onClose }) {
  return (
    <div className="task-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="task-drawer" aria-label={draft.id ? 'Task details' : 'New task'}>
        <header>
          <div><span className="muted small">{draft.id ? 'Task details' : 'Create task'}</span><h2>{draft.id ? draft.title : 'New task'}</h2></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
          <label>Task name<input autoFocus type="text" maxLength="200" required value={draft.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
          <div className="task-form-grid">
            <label>Project<select required value={draft.projectId} onChange={(event) => onChange({ projectId: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label>Status<select value={draft.status} onChange={(event) => onChange({ status: event.target.value })}>{COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>
            <label>Assignee<select value={draft.assignee || ''} onChange={(event) => onChange({ assignee: event.target.value })}><option value="">Unassigned</option>{team.map((person) => <option key={person.address} value={person.address}>{person.name || person.address}</option>)}</select></label>
            <label>Priority<select value={draft.priority} onChange={(event) => onChange({ priority: event.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
            <label>Due date<input type="date" value={draft.dueDate || ''} onChange={(event) => onChange({ dueDate: event.target.value })} /></label>
          </div>
          <label>Description<textarea rows="8" maxLength="10000" placeholder="Add context, acceptance criteria, or links…" value={draft.description || ''} onChange={(event) => onChange({ description: event.target.value })} /></label>
          <div className="task-form-actions">
            {draft.id && <button type="button" className="btn btn-ghost task-delete" onClick={onDelete}><Icon name="trash" size={17} /> Delete</button>}
            <span className="push-right" />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || !draft.title.trim() || !draft.projectId}>{saving ? 'Saving…' : 'Save task'}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function TaskImport({ preview, projectsById, peopleByAddress, importing, error, onImport, onChoose, onTemplate, onClose }) {
  return (
    <div className="task-drawer-backdrop task-import-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="task-import" role="dialog" aria-label="Import tasks from spreadsheet">
        <header>
          <div><span className="muted small">Spreadsheet import</span><h2>{preview ? `${preview.tasks.length} task${preview.tasks.length === 1 ? '' : 's'} ready` : 'Import tasks from a spreadsheet'}</h2></div>
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
            {preview ? preview.tasks.slice(0, 10).map((task, index) => <tr key={`${task.title}-${index}`}><td>{task.title}</td><td>{projectsById[task.projectId]?.name}</td><td>{peopleByAddress[task.assignee]?.name || task.assignee || 'Unassigned'}</td><td><span className={`task-priority ${task.priority}`}>{task.priority}</span></td><td>{COLUMNS.find((column) => column.id === task.status)?.label}</td><td>{task.dueDate || '—'}</td></tr>) : <tr><td>Prepare project update</td><td>Website launch</td><td>mary@example.com</td><td><span className="task-priority high">high</span></td><td>To do</td><td>2026-12-15</td></tr>}
          </tbody></table>
          {preview?.tasks.length > 10 && <p>And {preview.tasks.length - 10} more tasks…</p>}
        </div>
        <div className="task-import-help"><strong>Expected columns</strong><span>Task, Project, Assignee, Priority, Status, Due date, Description. Project and assignee names or emails are matched automatically.</span><button type="button" className="link" onClick={onTemplate}>Download CSV template</button></div>
        <footer><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>{preview && <button type="button" className="btn btn-primary" disabled={importing} onClick={onImport}><Icon name="upload" size={17} /> {importing ? 'Importing…' : `Import ${preview.tasks.length} tasks`}</button>}</footer>
      </section>
    </div>
  );
}

export default function Tasks({ user, startTask, onClose }) {
  const [data, setData] = useState({ me: '', team: [], projects: [], tasks: [], activity: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState('all');
  const [view, setView] = useState('board');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const spreadsheetPicker = useRef(null);

  const load = () => api('/tasks').then(setData).catch((err) => setError(err.message)).finally(() => setLoading(false));
  useEffect(() => {
    load();
    const refresh = () => document.visibilityState === 'visible' && load();
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!startTask || !data.tasks.length) return;
    const wanted = data.tasks.find((task) => task.id === startTask);
    if (wanted) { setScope(`project:${wanted.projectId}`); setEditor(wanted); }
    const url = new URL(window.location.href);
    url.searchParams.delete('task');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [startTask, data.tasks]);

  const projectsById = useMemo(() => Object.fromEntries(data.projects.map((project) => [project.id, project])), [data.projects]);
  const peopleByAddress = useMemo(() => Object.fromEntries(data.team.map((person) => [person.address, person])), [data.team]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.tasks.filter((task) => {
      if (scope === 'mine' && task.assignee !== data.me) return false;
      if (scope === 'completed' && task.status !== 'done') return false;
      if (scope.startsWith('project:') && task.projectId !== scope.slice(8)) return false;
      if (priority !== 'all' && task.priority !== priority) return false;
      if (needle && !`${task.title} ${task.description} ${projectsById[task.projectId]?.name || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data.tasks, data.me, scope, priority, query, projectsById]);

  const counts = useMemo(() => ({
    all: data.tasks.filter((task) => task.status !== 'done').length,
    mine: data.tasks.filter((task) => task.assignee === data.me && task.status !== 'done').length,
    completed: data.tasks.filter((task) => task.status === 'done').length,
  }), [data.tasks, data.me]);

  const updateLocal = (updated) => setData((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === updated.id ? updated : task) }));
  const move = async (task, status) => {
    if (task.status === status) return;
    const previous = task;
    updateLocal({ ...task, status });
    try { updateLocal(await api(`/tasks/items/${task.id}`, { method: 'PATCH', body: { status } })); }
    catch (err) { updateLocal(previous); setError(err.message); }
  };

  const createProject = async () => {
    const name = await ask({ title: 'New project', input: { label: 'Project name', placeholder: 'e.g. Website launch', maxLength: 80 }, confirmLabel: 'Create project' });
    if (!name) return;
    try {
      const color = COLORS[data.projects.length % COLORS.length];
      const project = await api('/tasks/projects', { method: 'POST', body: { name, color } });
      setData((current) => ({ ...current, projects: [...current.projects, project].sort((a, b) => a.name.localeCompare(b.name)) }));
      setScope(`project:${project.id}`);
    } catch (err) { setError(err.message); }
  };

  const removeProject = async (project) => {
    const number = data.tasks.filter((task) => task.projectId === project.id).length;
    const yes = await ask({ title: `Delete ${project.name}?`, message: `${number} task${number === 1 ? '' : 's'} in this project will also be permanently deleted.`, confirmLabel: 'Delete project', danger: true });
    if (!yes) return;
    try {
      await api(`/tasks/projects/${project.id}`, { method: 'DELETE' });
      setData((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== project.id), tasks: current.tasks.filter((task) => task.projectId !== project.id) }));
      setScope('all');
    } catch (err) { setError(err.message); }
  };

  const openNew = (status = 'todo') => {
    if (!data.projects.length) return createProject();
    const selected = scope.startsWith('project:') && projectsById[scope.slice(8)] ? scope.slice(8) : data.projects[0].id;
    setEditor({ ...EMPTY, projectId: selected, status, assignee: scope === 'mine' ? data.me : '' });
  };

  const saveTask = async () => {
    setSaving(true); setError('');
    try {
      const method = editor.id ? 'PATCH' : 'POST';
      const path = editor.id ? `/tasks/items/${editor.id}` : '/tasks/items';
      const saved = await api(path, { method, body: editor });
      setData((current) => ({ ...current, tasks: editor.id ? current.tasks.map((task) => task.id === saved.id ? saved : task) : [saved, ...current.tasks] }));
      setEditor(null);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const deleteTask = async () => {
    if (!(await ask({ title: `Delete “${editor.title}”?`, message: 'This task will be permanently deleted.', confirmLabel: 'Delete task', danger: true }))) return;
    try {
      await api(`/tasks/items/${editor.id}`, { method: 'DELETE' });
      setData((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== editor.id) }));
      setEditor(null);
    } catch (err) { setError(err.message); }
  };

  const selectedProject = () => scope.startsWith('project:') && projectsById[scope.slice(8)] ? projectsById[scope.slice(8)] : data.projects[0];
  const chooseSpreadsheet = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setImportError('');
    try {
      const tasks = await readTaskSpreadsheet(file, { projects: data.projects, team: data.team, defaultProjectId: selectedProject()?.id });
      setImportPreview({ fileName: file.name, tasks });
    } catch (err) { setImportError(err.message); }
  };

  const importTasks = async () => {
    setImporting(true); setImportError('');
    try {
      const result = await api('/tasks/items/import', { method: 'POST', body: { tasks: importPreview.tasks } });
      setData((current) => ({ ...current, tasks: [...result.tasks, ...current.tasks] }));
      setImportPreview(null);
      setImportOpen(false);
      setScope('all'); setPriority('all'); setQuery('');
      setNotice(`${result.imported} task${result.imported === 1 ? '' : 's'} imported successfully.`);
    } catch (err) { setImportError(err.message); }
    finally { setImporting(false); }
  };

  return (
    <div className="tasks-app">
      <header className="tasks-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Tasks</strong>
        <label className="tasks-search"><Icon name="search" size={19} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <NotificationCenter onNavigate={(notification) => {
          const task = data.tasks.find((item) => item.id === notification.entity?.id);
          if (task) { setScope(`project:${task.projectId}`); setEditor(task); }
        }} />
        <div className="tasks-view-toggle" aria-label="View">
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')} title="Board view"><Icon name="dashboard" size={18} /></button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List view"><Icon name="bulletList" size={18} /></button>
        </div>
        <input ref={spreadsheetPicker} className="task-spreadsheet-input" type="file" accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values" onChange={chooseSpreadsheet} />
        <button type="button" className="btn btn-outline task-import-btn" onClick={() => data.projects.length ? setImportOpen(true) : createProject()}><Icon name="upload" size={18} /><span>Import</span></button>
        <button type="button" className="btn btn-primary" onClick={() => openNew()}><Icon name="add" size={18} /><span>New task</span></button>
      </header>

      <div className="tasks-layout">
        <aside className="tasks-sidebar">
          <nav>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}><Icon name="dashboard" size={18} /><span>All active tasks</span><b>{counts.all}</b></button>
            <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}><Icon name="person" size={18} /><span>My tasks</span><b>{counts.mine}</b></button>
            <button className={scope === 'completed' ? 'active' : ''} onClick={() => setScope('completed')}><Icon name="checkCircle" size={18} /><span>Completed</span><b>{counts.completed}</b></button>
          </nav>
          <div className="tasks-sidebar-head"><span>Projects</span><button className="icon-btn" onClick={createProject} title="New project"><Icon name="add" size={18} /></button></div>
          <nav className="task-projects">
            {data.projects.map((project) => (
              <div key={project.id} className={scope === `project:${project.id}` ? 'active' : ''}>
                <button onClick={() => setScope(`project:${project.id}`)}><span className="task-project-mark" style={{ '--project': project.color }}>{initials(project.name)}</span><span>{project.name}</span><b>{data.tasks.filter((task) => task.projectId === project.id && task.status !== 'done').length}</b></button>
                {(user?.role === 'admin' || project.createdBy === data.me) && <button className="task-project-delete" onClick={() => removeProject(project)} title={`Delete ${project.name}`}><Icon name="trash" size={15} /></button>}
              </div>
            ))}
          </nav>
          {!data.projects.length && !loading && <p className="muted small tasks-sidebar-empty">Create your first project to start planning work.</p>}
        </aside>

        <main className="tasks-main">
          <div className="tasks-heading">
            <div>
              <span className="muted small">Team workspace</span>
              <h1>{scope === 'mine' ? 'My tasks' : scope === 'completed' ? 'Completed' : scope.startsWith('project:') ? projectsById[scope.slice(8)]?.name : 'All active tasks'}</h1>
              {scope.startsWith('project:') && projectsById[scope.slice(8)]?.description && <p>{projectsById[scope.slice(8)].description}</p>}
            </div>
            <label className="task-filter">Priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
          </div>
          {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
          {notice && <div className="alert ok"><span>{notice}</span><button className="link" onClick={() => setNotice('')}>Dismiss</button></div>}
          {loading ? <div className="empty">Loading tasks…</div> : !data.projects.length ? (
            <div className="tasks-empty"><span><Icon name="checkCircle" size={36} /></span><h2>Plan your team’s work</h2><p>Create a project, add tasks, choose owners and track work from start to finish.</p><button className="btn btn-primary" onClick={createProject}><Icon name="add" size={18} /> Create project</button></div>
          ) : view === 'board' ? (
            <div className="task-board">
              {COLUMNS.map((column) => {
                const tasks = visible.filter((task) => task.status === column.id);
                return (
                  <section
                    className="task-column"
                    key={column.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { const id = event.dataTransfer.getData('text/task-id'); const task = data.tasks.find((item) => item.id === id); if (task) move(task, column.id); }}
                  >
                    <header><span className="task-column-dot" style={{ '--column': column.color }} /><strong>{column.label}</strong><b>{tasks.length}</b><button className="icon-btn" onClick={() => openNew(column.id)} title={`Add to ${column.label}`}><Icon name="add" size={17} /></button></header>
                    <div className="task-column-body">
                      {tasks.map((task) => <TaskCard key={task.id} task={task} project={projectsById[task.projectId]} person={peopleByAddress[task.assignee]} onOpen={setEditor} />)}
                      {!tasks.length && <button className="task-column-empty" onClick={() => openNew(column.id)}>+ Add task</button>}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="task-list-wrap">
              <table className="task-list"><thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead><tbody>
                {visible.map((task) => { const person = peopleByAddress[task.assignee]; const project = projectsById[task.projectId]; return (
                  <tr key={task.id} onClick={() => setEditor(task)}><td><strong>{task.title}</strong>{task.description && <span>{task.description}</span>}</td><td><i style={{ '--project': project?.color }} />{project?.name}</td><td>{person ? <><Avatar url={person.avatarUrl} person={{ name: person.name, address: person.address }} color={person.color} size="xs" /> {person.name || person.address}</> : <span className="muted">Unassigned</span>}</td><td><span className={`task-priority ${task.priority}`}>{task.priority}</span></td><td className={overdue(task) ? 'task-overdue' : ''}>{dateLabel(task.dueDate) || '—'}</td><td><select value={task.status} onClick={(event) => event.stopPropagation()} onChange={(event) => move(task, event.target.value)}>{COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select></td></tr>
                ); })}
              </tbody></table>
              {!visible.length && <div className="empty">No tasks match this view.</div>}
            </div>
          )}
        </main>
      </div>
      {editor && <TaskEditor draft={editor} projects={data.projects} team={data.team} saving={saving} onChange={(patch) => setEditor((current) => ({ ...current, ...patch }))} onSave={saveTask} onDelete={deleteTask} onClose={() => setEditor(null)} />}
      {importOpen && <TaskImport preview={importPreview} projectsById={projectsById} peopleByAddress={peopleByAddress} importing={importing} error={importError} onImport={importTasks} onChoose={() => spreadsheetPicker.current?.click()} onTemplate={() => downloadTaskTemplate(selectedProject()?.name, data.me)} onClose={() => { setImportOpen(false); setImportPreview(null); setImportError(''); }} />}
    </div>
  );
}
