// Automations: someone describes an idea, the AI model answers with the list of functions needed
// (assistant.js, planAutomation), the person reviews the list, and the functions run in order. The
// model can only choose from the functions below: generated JavaScript, URLs and arbitrary backend
// calls are never accepted. Every list is checked here before it is saved and again before it runs.
//
// An automation can also start by itself when an email arrives. The model is only asked once, when
// the automation is made: incoming mail never reaches it, so an email can't talk it into anything,
// and text from an email only ever fills in the values of steps already chosen.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { createTask, taskStore } from './routes/tasks.js';
import { createNote } from './instant-notes.js';
import { createNotification } from './notifications.js';
import { teammates } from './team.js';
import { isVisibleTo } from './aliases.js';
import { mailEvents } from './mail-events.js';

const MAX_AUTOMATIONS = 100;
const MAX_STEPS = 12;
const ACTIONS = new Set(['create_task', 'send_note', 'create_draft', 'notify_user']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;
// What can be asked for when an automation runs.
const INPUTS = { text: 'details', name: 'a name', email: 'an email address' };
// What a step can use from the email that started it.
const EMAIL_VALUES = ['email.from', 'email.fromName', 'email.subject', 'email.snippet'];
const EMAIL_TRIGGER = 'email_received';
const FRESH_MS = 30 * 60e3; // Only mail that has just arrived, not old mail found by a sync.
const MAX_BATCH = 50; // More at once than this is a mailbox being imported, not new mail.
const MAX_RUNS_PER_HOUR = 30; // Past this something is wrong, like a flood of mail: switch it off.
const IGNORED_CATEGORIES = new Set(['promotions', 'social']);

export const actionCatalog = [
  { action: 'create_task', description: 'Create a task in an existing project', fields: ['projectId', 'title', 'description?', 'assignee?', 'priority?', 'dueDate?'] },
  { action: 'send_note', description: 'Send an internal instant note to a teammate', fields: ['to', 'text'] },
  { action: 'create_draft', description: 'Create an email draft for the workflow owner', fields: ['to', 'subject', 'body', 'cc?'] },
  { action: 'notify_user', description: 'Create a Nextspace notification for a teammate', fields: ['to', 'title', 'body?'] },
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

const hasVariable = (value) => /\{\{/.test(String(value));

/** The {{…}} values a step uses; anything unknown would otherwise quietly come out blank. */
function checkVariables(step, index, trigger) {
  for (const value of Object.values(step.params)) {
    for (const [, name] of String(value).matchAll(VARIABLE)) {
      const earlier = /^steps\.(\d+)\.(id|title|subject)$/.exec(name);
      // Nobody is there to type anything when an email starts it, and no email when someone does.
      const known = trigger.type === EMAIL_TRIGGER
        ? EMAIL_VALUES.includes(name) || ['actor.email', 'automation.name'].includes(name)
        : (name.startsWith('input.') && name.slice(6) in INPUTS) || ['actor.email', 'automation.name'].includes(name);
      if (!known && !(earlier && Number(earlier[1]) >= 1 && Number(earlier[1]) <= index)) {
        throw new HttpError(400, `Step ${index + 1} uses an unknown value: ${name}`);
      }
    }
  }
}

/** Do the projects and people a step names exist? Values filled in at run time are checked then. */
function checkTargets(step, index, { team, projects }) {
  const where = `Step ${index + 1}`;
  const isTeammate = (value) => hasVariable(value) || team.some((person) => person.address === String(value).trim().toLowerCase());
  const { params } = step;
  if (step.action === 'create_task') {
    if (!projects.some((project) => project.id === params.projectId)) throw new HttpError(400, `${where} uses a project that doesn’t exist`);
    if (params.assignee && !isTeammate(params.assignee)) throw new HttpError(400, `${where} assigns the task to someone who isn’t on the team: ${params.assignee}`);
    if (params.dueDate && !hasVariable(params.dueDate) && !DATE.test(params.dueDate)) throw new HttpError(400, `${where} needs its due date as YYYY-MM-DD`);
  } else if (step.action === 'send_note' || step.action === 'notify_user') {
    if (!isTeammate(params.to)) throw new HttpError(400, `${where} is for someone who isn’t on the team: ${params.to}`);
  } else if (step.action === 'create_draft') {
    const bad = params.to.split(',').map((value) => value.trim()).find((value) => !hasVariable(value) && !EMAIL.test(value));
    if (bad !== undefined) throw new HttpError(400, `${where} has an invalid email address: ${bad || '(blank)'}`);
  }
}

/** Which details the person must give when this runs, from the steps that use them. */
export function inputsOf(steps) {
  const found = new Set();
  for (const step of steps) {
    for (const value of Object.values(step.params || {})) {
      for (const [, name] of String(value).matchAll(VARIABLE)) if (name.startsWith('input.')) found.add(name.slice(6));
    }
  }
  return Object.keys(INPUTS).filter((key) => found.has(key));
}

function triggerFrom(value) {
  if (!value || value.type === 'manual') return { type: 'manual' };
  if (value.type !== EMAIL_TRIGGER) throw new HttpError(400, `Unsupported trigger: ${short(value.type, 40, 'Trigger', false)}`);
  return { type: EMAIL_TRIGGER, fromContains: short(value.fromContains, 200, 'Sender', false), subjectContains: short(value.subjectContains, 200, 'Subject', false) };
}

export function validateAutomationPlan(value, context = planningContext()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The AI did not return a valid automation');
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new HttpError(400, `An automation needs 1 to ${MAX_STEPS} steps`);
  const trigger = triggerFrom(value.trigger);
  return {
    name: short(value.name, 100, 'Automation name'),
    description: short(value.description, 500, 'Description', false),
    trigger,
    steps: steps.map((step, index) => {
      const action = short(step?.action, 40, `Step ${index + 1} function`);
      if (!ACTIONS.has(action)) throw new HttpError(400, `Step ${index + 1} uses an unsupported function: ${action}`);
      const checked = { id: crypto.randomUUID(), action, label: short(step?.label || action.replaceAll('_', ' '), 100, 'Step label'), params: paramsFor(action, step?.params) };
      checkVariables(checked, index, trigger);
      checkTargets(checked, index, context);
      return checked;
    }),
  };
}

export const automationsFor = (owner) => store().items.filter((item) => item.owner === owner);

export function automationFor(owner, id) {
  const item = automationsFor(owner).find((automation) => automation.id === id);
  if (!item) throw new HttpError(404, 'Automation not found');
  return item;
}

export function createAutomation(owner, input) {
  if (automationsFor(owner).length >= MAX_AUTOMATIONS) throw new HttpError(400, `You can keep up to ${MAX_AUTOMATIONS} automations`);
  const plan = validateAutomationPlan(input?.plan);
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), owner, prompt: template(input?.prompt, 5000, 'Description'), ...plan, enabled: plan.trigger.type === 'manual' || input?.enabled === true, version: 1, createdAt: now, updatedAt: now };
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
  return String(value ?? '').replace(VARIABLE, (_, path) => {
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
  const context = { input, actor: { email: actor }, automation: { id: automation.id, name: automation.name }, steps: {}, email: run.trigger || {} };
  try {
    for (const [index, step] of automation.steps.entries()) {
      const entry = { stepId: step.id, action: step.action, label: step.label, status: 'running', startedAt: new Date().toISOString() };
      run.steps.push(entry); save();
      try {
        const result = await executeStep(step, context);
        entry.status = 'completed'; entry.result = result?.id ? { id: result.id } : { ok: true };
        // Later steps can use what this one made, like the title of a new task.
        context.steps[index + 1] = { id: result?.id, title: result?.title, subject: result?.subject };
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
    // The rest don't run: each step can depend on the one before it.
    for (const step of automation.steps.slice(run.steps.length)) run.steps.push({ stepId: step.id, action: step.action, label: step.label, status: 'skipped' });
  }
  run.finishedAt = new Date().toISOString();
  save();
  // Nobody is watching a run that started by itself, so say when one goes wrong.
  if (run.status === 'failed' && run.trigger) {
    createNotification({ to: actor, type: 'automation', title: `“${automation.name}” stopped`, body: run.error, entity: { kind: 'automation', id: automation.id }, actor });
  }
}

export function startAutomation(owner, id, input = {}) {
  const automation = automationFor(owner, id);
  if (automation.trigger?.type === EMAIL_TRIGGER) throw new HttpError(400, 'This automation runs by itself when an email arrives');
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (JSON.stringify(given).length > 20_000) throw new HttpError(400, 'Automation input is too large');
  const values = Object.fromEntries(Object.keys(INPUTS).filter((key) => given[key] != null).map((key) => [key, String(given[key]).trim()]));
  for (const key of inputsOf(automation.steps)) {
    if (!values[key]) throw new HttpError(400, `This automation needs ${INPUTS[key]} to run`);
  }
  if (values.email && !EMAIL.test(values.email)) throw new HttpError(400, 'Enter a valid email address');
  // A project or teammate may have gone since this was saved: find out before any step runs.
  const context = planningContext();
  automation.steps.forEach((step, index) => checkTargets(step, index, context));
  return queueRun(automation, owner, values);
}

function queueRun(automation, owner, values, trigger = null) {
  const run = { id: crypto.randomUUID(), automationId: automation.id, automationName: automation.name, owner, status: 'queued', input: values, trigger, steps: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: '' };
  store().runs.push(run);
  if (store().runs.length > 1000) store().runs.splice(0, store().runs.length - 1000);
  save();
  setImmediate(() => execute(run, automation, owner, values));
  return run;
}

/** Does this email meet the automation's conditions? */
function emailMatches(trigger, mail) {
  const contains = (text, wanted) => !wanted || String(text || '').toLowerCase().includes(wanted.toLowerCase());
  return contains(`${mail.from?.name || ''} ${mail.from?.address || ''}`, trigger.fromContains) && contains(mail.subject, trigger.subjectContains);
}

/** New mail has arrived: start the automations it's for. */
export function runEmailAutomations(records) {
  const now = Date.now();
  const fresh = records.filter((mail) => now - Date.parse(mail.arrivedAt || mail.date) < FRESH_MS);
  if (!fresh.length || fresh.length > MAX_BATCH) return;
  for (const automation of store().items) {
    if (!automation.enabled || automation.trigger?.type !== EMAIL_TRIGGER) continue;
    const { owner } = automation;
    for (const mail of fresh) {
      // Their own mail is skipped so that nothing can ever set itself off.
      if (mail.from?.address === owner || IGNORED_CATEGORIES.has(mail.category) || !isVisibleTo(mail, owner)) continue;
      if (!emailMatches(automation.trigger, mail)) continue;
      const key = mail.messageId || `uid:${mail.uid}`;
      const earlier = store().runs.filter((run) => run.automationId === automation.id && run.trigger);
      if (earlier.some((run) => run.trigger.key === key)) continue;
      if (earlier.filter((run) => now - Date.parse(run.createdAt) < 3600e3).length >= MAX_RUNS_PER_HOUR) {
        automation.enabled = false;
        save();
        createNotification({
          to: owner, type: 'automation', title: `“${automation.name}” was turned off`,
          body: `It ran ${MAX_RUNS_PER_HOUR} times in an hour, which is more than expected. Check it, then turn it back on.`,
          entity: { kind: 'automation', id: automation.id }, actor: owner,
        });
        break;
      }
      queueRun(automation, owner, {}, {
        type: 'email', key, from: mail.from?.address || '', fromName: mail.from?.name || mail.from?.address || '',
        subject: String(mail.subject || ''), snippet: String(mail.snippet || ''),
      });
    }
  }
}

let listening = false;
/** Listen for new mail (once, at startup). A problem here must never disturb the mail sync. */
export function startEmailAutomations() {
  if (listening) return;
  listening = true;
  mailEvents.on('arrived', (records) => {
    try {
      runEmailAutomations(records);
    } catch (err) {
      console.error('[automations] couldn’t start from new mail:', err.message);
    }
  });
}

export const runsFor = (owner, automationId) => store().runs.filter((run) => run.owner === owner && (!automationId || run.automationId === automationId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function planningContext() {
  return { team: teammates().map(({ address, name }) => ({ address, name })), projects: taskStore().projects.map(({ id, name }) => ({ id, name })), actions: actionCatalog };
}
