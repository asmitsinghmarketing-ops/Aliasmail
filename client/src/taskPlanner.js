// Date buckets and the smart quick-add parser behind the Tasks planner.
// All dates are local calendar days written as YYYY-MM-DD, matching the server's dueDate format.

export const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const fromIso = (value) => new Date(`${value}T12:00:00`);
export const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };
export const todayIso = (now = new Date()) => iso(now);

/** Monday of the week that contains `date`. */
export function weekStart(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  return addDays(start, -((start.getDay() + 6) % 7));
}

export const BUCKETS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'Next 7 days' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No date' },
];

export function bucketOf(dueDate, now = new Date()) {
  if (!dueDate) return 'none';
  const today = iso(now);
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate === iso(addDays(now, 1))) return 'tomorrow';
  if (dueDate <= iso(addDays(now, 7))) return 'week';
  return 'later';
}

/** "Today", "Tomorrow", "Yesterday", "Fri", or "Dec 15" (with a year when it isn't this year). */
export function dayLabel(value, now = new Date()) {
  if (!value) return '';
  const today = iso(now);
  if (value === today) return 'Today';
  if (value === iso(addDays(now, 1))) return 'Tomorrow';
  if (value === iso(addDays(now, -1))) return 'Yesterday';
  const date = fromIso(value);
  const days = Math.round((date - fromIso(today)) / 86_400_000);
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(value.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }) }).format(date);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const squash = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const WEEKDAY = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?';
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

function monthDay(month, day, now) {
  const index = MONTHS.indexOf(month.slice(0, 3));
  const number = Number(day);
  if (index < 0 || number < 1 || number > 31) return null;
  let date = new Date(now.getFullYear(), index, number, 12);
  if (date.getMonth() !== index) return null;
  if (iso(date) < iso(now)) date = new Date(now.getFullYear() + 1, index, number, 12);
  return iso(date);
}

// Each rule returns a due date, or null when the words don't make a real date.
const DATE_RULES = [
  [/\bin (\d{1,3}) (day|days|week|weeks)\b/i, (m, now) => iso(addDays(now, Number(m[1]) * (m[2].startsWith('week') ? 7 : 1)))],
  [/\bnext week\b/i, (m, now) => iso(addDays(weekStart(now), 7))],
  [/\b(today|tod|tonight)\b/i, (m, now) => iso(now)],
  [/\b(tomorrow|tmrw|tmr)\b/i, (m, now) => iso(addDays(now, 1))],
  [new RegExp(`\\b(next |this )?${WEEKDAY}\\b`, 'i'), (m, now) => {
    const target = WEEKDAYS.indexOf(m[2].toLowerCase().slice(0, 3));
    let gap = (target - now.getDay() + 7) % 7;
    if (m[1]?.trim().toLowerCase() === 'next' && gap === 0) gap = 7;
    return iso(addDays(now, gap));
  }],
  [/\b(\d{4}-\d{2}-\d{2})\b/, (m) => (Number.isNaN(fromIso(m[1]).getTime()) || iso(fromIso(m[1])) !== m[1] ? null : m[1])],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}\\b`, 'i'), (m, now) => monthDay(m[2].toLowerCase(), m[1], now)],
  [new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m, now) => monthDay(m[1].toLowerCase(), m[2], now)],
];

const PRIORITY_WORDS = { high: 'high', h: 'high', urgent: 'high', 1: 'high', medium: 'medium', med: 'medium', m: 'medium', 2: 'medium', low: 'low', l: 'low', 3: 'low' };

/**
 * Reads "Send invoice #billing @mary !high fri" into { title, projectId, assignee, priority, dueDate }.
 * Tokens that match nothing (an unknown #project, say) stay in the title, so nothing typed is lost.
 */
export function parseQuickAdd(text, { projects = [], team = [], me = '', now = new Date() } = {}) {
  let rest = ` ${text} `;
  const found = {};

  rest = rest.replace(/\s#([\p{L}\p{N}_-]+)/u, (all, word) => {
    const key = squash(word);
    const match = projects.find((project) => squash(project.name) === key) || projects.find((project) => squash(project.name).startsWith(key));
    if (!match) return all;
    found.projectId = match.id;
    return ' ';
  });

  rest = rest.replace(/\s@([\p{L}\p{N}._+-]+(?:@[\w.-]+)?)/u, (all, word) => {
    const key = word.toLowerCase();
    if (key === 'me' && me) { found.assignee = me; return ' '; }
    const match = team.find((person) => person.address === key)
      || team.find((person) => squash(person.name).startsWith(squash(key)) && squash(key))
      || team.find((person) => person.address.startsWith(key));
    if (!match) return all;
    found.assignee = match.address;
    return ' ';
  });

  rest = rest.replace(/\s!(high|h|urgent|medium|med|m|low|l|[123])(?=\s)/i, (all, word) => {
    found.priority = PRIORITY_WORDS[word.toLowerCase()];
    return ' ';
  });

  for (const [pattern, toDate] of DATE_RULES) {
    const match = rest.match(pattern);
    if (!match) continue;
    const date = toDate(match, now);
    if (!date) continue;
    found.dueDate = date;
    found.dateWords = match[0].trim();
    rest = rest.slice(0, match.index) + rest.slice(match.index + match[0].length);
    break;
  }

  found.title = rest.replace(/\s+/g, ' ').trim();
  return found;
}
