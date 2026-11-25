// Meet: start or join a meeting, and a calendar of scheduled meetings and recorded calls. The
// calendar shows a month, a week (with times) or an agenda list; it can be searched and filtered,
// moved through with the keyboard, and a free slot clicked to plan a meeting there. Picking a day
// lists what's on: join, copy or share a meeting, add it to another calendar, duplicate, change or
// cancel it; play, download or delete a recording. Recordings are deleted automatically a set
// number of days after the meeting (15 by default).
import { localDate } from '../format.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { joinByCode, meetingLink, startMeeting } from '../calls.js';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import ScheduleMeeting from './ScheduleMeeting.jsx';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MEETING_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const VIEW_KEY = 'nextspace:meet-calendar-view';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_PX = 52; // one hour in the week view

const dayKey = localDate; // "2026-11-21"
const fromKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const startOfWeek = (date) => addDays(date, -((date.getDay() + 6) % 7)); // Monday
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
const clock = (date) => new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const longDay = (date) => date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

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

const hoursText = (minutes) => {
  if (!minutes) return '0 h';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};

function deletesIn(iso) {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / DAY);
  if (days <= 0) return 'Deleted soon';
  if (days === 1) return 'Deleted tomorrow';
  return `Deleted in ${days} days`;
}

function startsIn(meeting) {
  const minutes = Math.round((Date.parse(meeting.startAt) - Date.now()) / MINUTE);
  if (meeting.live) return 'In progress';
  if (Date.parse(meeting.endAt) < Date.now()) return 'Ended';
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `In ${minutes} min`;
  const days = Math.round((fromKey(dayKey(new Date(meeting.startAt))) - fromKey(dayKey(new Date()))) / DAY);
  if (days === 0) return `Today, in ${Math.round(minutes / 60)} h`;
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

/* ---------------------------------- calendar files ---------------------------------- */

const icsDate = (date) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (text = '') => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function icsEvent(meeting) {
  const link = meetingLink(meeting.code);
  return [
    'BEGIN:VEVENT',
    `UID:${meeting.id}@nextspace`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(meeting.startAt)}`,
    `DTEND:${icsDate(meeting.endAt)}`,
    `SUMMARY:${icsText(meeting.title)}`,
    `DESCRIPTION:${icsText(`${meeting.description ? `${meeting.description}\n\n` : ''}Join: ${link}`)}`,
    `URL:${link}`,
    `LOCATION:${icsText(link)}`,
    'END:VEVENT',
  ].join('\r\n');
}

/** A .ics file other calendars (Outlook, Apple, Google) can import. */
function downloadIcs(meetings, name) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nextspace//Meet//EN', 'CALSCALE:GREGORIAN', ...meetings.map(icsEvent), 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'meeting'}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const googleCalendarLink = (meeting) => `https://calendar.google.com/calendar/render?${new URLSearchParams({
  action: 'TEMPLATE',
  text: meeting.title,
  dates: `${icsDate(meeting.startAt)}/${icsDate(meeting.endAt)}`,
  details: `${meeting.description ? `${meeting.description}\n\n` : ''}Join: ${meetingLink(meeting.code)}`,
  location: meetingLink(meeting.code),
})}`;

const inviteMail = (meeting) => `mailto:?${new URLSearchParams({
  subject: `Invitation: ${meeting.title}`,
  body: `${meeting.title}\n${new Date(meeting.startAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} – ${clock(meeting.endAt)}\n\nJoin: ${meetingLink(meeting.code)}${meeting.description ? `\n\n${meeting.description}` : ''}`,
}).toString().replace(/\+/g, '%20')}`;

/* ---------------------------------- events ---------------------------------- */

/** Meetings and recordings as one kind of thing with a start and an end. */
function toEvents(meetings, recordings) {
  const events = [];
  for (const meeting of meetings) {
    events.push({ kind: 'meeting', id: `m:${meeting.id}`, title: meeting.title, start: new Date(meeting.startAt), end: new Date(meeting.endAt), live: meeting.live, mine: meeting.mine, item: meeting });
  }
  for (const item of recordings) {
    const start = new Date(item.startedAt);
    const end = item.endedAt ? new Date(item.endedAt) : new Date(start.getTime() + Math.max(item.durationMs || 0, 15 * MINUTE));
    events.push({ kind: 'recording', id: `r:${item.id}`, title: item.title, start, end, live: item.status === 'recording', mine: item.mine, item });
  }
  return events.sort((a, b) => a.start - b.start);
}

const eventClass = (event) => ['cal-event', event.kind, event.live && 'live', event.kind === 'meeting' && event.end < new Date() && !event.live && 'past'].filter(Boolean).join(' ');

/* ---------------------------------- cards ---------------------------------- */

function DriveNote({ drive }) {
  if (!drive) return null;
  if (drive.status === 'saved') return <a className="recording-drive saved" href={drive.link} target="_blank" rel="noreferrer"><Icon name="check" size={15} /> Copy in your Google Drive</a>;
  if (drive.status === 'uploading') return <span className="recording-drive">Copying to your Google Drive…</span>;
  if (drive.status === 'failed') return <span className="recording-drive problem">Couldn’t copy it to Google Drive</span>;
  return null;
}

function MeetingCard({ meeting, highlighted, onJoin, onEdit, onCancel, onDuplicate }) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  const card = useRef(null);
  const ended = !meeting.live && Date.parse(meeting.endAt) < Date.now();
  useEffect(() => {
    if (highlighted) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlighted]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setMenu(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meetingLink(meeting.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* nothing to copy to */ }
  };
  const others = meeting.invitees.filter((person) => !(meeting.mine && person.address === meeting.host.address));
  return (
    <article ref={card} className={`meeting-card ${meeting.live ? 'live' : ''} ${ended ? 'ended' : ''} ${highlighted ? 'highlighted' : ''}`}>
      <span className="meeting-card-icon"><Icon name="videocam" size={19} /></span>
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
        <div className="cal-more" ref={menuRef}>
          <button type="button" className="icon-btn" aria-label={`More for ${meeting.title}`} aria-expanded={menu} title="More" onClick={() => setMenu((open) => !open)}><Icon name="moreVert" size={19} /></button>
          {menu && (
            <div className="cal-menu" role="menu">
              {!ended && <a role="menuitem" href={inviteMail(meeting)} onClick={() => setMenu(false)}><Icon name="mail" size={18} /> Email an invitation</a>}
              {!ended && <a role="menuitem" href={googleCalendarLink(meeting)} target="_blank" rel="noopener noreferrer" onClick={() => setMenu(false)}><Icon name="event" size={18} /> Add to Google Calendar</a>}
              {!ended && <button type="button" role="menuitem" onClick={() => { setMenu(false); downloadIcs([meeting], meeting.title); }}><Icon name="download" size={18} /> Download for Outlook / Apple (.ics)</button>}
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onDuplicate(meeting); }}><Icon name="copy" size={18} /> Duplicate</button>
              {meeting.canEdit && !ended && <button type="button" role="menuitem" onClick={() => { setMenu(false); onEdit(meeting); }}><Icon name="edit" size={18} /> Change meeting</button>}
              {meeting.canEdit && <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); onCancel(meeting); }}><Icon name="trash" size={18} /> {ended ? 'Remove from calendar' : 'Cancel meeting'}</button>}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function RecordingCard({ item, playing, highlighted, onPlay, onDelete }) {
  const card = useRef(null);
  useEffect(() => {
    if (highlighted) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlighted]);
  return (
    <article ref={card} className={`recording ${playing ? 'open' : ''} ${highlighted ? 'highlighted' : ''}`}>
      {playing && item.status === 'ready' && <video className="recording-player" src={`/api/recordings/${item.id}/video`} controls autoPlay playsInline />}
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
          <button type="button" className="btn btn-outline" disabled={item.status !== 'ready'} onClick={onPlay}>
            <Icon name={playing ? 'close' : 'play'} size={17} /> {playing ? 'Close' : 'Play'}
          </button>
          {item.status === 'ready' && <a className="btn btn-primary" href={`/api/recordings/${item.id}/video?download=1`} download><Icon name="download" size={17} /> Download</a>}
          {item.canDelete && <button type="button" className="icon-btn" title="Delete recording" aria-label={`Delete ${item.title}`} onClick={onDelete}><Icon name="trash" size={19} /></button>}
        </div>
      </div>
    </article>
  );
}

/* ---------------------------------- views ---------------------------------- */

function MonthView({ month, byDay, day, today, onPick, onCreate, onOpenEvent }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = startOfWeek(first);
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  return (
    <div className="cal-month" role="grid" aria-label={month.toLocaleDateString([], { month: 'long', year: 'numeric' })}>
      {WEEKDAYS.map((name) => <span key={name} className="cal-weekday" role="columnheader">{name}</span>)}
      {cells.map((date) => {
        const key = dayKey(date);
        const events = byDay.get(key) || [];
        const shown = events.slice(0, 3);
        const more = events.length - shown.length;
        const classes = ['cal-cell', !sameMonth(date, month) && 'other', key === day && 'selected', key === today && 'today', events.length && 'has', (date.getDay() + 6) % 7 >= 5 && 'weekend'].filter(Boolean).join(' ');
        const label = `${longDay(date)}${events.length ? `, ${events.length} item${events.length === 1 ? '' : 's'}` : ''}`;
        return (
          <div
            key={key}
            role="gridcell"
            aria-selected={key === day}
            aria-label={label}
            tabIndex={key === day ? 0 : -1}
            className={classes}
            onClick={() => onPick(date)}
            onDoubleClick={() => key >= today && onCreate(date)}
            onKeyDown={(event) => { if (event.key === 'Enter') onPick(date); }}
          >
            <span className="cal-cell-head">
              <span className="cal-date">{date.getDate()}</span>
              {key >= today && <button type="button" className="cal-add" aria-label={`Schedule on ${longDay(date)}`} title="Schedule a meeting this day" onClick={(event) => { event.stopPropagation(); onCreate(date); }}><Icon name="add" size={16} /></button>}
            </span>
            <span className="cal-chips">
              {shown.map((event) => (
                <button key={event.id} type="button" className={eventClass(event)} title={`${clock(event.start)} ${event.title}`} onClick={(e) => { e.stopPropagation(); onOpenEvent(event); }}>
                  <i />
                  <time>{clock(event.start)}</time>
                  <span>{event.title}</span>
                </button>
              ))}
              {more > 0 && <span className="cal-more-count">+{more} more</span>}
            </span>
            {events.length > 0 && (
              <span className="cal-dots" aria-hidden="true">
                {events.slice(0, 4).map((event) => <i key={event.id} className={event.kind} />)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Side by side columns for events that overlap in time. */
function placeDay(events) {
  const placed = [];
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = [];
    for (const event of cluster) {
      let lane = lanes.findIndex((end) => end <= event.start.getTime());
      if (lane < 0) lane = lanes.length;
      lanes[lane] = event.end.getTime();
      placed.push({ event, lane });
    }
    for (const item of placed.slice(placed.length - cluster.length)) item.lanes = lanes.length;
    cluster = [];
  };
  for (const event of events) {
    if (cluster.length && event.start.getTime() >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, event.end.getTime());
  }
  if (cluster.length) flush();
  return placed;
}

function WeekView({ weekStart, byDay, day, today, onPick, onCreate, onOpenEvent }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const scroller = useRef(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  const all = days.flatMap((date) => byDay.get(dayKey(date)) || []);
  const firstHour = Math.min(7, ...all.map((event) => event.start.getHours()));
  const lastHour = Math.max(21, ...all.map((event) => Math.min(24, event.end.getHours() + (event.end.getMinutes() ? 1 : 0))));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const top = (date) => ((date.getHours() - firstHour) * 60 + date.getMinutes()) / 60 * HOUR_PX;

  // Open on the working day (or now), not at midnight.
  useEffect(() => {
    const focus = days.some((date) => dayKey(date) === today) ? Math.max(0, now.getHours() - 1) : 8;
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (focus - firstHour) * HOUR_PX);
  }, [dayKey(weekStart)]); // eslint-disable-line react-hooks/exhaustive-deps

  const slotClick = (date, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((event.clientY - rect.top) / HOUR_PX) * 2) * 30 + firstHour * 60;
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
    onPick(date);
    if (at.getTime() > Date.now()) onCreate(date, at);
  };

  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <span className="cal-gutter" />
        {days.map((date) => {
          const key = dayKey(date);
          return (
            <button key={key} type="button" className={`cal-week-day ${key === today ? 'today' : ''} ${key === day ? 'selected' : ''}`} onClick={() => onPick(date)}>
              <small>{WEEKDAYS[(date.getDay() + 6) % 7]}</small>
              <strong>{date.getDate()}</strong>
            </button>
          );
        })}
      </div>
      <div className="cal-week-body" ref={scroller}>
        <div className="cal-hours" style={{ height: hours.length * HOUR_PX }}>
          {hours.map((hour) => <span key={hour} style={{ top: (hour - firstHour) * HOUR_PX }}>{new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })}</span>)}
        </div>
        {days.map((date) => {
          const key = dayKey(date);
          const placed = placeDay(byDay.get(key) || []);
          return (
            <div key={key} className={`cal-col ${key === today ? 'today' : ''} ${key < today ? 'past' : ''}`} style={{ height: hours.length * HOUR_PX, '--hour': `${HOUR_PX}px` }} onClick={(event) => slotClick(date, event)} title={key >= today ? 'Click a time to schedule a meeting' : undefined}>
              {placed.map(({ event, lane, lanes }) => {
                const y = top(event.start);
                const h = Math.max(24, top(event.end) - y - 2);
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`${eventClass(event)} block ${h < 40 ? 'short' : ''}`}
                    style={{ top: y, height: h, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                    onClick={(e) => { e.stopPropagation(); onOpenEvent(event); }}
                    title={`${clock(event.start)}–${clock(event.end)} ${event.title}`}
                  >
                    <strong>{event.title}</strong>
                    <time>{clock(event.start)}–{clock(event.end)}</time>
                  </button>
                );
              })}
              {key === today && now.getHours() >= firstHour && now.getHours() < lastHour && <span className="cal-now" style={{ top: top(now) }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({ events, today, onOpenEvent, onPick, query }) {
  const [showPast, setShowPast] = useState(Boolean(query));
  useEffect(() => { if (query) setShowPast(true); }, [query]);
  const now = Date.now();
  const upcoming = events.filter((event) => event.end.getTime() >= now || event.live);
  const past = events.filter((event) => !(event.end.getTime() >= now || event.live)).reverse();
  const group = (list) => {
    const groups = [];
    for (const event of list) {
      const key = dayKey(event.start);
      if (groups.at(-1)?.key !== key) groups.push({ key, events: [] });
      groups.at(-1).events.push(event);
    }
    return groups;
  };
  const renderGroups = (groups) => groups.map(({ key, events: list }) => {
    const date = fromKey(key);
    const relative = key === today ? 'Today' : key === dayKey(addDays(new Date(), 1)) ? 'Tomorrow' : key === dayKey(addDays(new Date(), -1)) ? 'Yesterday' : '';
    return (
      <section key={key} className="cal-agenda-day">
        <button type="button" className={`cal-agenda-date ${key === today ? 'today' : ''}`} onClick={() => onPick(date)}>
          <strong>{date.getDate()}</strong>
          <span>{date.toLocaleDateString([], { weekday: 'short' })}<small>{date.toLocaleDateString([], { month: 'short' })}</small></span>
        </button>
        <div className="cal-agenda-items">
          {relative && <span className="cal-agenda-rel">{relative}</span>}
          {list.map((event) => (
            <button key={event.id} type="button" className={`${eventClass(event)} row`} onClick={() => onOpenEvent(event)}>
              <i />
              <time>{clock(event.start)} – {clock(event.end)}</time>
              <strong>{event.title}</strong>
              <small>{event.kind === 'meeting' ? (event.live ? 'Live now' : event.item.mine ? 'You organise' : `By ${event.item.host.name}`) : event.live ? 'Recording now' : `Recording · ${length(event.item.durationMs)}`}</small>
            </button>
          ))}
        </div>
      </section>
    );
  });
  return (
    <div className="cal-agenda">
      {!upcoming.length && <p className="cal-agenda-empty">{query ? 'Nothing upcoming matches your search.' : 'Nothing coming up. Schedule a meeting to see it here.'}</p>}
      {renderGroups(group(upcoming))}
      {past.length > 0 && (
        <>
          <button type="button" className="cal-agenda-toggle" onClick={() => setShowPast((open) => !open)} aria-expanded={showPast}>
            <Icon name="expandMore" size={18} className={showPast ? 'up' : ''} /> {showPast ? 'Hide' : 'Show'} earlier ({past.length})
          </button>
          {showPast && renderGroups(group(past))}
        </>
      )}
    </div>
  );
}

/* ---------------------------------- the page ---------------------------------- */

const readView = () => {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (['month', 'week', 'agenda'].includes(saved)) return saved;
  } catch { /* private window */ }
  return window.matchMedia?.('(max-width: 700px)').matches ? 'agenda' : 'month';
};

export default function Recordings({ me, onClose }) {
  const [data, setData] = useState(null); // recordings: { items, keepDays }
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const [view, setViewState] = useState(readView);
  const [cursor, setCursor] = useState(() => new Date()); // the month or week on screen
  const [day, setDay] = useState(null); // a dayKey, chosen once everything has loaded
  const [highlight, setHighlight] = useState(null); // an event id picked on the calendar
  const [editing, setEditing] = useState(null); // null | { meeting } | { day, at, template }
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all'); // all | meeting | recording
  const [mineOnly, setMineOnly] = useState(false);
  const searchBox = useRef(null);

  const setView = (next) => {
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* private window */ }
  };

  const load = () => Promise.all([
    api('/recordings').then(setData),
    api('/meetings').then((result) => setMeetings(result.items)),
  ]).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);
  // Still recording, copying to Drive, or a meeting about to start: look again in a little while.
  const busy = data?.items.some((item) => item.status === 'recording' || item.drive?.status === 'uploading')
    || meetings?.some((meeting) => meeting.live || Math.abs(Date.parse(meeting.startAt) - Date.now()) < 60 * MINUTE);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [busy]);

  const allEvents = useMemo(() => toEvents(meetings || [], data?.items || []), [meetings, data]);
  const needle = query.trim().toLowerCase();
  const events = useMemo(() => allEvents.filter((event) => {
    if (kind !== 'all' && event.kind !== kind) return false;
    if (mineOnly && !event.mine) return false;
    if (!needle) return true;
    const item = event.item;
    const haystack = event.kind === 'meeting'
      ? `${item.title} ${item.description || ''} ${item.host?.name || ''} ${item.invitees.map((p) => p.name).join(' ')} ${item.code}`
      : `${item.title} ${item.recorder?.name || ''}`;
    return haystack.toLowerCase().includes(needle);
  }), [allEvents, kind, mineOnly, needle]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const event of events) {
      const key = dayKey(event.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
    return map;
  }, [events]);

  const upcoming = useMemo(() => (meetings || [])
    .filter((meeting) => meeting.live || Date.parse(meeting.endAt) > Date.now())
    .sort((a, b) => a.startAt.localeCompare(b.startAt)), [meetings]);

  // This week at a glance.
  const week = useMemo(() => {
    const from = startOfWeek(new Date());
    const to = addDays(from, 7);
    const mine = (meetings || []).filter((meeting) => new Date(meeting.startAt) >= from && new Date(meeting.startAt) < to);
    return { count: mine.length, minutes: mine.reduce((sum, meeting) => sum + (Date.parse(meeting.endAt) - Date.parse(meeting.startAt)) / MINUTE, 0) };
  }, [meetings]);

  // Start on today if anything is on; else the next meeting; else the latest recording; else today.
  useEffect(() => {
    if (!data || !meetings || day) return;
    const today = dayKey(new Date());
    const next = upcoming[0] && new Date(upcoming[0].startAt);
    const latest = data.items[0] && new Date(data.items[0].startedAt);
    const chosen = byDay.has(today) ? new Date() : next || latest || new Date();
    setDay(dayKey(chosen));
    setCursor(chosen);
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
    setCursor(date);
    setHighlight(`m:${meeting.id}`);
  };

  const today = dayKey(new Date());
  const shown = (day && byDay.get(day)) || [];
  const shownMeetings = shown.filter((event) => event.kind === 'meeting').map((event) => event.item);
  const shownRecordings = shown.filter((event) => event.kind === 'recording').map((event) => event.item);
  const pick = (date) => {
    setDay(dayKey(date));
    setHighlight(null);
    setPlaying(null);
  };
  const openEvent = (event) => {
    setDay(dayKey(event.start));
    setHighlight(event.id);
    if (event.kind === 'recording' && event.item.status === 'ready') setPlaying(null);
  };
  const create = (date, at = null) => setEditing({ day: date, at });
  const move = (step) => setCursor((current) => (view === 'week' ? addDays(current, step * 7) : new Date(current.getFullYear(), current.getMonth() + step, 1)));
  const goToday = () => {
    setCursor(new Date());
    pick(new Date());
  };
  const pickedDate = day ? fromKey(day) : null;
  const weekStart = startOfWeek(cursor);
  const heading = view === 'week'
    ? (() => {
      const end = addDays(weekStart, 6);
      return sameMonth(weekStart, end)
        ? `${weekStart.getDate()} – ${end.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`
        : `${weekStart.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    })()
    : view === 'agenda' ? (needle ? `${events.length} result${events.length === 1 ? '' : 's'}` : 'Agenda')
      : cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });

  // Keyboard: arrows move the day, PageUp/PageDown the month or week, T today, N new, M/W/A views, / search.
  useEffect(() => {
    const onKey = (event) => {
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"], .modal-backdrop, .dialog')) return;
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (steps[event.key] !== undefined && view !== 'agenda' && day) {
        event.preventDefault();
        const next = addDays(fromKey(day), steps[event.key]);
        pick(next);
        setCursor(next);
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        move(event.key === 'PageUp' ? -1 : 1);
      } else if (event.key === 't') goToday();
      else if (event.key === 'n') create(day && day >= today ? fromKey(day) : new Date());
      else if (event.key === 'm') setView('month');
      else if (event.key === 'w') setView('week');
      else if (event.key === 'a') setView('agenda');
      else if (event.key === '/') {
        event.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const next = upcoming[0];
  const exportable = upcoming.filter((meeting) => !meeting.live);

  return (
    <div className="attendance-app recordings-app meet-hub">
      <header className="tasks-topbar attendance-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Meet</strong>
        <span className="grow" />
        <span className="meet-top-status"><i /> Ready to meet</span>
      </header>

      <main className="attendance-main">
        <section className="meet-hub-hero">
          <div className="meet-hub-intro">
            <span className="meet-hub-kicker"><i /> Nextspace Meet</span>
            <h1>Meet, share, and move work forward.</h1>
            <p>Video calls with chat, reactions and recordings, and one calendar for everything you plan and record.</p>
            <div className="meet-hub-actions">
              <button type="button" className="btn meet-start" disabled={starting} onClick={startNow}><Icon name="videocam" size={19} /> Start instant meeting</button>
              <button type="button" className="btn meet-schedule" onClick={() => create(day && day >= today ? fromKey(day) : new Date())}><Icon name="event" size={19} /> Schedule for later</button>
            </div>
            <form className="meet-join meet-join-hero" onSubmit={joinWithCode}>
              <span className="meet-join-icon"><Icon name="keyboard" size={19} /></span>
              <label htmlFor="meeting-code">Have an invite?</label>
              <input id="meeting-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste a meeting link or code" aria-label="Meeting code or link" autoComplete="off" spellCheck={false} />
              <button type="submit" className="btn" disabled={starting || !code.trim()}>Join</button>
            </form>
          </div>

          <div className={`meet-next-card ${next?.live ? 'live' : ''}`}>
            <div className="meet-next-art" aria-hidden="true">
              <span className="meet-orbit orbit-one" />
              <span className="meet-orbit orbit-two" />
              <span className="meet-next-camera"><Icon name="videocam" size={30} /></span>
            </div>
            {next ? (
              <div className="meet-next-content">
                <span className="meet-next-label">{next.live ? 'Live now' : 'Up next'} <em>{startsIn(next)}</em></span>
                <h2>{next.title}</h2>
                <p>{new Date(next.startAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                <button type="button" className="btn" onClick={() => join(next)}><Icon name="videocam" size={17} /> {next.live ? 'Join now' : 'Open meeting'}</button>
              </div>
            ) : (
              <div className="meet-next-content meet-next-empty">
                <span className="meet-next-label">Your meeting space</span>
                <h2>No rush. You’re all clear.</h2>
                <p>Schedule a conversation when the team is ready.</p>
              </div>
            )}
          </div>
        </section>

        {data && meetings && (
          <section className="meet-hub-stats" aria-label="Meeting overview">
            <div><span className="meet-stat-icon violet"><Icon name="event" size={18} /></span><strong>{week.count}</strong><small>Meetings this week</small></div>
            <div><span className="meet-stat-icon blue"><Icon name="clock" size={18} /></span><strong>{hoursText(week.minutes)}</strong><small>Planned this week</small></div>
            <div><span className="meet-stat-icon coral"><Icon name="play" size={18} /></span><strong>{data.items.length}</strong><small>Recordings</small></div>
            <p><Icon name="info" size={16} /> Recordings stay available for {data.keepDays} days.</p>
          </section>
        )}
        {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {!data || !meetings ? <PanelSkeleton /> : (
          <div className="cal-layout">
            <section className="cal-main" aria-label="Calendar">
              <header className="cal-toolbar">
                <div className="cal-nav">
                  <button type="button" className="btn btn-outline cal-today" onClick={goToday} title="Today (T)">Today</button>
                  {view !== 'agenda' && (
                    <>
                      <button type="button" className="icon-btn" aria-label={view === 'week' ? 'Previous week' : 'Previous month'} title="Previous (Page Up)" onClick={() => move(-1)}><Icon name="chevronLeft" /></button>
                      <button type="button" className="icon-btn" aria-label={view === 'week' ? 'Next week' : 'Next month'} title="Next (Page Down)" onClick={() => move(1)}><Icon name="chevronRight" /></button>
                    </>
                  )}
                  <h2>{heading}</h2>
                </div>
                <div className="cal-views" role="tablist" aria-label="Calendar view">
                  {[['month', 'viewMonth', 'Month', 'M'], ['week', 'viewWeek', 'Week', 'W'], ['agenda', 'viewList', 'Agenda', 'A']].map(([value, icon, label, key]) => (
                    <button key={value} type="button" role="tab" aria-selected={view === value} className={view === value ? 'on' : ''} title={`${label} (${key})`} onClick={() => setView(value)}>
                      <Icon name={icon} size={17} /><span>{label}</span>
                    </button>
                  ))}
                </div>
              </header>

              <div className="cal-filters">
                <label className="cal-search">
                  <Icon name="search" size={17} />
                  <input ref={searchBox} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings, people, recordings" aria-label="Search the calendar" />
                  {query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={16} /></button>}
                </label>
                <div className="cal-chips-filter" role="group" aria-label="Show">
                  {[['all', 'Everything'], ['meeting', 'Meetings'], ['recording', 'Recordings']].map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={kind === value} className={`${kind === value ? 'on' : ''} ${value}`} onClick={() => setKind(value)}>
                      {value !== 'all' && <i />}{label}
                    </button>
                  ))}
                  <button type="button" aria-pressed={mineOnly} className={mineOnly ? 'on' : ''} onClick={() => setMineOnly((on) => !on)}><Icon name="person" size={15} /> Mine</button>
                </div>
                {exportable.length > 0 && (
                  <button type="button" className="btn btn-outline cal-export" onClick={() => downloadIcs(exportable, 'Nextspace meetings')} title="Download every upcoming meeting as a calendar file">
                    <Icon name="download" size={16} /> Export upcoming
                  </button>
                )}
              </div>

              {view === 'month' && <MonthView month={cursor} byDay={byDay} day={day} today={today} onPick={pick} onCreate={create} onOpenEvent={openEvent} />}
              {view === 'week' && <WeekView weekStart={weekStart} byDay={byDay} day={day} today={today} onPick={pick} onCreate={create} onOpenEvent={openEvent} />}
              {view === 'agenda' && <AgendaView events={events} today={today} query={needle} onPick={(date) => { pick(date); }} onOpenEvent={openEvent} />}

              <p className="cal-hint">
                <Icon name="keyboard" size={15} />
                {view === 'week' ? 'Click a free time to plan a meeting there.' : view === 'month' ? 'Double-click a day to plan a meeting.' : 'Pick anything to see its details.'}
                <span> Keys: ← → ↑ ↓ move · T today · N new · M W A views · / search</span>
              </p>
            </section>

            <aside className="cal-side" aria-live="polite">
              <div className="recordings-day-head">
                <h2>{pickedDate ? (day === today ? `Today · ${pickedDate.toLocaleDateString([], { day: 'numeric', month: 'long' })}` : longDay(pickedDate)) : ''}</h2>
                {day >= today && <button type="button" className="btn btn-outline" onClick={() => create(fromKey(day))}><Icon name="add" size={17} /> Schedule</button>}
              </div>

              {!shown.length && (
                <div className="recordings-empty">
                  <span><Icon name="event" size={24} /></span>
                  <p>{needle || kind !== 'all' || mineOnly ? 'Nothing this day matches your filters.' : day >= today ? 'Nothing scheduled this day.' : 'No meetings or recordings this day.'}</p>
                </div>
              )}

              {shownMeetings.length > 0 && (
                <>
                  <h3 className="recordings-section">Meetings</h3>
                  <div className="recordings-list">
                    {shownMeetings.map((meeting) => (
                      <MeetingCard
                        key={meeting.id}
                        meeting={meeting}
                        highlighted={highlight === `m:${meeting.id}`}
                        onJoin={join}
                        onEdit={(m) => setEditing({ meeting: m })}
                        onCancel={cancelMeeting}
                        onDuplicate={(m) => setEditing({ template: m, day: fromKey(day) >= fromKey(today) ? addDays(fromKey(day), 7) : addDays(new Date(), 1), at: null })}
                      />
                    ))}
                  </div>
                </>
              )}

              {shownRecordings.length > 0 && (
                <>
                  <h3 className="recordings-section">Recordings</h3>
                  <div className="recordings-list">
                    {shownRecordings.map((item) => (
                      <RecordingCard
                        key={item.id}
                        item={item}
                        playing={playing === item.id}
                        highlighted={highlight === `r:${item.id}`}
                        onPlay={() => setPlaying(playing === item.id ? null : item.id)}
                        onDelete={() => removeRecording(item)}
                      />
                    ))}
                  </div>
                </>
              )}

              {upcoming.length > 0 && (
                <section className="upcoming" aria-label="Coming up">
                  <h2>Coming up</h2>
                  <ul>
                    {upcoming.slice(0, 5).map((meeting) => (
                      <li key={meeting.id}>
                        <button type="button" onClick={() => { const date = new Date(meeting.startAt); setCursor(date); openEvent({ kind: 'meeting', id: `m:${meeting.id}`, start: date, item: meeting }); }}>
                          <strong>{meeting.title}</strong>
                          <span>{new Date(meeting.startAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                          <em className={meeting.live ? 'live' : ''}>{startsIn(meeting)}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </aside>
          </div>
        )}
      </main>

      {editing && (
        <ScheduleMeeting
          me={me}
          day={editing.day || null}
          at={editing.at || null}
          template={editing.template || null}
          meeting={editing.meeting || null}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
