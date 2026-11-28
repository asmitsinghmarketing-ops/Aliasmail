// A meeting's private notes, kept on this device only. The notes panel in a call and the
// full-page notes (/notes/<id>, often in another tab) read and write the same entry, and each
// hears the other's changes straight away.

const PREFIX = 'nextspace:call-notes:';
const META = 'nextspace:call-notes-meta:';
const SAME_TAB = 'nextspace:notes-changed';

export const notesKey = (id) => `${PREFIX}${id}`;

export function readNotes(id) {
  try { return localStorage.getItem(notesKey(id)) || ''; } catch { return ''; }
}

export function writeNotes(id, text) {
  try {
    if (text) localStorage.setItem(notesKey(id), text); else localStorage.removeItem(notesKey(id));
  } catch { /* private window or full storage */ }
  window.dispatchEvent(new CustomEvent(SAME_TAB, { detail: { id, text } }));
}

export function readMeta(id) {
  try { return JSON.parse(localStorage.getItem(`${META}${id}`) || 'null') || {}; } catch { return {}; }
}

export function writeMeta(id, meta) {
  try { localStorage.setItem(`${META}${id}`, JSON.stringify({ ...readMeta(id), ...meta })); } catch { /* ignore */ }
}

/** Calls back with the new text whenever another tab, or another view in this tab, saves. */
export function watchNotes(id, onChange) {
  const onStorage = (event) => { if (event.key === notesKey(id)) onChange(event.newValue || ''); };
  const onLocal = (event) => { if (event.detail?.id === id) onChange(event.detail.text); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SAME_TAB, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SAME_TAB, onLocal);
  };
}

export const notesPath = (id, title) => `/notes/${encodeURIComponent(id)}${title ? `?title=${encodeURIComponent(title)}` : ''}`;

/** "/notes/<id>" in the address bar: the id, else null. */
export const notesIdOf = () => {
  const match = /^\/notes\/([\w-]{1,80})\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
};
