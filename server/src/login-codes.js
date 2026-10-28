// Spots one-time login codes in recent mail ("Your Claude code is 482913"), so a shared mailbox
// like access@ can show them at the top instead of everyone opening the message.

// Mail that is worth a closer look: the subject or preview talks about a code or signing in.
const HINT = /\b(code|otp|passcode|verif\w*|sign[- ]?in|log[- ]?in|security|confirm\w*|one[- ]time)\b/i;
const KEYWORD = /\b(code|otp|passcode|pin)\b/gi;
// 482913, 482-913, 482 913, G-482913 (the G- is not typed), or a mixed code like K7Q2PZ. Never
// part of a link, phone number, postal address ("CA 94104") or amount.
const CANDIDATE = /(?<![\w@./:=?#&+$₹€£%-]|\d |\b[A-Z]{2} )(?:[A-Z]{1,3}-(?=\d))?(\d{3}[- ]\d{3}|\d{4,8}|[A-Z0-9]{5,8})(?![\w@/:%]|[.,]\d| \d)/g;
const NEAR = 120;

const plain = (html) =>
  String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ');

export const mightHaveCode = (m) => HINT.test(`${m.subject} ${m.snippet}`);

const isCode = (token) => {
  if (/^\d{4}$/.test(token) && /^(19|20)\d\d$/.test(token)) return false; // a year
  if (/^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token)) return (token.match(/\d/g) || []).length >= 2 && /[A-Z]/.test(token);
  return true;
};

/** The login code in a message, or null. The code nearest to a word like "code" wins. */
export function findLoginCode(subject, text, html) {
  const body = `${subject || ''}\n${text || plain(html)}`.replace(/[ \t]+/g, ' ').slice(0, 6000);
  const keywords = [...body.matchAll(KEYWORD)].map((k) => k.index);
  if (!keywords.length) return null;
  let best = null;
  for (const match of body.matchAll(CANDIDATE)) {
    const token = match[1];
    if (!isCode(token)) continue;
    const distance = Math.min(...keywords.map((k) => Math.abs(k - match.index)));
    // Short all-digit codes only count right next to the word "code".
    if (distance > NEAR || (/^\d{4}$/.test(token) && distance > 40)) continue;
    if (!best || distance < best.distance) best = { code: token.replace(/[- ]/g, ''), distance };
  }
  return best?.code || null;
}

const KNOWN = [
  [/(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/, 'Claude'],
  [/(^|\.)google\.com$/, 'Google'],
  [/(^|\.)(microsoft|microsoftonline|live|outlook)\.com$/, 'Microsoft'],
  [/(^|\.)canva\.com$/, 'Canva'],
  [/(^|\.)openai\.com$/, 'ChatGPT'],
  [/(^|\.)notion\.so$/, 'Notion'],
  [/(^|\.)slack\.com$/, 'Slack'],
  [/(^|\.)(facebook|facebookmail|meta)\.com$/, 'Meta'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)github\.com$/, 'GitHub'],
  [/(^|\.)amazon\.\w+$/, 'Amazon'],
];

/** "Claude", "Google", or the sender's name / domain for anything else. */
export function serviceName(from = {}) {
  const domain = String(from.address || '').split('@')[1]?.toLowerCase() || '';
  const known = KNOWN.find(([re]) => re.test(domain));
  if (known) return known[1];
  const name = String(from.name || '').replace(/\b(team|support|no-?reply|notifications?)\b/gi, '').trim();
  if (name) return name;
  const base = domain.split('.').slice(-2, -1)[0] || 'Unknown';
  return base.charAt(0).toUpperCase() + base.slice(1);
}
