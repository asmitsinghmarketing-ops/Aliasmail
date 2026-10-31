// Web and email addresses written as plain text become links: as they are typed in Compose,
// in HTML that is sent, and in emails being read. Everything is done with DOM nodes, so no
// text is ever turned into markup.
export const LINK = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|www\.[^\s<>"']+[^\s<>"'.,;:!?)\]]|[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,})/gi;
const TRAILING = /^[.,;:!?)\]'"]*$/;
const SKIP = new Set(['A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON', 'TITLE']);

export const hrefFor = (address) =>
  /^https?:\/\//i.test(address) ? address : /^www\./i.test(address) ? `https://${address}` : `mailto:${address}`;

function anchor(doc, address) {
  const a = doc.createElement('a');
  a.setAttribute('href', hrefFor(address));
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  a.textContent = address;
  return a;
}

/** Turn the addresses in every text node under `root` (outside existing links) into links. */
export function linkifyNode(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let parent = node.parentElement;
    while (parent && parent !== root && !SKIP.has(parent.tagName)) parent = parent.parentElement;
    if ((!parent || parent === root) && LINK.test(node.data)) nodes.push(node);
    LINK.lastIndex = 0;
  }
  for (const node of nodes) {
    const parts = node.data.split(LINK);
    const fragment = doc.createDocumentFragment();
    parts.forEach((part, i) => part && fragment.append(i % 2 ? anchor(doc, part) : part));
    node.replaceWith(fragment);
  }
}

/** HTML with its plain-text addresses made into links. */
export function linkifyHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  linkifyNode(doc.body);
  return doc.body.innerHTML;
}

/**
 * In an editor, as space or Enter is pressed: if the word just typed is an address, make it a
 * link (like Gmail) and keep typing after it. Returns whether it did.
 */
export function linkWordBeforeCaret(editor) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const node = sel.anchorNode;
  const offset = sel.anchorOffset;
  if (node?.nodeType !== Node.TEXT_NODE || !editor.contains(node) || node.parentElement.closest('a')) return false;
  const before = node.data.slice(0, offset);
  const start = before.search(/\S+$/);
  if (start < 0) return false;
  const word = before.slice(start);
  const match = new RegExp(`^(?:${LINK.source})`, 'i').exec(word);
  if (!match || !TRAILING.test(word.slice(match[0].length))) return false;

  const doc = node.ownerDocument;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + match[0].length);
  const a = anchor(doc, match[0]);
  a.textContent = '';
  range.surroundContents(a);
  // The caret goes back where it was: after the address and any punctuation typed after it.
  const caret = doc.createRange();
  const rest = a.nextSibling;
  const leftOver = offset - start - match[0].length;
  if (rest?.nodeType === Node.TEXT_NODE && leftOver > 0) caret.setStart(rest, leftOver);
  else caret.setStartAfter(a);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  return true;
}
