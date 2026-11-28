// Shared team task management: projects, tasks and a compact activity trail.
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { db, save } from '../store.js';
import { HttpError } from '../errors.js';
import { nameOf, personOf, teammates } from '../team.js';
import { createNotification } from '../notifications.js';

const router = Router();
router.use(requireAuth());

const STATUSES = new Set(['backlog', 'todo', 'doing', 'done']);
const PRIORITIES = new Set(['low', 'medium', 'high']);
const COLORS = new Set(['#0b5cd5', '#7048e8', '#d6336c', '#e8590c', '#2b8a3e', '#0c8599', '#495057']);

export function taskStore() {
  const tasks = (db().tasks ||= {});
  tasks.projects ||= [];
  tasks.items ||= [];
  tasks.activity ||= [];
  return tasks;
}
const store = taskStore;

const clean = (value, max, field, required = false) => {
  const result = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && !result) throw new HttpError(400, `${field} is required`);
  return result.slice(0, max);
};
const longText = (value, max) => String(value ?? '').trim().slice(0, max);

function dueDate(value) {
  if (value == null || value === '') return null;
  const date = String(value);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  return date;
}

// A checklist is replaced as a whole: the client always sends the full list it shows.
function checklist(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Checklist must be a list');
  if (value.length > 50) throw new HttpError(400, 'A checklist can have at most 50 items');
  return value
    .map((step) => ({ id: typeof step?.id === 'string' && step.id ? step.id.slice(0, 80) : crypto.randomUUID(), text: clean(step?.text, 200, 'Checklist item'), done: Boolean(step?.done) }))
    .filter((step) => step.text);
}

/** Older tasks were saved before checklists and comments existed. */
const shaped = (item) => ({ ...item, checklist: item.checklist || [], comments: item.comments || [] });

function project(id) {
  const found = store().projects.find((p) => p.id === id);
  if (!found) throw new HttpError(404, 'Project not found');
  return found;
}

function task(id) {
  const found = store().items.find((item) => item.id === id);
  if (!found) throw new HttpError(404, 'Task not found');
  return found;
}

function canManageProject(req, found) {
  if (req.user.role !== 'admin' && found.createdBy !== personOf(req.user)) throw new HttpError(403, 'Only the project creator or an admin can change this project');
}

function assignee(value) {
  if (value == null || value === '') return null;
  const address = String(value).trim().toLowerCase();
  if (!teammates().some((person) => person.address === address)) throw new HttpError(400, 'Assignee is not an active teammate');
  return address;
}

function notifyAssignment(item, actor) {
  if (!item.assignee || item.assignee === actor) return;
  createNotification({
    to: item.assignee,
    type: 'task-assigned',
    title: 'Task assigned to you',
    body: `${nameOf(actor)} assigned “${item.title}” to you.`,
    entity: { kind: 'task', id: item.id, projectId: item.projectId },
    actor,
  });
}

function activity(actor, action, item, detail = '') {
  const list = store().activity;
  list.push({ id: crypto.randomUUID(), actor, action, taskId: item?.id || null, projectId: item?.projectId || item?.id || null, detail: String(detail).slice(0, 300), at: new Date().toISOString() });
  if (list.length > 500) list.splice(0, list.length - 500);
}

function makeTask(input, actor, now = new Date().toISOString()) {
  const parent = project(clean(input?.projectId, 80, 'Project', true));
  const status = STATUSES.has(input?.status) ? input.status : 'todo';
  const priority = PRIORITIES.has(input?.priority) ? input.priority : 'medium';
  return {
    id: crypto.randomUUID(),
    projectId: parent.id,
    title: clean(input?.title, 200, 'Task title', true),
    description: longText(input?.description, 10000),
    status,
    priority,
    assignee: assignee(input?.assignee),
    dueDate: dueDate(input?.dueDate),
    checklist: checklist(input?.checklist),
    comments: [],
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : null,
  };
}

function recordCreated(created) {
  store().items.push(created);
  activity(created.createdBy, 'task-created', created, created.title);
  notifyAssignment(created, created.createdBy);
}

/** Create a task through the same validation, activity and notification path as the Tasks UI. */
export function createTask(input, actor) {
  const created = makeTask(input, actor);
  recordCreated(created);
  save();
  return created;
}

router.get('/', (req, res) => {
  const data = store();
  res.json({
    me: personOf(req.user),
    team: teammates(),
    projects: [...data.projects].sort((a, b) => a.name.localeCompare(b.name)),
    tasks: data.items.map(shaped).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activity: data.activity.slice(-100).reverse(),
  });
});

router.post('/projects', (req, res) => {
  const name = clean(req.body?.name, 80, 'Project name', true);
  if (store().projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'A project with that name already exists');
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    name,
    description: longText(req.body?.description, 1000),
    color: COLORS.has(req.body?.color) ? req.body.color : '#0b5cd5',
    createdBy: personOf(req.user),
    createdAt: now,
    updatedAt: now,
  };
  store().projects.push(created);
  activity(created.createdBy, 'project-created', created, created.name);
  save();
  res.status(201).json(created);
});

router.patch('/projects/:id', (req, res) => {
  const found = project(req.params.id);
  canManageProject(req, found);
  if (req.body?.name !== undefined) {
    const name = clean(req.body.name, 80, 'Project name', true);
    if (store().projects.some((p) => p.id !== found.id && p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'A project with that name already exists');
    found.name = name;
  }
  if (req.body?.description !== undefined) found.description = longText(req.body.description, 1000);
  if (req.body?.color !== undefined) {
    if (!COLORS.has(req.body.color)) throw new HttpError(400, 'Choose a supported project color');
    found.color = req.body.color;
  }
  found.updatedAt = new Date().toISOString();
  activity(personOf(req.user), 'project-updated', found, found.name);
  save();
  res.json(found);
});

router.delete('/projects/:id', (req, res) => {
  const found = project(req.params.id);
  canManageProject(req, found);
  const data = store();
  const removed = data.items.filter((item) => item.projectId === found.id).length;
  data.items = data.items.filter((item) => item.projectId !== found.id);
  data.projects.splice(data.projects.indexOf(found), 1);
  activity(personOf(req.user), 'project-deleted', found, `${found.name}; ${removed} task(s)`);
  save();
  res.json({ ok: true, removedTasks: removed });
});

router.post('/items', (req, res) => {
  const created = createTask(req.body, personOf(req.user));
  res.status(201).json(created);
});

// Spreadsheet rows are validated as one batch before anything is written, so a bad row never
// leaves the workspace half-imported. The browser resolves project/person names to IDs/emails.
router.post('/items/import', (req, res) => {
  const rows = req.body?.tasks;
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Choose a spreadsheet containing at least one task');
  if (rows.length > 500) throw new HttpError(400, 'A spreadsheet can import at most 500 tasks at once');
  const actor = personOf(req.user);
  const now = new Date().toISOString();
  const created = rows.map((row, index) => {
    try {
      return makeTask(row, actor, now);
    } catch (err) {
      throw new HttpError(err.status || 400, `Row ${index + 2}: ${err.message || 'Invalid task'}`);
    }
  });
  created.forEach(recordCreated);
  save();
  res.status(201).json({ imported: created.length, tasks: created });
});

/** Change a task, with the same checks, activity and notifications as the Tasks screen. */
export function updateTask(id, body, actor) {
  const found = task(id);
  const beforeStatus = found.status;
  const beforeAssignee = found.assignee;
  if (body?.projectId !== undefined) found.projectId = project(clean(body.projectId, 80, 'Project', true)).id;
  if (body?.title !== undefined) found.title = clean(body.title, 200, 'Task title', true);
  if (body?.description !== undefined) found.description = longText(body.description, 10000);
  if (body?.status !== undefined) {
    if (!STATUSES.has(body.status)) throw new HttpError(400, 'Unknown task status');
    found.status = body.status;
  }
  if (body?.priority !== undefined) {
    if (!PRIORITIES.has(body.priority)) throw new HttpError(400, 'Unknown task priority');
    found.priority = body.priority;
  }
  if (body?.assignee !== undefined) found.assignee = assignee(body.assignee);
  if (body?.dueDate !== undefined) found.dueDate = dueDate(body.dueDate);
  if (body?.checklist !== undefined) found.checklist = checklist(body.checklist);
  found.updatedAt = new Date().toISOString();
  if (found.status === 'done' && beforeStatus !== 'done') found.completedAt = found.updatedAt;
  if (found.status !== 'done') found.completedAt = null;
  activity(actor, beforeStatus !== found.status ? 'task-status' : 'task-updated', found, found.title);
  if (found.assignee !== beforeAssignee) notifyAssignment(found, actor);
  if (found.status === 'done' && beforeStatus !== 'done' && found.createdBy !== actor) {
    createNotification({
      to: found.createdBy,
      type: 'task-completed',
      title: 'Task completed',
      body: `${nameOf(actor)} completed “${found.title}”.`,
      entity: { kind: 'task', id: found.id, projectId: found.projectId },
      actor,
    });
  }
  save();
  return shaped(found);
}

router.patch('/items/:id', (req, res) => res.json(updateTask(req.params.id, req.body, personOf(req.user))));

router.post('/items/:id/comments', (req, res) => {
  const found = task(req.params.id);
  const author = personOf(req.user);
  const text = longText(req.body?.text, 4000);
  if (!text) throw new HttpError(400, 'Write a comment first');
  found.comments ||= [];
  if (found.comments.length >= 200) throw new HttpError(400, 'This task has reached its comment limit');
  const comment = { id: crypto.randomUUID(), author, text, at: new Date().toISOString() };
  found.comments.push(comment);
  found.updatedAt = comment.at;
  activity(author, 'task-comment', found, found.title);
  for (const to of new Set([found.assignee, found.createdBy])) {
    if (!to || to === author) continue;
    createNotification({ to, type: 'task-comment', title: 'New comment on a task', body: `${nameOf(author)} on “${found.title}”: ${text.slice(0, 140)}`, entity: { kind: 'task', id: found.id, projectId: found.projectId }, actor: author });
  }
  save();
  res.status(201).json(shaped(found));
});

router.delete('/items/:id/comments/:commentId', (req, res) => {
  const found = task(req.params.id);
  const index = (found.comments || []).findIndex((comment) => comment.id === req.params.commentId);
  if (index < 0) throw new HttpError(404, 'Comment not found');
  if (req.user.role !== 'admin' && found.comments[index].author !== personOf(req.user)) throw new HttpError(403, 'You can only delete your own comments');
  found.comments.splice(index, 1);
  save();
  res.json(shaped(found));
});

router.delete('/items/:id', (req, res) => {
  const found = task(req.params.id);
  const data = store();
  data.items.splice(data.items.indexOf(found), 1);
  activity(personOf(req.user), 'task-deleted', found, found.title);
  save();
  res.json({ ok: true });
});

export default router;
