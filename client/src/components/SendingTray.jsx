// "Message sent" with Undo, like Gmail, shown only for the undo window. The actual sending (and
// any attachment still uploading) carries on quietly in the background; its progress is in the
// Outbox, and only a failure is reported again.
import Icon from './Icon.jsx';

export default function SendingTray({ items, onView }) {
  const waiting = items.filter((m) => m.phase === 'waiting');
  if (!waiting.length) return null;
  const latest = waiting[waiting.length - 1];

  return (
    <div className="send-tray" role="status" aria-live="polite">
      <span className="tray-icon" aria-hidden="true">
        <Icon name="send" size={16} />
      </span>
      <span className="tray-title">{waiting.length === 1 ? 'Message sent' : `${waiting.length} messages sent`}</span>
      <div className="tray-actions">
        {latest.undo && (
          <button type="button" className="tray-btn" onClick={latest.undo}>
            Undo
          </button>
        )}
        <button type="button" className="tray-btn" onClick={onView}>
          View
        </button>
      </div>
    </div>
  );
}
