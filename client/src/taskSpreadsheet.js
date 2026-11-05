const HEADER_ALIASES = {
  title: ['task', 'title', 'taskname', 'name'],
  project: ['project', 'projectname'],
  assignee: ['assignee', 'assignedto', 'owner', 'email'],
  priority: ['priority'],
  status: ['status', 'column'],
  dueDate: ['duedate', 'due', 'deadline'],
  description: ['description', 'details', 'notes'],
};

const cleanHeader = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (value) => String(value ?? '').trim();
const fieldFor = new Map(Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [alias, field])));

function parseDelimited(source, delimiter) {
  const rows = [[]];
  let value = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { rows.at(-1).push(value); value = ''; }
    else if (char === '\n') { rows.at(-1).push(value.replace(/\r$/, '')); rows.push([]); value = ''; }
    else value += char;
  }
  rows.at(-1).push(value.replace(/\r$/, ''));
  return rows.filter((row) => row.some((cell) => text(cell)));
}

async function rowsFrom(file) {
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    return readXlsxFile(file);
  }
  const source = (await file.text()).replace(/^\uFEFF/, '');
  const first = source.split(/\r?\n/, 1)[0] || '';
  const counts = [[',', (first.match(/,/g) || []).length], ['\t', (first.match(/\t/g) || []).length], [';', (first.match(/;/g) || []).length]];
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  return parseDelimited(source, delimiter);
}

function isoDate(value) {
  if (value == null || value === '') return '';
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number') date = new Date(Math.round((value - 25569) * 86400_000));
  else {
    const raw = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      date = new Date(`${raw}T00:00:00Z`);
      if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw) return raw;
      throw new Error('due date is not a valid date');
    }
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) throw new Error('due date is not a valid date');
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function statusOf(value) {
  const key = text(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!key) return 'todo';
  const statuses = { backlog: 'backlog', todo: 'todo', 'to do': 'todo', 'not started': 'todo', doing: 'doing', 'in progress': 'doing', started: 'doing', done: 'done', complete: 'done', completed: 'done' };
  if (!statuses[key]) throw new Error(`unknown status “${value}”`);
  return statuses[key];
}

function priorityOf(value) {
  const key = text(value).toLowerCase() || 'medium';
  if (!['low', 'medium', 'high'].includes(key)) throw new Error(`unknown priority “${value}”`);
  return key;
}

/** Read an Excel/CSV task sheet and resolve human names before sending validated IDs. */
export async function readTaskSpreadsheet(file, { projects, team, defaultProjectId }) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a spreadsheet smaller than 5 MB');
  const rows = await rowsFrom(file);
  if (rows.length < 2) throw new Error('The spreadsheet needs a header row and at least one task');
  const columns = {};
  rows[0].forEach((header, index) => {
    const field = fieldFor.get(cleanHeader(header));
    if (field && columns[field] === undefined) columns[field] = index;
  });
  if (columns.title === undefined) throw new Error('Add a “Task” or “Title” column to the spreadsheet');

  const projectByName = new Map(projects.map((project) => [project.name.toLowerCase(), project]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const peopleByAddress = new Map(team.map((person) => [person.address.toLowerCase(), person]));
  const peopleByName = new Map();
  team.forEach((person) => {
    if (person.name) {
      const key = person.name.trim().toLowerCase();
      peopleByName.set(key, peopleByName.has(key) ? null : person);
    }
  });
  const tasks = [];
  const errors = [];
  rows.slice(1).forEach((row, index) => {
    if (!row.some((cell) => text(cell))) return;
    try {
      const title = text(row[columns.title]);
      if (!title) throw new Error('task title is empty');
      const projectValue = columns.project === undefined ? '' : text(row[columns.project]);
      const parent = projectValue ? projectById.get(projectValue) || projectByName.get(projectValue.toLowerCase()) : projectById.get(defaultProjectId);
      if (!parent) throw new Error(projectValue ? `project “${projectValue}” was not found` : 'project is empty');
      const assigneeValue = columns.assignee === undefined ? '' : text(row[columns.assignee]);
      let person = null;
      if (assigneeValue) {
        person = peopleByAddress.get(assigneeValue.toLowerCase()) || peopleByName.get(assigneeValue.toLowerCase());
        if (!person) throw new Error(`assignee “${assigneeValue}” was not found or is ambiguous; use their email address`);
      }
      tasks.push({
        title,
        projectId: parent.id,
        assignee: person?.address || '',
        priority: priorityOf(columns.priority === undefined ? '' : row[columns.priority]),
        status: statusOf(columns.status === undefined ? '' : row[columns.status]),
        dueDate: isoDate(columns.dueDate === undefined ? '' : row[columns.dueDate]),
        description: columns.description === undefined ? '' : text(row[columns.description]),
      });
    } catch (err) {
      errors.push(`Row ${index + 2}: ${err.message}`);
    }
  });
  if (errors.length) throw new Error(`${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n…and ${errors.length - 5} more` : ''}`);
  if (!tasks.length) throw new Error('No task rows were found in the spreadsheet');
  if (tasks.length > 500) throw new Error('A spreadsheet can import at most 500 tasks at once');
  return tasks;
}

export function downloadTaskTemplate(projectName = '', assignee = '') {
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    ['Task', 'Project', 'Assignee', 'Priority', 'Status', 'Due date', 'Description'],
    ['Prepare project update', projectName, assignee, 'high', 'To do', new Date().toISOString().slice(0, 10), 'Add task details here'],
  ];
  const blob = new Blob([rows.map((row) => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aliasmail-task-import-template.csv';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
