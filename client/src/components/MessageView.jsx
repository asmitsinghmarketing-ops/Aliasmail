import { useEffect, useRef, useState } from 'react';
import { download, getMessage } from '../api.js';
import { displayName, formatDate, formatSize, personLabel, timeAgo } from '../format.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

function HtmlBody({ html }) {
  const frame = useRef(null);
  // No allow-scripts: the email's own JavaScript never runs.
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>html,body{margin:0;padding:0}body{display:flow-root;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#202124;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>
</head><body>${html}</body></html>`;

  useEffect(() => () => frame.current?._observer?.disconnect(), []);

  // Grow the iframe to its content, and keep growing as late images load.
  const onLoad = () => {
    const el = frame.current;
    const fit = () => {
      try {
        // The body's height, not the document's: the document is never shorter than the frame.
        el.style.height = `${el.contentDocument.body.scrollHeight + 4}px`;
      } catch {
        /* keep the CSS height */
      }
    };
    fit();
    try {
      el._observer = new ResizeObserver(fit);
      el._observer.observe(el.contentDocument.body);
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
      srcDoc={doc}
      onLoad={onLoad}
    />
  );
}

const joinPeople = (list, me) => (list || []).map((p) => personLabel(p, me)).join(', ');

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
      {notice && <div className="banner">{notice}</div>}

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
                <strong>{displayName(head.from)}</strong>
                {head.from?.name && <span className="muted small">&lt;{head.from.address}&gt;</span>}
              </div>
              <button className="details-toggle muted small" onClick={() => setDetails(!details)}>
                to {joinPeople(head.to, me) || 'undisclosed recipients'}
                {head.cc?.length > 0 && <>, cc {joinPeople(head.cc, me)}</>}
                <Icon name="expandMore" size={16} />
              </button>
            </div>
            <div className="sender-meta">
              <span className="muted small nowrap" title={formatDate(head.date, true)}>
                {formatDate(head.date, true)} ({timeAgo(head.date)})
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
            {msg && (msg.html ? <HtmlBody html={msg.html} /> : <pre className="plain">{msg.text}</pre>)}
          </div>

          {msg?.attachments?.length > 0 && (
            <div className="attachments">
              <div className="muted small attachments-title">
                {msg.attachments.length} attachment{msg.attachments.length === 1 ? '' : 's'}
              </div>
              {msg.attachments.map((a) => (
                <button
                  key={a.index}
                  className="attachment"
                  disabled={a.unavailable}
                  title={a.unavailable ? 'Available once the copy reaches the Sent folder' : `Download ${a.filename}`}
                  onClick={() => download(`${url}/attachments/${a.index}`, a.filename).catch((err) => setError(err.message))}
                >
                  <span className="attachment-type">{(a.filename.split('.').pop() || 'file').slice(0, 4)}</span>
                  <span className="attachment-text">
                    <span className="attachment-name">{a.filename}</span>
                    <span className="muted small">{formatSize(a.size)}</span>
                  </span>
                  {!a.unavailable && <Icon name="download" size={18} />}
                </button>
              ))}
            </div>
          )}

          {msg && (onReply || onForward) && (
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
