// Formatted message body: bold, italic, underline, lists and links, like Gmail's formatting bar.
// Content is kept to a short allowlist of tags, so a draft written by a teammate in a shared
// mailbox can never run script or load anything when it is opened here.
import { useEffect, useRef, useState } from 'react';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';

const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'A', 'BLOCKQUOTE']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK']);
const SAFE_URL = /^(https?:|mailto:)/i;

/** Rebuild HTML from allowed tags only; every other tag keeps just its text. */
export function sanitizeHtml(html) {
  const source = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body;
  const out = document.createElement('div');
  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE && !DROP.has(node.tagName)) {
        if (!KEEP.has(node.tagName)) {
          copy(node, to);
          continue;
        }
        const el = document.createElement(node.tagName.toLowerCase());
        if (node.tagName === 'A') {
          const href = node.getAttribute('href')?.trim() || '';
          if (SAFE_URL.test(href)) {
            el.setAttribute('href', href);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        }
        copy(node, el);
        to.append(el);
      }
    }
  };
  copy(source, out);
  return out.innerHTML;
}

export const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Plain text (a signature, a quoted reply) as editor HTML. */
export const htmlFromText = (text = '') => escapeHtml(text).replace(/\r?\n/g, '<br>');

const TOOLS = [
  ['bold', 'bold', 'Bold (Ctrl+B)'],
  ['italic', 'italic', 'Italic (Ctrl+I)'],
  ['underline', 'underline', 'Underline (Ctrl+U)'],
  ['insertUnorderedList', 'bulletList', 'Bulleted list'],
  ['insertOrderedList', 'numberList', 'Numbered list'],
  ['createLink', 'link', 'Insert link'],
  ['removeFormat', 'clearFormat', 'Remove formatting'],
];

/**
 * `initialHtml` is loaded once (sanitized). `onChange({ html, text })` runs on every edit;
 * `text` is the plain-text version sent alongside the HTML.
 */
export default function RichEditor({ initialHtml, onChange, placeholder, autoFocus, caretAtStart, className = '', toolbarClassName = '', editorRef }) {
  const box = useRef(null);
  const [active, setActive] = useState({});
  const savedRange = useRef(null);

  useEffect(() => {
    const el = box.current;
    el.innerHTML = sanitizeHtml(initialHtml);
    if (editorRef) editorRef.current = el;
    if (autoFocus) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(Boolean(caretAtStart));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (caretAtStart) el.scrollTop = 0;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show which styles apply where the cursor is.
  useEffect(() => {
    const update = () => {
      if (!box.current?.contains(document.getSelection()?.anchorNode)) return;
      setActive(Object.fromEntries(TOOLS.slice(0, 5).map(([cmd]) => [cmd, document.queryCommandState(cmd)])));
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  const emit = () => {
    const el = box.current;
    // An editor emptied by the user can keep a stray <br>; treat it as empty.
    if (!el.textContent.trim() && !el.querySelector('li')) el.innerHTML = '';
    // Editors store spaces next to formatting as non-breaking; plain text wants ordinary ones.
    onChange({ html: el.innerHTML, text: el.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd() });
  };

  async function run(cmd) {
    box.current.focus();
    if (cmd === 'createLink') {
      const sel = window.getSelection();
      savedRange.current = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const chosen = sel.toString();
      const url = await ask({ title: 'Insert link', input: { label: 'Web address', placeholder: 'https://example.com' }, confirmLabel: 'Insert' });
      if (!url) return;
      const href = /^(https?:|mailto:)/i.test(url) ? url : /@/.test(url) && !/\//.test(url) ? `mailto:${url}` : `https://${url}`;
      box.current.focus();
      const restored = window.getSelection();
      restored.removeAllRanges();
      if (savedRange.current) restored.addRange(savedRange.current);
      if (chosen) document.execCommand('createLink', false, href);
      else document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>&nbsp;`);
      box.current.querySelectorAll('a').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
    } else {
      document.execCommand(cmd, false);
      if (cmd === 'removeFormat') document.execCommand('unlink', false);
    }
    emit();
  }

  return (
    <>
      <div
        ref={box}
        className={`rich-editor ${className}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        data-placeholder={placeholder}
        spellCheck
        suppressContentEditableWarning
        onInput={emit}
        onPaste={(e) => {
          // Pasted content goes through the same allowlist as everything else.
          const html = e.clipboardData.getData('text/html');
          e.preventDefault();
          if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
          else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
          emit();
        }}
      />
      <div className={`format-bar ${toolbarClassName}`} role="toolbar" aria-label="Formatting">
        {TOOLS.map(([cmd, icon, title]) => (
          <button
            key={cmd}
            type="button"
            className={`icon-btn ${active[cmd] ? 'on' : ''}`}
            title={title}
            aria-label={title}
            aria-pressed={cmd in active ? Boolean(active[cmd]) : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(cmd)}
          >
            <Icon name={icon} size={20} />
          </button>
        ))}
      </div>
    </>
  );
}
