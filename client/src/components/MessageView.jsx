import { useEffect, useRef, useState } from 'react';
import { api, download, getMessage, preview, previewType } from '../api.js';
import { displayName, formatDate, formatSize, personLabel, timeAgo } from '../format.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

// A sender can't loosen that with their own <meta name="referrer"> or referrerpolicy="unsafe-url".
const noReferrerOverrides = (html) =>
  String(html || '')
    .replace(/<meta\b[^>]*\bname\s*=\s*["']?referrer\b[^>]*>/gi, '')
    .replace(/\sreferrerpolicy\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

function HtmlBody({ html }) {
  const frame = useRef(null);
  // No allow-scripts: the email's own JavaScript never runs.
  // No referrer either: images and links in an email never learn where it was read.
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">
<style>html{overflow:hidden}html,body{margin:0;padding:0}body{display:flow-root;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#202124;overflow-wrap:break-word}img{max-width:100%;height:auto}a{color:#1a73e8}</style>
</head><body>${noReferrerOverrides(html)}</body></html>`;

  useEffect(() => () => frame.current?._observers?.forEach((o) => o.disconnect()), []);

  // Fit the email to the frame like Gmail: newsletters built for a 600-700px column are scaled
  // down as a whole on a phone instead of having their tables squeezed. The frame then grows to
  // the content's height, and keeps adjusting as late images load or the window resizes.
  const onLoad = () => {
    const el = frame.current;
    const fit = () => {
      try {
        const body = el.contentDocument.body;
        body.style.transform = '';
        body.style.width = '';
        const available = el.clientWidth;
        const natural = Math.max(body.scrollWidth, el.contentDocument.documentElement.scrollWidth);
        let height = body.scrollHeight;
        if (available > 0 && natural > available + 1) {
          const scale = Math.max(0.35, available / natural);
          body.style.width = `${natural}px`;
          body.style.transformOrigin = '0 0';
          body.style.transform = `scale(${scale})`;
          height = body.scrollHeight * scale;
        }
        // The body's height, not the document's: the document is never shorter than the frame.
        el.style.height = `${Math.ceil(height) + 4}px`;
      } catch {
        /* keep the CSS height */
      }
    };
    fit();
    try {
      const content = new ResizeObserver(fit);
      content.observe(el.contentDocument.body);
      const outer = new ResizeObserver(fit);
      outer.observe(el);
      el._observers = [content, outer];
    } catch {
      setTimeout(fit, 500);
    }
  };

  return (
    <iframe
      ref={frame}
      title="Message body"
      className="mail-frame"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      onLoad={onLoad}
    />
  );
}

const joinPeople = (list, me) => (list || []).map((p) => personLabel(p, me)).join(', ');

// Attachment cards are coloured by kind of file, so a PDF or a spreadsheet stands out at a glance.
const FILE_KINDS = [
  ['pdf', /^pdf$/, 'PDF'],
  ['doc', /^(docx?|odt|rtf|pages)$/, 'Document'],
  ['sheet', /^(xlsx?|ods|csv|numbers)$/, 'Spreadsheet'],
  ['slides', /^(pptx?|odp|key)$/, 'Presentation'],
  ['image', /^(png|jpe?g|gif|webp|heic|bmp|svg|tiff?)$/, 'Image'],
  ['archive', /^(zip|rar|7z|tar|gz)$/, 'Archive'],
  ['media', /^(mp3|wav|m4a|mp4|mov|avi|webm)$/, 'Media'],
];
const fileKind = (filename) => {
  const ext = String(filename).split('.').pop().toLowerCase();
  const [kind, , label] = FILE_KINDS.find(([, re]) => re.test(ext)) || ['other', null, ext.length <= 5 ? ext.toUpperCase() : 'File'];
  return { kind, label, ext: ext.length <= 4 ? ext : 'file' };
};

function Attachments({ url, attachments, onError }) {
  const [busy, setBusy] = useState(null); // index being fetched, or 'all'
  const total = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  const available = attachments.filter((a) => !a.unavailable);
  const run = async (key, job) => {
    setBusy(key);
    try { await job(); } catch (err) { onError(err.message); } finally { setBusy(null); }
  };
  return (
    <section className="attachments" aria-label="Attachments">
      <div className="attachments-head">
        <span className="attachments-title">
          <Icon name="attach" size={16} /> {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
          {total > 0 && <span className="muted"> · {formatSize(total)}</span>}
        </span>
        {available.length > 1 && (
          <button
            type="button"
            className="link attachments-all"
            disabled={busy !== null}
            onClick={() => run('all', async () => { for (const a of available) await download(`${url}/attachments/${a.index}`, a.filename); })}
          >
            <Icon name="download" size={16} /> {busy === 'all' ? 'Downloading…' : 'Download all'}
          </button>
        )}
      </div>
      <div className="attachment-grid">
        {attachments.map((a) => {
          const { kind, label, ext } = fileKind(a.filename);
          const path = `${url}/attachments/${a.index}`;
          const canPreview = !a.unavailable && previewType(a.filename);
          return (
            <div key={a.index} className={`attachment file-${kind} ${a.unavailable ? 'unavailable' : ''} ${busy === a.index ? 'busy' : ''}`}>
              <button
                type="button"
                className="attachment-main"
                disabled={a.unavailable || busy !== null}
                title={a.unavailable ? 'Available once the copy reaches the Sent folder' : canPreview ? `Open ${a.filename}` : `Download ${a.filename}`}
                onClick={() => run(a.index, () => (canPreview ? preview(path, a.filename) : download(path, a.filename)))}
              >
                <span className="attachment-type" aria-hidden="true">{ext}</span>
                <span className="attachment-text">
                  <span className="attachment-name">{a.filename}</span>
                  <span className="attachment-meta">{busy === a.index ? 'Opening…' : `${label} · ${formatSize(a.size)}`}</span>
                </span>
              </button>
              {!a.unavailable && (
                <button type="button" className="icon-btn attachment-download" title={`Download ${a.filename}`} disabled={busy !== null} onClick={() => run(a.index, () => download(path, a.filename))}>
                  <Icon name="download" size={18} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const LINK = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|www\.[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Plain text with its web addresses made clickable (rendered by React, so nothing is injected). */
function Linkified({ text }) {
  return text.split(LINK).map((part, i) =>
    i % 2 ? (
      <a key={i} href={part.startsWith('www.') ? `https://${part}` : part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

// Where an earlier message is quoted in a reply: "On …, … wrote:" or the first "> " line.
const QUOTE_START = /\n(?=On [^\n]{4,200}wrote:\s*\n|>[^\n]*\n?)/;

/** Plain-text body; the quoted history of a reply folds away behind "•••", like Gmail. */
function PlainBody({ text }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const cut = text.search(QUOTE_START);
  const own = cut > 0 ? text.slice(0, cut) : text;
  const quoted = cut > 0 ? text.slice(cut) : '';
  return (
    <>
      <pre className="plain"><Linkified text={own.trimEnd()} /></pre>
      {quoted && (
        <>
          <button type="button" className="quote-toggle" title={showQuoted ? 'Hide trimmed content' : 'Show trimmed content'} aria-expanded={showQuoted} onClick={() => setShowQuoted(!showQuoted)}>
            •••
          </button>
          {showQuoted && <pre className="plain quoted"><Linkified text={quoted.replace(/^\n+/, '')} /></pre>}
        </>
      )}
    </>
  );
}

/**
 * One opened message, Gmail style. `url` is its API path; `preview` (the list row) fills the
 * header while the body loads. Every action prop is optional.
 */
export default function MessageView({
  url,
  preview,
  me,
  actions = [],
  position,
  onPrev,
  onNext,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onStar,
  onLoaded,
  labelsById = {},
  avatars = {},
  notice,
  noticeTone,
  footerActions,
  patch,
}) {
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;

  useEffect(() => {
    let alive = true;
    setMsg(null);
    setError('');
    setDetails(false);
    getMessage(url)
      .then((data) => {
        if (!alive) return;
        setMsg(data);
        loaded.current?.(data);
        // On screen now (not just preloaded on hover): have the server fetch its large
        // attachments in the background, so a click on one finds it ready.
        if (/^\/mail\/(messages\/\d+|sent\/s\d+)$/.test(url) && data.attachments?.some((a) => !a.unavailable)) api(`${url}/warm`).catch(() => {});
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [url]);

  const head = msg ? { ...msg, ...patch } : preview && { ...preview, ...patch };
  const others = head ? [...(head.to || []), ...(head.cc || [])].filter((p) => p.address !== me && p.address !== head.from?.address) : [];
  const star = async () => setMsg({ ...msg, starred: (await onStar(head)).starred });

  return (
    <div className="viewer">
      <div className="toolbar">
        <button className="icon-btn" title="Back (u)" onClick={onBack}>
          <Icon name="back" />
        </button>
        {Array.isArray(actions)
          ? actions.map((a) => (
              <button key={a.title} className={`icon-btn ${a.danger ? 'danger' : ''}`} title={a.title} onClick={a.onClick}>
                <Icon name={a.icon} />
              </button>
            ))
          : actions}
        {position && (
          <div className="pager">
            <span className="muted small">
              {position.index + 1} of {position.total}
            </span>
            <button className="icon-btn" title="Newer (k)" disabled={!onPrev} onClick={onPrev}>
              <Icon name="chevronLeft" />
            </button>
            <button className="icon-btn" title="Older (j)" disabled={!onNext} onClick={onNext}>
              <Icon name="chevronRight" />
            </button>
          </div>
        )}
      </div>

      {error && <div className="alert m">{error}</div>}
      {notice &&
        (noticeTone ? (
          <div className={`notice-card notice-${noticeTone}`} role={noticeTone === 'error' ? 'alert' : 'status'}>
            <Icon name={noticeTone === 'error' ? 'spam' : noticeTone === 'warning' ? 'outbox' : 'info'} size={20} />
            <span>{notice}</span>
          </div>
        ) : (
          <div className="banner">{notice}</div>
        ))}

      {head && (
        <article className="message">
          <div className="message-head">
            <h2>{head.subject || '(no subject)'}</h2>
            {head.aliases?.map((a) => (
              <span key={a.address} className="chip" style={{ '--chip': a.color }}>
                {a.address}
              </span>
            ))}
            {(head.labels || []).map(
              (id) =>
                labelsById[id] && (
                  <span key={id} className="chip" style={{ '--chip': labelsById[id].color }}>
                    {labelsById[id].name}
                  </span>
                ),
            )}
            {head.trashed && <span className="chip grey">Trash</span>}
            {head.kind === 'inbox' && head.archived === false && head.trashed === false && <span className="chip grey">Inbox</span>}
            {head.via === 'cc' && <span className="chip" style={{ '--chip': 'var(--violet)' }}>You were CC'd</span>}
            {head.via === 'bcc' && <span className="chip" style={{ '--chip': 'var(--orange)' }}>You were BCC'd</span>}
          </div>

          <div className="sender">
            <Avatar url={avatars[head.from?.address]} person={head.from} />
            <div className="sender-info">
              <div className="sender-line">
                <strong className="sender-name">{displayName(head.from)}</strong>
                {head.from?.name && <span className="muted small sender-address">&lt;{head.from.address}&gt;</span>}
              </div>
              <button className="details-toggle muted small" aria-expanded={details} onClick={() => setDetails(!details)}>
                <span className="details-who">
                  to {joinPeople(head.to, me) || 'undisclosed recipients'}
                  {head.cc?.length > 0 && <>, cc {joinPeople(head.cc, me)}</>}
                </span>
                <Icon name="expandMore" size={16} />
              </button>
            </div>
            <div className="sender-meta">
              <span className="muted small nowrap date-full" title={formatDate(head.date, true)}>
                {formatDate(head.date, true)} ({timeAgo(head.date)})
              </span>
              <span className="muted small nowrap date-short" title={formatDate(head.date, true)}>
                {formatDate(head.date)}
              </span>
              {onStar && msg?.kind === 'inbox' && (
                <button className={`icon-btn star ${head.starred ? 'on' : ''}`} title="Star (s)" onClick={star}>
                  <Icon name={head.starred ? 'star' : 'starOutline'} />
                </button>
              )}
              {onReply && msg?.kind === 'inbox' && (
                <button className="icon-btn" title="Reply (r)" onClick={() => onReply(msg)}>
                  <Icon name="reply" />
                </button>
              )}
            </div>
          </div>

          {details && (
            <table className="details">
              <tbody>
                <tr><th>from:</th><td>{displayName(head.from)} &lt;{head.from?.address}&gt;</td></tr>
                {msg?.replyTo && msg.replyTo.address !== head.from?.address && (
                  <tr><th>reply-to:</th><td>{msg.replyTo.address}</td></tr>
                )}
                <tr><th>to:</th><td>{(head.to || []).map((p) => p.address).join(', ') || '—'}</td></tr>
                {head.cc?.length > 0 && <tr><th>cc:</th><td>{head.cc.map((p) => p.address).join(', ')}</td></tr>}
                {head.bcc?.length > 0 && <tr><th>bcc:</th><td>{head.bcc.map((p) => p.address).join(', ')}</td></tr>}
                <tr><th>date:</th><td>{formatDate(head.date, true)}</td></tr>
                <tr><th>subject:</th><td>{head.subject || '(no subject)'}</td></tr>
                {me && head.via && <tr><th>delivered to:</th><td>{me} (as {head.via})</td></tr>}
              </tbody>
            </table>
          )}

          <div className="message-body">
            {!msg && !error && <div className="loading-lines"><span /><span /><span /></div>}
            {msg && (msg.html ? <HtmlBody html={msg.html} /> : <PlainBody text={msg.text || ''} />)}
          </div>

          {msg?.attachments?.length > 0 && <Attachments url={url} attachments={msg.attachments} onError={setError} />}

          {msg && footerActions?.length > 0 && (
            <div className="reply-bar">
              {footerActions.map((a) => (
                <button key={a.label} className={`btn ${a.primary ? 'btn-primary' : 'btn-outline'}`} onClick={a.onClick}>
                  <Icon name={a.icon} size={18} /> {a.label}
                </button>
              ))}
            </div>
          )}

          {msg && !footerActions?.length && (onReply || onForward) && (
            <div className="reply-bar">
              {onReply && msg.kind === 'inbox' && (
                <button className="btn btn-outline" onClick={() => onReply(msg)}>
                  <Icon name="reply" size={18} /> Reply
                </button>
              )}
              {onReplyAll && msg.kind === 'inbox' && others.length > 0 && (
                <button className="btn btn-outline" onClick={() => onReplyAll(msg)}>
                  <Icon name="replyAll" size={18} /> Reply all
                </button>
              )}
              {onForward && (
                <button className="btn btn-outline" onClick={() => onForward(msg)}>
                  <Icon name="forward" size={18} /> Forward
                </button>
              )}
            </div>
          )}
        </article>
      )}
    </div>
  );
}
