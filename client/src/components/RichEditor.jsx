// Formatted message body: bold, italic, underline, lists and links, like Gmail's formatting bar.
// Content is kept to an allowlist of tags and attributes, so a draft written by a teammate in a
// shared mailbox, or a message quoted in a reply, can never run script here. Quoted messages keep
// their layout (tables, colours, inline styles) and pictures (web and embedded ones only).
import { useEffect, useRef, useState } from 'react';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { Popover } from './Menus.jsx';
import { linkWordBeforeCaret } from '../linkify.js';

const KEEP = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'A', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'PRE', 'CODE', 'SUB', 'SUP', 'SMALL', 'BIG', 'FONT', 'CENTER', 'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
]);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
const SAFE_URL = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^(https:|data:image\/(png|jpe?g|gif|webp|bmp);base64,)/i;
// Layout attributes kept as they are; on* handlers and everything else are dropped.
const ATTRIBUTES = new Set(['align', 'valign', 'width', 'height', 'bgcolor', 'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'alt', 'title', 'dir']);
// Inline styles stay, minus anything that could load a resource or cover the page.
const UNSAFE_STYLE = /url\s*\(|expression|javascript:|behavior|-moz-binding|@import|position\s*:\s*(fixed|absolute|sticky)/i;

function safeStyle(style) {
  return style
    .split(';')
    .filter((rule) => rule.includes(':') && !UNSAFE_STYLE.test(rule))
    .join(';')
    .trim();
}

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
        if (node.tagName === 'IMG' && !SAFE_IMAGE.test(node.getAttribute('src')?.trim() || '')) continue;
        const el = document.createElement(node.tagName.toLowerCase());
        for (const { name, value } of node.attributes) {
          if (ATTRIBUTES.has(name)) el.setAttribute(name, value);
          else if (name === 'style' && safeStyle(value)) el.setAttribute('style', safeStyle(value));
        }
        if (node.tagName === 'IMG') el.setAttribute('src', node.getAttribute('src').trim());
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

/** The plain-text version of editor HTML, for a draft that starts as HTML (a reply or forward). */
export function textFromHtml(html = '') {
  const marked = sanitizeHtml(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '$&\n');
  return new DOMParser().parseFromString(`<body>${marked}</body>`, 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trimEnd();
}

const TOOLS = [
  ['bold', 'bold', 'Bold (Ctrl+B)'],
  ['italic', 'italic', 'Italic (Ctrl+I)'],
  ['underline', 'underline', 'Underline (Ctrl+U)'],
  ['insertUnorderedList', 'bulletList', 'Bulleted list'],
  ['insertOrderedList', 'numberList', 'Numbered list'],
  ['createLink', 'link', 'Insert link'],
  ['removeFormat', 'clearFormat', 'Remove formatting'],
];

const MAX_PICTURE_SIDE = 480; // a signature logo, not a photo (shown at most 240 px wide, so it stays sharp)
const SHOWN_PICTURE_WIDTH = 240;
const COLORS = [
  ['#202124', 'Black'], ['#5f6368', 'Grey'], ['#c2410c', 'Orange'], ['#d93025', 'Red'],
  ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#7b1fa2', 'Purple'], ['#b06000', 'Brown'],
];

/** A picked picture, shrunk to signature size, as a data: URL (PNG keeps a logo's transparency). */
async function pictureDataUrl(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPG, GIF or WebP picture');
  const image = await createImageBitmap(file).catch(() => {
    throw new Error('This picture can’t be read here — try a PNG or JPG');
  });
  const ratio = Math.min(1, MAX_PICTURE_SIDE / Math.max(image.width, image.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(image.width * ratio), height: Math.round(image.height * ratio) });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  return { url: file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9), width: Math.min(canvas.width, SHOWN_PICTURE_WIDTH) };
}

/**
 * `initialHtml` is loaded once (sanitized). `onChange({ html, text })` runs on every edit;
 * `text` is the plain-text version sent alongside the HTML. `richTools` adds text colour and
 * pictures (used for the signature).
 */
export default function RichEditor({ initialHtml, onChange, placeholder, autoFocus, caretAtStart, className = '', toolbarClassName = '', editorRef, richTools = false }) {
  const box = useRef(null);
  const [active, setActive] = useState({});
  const savedRange = useRef(null);
  const picturePicker = useRef(null);

  // Toolbar controls that open something (a colour or file picker) take the focus away from the
  // text: remember where the cursor was and put it back before changing anything.
  const keepSelection = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && box.current.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    box.current.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (savedRange.current) sel.addRange(savedRange.current);
    else {
      sel.selectAllChildren(box.current);
      sel.collapseToEnd();
    }
  };

  function setColor(color) {
    restoreSelection();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('foreColor', false, color);
    emit();
  }

  async function insertPicture(file) {
    if (!file) return;
    try {
      const { url, width } = await pictureDataUrl(file);
      restoreSelection();
      document.execCommand('insertHTML', false, `<img src="${url}" width="${width}" alt="">`);
      emit();
    } catch (err) {
      await ask({ title: 'Couldn’t add the picture', message: err.message, confirmLabel: 'OK', cancelLabel: '' });
    }
  }

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
    if (!el.textContent.trim() && !el.querySelector('li, img')) el.innerHTML = '';
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
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && linkWordBeforeCaret(box.current)) emit();
        }}
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
        {richTools && (
          <>
            <span
              className="color-tool"
              onMouseDown={(e) => {
                keepSelection();
                // Keep the text selected while the palette is open (the custom picker still opens).
                if (e.target.tagName !== 'INPUT') e.preventDefault();
              }}
            >
              <Popover icon="formatColor" title="Text colour">
                {(close) => (
                  <div className="menu color-menu" role="menu" aria-label="Text colour">
                    <div className="color-swatches">
                      {COLORS.map(([color, name]) => (
                        <button
                          key={color}
                          type="button"
                          className="color-swatch"
                          style={{ background: color }}
                          title={name}
                          aria-label={name}
                          onClick={() => {
                            setColor(color);
                            close();
                          }}
                        />
                      ))}
                    </div>
                    <label className="color-custom">
                      Custom colour…
                      <input
                        type="color"
                        onChange={(e) => {
                          setColor(e.target.value);
                          close();
                        }}
                      />
                    </label>
                  </div>
                )}
              </Popover>
            </span>
            <button
              type="button"
              className="icon-btn"
              title="Insert picture (e.g. your logo)"
              aria-label="Insert picture"
              onMouseDown={(e) => {
                e.preventDefault();
                keepSelection();
              }}
              onClick={() => picturePicker.current.click()}
            >
              <Icon name="image" size={20} />
            </button>
            <input
              ref={picturePicker}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                insertPicture(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
