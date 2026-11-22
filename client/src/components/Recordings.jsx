// Meetings: a calendar of scheduled meetings (upcoming and past) and recorded calls. Days with
// meetings and with recordings are marked; picking a day lists them: join or copy the link of a
// meeting, play or download a recording. Recordings are deleted automatically a set number of days
// after the meeting (15 by default).
import { localDate } from '../format.js';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { joinByCode, meetingLink, startMeeting } from '../calls.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import ScheduleMeeting from './ScheduleMeeting.jsx';

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

const MEETING_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const dayKey = localDate; // "2026-11-21"
const fromKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const longDay = (date) => date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

function deletesIn(iso) {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  if (days <= 0) return 'Deleted soon';
  if (days === 1) return 'Deleted tomorrow';
  return `Deleted in ${days} days`;
}

function startsIn(meeting) {
  const minutes = Math.round((Date.parse(meeting.startAt) - Date.now()) / 60_000);
  if (meeting.live) return 'In progress';
  if (Date.parse(meeting.endAt) < Date.now()) return 'Ended';
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `In ${minutes} min`;
  const days = Math.round((fromKey(dayKey(new Date(meeting.startAt))) - fromKey(dayKey(new Date()))) / 86_400_000);
  if (days === 0) return `Today, in ${Math.round(minutes / 60)} h`;
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

/** Weeks of the month, Monday first; days outside the month are null. */
function monthGrid(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  while (cells.length % 7) cells.push(null);
  return cells;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function DriveNote({ drive }) {
  if (!drive) return null;
  if (drive.status === 'saved') return <a className="recording-drive saved" href={drive.link} target="_blank" rel="noreferrer"><Icon name="check" size={15} /> Copy in your Google Drive</a>;
  if (drive.status === 'uploading') return <span className="recording-drive">Copying to your Google Drive…</span>;
  if (drive.status === 'failed') return <span className="recording-drive problem">Couldn’t copy it to Google Drive</span>;
  return null;
}

function MeetingCard({ meeting, onJoin, onEdit, onCancel }) {
  const [copied, setCopied] = useState(false);
  const ended = !meeting.live && Date.parse(meeting.endAt) < Date.now();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meetingLink(meeting.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* nothing to copy to */ }
  };
  const others = meeting.invitees.filter((person) => !(meeting.mine && person.address === meeting.host.address));
  return (
    <article className={`meeting-card ${meeting.live ? 'live' : ''} ${ended ? 'ended' : ''}`}>
      <span className="recording-time">
        <strong>{clock(meeting.startAt)}</strong>
        <small>{clock(meeting.endAt)}</small>
      </span>
      <div className="recording-info">
        <strong>{meeting.title}</strong>
        <span>
          {meeting.mine ? 'You organise' : `Organised by ${meeting.host.name}`}
          {others.length ? ` · with ${others.map((person) => person.name).join(', ')}` : ''}
        </span>
        <span className={`meeting-when ${meeting.live ? 'live' : ''}`}>{meeting.live && <i />}{startsIn(meeting)}</span>
        {meeting.description && <p className="meeting-note">{meeting.description}</p>}
      </div>
      <div className="recording-actions">
        {!ended && <button type="button" className="btn btn-primary" onClick={() => onJoin(meeting)}><Icon name="videocam" size={17} /> {meeting.live ? 'Join' : 'Start'}</button>}
        <button type="button" className="btn btn-outline" onClick={copy} title={meetingLink(meeting.code)}><Icon name={copied ? 'check' : 'link'} size={17} /> {copied ? 'Copied' : 'Copy link'}</button>
        {meeting.canEdit && !ended && <button type="button" className="icon-btn" title="Change meeting" aria-label={`Change ${meeting.title}`} onClick={() => onEdit(meeting)}><Icon name="edit" size={19} /></button>}
        {meeting.canEdit && <button type="button" className="icon-btn" title="Cancel meeting" aria-label={`Cancel ${meeting.title}`} onClick={() => onCancel(meeting)}><Icon name="trash" size={19} /></button>}
      </div>
    </article>
  );
}

/** Under a calendar day: a dot each for up to 3 things, then one dot and how many. */
function DayMarks({ kind, count }) {
  if (!count) return null;
  if (count > 3) return <span className={`recordings-mark-count ${kind}`}><i className={kind} />{count}</span>;
  return Array.from({ length: count }, (_, n) => <i key={n} className={kind} />);
}

export default function Recordings({ me, onClose }) {
  const [data, setData] = useState(null); // recordings: { items, keepDays }
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [day, setDay] = useState(null); // a dayKey, chosen once everything has loaded
  const [editing, setEditing] = useState(null); // null | 'new' | a meeting

  const load = () => Promise.all([
    api('/recordings').then(setData),
    api('/meetings').then((result) => setMeetings(result.items)),
  ]).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);
  // Still recording, copying to Drive, or a meeting about to start: look again in a little while.
  const busy = data?.items.some((item) => item.status === 'recording' || item.drive?.status === 'uploading')
    || meetings?.some((meeting) => meeting.live || Math.abs(Date.parse(meeting.startAt) - Date.now()) < 60 * 60_000);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [busy]);

  const byDay = useMemo(() => {
    const map = new Map();
    const entry = (key) => {
      if (!map.has(key)) map.set(key, { meetings: [], recordings: [] });
      return map.get(key);
    };
    for (const item of data?.items || []) entry(dayKey(new Date(item.startedAt))).recordings.push(item);
    for (const meeting of meetings || []) entry(dayKey(new Date(meeting.startAt))).meetings.push(meeting);
    for (const value of map.values()) {
      value.recordings.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      value.meetings.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [data, meetings]);

  const upcoming = useMemo(() => (meetings || [])
    .filter((meeting) => meeting.live || Date.parse(meeting.endAt) > Date.now())
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 5), [meetings]);

  // Start on today if anything is on; else the next meeting; else the latest recording; else today.
  useEffect(() => {
    if (!data || !meetings || day) return;
    const today = dayKey(new Date());
    const next = upcoming[0] && new Date(upcoming[0].startAt);
    const latest = data.items[0] && new Date(data.items[0].startedAt);
    const chosen = byDay.has(today) ? new Date() : next || latest || new Date();
    setDay(dayKey(chosen));
    setMonth(new Date(chosen.getFullYear(), chosen.getMonth(), 1));
  }, [data, meetings, day, byDay, upcoming]);

  async function removeRecording(item) {
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

  async function cancelMeeting(meeting) {
    const future = Date.parse(meeting.endAt) > Date.now();
    const sure = await ask({
      title: future ? 'Cancel this meeting?' : 'Remove this meeting?',
      message: future ? `“${meeting.title}” will be cancelled, invited teammates told, and its link will stop working.` : `“${meeting.title}” will be removed from the calendar. Its recordings stay.`,
      confirmLabel: future ? 'Cancel meeting' : 'Remove',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!sure) return;
    try {
      await api(`/meetings/${meeting.id}`, { method: 'DELETE' });
      setMeetings((current) => current.filter((other) => other.id !== meeting.id));
    } catch (err) {
      setError(err.message);
    }
  }

  const join = (meeting) => joinByCode(meeting.code, { video: true }).then(load).catch((err) => setError(err.message));

  // Start one now, or join with a code (or a whole meeting link) someone sent.
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);
  const run = async (action) => {
    setError('');
    setStarting(true);
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };
  const startNow = () => run(() => startMeeting({ video: true }));
  const joinWithCode = (event) => {
    event.preventDefault();
    const found = MEETING_CODE.exec(code.trim().toLowerCase());
    if (!found) return setError('Enter a meeting code like abc-defg-hij, or paste the meeting link.');
    return run(() => joinByCode(found[0], { video: true }).then(() => setCode('')));
  };

  const saved = (meeting) => {
    setMeetings((current) => [...(current || []).filter((other) => other.id !== meeting.id), meeting]);
    const date = new Date(meeting.startAt);
    setDay(dayKey(date));
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  const today = dayKey(new Date());
  const oldest = data ? dayKey(new Date(Date.now() - data.keepDays * 86_400_000)) : null;
  const shown = (day && byDay.get(day)) || { meetings: [], recordings: [] };
  const moveMonth = (step) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + step, 1));
  const pick = (date) => {
    setDay(dayKey(date));
    setPlaying(null);
  };
  const goToday = () => {
    const now = new Date();
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    pick(now);
  };
  const pickedDate = day ? fromKey(day) : null;

  return (
    <div className="attendance-app recordings-app">
      <header className="tasks-topbar attendance-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Meet</strong>
        <span className="grow" />
        <button type="button" className="btn btn-outline" onClick={() => setEditing('new')}><Icon name="event" size={18} /> Schedule</button>
        <button type="button" className="btn btn-primary" disabled={starting} onClick={startNow}><Icon name="videocam" size={18} /> Start now</button>
      </header>

      <main className="attendance-main">
        <div className="attendance-heading">
          <div>
            <h1>Meet</h1>
            <p>Start or join a meeting, plan one ahead, and watch recorded calls. {data ? `Recordings are deleted automatically ${data.keepDays} days after the meeting, so download anything you want to keep.` : ''}</p>
          </div>
          <form className="meet-join" onSubmit={joinWithCode}>
            <Icon name="keyboard" size={18} />
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter a code or link" aria-label="Meeting code or link" autoComplete="off" spellCheck={false} />
            <button type="submit" className="btn btn-outline" disabled={starting || !code.trim()}>Join</button>
          </form>
        </div>
        {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {!data || !meetings ? <PanelSkeleton /> : (
          <div className="recordings-layout">
            <div className="recordings-side">
              <section className="recordings-calendar" aria-label="Calendar">
                <header>
                  <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => moveMonth(-1)}><Icon name="chevronLeft" /></button>
                  <strong>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
                  <button type="button" className="icon-btn" aria-label="Next month" onClick={() => moveMonth(1)}><Icon name="chevronRight" /></button>
                  <button type="button" className="btn btn-outline recordings-today" onClick={goToday}>Today</button>
                </header>
                <div className="recordings-grid" role="grid">
                  {WEEKDAYS.map((name) => <span key={name} className="recordings-weekday" role="columnheader">{name}</span>)}
                  {monthGrid(month).map((date, index) => {
                    if (!date) return <span key={`blank-${index}`} className="recordings-day blank" />;
                    const key = dayKey(date);
                    const on = byDay.get(key);
                    const meetingCount = on?.meetings.length || 0;
                    const recordingCount = on?.recordings.length || 0;
                    const classes = ['recordings-day', (meetingCount || recordingCount) && 'has', key === day && 'selected', key === today && 'today', key < oldest && 'outside'].filter(Boolean).join(' ');
                    const what = [meetingCount && `${meetingCount} meeting${meetingCount === 1 ? '' : 's'}`, recordingCount && `${recordingCount} recording${recordingCount === 1 ? '' : 's'}`].filter(Boolean).join(', ');
                    return (
                      <button key={key} type="button" role="gridcell" className={classes} aria-selected={key === day} aria-label={`${longDay(date)}${what ? `, ${what}` : ''}`} onClick={() => pick(date)}>
                        <span>{date.getDate()}</span>
                        {(meetingCount > 0 || recordingCount > 0) && (
                          <span className="recordings-marks" aria-hidden="true">
                            <DayMarks kind="meeting" count={meetingCount} />
                            <DayMarks kind="recording" count={recordingCount} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="recordings-legend">
                  <span><i className="meeting" /> Meetings</span>
                  <span><i className="recording" /> Recordings</span>
                </p>
              </section>

              <section className="upcoming" aria-label="Upcoming meetings">
                <h2>Upcoming</h2>
                {!upcoming.length ? <p className="muted small">Nothing scheduled. Use <strong>Schedule meeting</strong> to plan one and get a link.</p> : (
                  <ul>
                    {upcoming.map((meeting) => (
                      <li key={meeting.id}>
                        <button type="button" onClick={() => { const date = new Date(meeting.startAt); setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); pick(date); }}>
                          <strong>{meeting.title}</strong>
                          <span>{new Date(meeting.startAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                          <em className={meeting.live ? 'live' : ''}>{startsIn(meeting)}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section className="recordings-day-list" aria-live="polite">
              <div className="recordings-day-head">
                <h2>{pickedDate ? longDay(pickedDate) : ''}</h2>
                {day >= today && <button type="button" className="btn btn-outline" onClick={() => setEditing('new')}><Icon name="add" size={17} /> Schedule this day</button>}
              </div>

              {!shown.meetings.length && !shown.recordings.length && (
                <div className="recordings-empty">
                  <span><Icon name="event" size={24} /></span>
                  <p>{day >= today ? 'Nothing scheduled this day.' : 'No meetings or recordings this day.'} Days with something on are marked in the calendar.</p>
                </div>
              )}

              {shown.meetings.length > 0 && (
                <>
                  <h3 className="recordings-section">Meetings</h3>
                  <div className="recordings-list">
                    {shown.meetings.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} onJoin={join} onEdit={setEditing} onCancel={cancelMeeting} />)}
                  </div>
                </>
              )}

              {shown.recordings.length > 0 && (
                <>
                  <h3 className="recordings-section">Recordings</h3>
                  <div className="recordings-list">
                    {shown.recordings.map((item) => (
                      <article key={item.id} className={`recording ${playing === item.id ? 'open' : ''}`}>
                        {playing === item.id && item.status === 'ready' && (
                          <video className="recording-player" src={`/api/recordings/${item.id}/video`} controls autoPlay playsInline />
                        )}
                        <div className="recording-row">
                          <span className="recording-time">
                            <strong>{clock(item.startedAt)}</strong>
                            {item.endedAt && <small>{clock(item.endedAt)}</small>}
                          </span>
                          <div className="recording-info">
                            <strong>{item.title}</strong>
                            <span>
                              {item.status === 'ready' ? `${length(item.durationMs)} · ${size(item.size)} · ` : ''}
                              {`recorded by ${item.mine ? 'you' : item.recorder.name}`}
                            </span>
                            {item.status === 'recording'
                              ? <span className="recording-live"><i /> Still recording</span>
                              : <span className="recording-expiry" title={new Date(item.deletesAt).toLocaleString()}>{deletesIn(item.deletesAt)}</span>}
                            <DriveNote drive={item.drive} />
                          </div>
                          <div className="recording-actions">
                            <button type="button" className="btn btn-outline" disabled={item.status !== 'ready'} onClick={() => setPlaying(playing === item.id ? null : item.id)}>
                              <Icon name={playing === item.id ? 'close' : 'play'} size={17} /> {playing === item.id ? 'Close' : 'Play'}
                            </button>
                            {item.status === 'ready' && <a className="btn btn-primary" href={`/api/recordings/${item.id}/video?download=1`} download><Icon name="download" size={17} /> Download</a>}
                            {item.canDelete && <button type="button" className="icon-btn" title="Delete recording" aria-label={`Delete ${item.title}`} onClick={() => removeRecording(item)}><Icon name="trash" size={19} /></button>}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </main>

      {editing && (
        <ScheduleMeeting
          me={me}
          day={editing === 'new' && day ? fromKey(day) : null}
          meeting={editing === 'new' ? null : editing}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
