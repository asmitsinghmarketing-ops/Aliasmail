// Automations: someone describes an idea, the AI model answers with the list of functions needed
// (assistant.js, planAutomation), the person reviews the list, and the functions run in order. The
// model can only choose from the functions in automation-functions.js: generated JavaScript, URLs
// and arbitrary backend calls are never accepted. Every list is checked here before it is saved,
// and again before it runs.
//
// An automation starts when its owner runs it, when an email arrives, or on a schedule. The model
// is only asked once, when the automation is made. Incoming mail never reaches it then, and text
// from an email or an AI step only ever fills in text: never who or what a step acts on.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { taskStore } from './routes/tasks.js';
import { groups } from './instant-notes.js';
import { createNotification } from './notifications.js';
import { teammates } from './team.js';
import { isVisibleTo } from './aliases.js';
import { mailEvents } from './mail-events.js';
import { mailTools } from './routes/mail.js';
import { EMAIL, EMAIL_KINDS, FUNCTIONS, catalogForPlanner, catalogForScreen, resolveDate, runContext } from './automation-functions.js';

export { EMAIL_KINDS };

const MAX_AUTOMATIONS = 100;
const MAX_STEPS = 12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;
// What can be asked for when someone runs an automation themselves.
const INPUTS = { text: 'details', name: 'a name', email: 'an email address', kind: 'the type of email' };
// What a step can use from the email that started it.
const EMAIL_VALUES = ['email.id', 'email.from', 'email.fromName', 'email.subject', 'email.snippet'];
const STEP_VALUES = ['id', 'ids', 'count', 'text', 'value', 'title', 'subject'];
const EMAIL_TRIGGER = 'email_received';
const SCHEDULE = 'schedule';
const EVERY = ['hour', 'day', 'weekday', 'week'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FRESH_MS = 30 * 60e3; // Only mail that has just arrived, not old mail found by a sync.
const MAX_BATCH = 50; // More at once than this is a mailbox being imported, not new mail.
const MAX_RUNS_PER_HOUR = 30; // Past this something is wrong, like a flood of mail: switch it off.
const IGNORED_CATEGORIES = new Set(['promotions', 'social']);

/** Kept for anything that still asks for the list in its old shape. */
export const actionCatalog = catalogForPlanner();

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
const hasVariable = (value) => /\{\{/.test(String(value));
const variablesIn = (value) => [...String(value).matchAll(VARIABLE)].map(([, name]) => name);

/* ---------------------------------- checking a list of steps ---------------------------------- */

/** A step's fields, cleaned: unknown fields dropped, lengths capped, defaults filled in. */
function paramsFor(fn, input, where) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const params = {};
  for (const [name, field] of Object.entries(fn.fields)) {
    let value = p[name] ?? field.default ?? '';
    value = field.kind === 'text' ? String(value).trim().slice(0, field.max || 4000) : String(value).trim().slice(0, 2000);
    if (field.required && !value) throw new HttpError(400, `${where}: ${field.label} is required`);
    params[name] = value;
  }
  return params;
}

/** Which values a step may use, and in which fields: the heart of what keeps automations safe. */
function checkStep(step, index, { trigger, context, earlier }) {
  const where = `Step ${index + 1}`;
  const fn = FUNCTIONS[step.action];
  const produces = (n) => FUNCTIONS[earlier[n - 1]?.action]?.produces;
  const known = (name) => {
    if (['actor.email', 'automation.name'].includes(name)) return true;
    if (name.startsWith('input.')) return trigger.type === 'manual' && name.slice(6) in INPUTS;
    if (name.startsWith('email.')) return trigger.type === EMAIL_TRIGGER && EMAIL_VALUES.includes(name);
    const step_ = /^steps\.(\d+)\.(\w+)$/.exec(name);
    return Boolean(step_) && Number(step_[1]) >= 1 && Number(step_[1]) <= index && STEP_VALUES.includes(step_[2]);
  };
  for (const [name, field] of Object.entries(fn.fields)) {
    const value = step.params[name];
    if (!value) continue;
    const vars = variablesIn(value);
    const unknown = vars.find((v) => !known(v));
    if (unknown) throw new HttpError(400, `${where} uses an unknown value: ${unknown}`);
    const only = (allowed, message) => {
      const bad = vars.find((v) => !allowed(v));
      if (bad) throw new HttpError(400, `${where}: ${field.label} ${message}`);
    };
    switch (field.kind) {
      case 'text':
        if (field.noVariables && vars.length) throw new HttpError(400, `${where}: ${field.label} must be written out, not filled in`);
        break;
      case 'choice': {
        if (field.askable && value === `{{input.${field.askable}}}` && trigger.type === 'manual') break;
        if (!field.options.some((option) => option.value === value)) throw new HttpError(400, `${where}: ${field.label} can’t be “${value}”`);
        break;
      }
      case 'number': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < field.min || n > field.max) throw new HttpError(400, `${where}: ${field.label} must be a whole number from ${field.min} to ${field.max}`);
        break;
      }
      case 'date':
        if (!['today'].includes(value) && !/^\+\d{1,3}$/.test(value) && !DATE.test(value)) throw new HttpError(400, `${where}: ${field.label} must be YYYY-MM-DD, today or +N days`);
        break;
      // Who or what a step acts on: never text that an AI wrote or that came with an email.
      case 'teammate':
        only((v) => ['input.email', 'email.from'].includes(v), 'can only be a teammate, their address from the email, or one you enter');
        if (!vars.length && !context.team.some((person) => person.address === value.toLowerCase())) throw new HttpError(400, `${where}: ${value} isn’t on the team`);
        break;
      case 'emails': {
        only((v) => ['input.email', 'email.from'].includes(v), 'can only be email addresses, the sender’s, or one you enter');
        const bad = value.split(',').map((part) => part.trim()).find((part) => !hasVariable(part) && !EMAIL.test(part));
        if (bad !== undefined) throw new HttpError(400, `${where} has an invalid email address: ${bad || '(blank)'}`);
        break;
      }
      case 'project':
        if (vars.length || !context.projects.some((project) => project.id === value)) throw new HttpError(400, `${where} uses a project that doesn’t exist`);
        break;
      case 'label':
        if (vars.length || !context.labels.some((label) => label.toLowerCase() === value.toLowerCase())) throw new HttpError(400, `${where}: there’s no label called “${value}”`);
        break;
      case 'group':
        if (vars.length || !context.groups.some((group) => group.id === value)) throw new HttpError(400, `${where} uses a note group that doesn’t exist`);
        break;
      case 'messages': {
        const v = vars[0];
        const step_ = /^steps\.(\d+)\.(ids|id)$/.exec(v || '');
        const ok = vars.length === 1 && value === `{{${v}}}` && (v === 'email.id' || (step_ && produces(Number(step_[1])) === 'messages'));
        if (!ok) throw new HttpError(400, `${where}: ${field.label} must be the email that started it, or emails an earlier Find emails step found`);
        break;
      }
      case 'task': {
        const step_ = /^steps\.(\d+)\.id$/.exec(vars[0] || '');
        if (vars.length !== 1 || value !== `{{${vars[0]}}}` || !step_ || produces(Number(step_[1])) !== 'task') throw new HttpError(400, `${where}: ${field.label} must be a task an earlier step made`);
        break;
      }
      default:
        throw new HttpError(400, `${where}: unknown field`);
    }
  }
}

function triggerFrom(value) {
  if (!value || value.type === 'manual') return { type: 'manual' };
  if (value.type === EMAIL_TRIGGER) {
    return { type: EMAIL_TRIGGER, fromContains: short(value.fromContains, 200, 'Sender', false), subjectContains: short(value.subjectContains, 200, 'Subject', false) };
  }
  if (value.type === SCHEDULE) {
    const every = EVERY.includes(value.every) ? value.every : null;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time)) ? String(value.time) : null;
    if (!every || !time) throw new HttpError(400, 'A schedule needs how often (hour, day, weekday or week) and a time like 09:00');
    const day = every === 'week' ? String(value.day || '').toLowerCase().slice(0, 3) : '';
    if (every === 'week' && !DAYS.includes(day)) throw new HttpError(400, 'A weekly schedule needs a day');
    let timeZone = String(value.timeZone || 'UTC').slice(0, 60);
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = 'UTC'; }
    return { type: SCHEDULE, every, time, day, timeZone };
  }
  throw new HttpError(400, `Unsupported trigger: ${short(value.type, 40, 'Trigger', false)}`);
}

export function validateAutomationPlan(value, context = planningContext()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The AI did not return a valid automation');
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new HttpError(400, `An automation needs 1 to ${MAX_STEPS} steps`);
  const trigger = triggerFrom(value.trigger);
  const checked = [];
  for (const [index, step] of steps.entries()) {
    const action = short(step?.action, 40, `Step ${index + 1} function`);
    const fn = FUNCTIONS[action];
    if (!fn || !Object.hasOwn(FUNCTIONS, action)) throw new HttpError(400, `Step ${index + 1} uses an unsupported function: ${action}`);
    const next = { id: crypto.randomUUID(), action, label: short(step?.label || fn.label, 100, 'Step label'), params: paramsFor(fn, step?.params, `Step ${index + 1}`) };
    checkStep(next, index, { trigger, context, earlier: checked });
    checked.push(next);
  }
  return { name: short(value.name, 100, 'Automation name'), description: short(value.description, 500, 'Description', false), trigger, steps: checked };
}

/** Which details the person must give when they run it, from the steps that use them. */
export function inputsOf(steps) {
  const found = new Set();
  for (const step of steps) {
    const fn = FUNCTIONS[step.action];
    for (const [name, value] of Object.entries(step.params || {})) {
      if (fn?.fields[name]?.optionalInput) continue; // Something to mention is optional.
      for (const v of variablesIn(value)) if (v.startsWith('input.')) found.add(v.slice(6));
    }
  }
  return Object.keys(INPUTS).filter((key) => found.has(key));
}

/* ---------------------------------- saved automations ---------------------------------- */

export const automationsFor = (owner) => store().items.filter((item) => item.owner === owner);

export function automationFor(owner, id) {
  const item = automationsFor(owner).find((automation) => automation.id === id);
  if (!item) throw new HttpError(404, 'Automation not found');
  return item;
}

export function createAutomation(owner, input) {
  if (automationsFor(owner).length >= MAX_AUTOMATIONS) throw new HttpError(400, `You can keep up to ${MAX_AUTOMATIONS} automations`);
  const plan = validateAutomationPlan(input?.plan, planningContext(owner));
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(), owner, prompt: String(input?.prompt ?? '').trim().slice(0, 5000) || plan.name, ...plan,
    // One that starts by itself stays off until its owner turns it on.
    enabled: plan.trigger.type === 'manual' || input?.enabled === true, version: 1, createdAt: now, updatedAt: now,
  };
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

/* ---------------------------------- running ---------------------------------- */

const pathValue = (source, path) => path.split('.').reduce((value, key) => value?.[key], source);
const render = (value, context) => String(value ?? '').replace(VARIABLE, (_, path) => {
  const replacement = pathValue(context, path);
  return replacement == null ? '' : String(replacement);
});

class Stopped extends Error {}

async function execute(run, automation, owner, input) {
  run.status = 'running'; run.startedAt = new Date().toISOString(); save();
  const values = { input, actor: { email: owner }, automation: { id: automation.id, name: automation.name }, steps: {}, email: run.trigger?.type === 'email' ? run.trigger : {} };
  const made = [];
  const ctx = runContext({ owner, automationId: automation.id, automationName: automation.name, input, made });
  try {
    for (const [index, step] of automation.steps.entries()) {
      const fn = FUNCTIONS[step.action];
      const entry = { stepId: step.id, action: step.action, label: step.label, status: 'running', startedAt: new Date().toISOString() };
      run.steps.push(entry); save();
      try {
        if (!fn) throw new HttpError(400, `Unsupported automation function: ${step.action}`);
        const params = Object.fromEntries(Object.entries(step.params).map(([name, value]) => {
          const filled = render(value, values);
          return [name, fn.fields[name]?.kind === 'date' ? resolveDate(filled) : filled];
        }));
        const result = (await fn.run(params, ctx)) || {};
        entry.status = 'completed';
        entry.result = { ...(result.id && { id: result.id }), ...(result.count !== undefined && { count: result.count }), ...(result.value && { value: result.value }) };
        // Later steps can use what this one found or made.
        values.steps[index + 1] = { id: result.id, ids: result.ids ?? (result.id != null ? String(result.id) : ''), count: result.count, text: result.text, value: result.value, title: result.title, subject: result.subject };
        if (fn.stops && !result.passes) throw new Stopped();
      } catch (error) {
        if (error instanceof Stopped) {
          entry.note = 'The condition wasn’t met, so it stopped here.';
          throw error;
        }
        entry.status = 'failed'; entry.error = String(error.message || error).slice(0, 500);
        throw error;
      } finally {
        entry.finishedAt = new Date().toISOString(); save();
      }
    }
    run.status = 'completed';
  } catch (error) {
    if (error instanceof Stopped) {
      run.status = 'completed';
      run.stopped = true;
    } else {
      run.status = 'failed'; run.error = String(error.message || error).slice(0, 500);
    }
    // The rest don't run: each step can depend on the one before it.
    for (const step of automation.steps.slice(run.steps.length)) run.steps.push({ stepId: step.id, action: step.action, label: step.label, status: 'skipped' });
  }
  run.finishedAt = new Date().toISOString();
  save();
  // Started by itself: say when emails are ready to send, as nobody was watching.
  if (run.trigger && made.length) {
    createNotification({
      to: owner, type: 'work-items', title: made.length === 1 ? 'An email is ready to send' : `${made.length} emails are ready to send`,
      body: `“${automation.name}” prepared ${made.length === 1 ? 'it' : 'them'}. Check and send in Work items.`, entity: { kind: 'work' }, actor: owner,
    });
  }
  // Nobody is watching a run that started by itself, so say when one goes wrong.
  if (run.status === 'failed' && run.trigger) {
    createNotification({ to: owner, type: 'automation', title: `“${automation.name}” stopped`, body: run.error, entity: { kind: 'automation', id: automation.id }, actor: owner });
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
  if (values.kind && !EMAIL_KINDS[values.kind]) throw new HttpError(400, 'Choose a type of email');
  if (values.email && !EMAIL.test(values.email)) throw new HttpError(400, 'Enter a valid email address');
  preflight(automation);
  return queueRun(automation, owner, values);
}

/** A project, label, group or teammate may have gone since it was saved: find out before any step runs. */
function preflight(automation) {
  const context = planningContext(automation.owner);
  const checked = [];
  for (const [index, step] of automation.steps.entries()) {
    checkStep(step, index, { trigger: automation.trigger || { type: 'manual' }, context, earlier: checked });
    checked.push(step);
  }
}

function queueRun(automation, owner, values, trigger = null) {
  const run = { id: crypto.randomUUID(), automationId: automation.id, automationName: automation.name, owner, status: 'queued', input: values, trigger, steps: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: '' };
  store().runs.push(run);
  if (store().runs.length > 1000) store().runs.splice(0, store().runs.length - 1000);
  save();
  setImmediate(() => execute(run, automation, owner, values));
  return run;
}

/** Too many runs by itself in an hour: switch it off and say why. True if it was switched off. */
function tooBusy(automation, now) {
  const recent = store().runs.filter((run) => run.automationId === automation.id && run.trigger && now - Date.parse(run.createdAt) < 3600e3).length;
  if (recent < MAX_RUNS_PER_HOUR) return false;
  automation.enabled = false;
  save();
  createNotification({
    to: automation.owner, type: 'automation', title: `“${automation.name}” was turned off`,
    body: `It ran ${MAX_RUNS_PER_HOUR} times in an hour, which is more than expected. Check it, then turn it back on.`,
    entity: { kind: 'automation', id: automation.id }, actor: automation.owner,
  });
  return true;
}

/* ---------------------------------- when an email arrives ---------------------------------- */

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
      if (store().runs.some((run) => run.automationId === automation.id && run.trigger?.key === key)) continue;
      if (tooBusy(automation, now)) break;
      queueRun(automation, owner, {}, {
        type: 'email', key, id: mail.uid, from: mail.from?.address || '', fromName: mail.from?.name || mail.from?.address || '',
        subject: String(mail.subject || ''), snippet: String(mail.snippet || ''),
      });
    }
  }
}

/* ---------------------------------- on a schedule ---------------------------------- */

/** The minute it is now where the automation's owner is: { key, day, time, minute }. */
function localNow(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(now).map(({ type, value }) => [type, value]));
  const time = `${parts.hour}:${parts.minute}`;
  return { key: `${parts.year}-${parts.month}-${parts.day} ${time}`, day: parts.weekday.toLowerCase().slice(0, 3), time, minute: parts.minute };
}

/** Is it time? Checked every few seconds; each minute it's due runs it once. */
export function runScheduledAutomations(now = new Date()) {
  for (const automation of store().items) {
    const { trigger } = automation;
    if (!automation.enabled || trigger?.type !== SCHEDULE) continue;
    const local = localNow(now, trigger.timeZone || 'UTC');
    const due = trigger.every === 'hour'
      ? local.minute === trigger.time.slice(3)
      : local.time === trigger.time && (trigger.every === 'day' || (trigger.every === 'weekday' && !['sat', 'sun'].includes(local.day)) || (trigger.every === 'week' && local.day === trigger.day));
    if (!due || automation.lastScheduled === local.key) continue;
    automation.lastScheduled = local.key;
    save();
    // Still going from last time: let that one finish rather than pile up.
    if (store().runs.some((run) => run.automationId === automation.id && ['queued', 'running'].includes(run.status))) continue;
    if (tooBusy(automation, now.getTime())) continue;
    try {
      preflight(automation);
    } catch (err) {
      const run = queueRun({ ...automation, steps: [] }, automation.owner, {}, { type: 'schedule', key: local.key });
      run.status = 'failed';
      run.error = err.message;
      createNotification({ to: automation.owner, type: 'automation', title: `“${automation.name}” didn’t run`, body: err.message, entity: { kind: 'automation', id: automation.id }, actor: automation.owner });
      continue;
    }
    queueRun(automation, automation.owner, {}, { type: 'schedule', key: local.key });
  }
}

let listening = false;
/** Listen for new mail and keep time for schedules (once, at startup). A problem here must never disturb the mail sync. */
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
  setInterval(() => {
    try {
      runScheduledAutomations();
    } catch (err) {
      console.error('[automations] couldn’t check schedules:', err.message);
    }
  }, 15_000).unref?.();
}

export const runsFor = (owner, automationId) => store().runs.filter((run) => run.owner === owner && (!automationId || run.automationId === automationId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** What the planner may use for this person, and what the screen needs to show steps in words. */
export function planningContext(owner) {
  return {
    team: teammates().map(({ address, name }) => ({ address, name })),
    projects: taskStore().projects.map(({ id, name }) => ({ id, name })),
    labels: owner ? mailTools.labels(owner) : [],
    groups: owner ? groups().filter((group) => group.members.includes(owner)).map(({ id, name }) => ({ id, name })) : [],
    functions: catalogForPlanner(),
    screen: catalogForScreen(),
  };
}
