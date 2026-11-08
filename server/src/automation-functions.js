// The functions an automation can be built from. The AI model that plans automations sees this
// list and nothing else, so it can only ever choose from it; adding a function here makes it
// available everywhere: to the planner, to the checks, to the screen that shows the steps.
//
// Every field has a kind, and the kind decides what may go in it:
// - text: anything, including what an earlier step wrote (AI text, a summary, an email's subject).
// - choice, number, date: one of the allowed values, checked here.
// - teammate, emails, project, label, group: who or what a step acts on. These never take text an
//   AI wrote or a stranger sent, only fixed values or the person's own input, so nothing written
//   in an email can redirect an automation.
// - messages, task: only emails or a task that an earlier step found or made, or the email that
//   started the automation.
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { createTask, updateTask } from './routes/tasks.js';
import { createNote } from './instant-notes.js';
import { createNotification } from './notifications.js';
import { teammates } from './team.js';
import { mailTools } from './routes/mail.js';

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The types of email write_email knows, with what makes each one good. Shown in this order.
export const EMAIL_KINDS = {
  first_contact: { label: 'First time approaching a client', guide: 'This is the first time the sender contacts this person. Briefly introduce the sender and what they offer, say why they are getting in touch, and end with one light, specific next step, such as a short call. Warm and professional, never pushy. Under 150 words.' },
  follow_up: { label: 'Following up', guide: 'A follow-up to an earlier conversation or email that has not had a reply. Brief and friendly: remind them of the point and make replying easy. Under 100 words.' },
  proposal: { label: 'Sending a proposal or quote', guide: 'Sending a proposal or quote. Say what it covers, sum up the main point in a sentence or two, and invite questions. Under 150 words.' },
  payment_reminder: { label: 'Payment reminder', guide: 'A polite reminder that a payment is due or overdue. Clear and courteous. Under 120 words.' },
  thank_you: { label: 'Thank you', guide: 'Thanking them, for example for a meeting, their business or a referral. Sincere and specific. Under 100 words.' },
  meeting_request: { label: 'Asking for a meeting', guide: 'Asking for a meeting or call: why, about how long, and asking for times that suit them. Under 120 words.' },
  general: { label: 'Something else', guide: 'Write the email the details describe. Under 180 words.' },
};

const choices = (entries) => Object.entries(entries).map(([value, label]) => ({ value, label }));
const MAIL_CHANGES = choices({
  read: 'Mark as read', unread: 'Mark as unread', star: 'Star', unstar: 'Remove star', important: 'Mark important', notImportant: 'Mark not important',
  archive: 'Archive', trash: 'Move to Trash', inbox: 'Move back to Inbox', waiting: 'Mark as waiting', done: 'Mark as done',
});
const TEST_CHOICES = choices({
  contains: 'contains', not_contains: 'doesn’t contain', equals: 'is', not_equals: 'isn’t', not_empty: 'has something in it', empty: 'is empty',
  more_than: 'is more than', less_than: 'is less than',
});

/** First to last, as the planner and the screen list them. */
export const FUNCTIONS = {
  /* ----- mail: the person's own mailbox ----- */
  find_emails: {
    label: 'Find emails', icon: 'search', group: 'Mail', produces: 'messages',
    description: 'Find emails in the person’s mailbox. Later steps can act on what it finds with {{steps.N.ids}}, count them with {{steps.N.count}}, or read them with {{steps.N.text}} (sender and subject of each).',
    fields: {
      folder: { kind: 'choice', label: 'In', options: choices({ inbox: 'Inbox', all: 'All mail', starred: 'Starred', important: 'Important', waiting: 'Waiting' }), default: 'inbox' },
      from: { kind: 'text', label: 'From containing', max: 200 },
      subject: { kind: 'text', label: 'Subject containing', max: 200 },
      unread: { kind: 'choice', label: 'Read or not', options: choices({ any: 'Either', unread: 'Unread only', read: 'Read only' }), default: 'any' },
      days: { kind: 'number', label: 'From the last … days', min: 1, max: 365 },
      limit: { kind: 'number', label: 'At most', min: 1, max: 50, default: 20 },
    },
    run: async (p, ctx) => {
      const found = ctx.mail.find(ctx.owner, { folder: p.folder, from: p.from, subject: p.subject, unread: p.unread, days: p.days, limit: p.limit });
      return {
        id: found[0]?.uid, ids: found.map((m) => m.uid).join(','), count: found.length,
        text: found.map((m) => `${m.from?.name || m.from?.address}: ${m.subject || '(no subject)'}`).join('\n') || 'No emails found.',
      };
    },
  },
  update_emails: {
    label: 'Change emails', icon: 'markRead', group: 'Mail',
    description: 'Archive, star, mark read and so on, for emails found by an earlier step or the email that started the automation.',
    fields: { emails: { kind: 'messages', label: 'Emails', required: true }, change: { kind: 'choice', label: 'Change', options: MAIL_CHANGES, required: true } },
    run: async (p, ctx) => ({ count: ctx.mail.apply(ctx.owner, p.emails, p.change) }),
  },
  label_emails: {
    label: 'Label emails', icon: 'label', group: 'Mail',
    description: 'Add one of the person’s existing labels to emails.',
    fields: { emails: { kind: 'messages', label: 'Emails', required: true }, label: { kind: 'label', label: 'Label', required: true } },
    run: async (p, ctx) => ({ count: ctx.mail.apply(ctx.owner, p.emails, 'addLabel', { labelId: ctx.mail.labelId(ctx.owner, p.label) }) }),
  },
  snooze_emails: {
    label: 'Snooze emails', icon: 'clock', group: 'Mail',
    description: 'Hide emails from the Inbox until a number of days from now.',
    fields: { emails: { kind: 'messages', label: 'Emails', required: true }, days: { kind: 'number', label: 'For days', min: 1, max: 60, required: true } },
    run: async (p, ctx) => ({ count: ctx.mail.apply(ctx.owner, p.emails, 'snooze', { until: new Date(Date.now() + Number(p.days) * 86400e3).toISOString() }) }),
  },
  assign_emails: {
    label: 'Give emails an owner', icon: 'person', group: 'Mail',
    description: 'Make a teammate the owner of conversations, so the team knows who handles them.',
    fields: { emails: { kind: 'messages', label: 'Emails', required: true }, owner: { kind: 'teammate', label: 'Owner', required: true } },
    run: async (p, ctx) => ({ count: ctx.mail.setOwner(ctx.owner, p.emails, ctx.teammate(p.owner)) }),
  },
  note_on_emails: {
    label: 'Add a team note to emails', icon: 'edit', group: 'Mail',
    description: 'Add a note to conversations that only the team sees.',
    fields: { emails: { kind: 'messages', label: 'Emails', required: true }, text: { kind: 'text', label: 'Note', max: 2000, required: true } },
    run: async (p, ctx) => ({ count: ctx.mail.addNote(ctx.owner, p.emails, p.text) }),
  },
  reply_draft: {
    label: 'Draft a reply', icon: 'reply', group: 'Mail',
    description: 'Write a reply to the first of the emails. It waits in Work items until the person sends it with one click.',
    fields: { emails: { kind: 'messages', label: 'Reply to', required: true }, body: { kind: 'text', label: 'Message', max: 20_000, required: true } },
    run: async (p, ctx) => {
      const reply = ctx.mail.replyTo(ctx.owner, p.emails);
      if (!reply) return { count: 0 };
      return ctx.saveDraft({ to: reply.to, subject: reply.subject, text: p.body, inReplyTo: reply.inReplyTo, references: reply.references });
    },
  },
  create_draft: {
    label: 'Write an email draft', icon: 'draft', group: 'Mail',
    description: 'Prepare an email with fixed text. It waits in Work items until the person sends it with one click.',
    fields: {
      to: { kind: 'emails', label: 'To', required: true }, cc: { kind: 'emails', label: 'Cc' },
      subject: { kind: 'text', label: 'Subject', max: 300 }, body: { kind: 'text', label: 'Message', max: 20_000, required: true },
    },
    run: async (p, ctx) => ctx.saveDraft({ to: p.to, cc: p.cc, subject: p.subject, text: p.body }),
  },
  write_email: {
    label: 'Write an email with AI', icon: 'sparkle', group: 'Mail', ai: true,
    description: 'AI writes an email of the chosen type. It waits in Work items until the person sends it with one click.',
    fields: {
      to: { kind: 'emails', label: 'To', required: true },
      kind: { kind: 'choice', label: 'Type', required: true, options: Object.entries(EMAIL_KINDS).map(([value, { label }]) => ({ value, label })), askable: 'kind' },
      details: { kind: 'text', label: 'Mention', max: 4000, optionalInput: true },
    },
    run: async (p, ctx) => {
      const kind = EMAIL_KINDS[p.kind];
      if (!kind) throw new HttpError(400, 'Choose a type of email');
      const { writeEmail } = await import('./assistant.js');
      const written = await writeEmail({ person: ctx.owner, kind: kind.label, guide: kind.guide, to: p.to, toName: ctx.input.name || '', details: p.details, sender: ctx.nameOf(ctx.owner) });
      return ctx.saveDraft({ to: p.to, subject: written.subject, text: written.body });
    },
  },

  /* ----- tasks ----- */
  create_task: {
    label: 'Create a task', icon: 'checkCircle', group: 'Tasks', produces: 'task',
    description: 'Create a task in an existing project. Later steps can change it with {{steps.N.id}} or mention it with {{steps.N.title}}.',
    fields: {
      projectId: { kind: 'project', label: 'Project', required: true }, title: { kind: 'text', label: 'Task', max: 200, required: true },
      description: { kind: 'text', label: 'Notes', max: 10_000 }, assignee: { kind: 'teammate', label: 'For' },
      priority: { kind: 'choice', label: 'Priority', options: choices({ low: 'Low', medium: 'Medium', high: 'High' }), default: 'medium' },
      dueDate: { kind: 'date', label: 'Due' },
    },
    run: async (p, ctx) => createTask({ ...p, assignee: p.assignee ? ctx.teammate(p.assignee) : '' }, ctx.owner),
  },
  update_task: {
    label: 'Change a task', icon: 'checkCircle', group: 'Tasks',
    description: 'Change a task an earlier step made: its status, priority, owner or due date.',
    fields: {
      task: { kind: 'task', label: 'Task', required: true },
      status: { kind: 'choice', label: 'Status', options: choices({ backlog: 'Backlog', todo: 'To do', doing: 'Doing', done: 'Done' }) },
      priority: { kind: 'choice', label: 'Priority', options: choices({ low: 'Low', medium: 'Medium', high: 'High' }) },
      assignee: { kind: 'teammate', label: 'For' }, dueDate: { kind: 'date', label: 'Due' },
    },
    run: async (p, ctx) => {
      const changes = Object.fromEntries(Object.entries({ status: p.status, priority: p.priority, dueDate: p.dueDate }).filter(([, value]) => value));
      if (p.assignee) changes.assignee = ctx.teammate(p.assignee);
      return updateTask(p.task, changes, ctx.owner);
    },
  },

  /* ----- people ----- */
  send_note: {
    label: 'Send an instant note', icon: 'chat', group: 'People',
    description: 'Send an instant note to a teammate.',
    fields: { to: { kind: 'teammate', label: 'To', required: true }, text: { kind: 'text', label: 'Note', max: 4000, required: true } },
    run: async (p, ctx) => createNote(ctx.owner, { to: ctx.teammate(p.to), text: p.text, files: [] }),
  },
  send_group_note: {
    label: 'Send a note to a group', icon: 'people', group: 'People',
    description: 'Send an instant note to one of the person’s note groups.',
    fields: { group: { kind: 'group', label: 'Group', required: true }, text: { kind: 'text', label: 'Note', max: 4000, required: true } },
    run: async (p, ctx) => createNote(ctx.owner, { group: p.group, text: p.text, files: [] }),
  },
  notify_user: {
    label: 'Notify a teammate', icon: 'bell', group: 'People',
    description: 'Show a notification to a teammate.',
    fields: { to: { kind: 'teammate', label: 'To', required: true }, title: { kind: 'text', label: 'Title', max: 160, required: true }, body: { kind: 'text', label: 'Message', max: 500 } },
    run: async (p, ctx) => createNotification({ to: ctx.teammate(p.to), type: 'automation', title: p.title, body: p.body, entity: { kind: 'automation', id: ctx.automationId }, actor: ctx.owner }),
  },

  /* ----- AI: text in, text out. What they write can only ever be text in a later step. ----- */
  ai_summarize: {
    label: 'Summarise with AI', icon: 'sparkle', group: 'AI', ai: true,
    description: 'AI summarises some text. Later steps use the summary with {{steps.N.text}}.',
    fields: { text: { kind: 'text', label: 'Text', max: 20_000, required: true }, length: { kind: 'choice', label: 'Length', options: choices({ short: 'A sentence or two', medium: 'A short paragraph', bullets: 'A few bullet points' }), default: 'short' } },
    run: async (p, ctx) => ({ text: await ctx.ai({ task: `Summarise the text. Length: ${{ short: 'one or two sentences', medium: 'a short paragraph', bullets: 'three to five short bullet points' }[p.length] || 'one or two sentences'}.`, text: p.text }) }),
  },
  ai_classify: {
    label: 'Sort with AI', icon: 'sparkle', group: 'AI', ai: true,
    description: 'AI picks which of the given categories some text belongs to. Later steps use the answer with {{steps.N.value}}, often with continue_if.',
    fields: { text: { kind: 'text', label: 'Text', max: 20_000, required: true }, options: { kind: 'text', label: 'Categories (commas between)', max: 500, required: true, noVariables: true } },
    run: async (p, ctx) => {
      const options = p.options.split(',').map((option) => option.trim()).filter(Boolean).slice(0, 12);
      const answer = (await ctx.ai({ task: `Answer with exactly one of these categories and nothing else: ${options.join(' | ')}`, text: p.text })).trim().replace(/^["'.\s]+|["'.\s]+$/g, '');
      const value = options.find((option) => option.toLowerCase() === answer.toLowerCase());
      if (!value) throw new HttpError(502, 'The AI didn’t pick one of the categories');
      return { value, text: value };
    },
  },
  ai_write: {
    label: 'Write text with AI', icon: 'sparkle', group: 'AI', ai: true,
    description: 'AI writes text following instructions, for example translating, shortening or drafting a note. Later steps use it with {{steps.N.text}}.',
    fields: { instructions: { kind: 'text', label: 'Instructions', max: 2000, required: true, noVariables: true }, text: { kind: 'text', label: 'Using', max: 20_000 } },
    run: async (p, ctx) => ({ text: await ctx.ai({ task: p.instructions, text: p.text }) }),
  },

  /* ----- flow ----- */
  continue_if: {
    label: 'Only continue if', icon: 'info', group: 'Flow', stops: true,
    description: 'Stop here, quietly, unless a value passes a test. Use it to make decisions, for example {{steps.1.count}} more_than 0, or {{steps.2.value}} equals Urgent.',
    fields: { value: { kind: 'text', label: 'Value', max: 20_000 }, test: { kind: 'choice', label: 'Test', options: TEST_CHOICES, required: true }, compare: { kind: 'text', label: 'Compared with', max: 500 } },
    run: async (p) => {
      const value = String(p.value || '').trim().toLowerCase();
      const compare = String(p.compare || '').trim().toLowerCase();
      const passes = {
        contains: () => value.includes(compare), not_contains: () => !value.includes(compare), equals: () => value === compare, not_equals: () => value !== compare,
        not_empty: () => Boolean(value), empty: () => !value, more_than: () => Number(value) > Number(compare), less_than: () => Number(value) < Number(compare),
      }[p.test]?.();
      return { passes: Boolean(passes) };
    },
  },
};

/** What the planner is told: each function, what it's for and what goes in each field. */
export function catalogForPlanner() {
  const kindHint = {
    text: 'text', choice: 'one of', number: 'a whole number', date: 'YYYY-MM-DD, "today" or "+N" days from the run',
    teammate: 'a teammate’s email address from context.team', emails: 'email addresses, commas between', project: 'a project id from context.projects',
    label: 'a label name from context.labels', group: 'a group id from context.groups', messages: 'emails: {{email.id}} or {{steps.N.ids}} from find_emails', task: 'a task: {{steps.N.id}} from create_task',
  };
  return Object.entries(FUNCTIONS).map(([action, fn]) => ({
    action, description: fn.description, usesAiEachRun: Boolean(fn.ai),
    fields: Object.fromEntries(Object.entries(fn.fields).map(([name, field]) => [name,
      `${field.required ? 'required' : 'optional'}: ${field.kind === 'choice' ? `${kindHint.choice} ${field.options.map((option) => option.value).join(' | ')}${field.askable ? ` (or {{input.${field.askable}}} to ask each time)` : ''}` : kindHint[field.kind]}`])),
  }));
}

/** What the screen needs to show a step in words: names and field labels, never code. */
export function catalogForScreen() {
  return Object.fromEntries(Object.entries(FUNCTIONS).map(([action, fn]) => [action, {
    label: fn.label, icon: fn.icon, group: fn.group, ai: Boolean(fn.ai),
    fields: Object.fromEntries(Object.entries(fn.fields).map(([name, field]) => [name, { label: field.label, kind: field.kind, options: field.options, optional: Boolean(field.optionalInput) }])),
  }]));
}

/** What each step can draw on while it runs. */
export function runContext({ owner, automationId, automationName = '', input, made = [] }) {
  return {
    owner, automationId, input, mail: mailTools,
    nameOf: (address) => teammates().find((person) => person.address === address)?.name || '',
    teammate: (value) => {
      const found = teammates().find((person) => person.address === String(value).trim().toLowerCase());
      if (!found) throw new HttpError(400, `${value} isn’t on the team`);
      return found.address;
    },
    saveDraft: ({ to, cc = '', subject = '', text, inReplyTo = '', references = [] }) => {
      const list = (value) => String(value || '').split(',').map((address) => address.trim()).filter(Boolean);
      const recipients = list(to);
      if (!recipients.length || [...recipients, ...list(cc)].some((address) => !EMAIL.test(address))) throw new HttpError(400, 'The email address isn’t valid');
      // Marked as an automation's: it's shown in Work items, to be sent or discarded.
      const draft = { id: crypto.randomUUID(), alias: owner, to: recipients.join(', '), cc: list(cc).join(', '), bcc: '', subject, text, html: '', inReplyTo, references, updatedAt: new Date().toISOString(), automation: { id: automationId, name: automationName } };
      db().drafts.push(draft);
      save();
      made.push(draft.id);
      return { id: draft.id, subject: draft.subject };
    },
    ai: async ({ task, text }) => {
      const { aiText } = await import('./assistant.js');
      return aiText({ person: owner, task, text });
    },
  };
}

/** today, +N or a date, as YYYY-MM-DD on the day it runs. */
export function resolveDate(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'today') return now.toISOString().slice(0, 10);
  const plus = /^\+(\d{1,3})$/.exec(text);
  if (plus) return new Date(now.getTime() + Number(plus[1]) * 86400e3).toISOString().slice(0, 10);
  if (DATE.test(text)) return text;
  throw new HttpError(400, `“${text}” isn’t a date`);
}
