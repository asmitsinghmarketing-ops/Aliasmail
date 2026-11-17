// Explicit clock-in/out with a lightweight browser heartbeat. Admins see team presence and
// attendance history; everyone else sees only their own records.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { attendanceChanged } from '../attendance.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';

const STATUS = {
  online: ['Online', 'online'],
  away: ['Away', 'away'],
  offline: ['Offline', 'offline'],
  'clocked-out': ['Clocked out', 'out'],
};

const sameDay = (value, day = new Date()) => {
  const date = new Date(value);
  return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
};

function duration(start, end = Date.now()) {
  const milliseconds = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';

function Status({ value }) {
  const [label, kind] = STATUS[value] || STATUS.offline;
  return <span className={`attendance-status ${kind}`}><i />{label}</span>;
}

export default function Attendance({ user, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = (quiet = false) => {
    if (!quiet) setError('');
    return api('/attendance').then(setData).catch((err) => !quiet && setError(err.message));
  };

  useEffect(() => {
    void load();
    const poll = setInterval(() => load(true), 30_000);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleClock() {
    setBusy(true);
    setError('');
    try {
      await api(data.current ? '/attendance/clock-out' : '/attendance/clock-in', { method: 'POST', body: {} });
      attendanceChanged();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const today = useMemo(() => (data?.sessions || []).filter((session) => session.person === data.me && sameDay(session.clockInAt)), [data]);
  const todayMs = today.reduce((sum, session) => sum + Math.max(0, new Date(session.clockOutAt || Date.now()).getTime() - new Date(session.clockInAt).getTime()), 0);
  const todayDuration = duration(0, todayMs);
  const team = useMemo(() => [...(data?.team || [])].sort((a, b) => {
    const rank = { online: 0, away: 1, offline: 2, 'clocked-out': 3 };
    return (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || (a.name || a.address).localeCompare(b.name || b.address);
  }), [data]);
  const firstName = String(user?.displayName || user?.email || '').split(/\s|@/)[0];
  const clockParts = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const clockPart = (type) => clockParts.find((part) => part.type === type)?.value || '';

  return (
    <div className="attendance-app">
      <header className="tasks-topbar attendance-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Attendance</strong>
        <span className="grow" />
        {data && <button type="button" className={`btn ${data.current ? 'btn-outline attendance-clock-out' : 'btn-primary'}`} disabled={busy} onClick={toggleClock}><Icon name="clock" size={18} />{busy ? 'Saving…' : data.current ? 'Clock out' : 'Clock in'}</button>}
      </header>

      <main className="attendance-main">
        <div className="attendance-heading">
          <div><span className="muted small">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span><h1>{data?.isAdmin ? 'Team attendance' : `Hello${firstName ? `, ${firstName}` : ''}`}</h1><p>{data?.isAdmin ? 'See who is working and review recent attendance.' : 'Ready to start your workday?'}</p></div>
          <div className="attendance-privacy"><Icon name="shield" size={18} /><span>No screenshots, location, files or typed content are tracked.</span></div>
        </div>
        {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {!data ? <PanelSkeleton /> : (
          <>
            <section className="attendance-summary">
              <article className={`attendance-clock-card ${data.current ? 'working' : ''}`}>
                <div className="attendance-live-clock"><strong>{clockPart('hour')}:{clockPart('minute')}</strong><span>:{clockPart('second')} {clockPart('dayPeriod')}</span></div>
                <div className="attendance-card-head"><Status value={data.status} /><span className="attendance-since">{data.current ? `Working for ${duration(data.current.clockInAt)}` : 'Your timer is stopped'}</span></div>
                <button type="button" className={`attendance-punch ${data.current ? 'working' : ''}`} disabled={busy} onClick={toggleClock}>
                  <span><Icon name={data.current ? 'logout' : 'clock'} size={22} /></span>
                  <strong>{busy ? 'Saving…' : data.current ? 'Clock out' : 'Clock in'}</strong>
                  <small>{data.current ? `Started ${time(data.current.clockInAt)}` : 'Start tracking this work session'}</small>
                </button>
              </article>
              <article className="attendance-stat"><span>Today</span><strong>{todayDuration}</strong><small>{today.length} work session{today.length === 1 ? '' : 's'}</small></article>
              <article className="attendance-stat"><span>Last heartbeat</span><strong>{data.current ? time(data.current.lastSeenAt) : '—'}</strong><small>{data.current ? 'Stops when the laptop sleeps or the app goes offline' : 'Clocked out'}</small></article>
            </section>

            <section className="attendance-state-guide" aria-label="How attendance status works">
              <div><Status value="online" /><span>Nextspace is open and you are active.</span></div>
              <div><Status value="away" /><span>The app is in the background or idle.</span></div>
              <div><Status value="offline" /><span>The laptop is asleep, off, or disconnected.</span></div>
            </section>

            {data.isAdmin && (
              <section className="attendance-panel">
                <header><div><h2>Team status</h2><p>Offline means no heartbeat was received for about 90 seconds.</p></div><span>{data.team.filter((member) => member.status === 'online').length} online</span></header>
                <div className="attendance-team">
                  {team.map((member) => (
                    <article key={member.address}>
                      <Avatar person={member} url={member.avatarUrl} size="sm" />
                      <div><strong>{member.name || member.address}</strong><span>{member.address}</span></div>
                      <Status value={member.status} />
                      <div className="attendance-team-time"><span>Clocked in</span><strong>{member.current ? time(member.current.clockInAt) : '—'}</strong></div>
                      <div className="attendance-team-time"><span>Duration</span><strong>{member.current ? duration(member.current.clockInAt) : '—'}</strong></div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="attendance-panel attendance-history">
              <header><div><h2>{data.isAdmin ? 'Recent attendance' : 'My recent attendance'}</h2><p>Clock-in and clock-out records are retained for attendance reporting.</p></div></header>
              <div className="attendance-table-wrap">
                <table>
                  <thead><tr>{data.isAdmin && <th>Person</th>}<th>Date</th><th>Clock in</th><th>Clock out</th><th>Duration</th><th>State</th></tr></thead>
                  <tbody>
                    {data.sessions.map((session) => (
                      <tr key={session.id}>
                        {data.isAdmin && <td><strong>{session.name}</strong><span>{session.person}</span></td>}
                        <td>{new Date(session.clockInAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                        <td>{time(session.clockInAt)}</td>
                        <td>{session.clockOutAt ? time(session.clockOutAt) : 'In progress'}</td>
                        <td>{duration(session.clockInAt, session.clockOutAt || Date.now())}</td>
                        <td><Status value={session.status} /></td>
                      </tr>
                    ))}
                    {!data.sessions.length && <tr><td colSpan={data.isAdmin ? 6 : 5} className="attendance-empty">No attendance records yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
