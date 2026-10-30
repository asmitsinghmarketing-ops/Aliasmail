const PAGE_SIZE = 50;

export function paginate(items, page) {
  const current = Math.max(1, Number(page) || 1);
  return {
    items: items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    total: items.length,
    page: current,
    pageSize: PAGE_SIZE,
  };
}

export const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

const OPERATORS = ['from', 'to', 'cc', 'subject', 'is', 'has'];

/** Split a Gmail-style query (`from:bob has:attachment "exact words"`) into filters. */
export function parseSearch(q) {
  const filters = { words: [] };
  for (const token of String(q ?? '').match(/\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+/g) || []) {
    const [, key, value] = token.match(/^(\w+):(.+)$/) || [];
    const clean = (s) => s.replace(/^"|"$/g, '').toLowerCase();
    if (key && OPERATORS.includes(key.toLowerCase())) (filters[key.toLowerCase()] ||= []).push(clean(value));
    else filters.words.push(clean(token));
  }
  return filters;
}

const addressText = (list) => list.map((a) => `${a.name} ${a.address}`).join(' ').toLowerCase();

export function matchesQuery(item, q) {
  if (!q) return true;
  const f = parseSearch(q);
  const from = addressText(item.from ? [item.from] : []);
  const to = addressText(item.to || []);
  const cc = addressText(item.cc || []);
  const subject = (item.subject || '').toLowerCase();
  const everything = [subject, from, to, cc, (item.snippet || '').toLowerCase()].join(' ');
  const is = { unread: item.read === false, read: item.read === true, starred: item.starred === true };

  return (
    f.words.every((w) => everything.includes(w)) &&
    (f.from || []).every((v) => from.includes(v)) &&
    (f.to || []).every((v) => to.includes(v) || cc.includes(v)) &&
    (f.cc || []).every((v) => cc.includes(v)) &&
    (f.subject || []).every((v) => subject.includes(v)) &&
    (f.has || []).every((v) => v !== 'attachment' || item.hasAttachments) &&
    (f.is || []).every((v) => is[v] ?? true)
  );
}

export const toUidList = (ids) => (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);

/** Turn a mailparser result into what the client renders. Inline (cid:) images become data URIs. */
// An attachment the message was opened without (fetchLite) reports its encoded size; base64
// carries 3 bytes in every 4.
const leftOutSize = (a) => Math.round(Number(/size=(\d+)/.exec(a.headers?.get('x-aliasmail-part') || '')?.[1] || 0) * 0.74);

export function bodyOf(parsed) {
  let html = parsed.html || null;
  if (html) {
    for (const att of parsed.attachments) {
      if (att.cid) {
        html = html.replaceAll(`cid:${att.cid}`, `data:${att.contentType};base64,${att.content.toString('base64')}`);
      }
    }
  }
  return {
    html,
    text: parsed.text || '',
    references: parsed.references || null,
    attachments: parsed.attachments
      .map((a, index) => ({ index, filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, size: a.size || leftOutSize(a), inline: Boolean(a.cid && a.contentDisposition === 'inline') }))
      .filter((a) => !a.inline),
  };
}

export function sendAttachment(res, att) {
  res.attachment(att.filename || 'attachment');
  res.type(att.contentType || 'application/octet-stream');
  res.send(att.content);
}
