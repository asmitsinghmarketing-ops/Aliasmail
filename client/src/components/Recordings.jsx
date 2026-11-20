// Call recordings kept in Nextspace: the ones this person was in (the admin sees all), to play,
// download, or delete if they recorded it.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';

function length(ms) {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0'));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${parts.join(':')}` : parts.join(':');
}

function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function DriveNote({ drive }) {
  if (!drive) return null;
  if (drive.status === 'saved') return <a className="recording-drive saved" href={drive.link} target="_blank" rel="noreferrer"><Icon name="check" size={15} /> Copy in your Google Drive</a>;
  if (drive.status === 'uploading') return <span className="recording-drive">Copying to your Google Drive…</span>;
  if (drive.status === 'failed') return <span className="recording-drive problem">Couldn’t copy it to Google Drive</span>;
  return <span className="recording-drive">Connect Google Drive in Settings → Security to keep copies there too</span>;
}

export default function Recordings({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);

  const load = () => api('/recordings').then(setData).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);
  // Still recording, or still copying to Drive: look again in a little while.
  const busy = data?.items.some((item) => item.status === 'recording' || item.drive?.status === 'uploading');
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [busy]);

  async function remove(item) {
    const sure = await ask({ title: 'Delete this recording?', message: `“${item.title}” will be deleted for everyone who was in the call. A copy in Google Drive stays there.`, confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try {
      await api(`/recordings/${item.id}`, { method: 'DELETE' });
      if (playing === item.id) setPlaying(null);
      setData((current) => ({ ...current, items: current.items.filter((other) => other.id !== item.id) }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="attendance-app recordings-app">
      <header className="tasks-topbar attendance-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Recordings</strong>
      </header>

      <main className="attendance-main">
        <div className="attendance-heading">
          <div>
            <h1>Call recordings</h1>
            <p>Calls you were in that someone recorded. {data ? `They are kept for ${data.keepDays} days.` : ''}</p>
          </div>
        </div>
        {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {!data ? <PanelSkeleton /> : !data.items.length ? (
          <section className="recordings-empty">
            <span><Icon name="record" size={26} /></span>
            <h2>No recordings yet</h2>
            <p>In a call, press <strong>Record</strong>. When you stop, the recording appears here for everyone from your team who was in the call.</p>
          </section>
        ) : (
          <section className="recordings-list">
            {data.items.map((item) => (
              <article key={item.id} className={`recording ${playing === item.id ? 'open' : ''}`}>
                {playing === item.id && item.status === 'ready' && (
                  <video className="recording-player" src={`/api/recordings/${item.id}/video`} controls autoPlay playsInline />
                )}
                <div className="recording-row">
                  <button type="button" className="recording-play" disabled={item.status !== 'ready'} aria-label={playing === item.id ? 'Close player' : `Play ${item.title}`} onClick={() => setPlaying(playing === item.id ? null : item.id)}>
                    <Icon name={playing === item.id ? 'close' : 'play'} size={22} />
                  </button>
                  <div className="recording-info">
                    <strong>{item.title}</strong>
                    <span>
                      {when(item.startedAt)}
                      {item.status === 'ready' ? ` · ${length(item.durationMs)} · ${size(item.size)}` : ''}
                      {` · recorded by ${item.mine ? 'you' : item.recorder.name}`}
                    </span>
                    {item.status === 'recording' && <span className="recording-live"><i /> Still recording</span>}
                    <DriveNote drive={item.drive} />
                  </div>
                  <div className="recording-actions">
                    {item.status === 'ready' && <a className="btn btn-outline" href={`/api/recordings/${item.id}/video?download=1`} download><Icon name="download" size={17} /> Download</a>}
                    {item.canDelete && <button type="button" className="icon-btn" title="Delete recording" aria-label={`Delete ${item.title}`} onClick={() => remove(item)}><Icon name="trash" size={19} /></button>}
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
