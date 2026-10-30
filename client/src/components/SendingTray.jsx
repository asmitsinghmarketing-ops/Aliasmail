// The small card in the corner while mail is on its way out (like Gmail's "Sending…"): a progress
// ring, what's happening, Undo while it's still possible, and "Sent" once it has gone. It can be
// shrunk to just the ring so it never gets in the way.
import { uploadProgress } from '../attachmentUpload.js';
import Icon from './Icon.jsx';

const R = 15;
const CIRCLE = 2 * Math.PI * R;

function Ring({ pct, spinning, done }) {
  return (
    <span className={`tray-ring ${spinning ? 'spinning' : ''} ${done ? 'done' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 36 36" width="36" height="36">
        <circle className="tray-ring-track" cx="18" cy="18" r={R} />
        <circle
          className="tray-ring-fill"
          cx="18"
          cy="18"
          r={R}
          strokeDasharray={CIRCLE}
          strokeDashoffset={done ? 0 : spinning ? CIRCLE * 0.7 : CIRCLE * (1 - pct / 100)}
        />
      </svg>
      <span className="tray-ring-icon">
        <Icon name={done ? 'check' : 'send'} size={done ? 18 : 15} />
      </span>
    </span>
  );
}

export default function SendingTray({ items, justSent, minimized, onToggle, onView }) {
  if (!items.length && !justSent) return null;
  const done = !items.length;

  // One summary for everything on its way out.
  const files = items.flatMap((m) => m.files || []);
  const { loaded, total } = uploadProgress(files);
  const uploading = total > 0 && loaded < total;
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  const waiting = items.filter((m) => m.phase === 'waiting');
  const sendingNow = items.some((m) => m.phase === 'sending' || m.phase === 'uploading');
  const latestUndo = [...waiting].reverse().find((m) => m.undo);

  const subject = (m) => `“${m.subject || '(no subject)'}”`;
  const title = done ? `${subject(justSent)} sent` : items.length === 1 ? `Sending ${subject(items[0])}` : `Sending ${items.length} messages`;
  const detail = done
    ? 'Delivered to the mail server.'
    : uploading
      ? `Uploading attachments · ${pct}%`
      : sendingNow
        ? 'Sending…'
        : 'Sending in a moment…';

  if (minimized && !done) {
    return (
      <button type="button" className="send-tray mini" title={`${title} · ${detail}`} aria-label={`${title}. ${detail}. Show details`} onClick={onToggle}>
        <Ring pct={uploading ? pct : 0} spinning={!uploading && sendingNow} />
        {items.length > 1 && <span className="tray-badge">{items.length}</span>}
      </button>
    );
  }

  return (
    <div className={`send-tray ${done ? 'is-done' : ''}`} role="status" aria-live="polite">
      <Ring pct={uploading ? pct : 0} spinning={!done && !uploading && sendingNow} done={done} />
      <div className="tray-text">
        <strong className="tray-title">{title}</strong>
        <span className="tray-detail">{detail}</span>
      </div>
      <div className="tray-actions">
        {latestUndo && (
          <button type="button" className="tray-btn" onClick={latestUndo.undo}>
            Undo
          </button>
        )}
        {!done && (
          <button type="button" className="tray-btn" onClick={onView}>
            View
          </button>
        )}
        {!done && (
          <button type="button" className="icon-btn tray-min" title="Minimise" aria-label="Minimise" onClick={onToggle}>
            <Icon name="minimize" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
