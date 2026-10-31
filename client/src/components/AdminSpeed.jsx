// Admin → Speed: where the time goes when mail is sent and received. Each recent send and each
// newly arrived message is one bar, split into its hops, so the slow one stands out.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, timeAgo } from '../format.js';
import Icon from './Icon.jsx';

const HOPS = {
  uploadWait: { label: 'Attachment upload (wait)', color: '#adb5bd' },
  app: { label: 'AliasMail builds the email', color: '#7048e8' },
  network: { label: 'Network: app ↔ bridge', color: '#1c7ed6' },
  attach: { label: 'Bridge adds attachments', color: '#0c8599' },
  connect: { label: 'Relay: connect', color: '#2b8a3e' },
  envelope: { label: 'Relay: sender & recipients', color: '#5c940d' },
  upload: { label: 'Relay: message upload', color: '#f08c00' },
  accept: { label: 'Relay: spam & virus scan', color: '#e03131' },
  quit: { label: 'Relay: goodbye', color: '#868e96' },
  delivery: { label: 'Sender → your mailbox', color: '#1c7ed6' },
  notice: { label: 'Mailbox → AliasMail notices it', color: '#e8590c' },
  open: { label: 'Open folder', color: '#1c7ed6' },
  status: { label: 'Folder status', color: '#0c8599' },
  list: { label: 'List messages', color: '#7048e8' },
  fresh: { label: 'Read new messages', color: '#f08c00' },
  seen: { label: 'Read/unread flags', color: '#5c940d' },
  other: { label: 'Network & other', color: '#ced4da' },
};

const secs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const sum = (list) => list.reduce((a, b) => a + (b || 0), 0);
const avg = (list) => (list.length ? sum(list) / list.length : null);

/** One horizontal bar split into hops (widths relative to `scale`), each labelled on hover. */
function HopBar({ parts, scale }) {
  const total = sum(parts.map((p) => p.ms));
  return (
    <div className="hop-bar" style={{ width: `${Math.max(2, (total / scale) * 100)}%` }} role="img" aria-label={parts.map((p) => `${HOPS[p.hop].label} ${secs(p.ms)}`).join(', ')}>
      {parts.filter((p) => p.ms > 0).map((p) => (
        <span key={p.hop} title={`${HOPS[p.hop].label}: ${secs(p.ms)}`} style={{ flexGrow: p.ms, background: HOPS[p.hop].color }} />
      ))}
    </div>
  );
}

function Legend({ hops }) {
  return (
    <div className="hop-legend">
      {hops.map((h) => (
        <span key={h}><i style={{ background: HOPS[h].color }} />{HOPS[h].label}</span>
      ))}
    </div>
  );
}

// A send split into its hops; what the app spent waiting on the bridge, minus what the bridge
// reports, is the network between them.
function sendParts(s) {
  const t = s.timing || {};
  const r = t.relay || {};
  const relay = (r.totalMs || 0) + (r.attachMs || 0);
  return [
    { hop: 'uploadWait', ms: s.browser?.uploadWaitMs || 0 },
    { hop: 'app', ms: t.buildMs || 0 },
    { hop: 'network', ms: Math.max(0, (t.bridgeMs || 0) - relay) },
    { hop: 'attach', ms: r.attachMs || 0 },
    { hop: 'connect', ms: r.connectMs || 0 },
    { hop: 'envelope', ms: r.envelopeMs || 0 },
    { hop: 'upload', ms: r.uploadMs || 0 },
    { hop: 'accept', ms: r.acceptMs || 0 },
    { hop: 'quit', ms: r.quitMs || 0 },
  ];
}

function checkParts(run) {
  const parts = [];
  for (const step of run?.steps || []) {
    const b = step.bridge || {};
    const known = sum([b.openMs, b.statusMs, b.listMs, b.newMs, b.seenMs]);
    parts.push(
      { hop: 'open', ms: b.openMs || 0 }, { hop: 'status', ms: b.statusMs || 0 }, { hop: 'list', ms: b.listMs || 0 },
      { hop: 'fresh', ms: b.newMs || 0 }, { hop: 'seen', ms: b.seenMs || 0 }, { hop: 'other', ms: Math.max(0, (step.bridgeMs || 0) - known) },
    );
  }
  // Same hop from several folders adds up into one segment.
  const merged = {};
  for (const p of parts) merged[p.hop] = (merged[p.hop] || 0) + p.ms;
  return Object.entries(merged).map(([hop, ms]) => ({ hop, ms }));
}

export default function AdminSpeed() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('/admin/timings').then((d) => { setData(d); setError(''); }).catch((err) => setError(err.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const sends = data.sends || [];
  const receives = data.receives || [];
  const sendTotals = sends.map((s) => sum(sendParts(s).map((p) => p.ms)));
  const sendScale = Math.max(1, ...sendTotals);
  const receiveScale = Math.max(1, ...receives.map((r) => ((r.sentToMailboxSec || 0) + (r.mailboxToAliasMailSec || 0)) * 1000));
  const checkTotal = data.lastCheck?.ms || 0;
  const scans = sends.map((s) => s.timing?.relay?.acceptMs).filter((n) => n != null);
  const notice = receives.map((r) => r.mailboxToAliasMailSec).filter((n) => n != null);

  return (
    <div className="speed-page">
      <div className="page-head">
        <h1 className="page-title">Speed</h1>
        <span className="muted small">Live · refreshes every 5 s · kept since the app last restarted</span>
      </div>

      <div className="speed-tiles">
        <div className="card speed-tile">
          <span className="muted small">New mail is checked</span>
          <strong>every {data.checking?.everySeconds ?? '–'} s</strong>
          <span className={`small ${checkTotal > 10_000 ? 'text-red' : 'muted'}`}>
            last check took {checkTotal ? secs(checkTotal) : '–'}{data.checking?.failing ? ' · failing' : ''}
          </span>
        </div>
        <div className="card speed-tile">
          <span className="muted small">Sending (after Undo)</span>
          <strong>{sendTotals.length ? secs(avg(sendTotals)) : '–'}</strong>
          <span className="muted small">average of last {sends.length || 0}</span>
        </div>
        <div className="card speed-tile">
          <span className="muted small">GoDaddy relay spam scan</span>
          <strong>{scans.length ? secs(avg(scans)) : '–'}</strong>
          <span className="muted small">part of sending</span>
        </div>
        <div className="card speed-tile">
          <span className="muted small">New mail noticed after</span>
          <strong>{notice.length ? secs(avg(notice) * 1000) : '–'}</strong>
          <span className="muted small">from reaching your mailbox</span>
        </div>
      </div>

      <section className="card speed-card">
        <h2 className="card-title">Recent sends</h2>
        {sends.length === 0 ? (
          <p className="muted">Nothing sent since the app last restarted. Send an email and it appears here with each hop.</p>
        ) : (
          <>
            <Legend hops={['uploadWait', 'app', 'network', 'attach', 'connect', 'envelope', 'upload', 'accept', 'quit']} />
            <ul className="hop-rows">
              {sends.map((s, i) => (
                <li key={s.at + i}>
                  <div className="hop-row-head">
                    <span className="hop-row-title">
                      {s.from} → {s.recipients} recipient{s.recipients === 1 ? '' : 's'}
                      {s.attachments > 0 && <span className="muted"> · {s.attachments} attachment{s.attachments === 1 ? '' : 's'}</span>}
                    </span>
                    <span className="hop-row-total">{secs(sendTotals[i])}</span>
                  </div>
                  <HopBar parts={sendParts(s)} scale={sendScale} />
                  <div className="muted small">
                    {timeAgo(s.at)} · {s.timing?.route || ''}
                    {s.timing?.sentCopyMs != null && ` · copy saved to Sent in ${secs(s.timing.sentCopyMs)}`}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card speed-card">
        <h2 className="card-title">Recently received</h2>
        {receives.length === 0 ? (
          <p className="muted">No new mail since the app last restarted. When some arrives, it shows here: how long it took to reach your mailbox, and how long until AliasMail noticed it.</p>
        ) : (
          <>
            <Legend hops={['delivery', 'notice']} />
            <ul className="hop-rows">
              {receives.map((r, i) => (
                <li key={r.detectedAt + i}>
                  <div className="hop-row-head">
                    <span className="hop-row-title">{r.subject || '(no subject)'} <span className="muted">· {r.from}</span></span>
                    <span className="hop-row-total">{secs(((r.sentToMailboxSec || 0) + (r.mailboxToAliasMailSec || 0)) * 1000)}</span>
                  </div>
                  <HopBar parts={[{ hop: 'delivery', ms: Math.max(0, (r.sentToMailboxSec || 0) * 1000) }, { hop: 'notice', ms: Math.max(0, (r.mailboxToAliasMailSec || 0) * 1000) }]} scale={receiveScale} />
                  <div className="muted small">
                    reached the mailbox {formatDate(r.arrivedAt, true)} · AliasMail saw it {r.mailboxToAliasMailSec} s later
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card speed-card">
        <h2 className="card-title">Last mail check</h2>
        {!data.lastCheck ? (
          <p className="muted">No check recorded yet.</p>
        ) : (
          <>
            <Legend hops={['open', 'status', 'list', 'fresh', 'seen', 'other']} />
            <div className="hop-row-head">
              <span className="hop-row-title">
                {data.lastCheck.quick ? 'Quick inbox check' : 'Full check'} · {(data.lastCheck.steps || []).map((s) => `${s.folder} via ${s.via}${s.fetched ? `, ${s.fetched} new` : ''}${s.hasMore ? ' (still importing older mail)' : ''}`).join(' · ')}
              </span>
              <span className="hop-row-total">{secs(checkTotal)}</span>
            </div>
            <HopBar parts={checkParts(data.lastCheck)} scale={Math.max(checkTotal, 1)} />
          </>
        )}
      </section>

      <p className="muted small speed-note">
        <Icon name="info" size={14} /> Hover a bar segment for its exact time. These numbers live in memory, so they reset whenever the app restarts or is published again.
      </p>
    </div>
  );
}
