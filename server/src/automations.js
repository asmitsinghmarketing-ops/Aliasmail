// User-built workflow automations. AI may propose this data, but execution is limited to the
// functions below: generated JavaScript, URLs and arbitrary backend calls are never accepted.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { createTask, taskStore } from './routes/tasks.js';
import { createNote } from './instant-notes.js';
import { createNotification } from './notifications.js';
import { teammates } from './team.js';

const MAX_AUTOMATIONS = 100;
const MAX_STEPS = 12;
const ACTIONS = new Set(['create_task', 'send_note', 'create_draft', 'notify_user']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const actionCatalog = [
  { action: 'create_task', description: 'Create a task in an existing project', fields: ['projectId', 'title', 'description?', 'assignee?', 'priority?', 'dueDate?'] },
  { action: 'send_note', description: 'Send an internal instant note to a teammate', fields: ['to', 'text'] },
  { action: 'create_draft', description: 'Create an email draft for the workflow owner', fields: ['to', 'subject', 'body', 'cc?'] },
  { action: 'notify_user', description: 'Create an AliasMail notification for a teammate', fields: ['to', 'title', 'body?'] },
];

function store() {
  const data = (db().automations ||= {});
  data.items ||= [];
  data.runs ||= [];
  return data;
}

const short = (value, max, field, required = true) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (required && !text) throw new HttpError(400, `${field} is required`);
  return text;
};
const template = (value, max, field, required = true) => {
  const text = String(value ?? '').trim().slice(0, max);
  if (required && !text) throw new HttpError(400, `${field} is required`);
  return text;
};

function paramsFor(action, input) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (action === 'create_task') return {
    projectId: short(p.projectId, 80, 'Project'), title: template(p.title, 200, 'Task title'),
    description: template(p.description, 10_000, 'Description', false), assignee: short(p.assignee, 200, 'Assignee', false),
    priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium', dueDate: short(p.dueDate, 20, 'Due date', false),
  };
  if (action === 'send_note') return { to: short(p.to, 200, 'Recipient'), text: template(p.text, 4000, 'Note') };
  if (action === 'create_draft') return {
    to: template(p.to, 2000, 'Recipient'), cc: template(p.cc, 2000, 'Cc', false),
    subject: template(p.subject, 300, 'Subject', false), body: template(p.body, 20_000, 'Body'),
  };
  if (action === 'notify_user') return {
    to: short(p.to, 200, 'Recipient'), title: template(p.title, 160, 'Notification title'), body: template(p.body, 500, 'Notification body', false),
  };
  throw new HttpError(400, `Unsupported automation function: ${action}`);
}

export function validateAutomationPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The AI did not return a valid automation');
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new HttpError(400, `An automation needs 1 to ${MAX_STEPS} steps`);
  return {
    name: short(value.name, 100, 'Automation name'),
    description: short(value.description, 500, 'Description', false),
    trigger: { type: 'manual' },
    steps: steps.map((step, index) => {
      const action = short(step?.action, 40, `Step ${index + 1} function`);
      if (!ACTIONS.has(action)) throw new HttpError(400, `Step ${index + 1} uses an unsupported function: ${action}`);
      return { id: crypto.randomUUID(), action, label: short(step?.label || action.replaceAll('_', ' '), 100, 'Step label'), params: paramsFor(action, step?.params) };
    }),
  };
}

export const automationsFor = (owner) => store().items.filter((item) => item.owner === owner);

export function automationFor(owner, id, { enabled = false } = {}) {
  const item = automationsFor(owner).find((automation) => automation.id === id);
  if (!item || (enabled && !item.enabled)) throw new HttpError(404, enabled ? 'Active automation not found' : 'Automation not found');
  return item;
}

export function createAutomation(owner, input) {
  if (automationsFor(owner).length >= MAX_AUTOMATIONS) throw new HttpError(400, `You can keep up to ${MAX_AUTOMATIONS} automations`);
  const plan = validateAutomationPlan(input?.plan);
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), owner, prompt: template(input?.prompt, 5000, 'Description'), ...plan, enabled: false, version: 1, createdAt: now, updatedAt: now };
  store().items.push(item);
  save();
  return item;
}

export function updateAutomation(owner, id, input) {
  const item = automationFor(owner, id);
  if (typeof input?.enabled === 'boolean') item.enabled = input.enabled;
  if (input?.name !== undefined) item.name = short(input.name, 100, 'Automation name');
  if (input?.description !== undefined) item.description = short(input.description, 500, 'Description', false);
  item.updatedAt = new Date().toISOString();
  item.version += 1;
  save();
  return item;
}

export function deleteAutomation(owner, id) {
  const item = automationFor(owner, id);
  store().items.splice(store().items.indexOf(item), 1);
  save();
}

const pathValue = (source, path) => path.split('.').reduce((value, key) => value?.[key], source);
function render(value, context) {
  return String(value ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path) => {
    const replacement = pathValue(context, path);
    return replacement == null ? '' : String(replacement);
  });
}
const rendered = (params, context) => Object.fromEntries(Object.entries(params).map(([key, value]) => [key, render(value, context)]));
const teamAddress = (value) => teammates().find((person) => person.address === String(value).trim().toLowerCase())?.address;

async function executeStep(step, context) {
  const params = rendered(step.params, context);
  if (step.action === 'create_task') return createTask(params, context.actor.email);
  if (step.action === 'send_note') return createNote(context.actor.email, { to: params.to, text: params.text, files: [] });
  if (step.action === 'create_draft') {
    const recipients = params.to.split(',').map((value) => value.trim()).filter(Boolean);
    if (!recipients.length || recipients.some((address) => !EMAIL.test(address))) throw new HttpError(400, 'Draft recipients must be valid email addresses');
    const now = new Date().toISOString();
    const draft = { id: crypto.randomUUID(), alias: context.actor.email, to: recipients.join(', '), cc: params.cc, bcc: '', subject: params.subject, text: params.body, html: '', inReplyTo: '', references: [], updatedAt: now };
    db().drafts.push(draft);
    save();
    return { id: draft.id, subject: draft.subject };
  }
  if (step.action === 'notify_user') {
    const to = teamAddress(params.to);
    if (!to) throw new HttpError(400, `${params.to} is not an active teammate`);
    return createNotification({ to, type: 'automation', title: params.title, body: params.body, entity: { kind: 'automation', id: context.automation.id }, actor: context.actor.email });
  }
  throw new HttpError(400, `Unsupported automation function: ${step.action}`);
}

async function execute(run, automation, actor, input) {
  run.status = 'running'; run.startedAt = new Date().toISOString(); save();
  const context = { input, actor: { email: actor }, automation: { id: automation.id, name: automation.name } };
  try {
    for (const step of automation.steps) {
      const entry = { stepId: step.id, action: step.action, label: step.label, status: 'running', startedAt: new Date().toISOString() };
      run.steps.push(entry); save();
      try {
        const result = await executeStep(step, context);
        entry.status = 'completed'; entry.result = result?.id ? { id: result.id } : { ok: true };
      } catch (error) {
        entry.status = 'failed'; entry.error = String(error.message || error).slice(0, 500);
        throw error;
      } finally {
        entry.finishedAt = new Date().toISOString(); save();
      }
    }
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed'; run.error = String(error.message || error).slice(0, 500);
  }
  run.finishedAt = new Date().toISOString();
  save();
}

export function startAutomation(owner, id, input = {}) {
  const automation = automationFor(owner, id, { enabled: true });
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (JSON.stringify(values).length > 20_000) throw new HttpError(400, 'Automation input is too large');
  const run = { id: crypto.randomUUID(), automationId: automation.id, automationName: automation.name, owner, status: 'queued', input: values, steps: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: '' };
  store().runs.push(run);
  if (store().runs.length > 1000) store().runs.splice(0, store().runs.length - 1000);
  save();
  setImmediate(() => execute(run, automation, owner, values));
  return run;
}

export const runsFor = (owner, automationId) => store().runs.filter((run) => run.owner === owner && (!automationId || run.automationId === automationId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function planningContext() {
  return { team: teammates().map(({ address, name }) => ({ address, name })), projects: taskStore().projects.map(({ id, name }) => ({ id, name })), actions: actionCatalog };
}
