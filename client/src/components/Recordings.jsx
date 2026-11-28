// Meet: start or join a meeting, and a calendar of scheduled meetings and recorded calls. A side
// rail holds the actions, a mini month, what's up next and the week at a glance; the calendar shows
// a day, a week (with times), a month or an agenda list, and can be searched, filtered and moved
// through with the keyboard. Clicking a meeting or recording opens its details beside it: join,
// copy or share a meeting, add it to another calendar, duplicate, change or cancel it; play,
// download or delete a recording. Recordings are deleted automatically a set
// number of days after the meeting (15 by default).
import { localDate } from '../format.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { joinByCode, meetingLink, startMeeting } from '../calls.js';
import Avatar from './Avatar.jsx';
import { ask } from './Dialog.jsx';
import Icon from './Icon.jsx';
import { PanelSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { Popover } from './Menus.jsx';
import ScheduleMeeting from './ScheduleMeeting.jsx';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MEETING_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const VIEW_KEY = 'nextspace:meet-calendar-view';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_PX = 56; // one hour in the day and week views

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

const eventClass = (event, conflicts) => ['mc-event', event.kind, event.live && 'live', event.kind === 'meeting' && event.end < new Date() && !event.live && 'past', conflicts?.has(event.id) && 'clash'].filter(Boolean).join(' ');

/** Meetings that overlap in time: event id → the titles of the meetings it clashes with. */
function findConflicts(events) {
  const meetings = events.filter((event) => event.kind === 'meeting').sort((a, b) => a.start - b.start);
  const clashes = new Map();
  for (let i = 0; i < meetings.length; i += 1) {
    for (let j = i + 1; j < meetings.length && meetings[j].start < meetings[i].end; j += 1) {
      for (const [one, other] of [[meetings[i], meetings[j]], [meetings[j], meetings[i]]]) {
        if (!clashes.has(one.id)) clashes.set(one.id, []);
        clashes.get(one.id).push(other.title);
      }
    }
  }
  return clashes;
}

/** Free stretches of `date` between 9:00 and 18:00 (after now), as [start, end] pairs. */
function freeRanges(date, events, limit = 3) {
  const busy = events.filter((event) => event.kind === 'meeting');
  const soon = Date.now() + 10 * MINUTE;
  const ranges = [];
  for (let at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9); at.getHours() < 18; at = new Date(at.getTime() + 30 * MINUTE)) {
    const end = new Date(at.getTime() + 30 * MINUTE);
    if (at.getTime() < soon || busy.some((event) => event.start < end && event.end > at)) continue;
    const last = ranges.at(-1);
    if (last && last[1].getTime() === at.getTime()) last[1] = end;
    else ranges.push([at, end]);
  }
  return ranges.slice(0, limit);
}

/* ---------------------------------- details ---------------------------------- */

function DriveNote({ drive }) {
  if (!drive) return null;
  if (drive.status === 'saved') return <a className="mc-drive saved" href={drive.link} target="_blank" rel="noreferrer"><Icon name="check" size={15} /> Copy in your Google Drive</a>;
  if (drive.status === 'uploading') return <span className="mc-drive">Copying to your Google Drive…</span>;
  if (drive.status === 'failed') return <span className="mc-drive problem">Couldn’t copy it to Google Drive</span>;
  return null;
}

/** Floats beside the event that was clicked; a sheet from the bottom on a phone. */
function EventPopover({ anchor, label, onClose, children }) {
  const box = useRef(null);
  const [place, setPlace] = useState(null);
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 800px)').matches;

  useLayoutEffect(() => {
    if (phone || !box.current) return;
    const width = box.current.offsetWidth;
    const height = box.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;
    if (anchor) {
      left = anchor.right + 12;
      if (left + width > vw - 12) left = anchor.left - 12 - width;
      if (left < 12) left = Math.min(Math.max(12, anchor.left), vw - width - 12);
      top = anchor.top - 18;
    } else {
      left = vw - width - 28;
      top = 88;
    }
    top = Math.max(76, Math.min(top, vh - height - 12));
    setPlace({ left, top: Math.max(12, top) });
  }, [anchor, phone, children]);

  useEffect(() => {
    const away = (event) => {
      if (box.current?.contains(event.target) || event.target.closest?.('.dialog, .modal-backdrop, .mc-event, .mc-row')) return;
      onClose();
    };
    const key = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);

  return (
    <>
      {phone && <div className="mc-scrim" onClick={onClose} />}
      <section
        ref={box}
        className={`mc-pop ${phone ? 'sheet' : ''} ${!phone && !place ? 'measuring' : ''}`}
        style={place && !phone ? { left: place.left, top: place.top } : undefined}
        role="dialog"
        aria-label={label}
      >
        {children}
      </section>
    </>
  );
}

function PopHead({ kind, live, title, when, status, onClose }) {
  return (
    <header className="mc-pop-head">
      <span className={`mc-swatch ${kind} ${live ? 'live' : ''}`} aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        <p>{when}</p>
        {status}
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={19} /></button>
    </header>
  );
}

function MeetingDetail({ meeting, clashes, onClose, onJoin, onEdit, onCancel, onDuplicate }) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  const ended = !meeting.live && Date.parse(meeting.endAt) < Date.now();
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
  const people = [meeting.host, ...meeting.invitees.filter((person) => person.address !== meeting.host.address)];
  const start = new Date(meeting.startAt);
  return (
    <>
      <PopHead
        kind="meeting"
        live={meeting.live}
        title={meeting.title}
        when={`${longDay(start)} · ${clock(meeting.startAt)} – ${clock(meeting.endAt)}`}
        status={meeting.live ? <span className="mc-status live"><i /> Live now</span> : !ended && <span className="mc-status">{startsIn(meeting)}</span>}
        onClose={onClose}
      />
      <div className="mc-code">
        <Icon name="link" size={16} />
        <code>{meeting.code}</code>
        <button type="button" className="link" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      {clashes?.length > 0 && !ended && <p className="mc-clash"><Icon name="info" size={15} /> Overlaps with {clashes.join(', ')}</p>}
      <div className="mc-people">
        <h3>{people.length} {people.length === 1 ? 'person' : 'people'}</h3>
        <ul>
          {people.map((person) => (
            <li key={person.address}>
              <Avatar person={person} size="xs" />
              <span>{person.name}</span>
              {person.address === meeting.host.address && <small>organiser</small>}
            </li>
          ))}
        </ul>
      </div>
      {meeting.description && <p className="mc-note">{meeting.description}</p>}
      <footer className="mc-pop-actions">
        {!ended && <button type="button" className="btn btn-primary" onClick={() => onJoin(meeting)}><Icon name="videocam" size={17} /> {meeting.live ? 'Join meeting' : 'Start meeting'}</button>}
        {meeting.canEdit && !ended && <button type="button" className="btn btn-outline" onClick={() => onEdit(meeting)}><Icon name="edit" size={16} /> Edit</button>}
        <div className="mc-more" ref={menuRef}>
          <button type="button" className="btn btn-outline mc-more-btn" aria-label={`More for ${meeting.title}`} aria-expanded={menu} onClick={() => setMenu((open) => !open)}><Icon name="moreVert" size={18} /></button>
          {menu && (
            <div className="mc-menu" role="menu">
              {!ended && <a role="menuitem" href={inviteMail(meeting)} onClick={() => setMenu(false)}><Icon name="mail" size={18} /> Email an invitation</a>}
              {!ended && <a role="menuitem" href={googleCalendarLink(meeting)} target="_blank" rel="noopener noreferrer" onClick={() => setMenu(false)}><Icon name="event" size={18} /> Add to Google Calendar</a>}
              {!ended && <button type="button" role="menuitem" onClick={() => { setMenu(false); downloadIcs([meeting], meeting.title); }}><Icon name="download" size={18} /> Download for Outlook / Apple (.ics)</button>}
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onDuplicate(meeting); }}><Icon name="copy" size={18} /> Duplicate</button>
              {meeting.canEdit && <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); onCancel(meeting); }}><Icon name="trash" size={18} /> {ended ? 'Remove from calendar' : 'Cancel meeting'}</button>}
            </div>
          )}
        </div>
      </footer>
    </>
  );
}

function RecordingDetail({ item, onClose, onDelete }) {
  const start = new Date(item.startedAt);
  return (
    <>
      <PopHead
        kind="recording"
        live={item.status === 'recording'}
        title={item.title}
        when={`${longDay(start)} · ${clock(item.startedAt)}${item.endedAt ? ` – ${clock(item.endedAt)}` : ''}`}
        status={item.status === 'recording' ? <span className="mc-status rec"><i /> Still recording</span> : <span className="mc-status warn" title={new Date(item.deletesAt).toLocaleString()}>{deletesIn(item.deletesAt)}</span>}
        onClose={onClose}
      />
      {item.status === 'ready'
        ? <video className="mc-video" src={`/api/recordings/${item.id}/video`} controls preload="metadata" playsInline />
        : <div className="mc-video empty"><Icon name="record" size={22} /> {item.status === 'recording' ? 'Recording in progress' : 'Getting the video ready…'}</div>}
      <dl className="mc-facts">
        {item.status === 'ready' && <><dt>Length</dt><dd>{length(item.durationMs)}</dd><dt>Size</dt><dd>{size(item.size)}</dd></>}
        <dt>Recorded by</dt><dd>{item.mine ? 'You' : item.recorder.name}</dd>
      </dl>
      <DriveNote drive={item.drive} />
      <footer className="mc-pop-actions">
        {item.status === 'ready' && <a className="btn btn-primary" href={`/api/recordings/${item.id}/video?download=1`} download><Icon name="download" size={17} /> Download</a>}
        {item.canDelete && <button type="button" className="btn btn-outline mc-danger" onClick={onDelete}><Icon name="trash" size={16} /> Delete</button>}
      </footer>
    </>
  );
}

/* ---------------------------------- views ---------------------------------- */

function MiniMonth({ month, day, today, byDay, onPick, onMove }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = startOfWeek(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return (
    <section className="mc-mini" aria-label="Pick a date">
      <header>
        <strong>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => onMove(-1)}><Icon name="chevronLeft" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => onMove(1)}><Icon name="chevronRight" size={18} /></button>
      </header>
      <div className="mc-mini-grid">
        {WEEKDAYS.map((name) => <span key={name} className="mc-mini-wd" aria-hidden="true">{name[0]}</span>)}
        {cells.map((date) => {
          const key = dayKey(date);
          const classes = [!sameMonth(date, month) && 'dim', key === today && 'today', key === day && 'on', byDay.has(key) && 'has'].filter(Boolean).join(' ');
          return <button key={key} type="button" className={classes} aria-label={longDay(date)} aria-pressed={key === day} onClick={() => onPick(date)}>{date.getDate()}</button>;
        })}
      </div>
    </section>
  );
}

function EventChip({ event, conflicts, onOpenEvent }) {
  return (
    <button type="button" className={eventClass(event, conflicts)} title={`${clock(event.start)} ${event.title}`} onClick={(e) => { e.stopPropagation(); onOpenEvent(event, e.currentTarget); }}>
      {event.kind === 'recording' ? <Icon name="play" size={12} /> : <time>{clock(event.start)}</time>}
      <span>{event.title}</span>
    </button>
  );
}

function MonthView({ month, byDay, day, today, conflicts, onPick, onOpenDay, onCreate, onOpenEvent }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = startOfWeek(first);
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  return (
    <div className="mc-month-wrap">
      <div className="mc-weekdays" aria-hidden="true">{WEEKDAYS.map((name) => <span key={name}>{name}</span>)}</div>
      <div className="mc-month" role="grid" aria-label={month.toLocaleDateString([], { month: 'long', year: 'numeric' })} style={{ '--weeks': weeks }}>
        {cells.map((date) => {
          const key = dayKey(date);
          const events = byDay.get(key) || [];
          const shown = events.slice(0, 3);
          const more = events.length - shown.length;
          const classes = ['mc-cell', !sameMonth(date, month) && 'other', key === day && 'selected', key === today && 'today', (date.getDay() + 6) % 7 >= 5 && 'weekend', key < today && 'past'].filter(Boolean).join(' ');
          return (
            <div
              key={key}
              role="gridcell"
              aria-selected={key === day}
              aria-label={`${longDay(date)}${events.length ? `, ${events.length} item${events.length === 1 ? '' : 's'}` : ''}`}
              tabIndex={key === day ? 0 : -1}
              className={classes}
              onClick={() => onPick(date)}
              onDoubleClick={() => key >= today && onCreate(date)}
              onKeyDown={(event) => { if (event.key === 'Enter') onOpenDay(date); }}
            >
              <span className="mc-cell-head">
                <button type="button" className="mc-date" onClick={(e) => { e.stopPropagation(); onOpenDay(date); }} aria-label={`Open ${longDay(date)}`}>{date.getDate()}</button>
                {key >= today && <button type="button" className="mc-add" aria-label={`Schedule on ${longDay(date)}`} title="Schedule a meeting this day" onClick={(e) => { e.stopPropagation(); onCreate(date); }}><Icon name="add" size={16} /></button>}
              </span>
              {shown.map((event) => <EventChip key={event.id} event={event} conflicts={conflicts} onOpenEvent={onOpenEvent} />)}
              {more > 0 && <button type="button" className="mc-more-count" onClick={(e) => { e.stopPropagation(); onOpenDay(date); }}>+{more} more</button>}
            </div>
          );
        })}
      </div>
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

/** Days side by side with a column of hours: the week view, or the day view with one day. */
function TimeGrid({ days, byDay, day, today, conflicts, onPick, onCreate, onOpenEvent }) {
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
  }, [dayKey(days[0]), days.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const slotClick = (date, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((event.clientY - rect.top) / HOUR_PX) * 2) * 30 + firstHour * 60;
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
    onPick(date);
    if (at.getTime() > Date.now()) onCreate(date, at);
  };

  return (
    <div className={`mc-grid ${days.length === 1 ? 'one' : ''}`} style={{ '--days': days.length }}>
      <div className="mc-grid-head">
        <span />
        {days.map((date) => {
          const key = dayKey(date);
          return (
            <button key={key} type="button" className={`mc-grid-day ${key === today ? 'today' : ''} ${key === day ? 'selected' : ''} ${key < today ? 'past' : ''}`} onClick={() => onPick(date)}>
              <small>{days.length === 1 ? date.toLocaleDateString([], { weekday: 'long' }) : WEEKDAYS[(date.getDay() + 6) % 7]}</small>
              <strong>{date.getDate()}</strong>
            </button>
          );
        })}
      </div>
      <div className="mc-grid-body" ref={scroller}>
        <div className="mc-hours" style={{ height: hours.length * HOUR_PX }}>
          {hours.map((hour) => <span key={hour} style={{ top: (hour - firstHour) * HOUR_PX }}>{String(hour).padStart(2, '0')}:00</span>)}
        </div>
        {days.map((date) => {
          const key = dayKey(date);
          const placed = placeDay(byDay.get(key) || []);
          return (
            <div key={key} className={`mc-col ${key === today ? 'today' : ''} ${key < today ? 'past' : ''}`} style={{ height: hours.length * HOUR_PX, '--hour': `${HOUR_PX}px` }} onClick={(event) => slotClick(date, event)} title={key >= today ? 'Click a time to schedule a meeting' : undefined}>
              {placed.map(({ event, lane, lanes }) => {
                const y = top(event.start);
                const h = Math.max(26, top(event.end) - y - 2);
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`${eventClass(event, conflicts)} block ${h < 38 ? 'short' : ''}`}
                    style={{ top: y, height: h, left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }}
                    onClick={(e) => { e.stopPropagation(); onOpenEvent(event, e.currentTarget); }}
                    title={`${clock(event.start)}–${clock(event.end)} ${event.title}`}
                  >
                    <strong>{event.title}</strong>
                    <time>{clock(event.start)}<span> – {clock(event.end)}</span></time>
                  </button>
                );
              })}
              {key === today && now.getHours() >= firstHour && now.getHours() < lastHour && <span className="mc-now" style={{ top: top(now) }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The phone's day view: what's on, in order, with the free stretches between. */
function DayList({ date, events, allEvents, conflicts, onOpenEvent, onCreate }) {
  const key = dayKey(date);
  const today = dayKey(new Date());
  const tomorrow = addDays(date, 1);
  const free = key >= today ? freeRanges(date, allEvents.filter((event) => dayKey(event.start) === key), 1) : [];
  const section = (label, list, when, current) => (
    <section className="mc-daylist">
      <h2 className={current ? 'today' : ''}>{label}</h2>
      {!list.length && !(when === 'first' && free.length) && <p className="mc-daylist-empty">Nothing scheduled.</p>}
      {[...list, ...(when === 'first' ? free.map(([from, to]) => ({ free: true, id: `free-${from.toISOString()}`, start: from, end: to })) : [])].sort((a, b) => a.start - b.start).map((event) => (event.free ? (
        <div key={event.id} className="mc-row-wrap">
          <time>{clock(event.start)}</time>
          <button type="button" className="mc-row mc-free" onClick={() => onCreate(date, event.start)}>
            <strong>Free until {clock(event.end)}</strong>
            <span>Tap to schedule a meeting here</span>
          </button>
        </div>
      ) : (
        <div key={event.id} className="mc-row-wrap">
          <time>{clock(event.start)}</time>
          <button type="button" className={`${eventClass(event, conflicts)} mc-row`} onClick={(e) => onOpenEvent(event, e.currentTarget)}>
            <strong>{event.title}</strong>
            <span>{clock(event.start)} – {clock(event.end)} · {event.kind === 'meeting' ? `${event.item.invitees.length + 1} ${event.item.invitees.length ? 'people' : 'person'}` : 'Recording'}</span>
          </button>
        </div>
      )))}
    </section>
  );
  const label = (value) => {
    const k = dayKey(value);
    const prefix = k === today ? 'Today' : k === dayKey(addDays(new Date(), 1)) ? 'Tomorrow' : k === dayKey(addDays(new Date(), -1)) ? 'Yesterday' : '';
    return `${prefix ? `${prefix} · ` : ''}${value.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}`;
  };
  return (
    <div className="mc-daylists">
      {section(label(date), events.filter((event) => dayKey(event.start) === key), 'first', key === today)}
      {section(label(tomorrow), events.filter((event) => dayKey(event.start) === dayKey(tomorrow)), 'second', false)}
    </div>
  );
}

function AgendaView({ events, today, onOpenEvent, onOpenDay, query }) {
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
      <section key={key} className="mc-agenda-day">
        <button type="button" className={`mc-agenda-date ${key === today ? 'today' : ''}`} onClick={() => onOpenDay(date)}>
          <strong>{date.getDate()}</strong>
          <span>{date.toLocaleDateString([], { weekday: 'short' })} · {date.toLocaleDateString([], { month: 'short' })}</span>
        </button>
        <div className="mc-agenda-items">
          {relative && <span className="mc-agenda-rel">{relative}</span>}
          {list.map((event) => (
            <button key={event.id} type="button" className={`${eventClass(event)} mc-agenda-row`} onClick={(e) => onOpenEvent(event, e.currentTarget)}>
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
    <div className="mc-agenda">
      {!upcoming.length && <p className="mc-agenda-empty">{query ? 'Nothing upcoming matches your search.' : 'Nothing coming up. Schedule a meeting to see it here.'}</p>}
      {renderGroups(group(upcoming))}
      {past.length > 0 && (
        <>
          <button type="button" className="mc-agenda-toggle" onClick={() => setShowPast((open) => !open)} aria-expanded={showPast}>
            <Icon name="expandMore" size={18} className={showPast ? 'up' : ''} /> {showPast ? 'Hide' : 'Show'} earlier ({past.length})
          </button>
          {showPast && renderGroups(group(past))}
        </>
      )}
    </div>
  );
}

/* ---------------------------------- the page ---------------------------------- */

const VIEWS = [['day', 'Day', 'D'], ['week', 'Week', 'W'], ['month', 'Month', 'M'], ['agenda', 'Agenda', 'A']];
const readView = () => {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (VIEWS.some(([value]) => value === saved)) return saved;
  } catch { /* private window */ }
  return window.matchMedia?.('(max-width: 800px)').matches ? 'day' : 'month';
};

export default function Recordings({ me, onClose }) {
  const [data, setData] = useState(null); // recordings: { items, keepDays }
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState('');
  const [view, setViewState] = useState(readView);
  const [cursor, setCursor] = useState(() => new Date()); // the day, week or month on screen
  const [miniMonth, setMiniMonth] = useState(() => new Date());
  const [day, setDay] = useState(null); // a dayKey, chosen once everything has loaded
  const [selected, setSelected] = useState(null); // { id, anchor } of the event whose details are open
  const [editing, setEditing] = useState(null); // null | { meeting } | { day, at, template }
  const [query, setQuery] = useState('');
  const [showMeetings, setShowMeetings] = useState(true);
  const [showRecordings, setShowRecordings] = useState(true);
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
    if (event.kind === 'meeting' && !showMeetings) return false;
    if (event.kind === 'recording' && !showRecordings) return false;
    if (mineOnly && !event.mine) return false;
    if (!needle) return true;
    const item = event.item;
    const haystack = event.kind === 'meeting'
      ? `${item.title} ${item.description || ''} ${item.host?.name || ''} ${item.invitees.map((p) => p.name).join(' ')} ${item.code}`
      : `${item.title} ${item.recorder?.name || ''}`;
    return haystack.toLowerCase().includes(needle);
  }), [allEvents, showMeetings, showRecordings, mineOnly, needle]);
  const conflicts = useMemo(() => findConflicts(allEvents), [allEvents]);
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
    const inWeek = (date) => date >= from && date < to;
    const list = (meetings || []).filter((meeting) => inWeek(new Date(meeting.startAt)));
    const clashing = list.filter((meeting) => conflicts.has(`m:${meeting.id}`) && Date.parse(meeting.endAt) > Date.now());
    return {
      count: list.length,
      minutes: list.reduce((sum, meeting) => sum + (Date.parse(meeting.endAt) - Date.parse(meeting.startAt)) / MINUTE, 0),
      recordings: (data?.items || []).filter((item) => inWeek(new Date(item.startedAt))).length,
      clashing,
    };
  }, [meetings, data, conflicts]);

  // Start on today if anything is on; else the next meeting; else the latest recording; else today.
  useEffect(() => {
    if (!data || !meetings || day) return;
    const today = dayKey(new Date());
    const next = upcoming[0] && new Date(upcoming[0].startAt);
    const latest = data.items[0] && new Date(data.items[0].startedAt);
    const chosen = byDay.has(today) ? new Date() : next || latest || new Date();
    setDay(dayKey(chosen));
    setCursor(chosen);
    setMiniMonth(chosen);
  }, [data, meetings, day, byDay, upcoming]);

  async function removeRecording(item) {
    const sure = await ask({ title: 'Delete this recording?', message: `“${item.title}” will be deleted for everyone who was in the call. A copy in Google Drive stays there.`, confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try {
      await api(`/recordings/${item.id}`, { method: 'DELETE' });
      setSelected(null);
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
      setSelected(null);
      setMeetings((current) => current.filter((other) => other.id !== meeting.id));
    } catch (err) {
      setError(err.message);
    }
  }

  const join = (meeting) => joinByCode(meeting.code, { video: false, muted: true }).then(load).catch((err) => setError(err.message));

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
  const joinCode = (text, options = { video: false, muted: true }) => {
    const found = MEETING_CODE.exec(String(text || '').trim().toLowerCase());
    if (!found) { setError('Enter a meeting code like abc-defg-hij, or paste the meeting link.'); return null; }
    return run(() => joinByCode(found[0], options).then(() => setCode('')));
  };
  const joinWithCode = (event) => {
    event.preventDefault();
    joinCode(code);
  };
  const askForCode = async () => {
    const text = await ask({ title: 'Join a meeting', input: { label: 'Meeting code or link', placeholder: 'abc-defg-hij', maxLength: 300 }, confirmLabel: 'Join' });
    if (text) joinCode(text);
  };

  const today = dayKey(new Date());
  const pick = (date) => {
    setDay(dayKey(date));
    setSelected(null);
  };
  const openDay = (date) => {
    pick(date);
    setCursor(date);
    setView('day');
  };
  const pickFromMini = (date) => {
    pick(date);
    setCursor(date);
    setMiniMonth(date);
  };
  const saved = (meeting) => {
    setMeetings((current) => [...(current || []).filter((other) => other.id !== meeting.id), meeting]);
    const date = new Date(meeting.startAt);
    setDay(dayKey(date));
    setCursor(date);
    setMiniMonth(date);
    justSaved.current = `m:${meeting.id}`;
  };
  // The new meeting's details open once the "Meeting scheduled" dialog is closed, not behind it.
  const justSaved = useRef(null);
  const closeEditor = () => {
    setEditing(null);
    if (justSaved.current) setSelected({ id: justSaved.current, anchor: null });
    justSaved.current = null;
  };
  const openEvent = (event, element) => {
    const rect = element?.getBoundingClientRect();
    setDay(dayKey(event.start));
    setSelected({ id: event.id, anchor: rect ? { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom } : null });
  };
  const create = (date, at = null) => { setSelected(null); setEditing({ day: date, at }); };
  const move = (step) => setCursor((current) => {
    const next = view === 'day' ? addDays(current, step) : view === 'week' ? addDays(current, step * 7) : new Date(current.getFullYear(), current.getMonth() + step, 1);
    if (view === 'day') setDay(dayKey(next));
    setMiniMonth(next);
    return next;
  });
  const goToday = () => {
    setCursor(new Date());
    setMiniMonth(new Date());
    pick(new Date());
  };

  const pickedDate = day ? fromKey(day) : new Date();
  const weekStart = startOfWeek(cursor);
  const heading = view === 'week'
    ? (() => {
      const end = addDays(weekStart, 6);
      return sameMonth(weekStart, end)
        ? <>{weekStart.getDate()} – {end.toLocaleDateString([], { day: 'numeric', month: 'long' })} <span>{end.getFullYear()}</span></>
        : <>{weekStart.toLocaleDateString([], { day: 'numeric', month: 'short' })} – {end.toLocaleDateString([], { day: 'numeric', month: 'short' })} <span>{end.getFullYear()}</span></>;
    })()
    : view === 'day' ? <>{cursor.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</>
      : view === 'agenda' ? (needle ? `${events.length} result${events.length === 1 ? '' : 's'}` : 'Agenda')
        : <>{cursor.toLocaleDateString([], { month: 'long' })} <span>{cursor.getFullYear()}</span></>;

  // Keyboard: arrows move the day, PageUp/PageDown the period, T today, N new, D/W/M/A views, / search.
  useEffect(() => {
    const onKey = (event) => {
      if (editing || selected || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"], .modal-backdrop, .dialog')) return;
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (steps[event.key] !== undefined && view !== 'agenda' && day) {
        event.preventDefault();
        const next = addDays(fromKey(day), steps[event.key]);
        pick(next);
        setCursor(next);
        setMiniMonth(next);
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        move(event.key === 'PageUp' ? -1 : 1);
      } else if (event.key === 't') goToday();
      else if (event.key === 'n') create(day && day >= today ? fromKey(day) : new Date());
      else if (event.key === 'd') setView('day');
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
  const open = selected && allEvents.find((event) => event.id === selected.id);
  const free = day && day >= today ? freeRanges(pickedDate, allEvents.filter((event) => dayKey(event.start) === day)) : [];
  const stripStart = startOfWeek(pickedDate);
  const closeDetails = () => setSelected(null);

  const upNext = next && (
    <section className={`mc-next ${next.live ? 'live' : ''}`} aria-label="Up next">
      <span className="mc-next-when">{next.live ? <><i /> Live now</> : <><Icon name="clock" size={14} /> Up next · {startsIn(next).replace(/^In /, 'in ')}</>}</span>
      <strong>{next.title}</strong>
      <span className="mc-next-time">{dayKey(new Date(next.startAt)) === today ? 'Today' : new Date(next.startAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · {clock(next.startAt)} – {clock(next.endAt)}</span>
      <div className="mc-next-foot">
        <span className="mc-faces">
          {[next.host, ...next.invitees.filter((person) => person.address !== next.host.address)].slice(0, 4).map((person) => <Avatar key={person.address} person={person} size="xs" />)}
        </span>
        <button type="button" className="btn" onClick={() => (next.live ? join(next) : openEvent({ kind: 'meeting', id: `m:${next.id}`, start: new Date(next.startAt) }, null))}>{next.live ? 'Join' : 'Open'}</button>
      </div>
    </section>
  );

  return (
    <div className="attendance-app recordings-app mc-app">
      <header className="tasks-topbar attendance-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose} title="Back to mail"><Logo /><Wordmark /></button>
        <span className="tasks-divider" />
        <strong>Meet</strong>
        <label className="tasks-search mc-search">
          <Icon name="search" size={19} />
          <input ref={searchBox} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings, people, recordings" aria-label="Search the calendar" />
          {query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={16} /></button>}
        </label>
      </header>

      {!data || !meetings ? <div className="mc-loading"><PanelSkeleton /></div> : (
        <div className="mc-layout">
          <aside className="mc-rail">
            <div className="mc-actions">
              <button type="button" className="btn btn-primary" disabled={starting} onClick={startNow}><Icon name="videocam" size={19} /> New meeting</button>
              <button type="button" className="btn btn-outline" onClick={() => create(day && day >= today ? fromKey(day) : new Date())}><Icon name="event" size={18} /> Schedule</button>
            </div>
            <form className="mc-join" onSubmit={joinWithCode}>
              <label>
                <Icon name="link" size={17} />
                <input id="meeting-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code or link" aria-label="Meeting code or link" autoComplete="off" spellCheck={false} />
              </label>
              <span className="mc-join-actions">
                <button type="submit" className="mc-join-main" disabled={starting || !code.trim()}>Join</button>
                <Popover icon="arrowDrop" title="Choose how to join" className="mc-join-more" align="right" disabled={starting || !code.trim()}>
                  {(close) => (
                    <div className="menu meet-join-menu" role="menu">
                      <div className="menu-title">Choose how to join</div>
                      <button type="button" className="menu-item" role="menuitem" onClick={() => { close(); joinCode(code, { video: true, muted: false }); }}>
                        <Icon name="videocam" size={19} />
                        <span><strong>Camera and mic on</strong><small>Join normally</small></span>
                      </button>
                      <button type="button" className="menu-item" role="menuitem" onClick={() => { close(); joinCode(code, { video: false, muted: false }); }}>
                        <Icon name="videocamOff" size={19} />
                        <span><strong>Camera off</strong><small>Join with your microphone on</small></span>
                      </button>
                      <button type="button" className="menu-item" role="menuitem" onClick={() => { close(); joinCode(code, { video: false, muted: true }); }}>
                        <Icon name="micOff" size={19} />
                        <span><strong>Camera and mic off</strong><small>Default · join quietly</small></span>
                      </button>
                    </div>
                  )}
                </Popover>
              </span>
            </form>

            <MiniMonth
              month={miniMonth}
              day={day}
              today={today}
              byDay={byDay}
              onPick={pickFromMini}
              onMove={(step) => setMiniMonth((current) => new Date(current.getFullYear(), current.getMonth() + step, 1))}
            />

            {upNext}

            <section className="mc-stats" aria-label="This week">
              <div><strong>{week.count}</strong><small>meeting{week.count === 1 ? '' : 's'} this week</small></div>
              <div><strong>{week.minutes >= 60 ? `${Math.floor(week.minutes / 60)}h${Math.round(week.minutes % 60) ? ` ${Math.round(week.minutes % 60)}m` : ''}` : `${Math.round(week.minutes)}m`}</strong><small>in meetings</small></div>
              <div><strong>{week.recordings}</strong><small>recording{week.recordings === 1 ? '' : 's'}</small></div>
            </section>

            {week.clashing.length > 0 && (
              <section className="mc-warn" aria-label="Clashes">
                <strong>{week.clashing.length} meetings overlap this week</strong>
                <span>{week.clashing.slice(0, 4).map((meeting) => meeting.title).join(', ')}</span>
              </section>
            )}

            {free.length > 0 && (
              <section className="mc-free-list" aria-label="Free time">
                <h3>Free {day === today ? 'today' : `on ${pickedDate.toLocaleDateString([], { weekday: 'long' })}`}</h3>
                {free.map(([from, to]) => (
                  <button key={from.toISOString()} type="button" onClick={() => create(pickedDate, from)}>
                    <strong>{clock(from)} – {clock(to)}</strong><span>Schedule here</span>
                  </button>
                ))}
              </section>
            )}

            <section className="mc-show" aria-label="Show">
              <h3>Show</h3>
              <label><input type="checkbox" checked={showMeetings} onChange={(e) => setShowMeetings(e.target.checked)} /><i className="meeting" />Meetings</label>
              <label><input type="checkbox" checked={showRecordings} onChange={(e) => setShowRecordings(e.target.checked)} /><i className="recording" />Recordings</label>
              <label><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /><i className="mine" />Only ones I organise</label>
            </section>

            <p className="mc-hint">Recordings are kept for {data.keepDays} days.<br />Keys: T today · N new · D W M A views · / search</p>
          </aside>

          <main className="mc-main">
            <div className="mc-toolbar">
              <h1>{heading}</h1>
              <div className="mc-nav">
                <button type="button" className="btn btn-outline" onClick={goToday} title="Today (T)">Today</button>
                {view !== 'agenda' && (
                  <>
                    <button type="button" className="btn btn-outline mc-arrow" aria-label="Previous" title="Previous (Page Up)" onClick={() => move(-1)}><Icon name="chevronLeft" size={18} /></button>
                    <button type="button" className="btn btn-outline mc-arrow" aria-label="Next" title="Next (Page Down)" onClick={() => move(1)}><Icon name="chevronRight" size={18} /></button>
                  </>
                )}
              </div>
              <div className="mc-views" role="tablist" aria-label="Calendar view">
                {VIEWS.map(([value, label, key]) => (
                  <button key={value} type="button" role="tab" aria-selected={view === value} className={view === value ? 'on' : ''} title={`${label} (${key})`} onClick={() => { if (value === 'day' && day) setCursor(fromKey(day)); setView(value); }}>{label}</button>
                ))}
              </div>
              {exportable.length > 0 && (
                <button type="button" className="btn btn-outline mc-arrow mc-export" onClick={() => downloadIcs(exportable, 'Nextspace meetings')} title="Download every upcoming meeting as a calendar file" aria-label="Export upcoming meetings">
                  <Icon name="download" size={18} />
                </button>
              )}
            </div>

            {error && <div className="alert"><span>{error}</span><button type="button" className="link" onClick={() => setError('')}>Dismiss</button></div>}

            {view === 'day' && (
              <nav className="mc-strip" aria-label="Pick a day">
                <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => pickFromMini(addDays(pickedDate, -7))}><Icon name="chevronLeft" size={18} /></button>
                {Array.from({ length: 7 }, (_, i) => addDays(stripStart, i)).map((date) => {
                  const key = dayKey(date);
                  return (
                    <button key={key} type="button" className={[key === day && 'on', key === today && 'today', key < today && 'past', byDay.has(key) && 'has'].filter(Boolean).join(' ')} onClick={() => pickFromMini(date)} aria-label={longDay(date)} aria-pressed={key === day}>
                      <small>{WEEKDAYS[(date.getDay() + 6) % 7][0]}</small><b>{date.getDate()}</b><i />
                    </button>
                  );
                })}
                <button type="button" className="icon-btn" aria-label="Next week" onClick={() => pickFromMini(addDays(pickedDate, 7))}><Icon name="chevronRight" size={18} /></button>
              </nav>
            )}
            {view === 'day' && <div className="mc-phone-only">{upNext}</div>}

            <div className="mc-surface">
              {view === 'month' && <MonthView month={cursor} byDay={byDay} day={day} today={today} conflicts={conflicts} onPick={pick} onOpenDay={openDay} onCreate={create} onOpenEvent={openEvent} />}
              {view === 'week' && <TimeGrid days={Array.from({ length: 7 }, (_, n) => addDays(weekStart, n))} byDay={byDay} day={day} today={today} conflicts={conflicts} onPick={pick} onCreate={create} onOpenEvent={openEvent} />}
              {view === 'day' && (
                <>
                  <div className="mc-desktop-only"><TimeGrid days={[pickedDate]} byDay={byDay} day={day} today={today} conflicts={conflicts} onPick={pick} onCreate={create} onOpenEvent={openEvent} /></div>
                  <div className="mc-phone-only"><DayList date={pickedDate} events={events} allEvents={allEvents} conflicts={conflicts} onOpenEvent={openEvent} onCreate={create} /></div>
                </>
              )}
              {view === 'agenda' && <AgendaView events={events} today={today} query={needle} onOpenDay={openDay} onOpenEvent={openEvent} />}
            </div>
          </main>
        </div>
      )}

      {data && meetings && !editing && (
        <div className="mc-bottom">
          <button type="button" className="btn btn-primary" disabled={starting} onClick={startNow}><Icon name="videocam" size={19} /> New meeting</button>
          <button type="button" className="btn btn-outline" onClick={askForCode} aria-label="Join with code"><Icon name="keyboard" size={19} /><span className="mc-long">Join with code</span><span className="mc-short">Join</span></button>
          <button type="button" className="btn btn-outline mc-bottom-add" aria-label="Schedule a meeting" onClick={() => create(day && day >= today ? fromKey(day) : new Date())}><Icon name="event" size={19} /></button>
        </div>
      )}

      {open && (
        <EventPopover anchor={selected.anchor} label={`${open.title} details`} onClose={closeDetails}>
          {open.kind === 'meeting' ? (
            <MeetingDetail
              meeting={open.item}
              clashes={conflicts.get(open.id)}
              onClose={closeDetails}
              onJoin={join}
              onEdit={(m) => { setSelected(null); setEditing({ meeting: m }); }}
              onCancel={cancelMeeting}
              onDuplicate={(m) => { setSelected(null); setEditing({ template: m, day: fromKey(dayKey(new Date(m.startAt))) >= fromKey(today) ? addDays(new Date(m.startAt), 7) : addDays(new Date(), 1), at: null }); }}
            />
          ) : (
            <RecordingDetail item={open.item} onClose={closeDetails} onDelete={() => removeRecording(open.item)} />
          )}
        </EventPopover>
      )}

      {editing && (
        <ScheduleMeeting
          me={me}
          day={editing.day || null}
          at={editing.at || null}
          template={editing.template || null}
          meeting={editing.meeting || null}
          onSaved={saved}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}

