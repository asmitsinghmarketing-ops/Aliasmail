// Schedule a meeting ahead (or change one): title, date, time, length, teammates to invite, a note.
// Afterwards it shows the meeting link to send anyone else.
import { localDate, localTime } from '../format.js';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { meetingLink } from '../calls.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const QUICK = [15, 30, 45, 60];
const durationLabel = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

/** The next half hour, on `day` if that's later than now. */
function defaultStart(day) {
  const soon = new Date(Date.now() + 30 * 60_000);
  soon.setMinutes(soon.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (!day || day <= soon) return soon;
  const start = new Date(day);
  start.setHours(10, 0, 0, 0);
  return start;
}

/**
 * `meeting`: change that meeting. `template`: a new meeting copying its title, length, people and
 * note (Duplicate). `at`: a new meeting starting exactly then (a slot picked on the calendar).
 */
export default function ScheduleMeeting({ me, day, at, template, meeting, onSaved, onClose, onEmail, onOpenMeetings }) {
  const start = meeting ? new Date(meeting.startAt) : at && at.getTime() > Date.now() ? at : defaultStart(day);
  const source = meeting || template;
  const [form, setForm] = useState({
    title: source?.title ? `${source.title}${template && !meeting ? ' (copy)' : ''}` : '',
    date: localDate(start),
    time: localTime(start),
    durationMin: source?.durationMin || 30,
    invitees: new Set((source?.invitees || []).map((person) => person.address).filter((address) => address !== me)),
    description: source?.description || '',
  });
  const [team, setTeam] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [copied, setCopied] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  useEffect(() => {
    api('/mail/team').then((people) => setTeam(people.filter((person) => person.address !== me))).catch(() => setTeam([]));
  }, [me]);
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (address) => setForm((current) => {
    const invitees = new Set(current.invitees);
    if (invitees.has(address)) invitees.delete(address);
    else invitees.add(address);
    return { ...current, invitees };
  });

  async function submit(event) {
    event.preventDefault();
    const startAt = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(startAt.getTime())) return setError('Choose a date and time');
    if (!meeting && startAt.getTime() < Date.now() - 60_000) return setError('Choose a time in the future');
    setBusy(true);
    setError('');
    try {
      const body = { title: form.title.trim() || 'Meeting', startAt: startAt.toISOString(), durationMin: Number(form.durationMin), invitees: [...form.invitees], description: form.description };
      const result = await api(meeting ? `/meetings/${meeting.id}` : '/meetings', { method: meeting ? 'PATCH' : 'POST', body });
      onSaved(result);
      if (meeting) onClose();
      else setSaved(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  async function copy() {
    setError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(meetingLink(saved.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Couldn’t copy the link. Select it and copy it manually.');
    }
  }

  const begins = new Date(`${form.date}T${form.time}`);
  const ends = Number.isNaN(begins.getTime()) ? null : new Date(begins.getTime() + Number(form.durationMin) * 60_000);
  const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const summary = ends
    ? `${begins.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${clock(begins)} – ${clock(ends)}${form.invitees.size ? ` · ${form.invitees.size} invited` : ''}`
    : 'Pick a date and time';
  const quick = QUICK.includes(Number(form.durationMin));

  return (
    <div className="modal-backdrop sm-backdrop" onMouseDown={onClose}>
      <div className="sm-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="sm-head">
          <span className={`sm-badge ${saved ? 'done' : ''}`}><Icon name={saved ? 'check' : 'event'} size={20} /></span>
          <div>
            <h2 id="schedule-dialog-title">{saved ? 'Meeting scheduled' : meeting ? 'Change meeting' : 'Schedule a meeting'}</h2>
            <p>{saved ? saved.title : meeting ? 'Invited teammates are told about the change.' : 'Pick a time and who to invite.'}</p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>

        {saved ? (
          <div className="sm-body sm-done">
            <div className="sm-when-card">
              <Icon name="event" size={20} />
              <div>
                <strong>{new Date(saved.startAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                <span>{clock(new Date(saved.startAt))} – {clock(new Date(saved.endAt))}{saved.invitees.length ? ` · ${saved.invitees.length} teammate${saved.invitees.length === 1 ? '' : 's'} told` : ''}</span>
              </div>
            </div>
            <div className="sm-field">
              <span className="sm-label">Meeting link</span>
              <div className="sm-link">
                <Icon name="link" size={18} />
                <span title={meetingLink(saved.code)}>{meetingLink(saved.code).replace(/^https?:\/\//, '')}</span>
                <button type="button" className="btn btn-outline" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copied' : 'Copy'}</button>
              </div>
              <span className="sm-hint">Send it to anyone else. Teammates come straight in; you’re asked before guests join.</span>
            </div>
            {error && <div className="alert" role="alert">{error}</div>}
            <footer className="sm-foot">
              {onOpenMeetings && <button type="button" className="btn btn-outline" onClick={() => { onClose(); onOpenMeetings(); }}><Icon name="event" size={17} /> Open Meet</button>}
              {onEmail && <button type="button" className="btn btn-outline" onClick={() => onEmail({ ...saved, link: meetingLink(saved.code) })}><Icon name="mail" size={17} /> Send by email</button>}
              <span className="sm-grow" />
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </footer>
          </div>
        ) : (
          <form className="sm-body" onSubmit={submit}>
            <label className="sm-field">
              <span className="sm-label">Title</span>
              <input className="sm-title" type="text" value={form.title} onChange={set('title')} placeholder="Add a title, e.g. Weekly sync" maxLength={120} autoFocus />
            </label>

            <div className="sm-when">
              <label className="sm-field">
                <span className="sm-label">Date</span>
                <input type="date" value={form.date} min={meeting ? undefined : localDate(new Date())} onChange={set('date')} required />
              </label>
              <label className="sm-field">
                <span className="sm-label">Start</span>
                <input type="time" value={form.time} onChange={set('time')} required />
              </label>
            </div>

            <div className="sm-field">
              <span className="sm-label" id="sm-length">Length</span>
              <div className="sm-lengths" role="group" aria-labelledby="sm-length">
                {QUICK.map((m) => (
                  <button key={m} type="button" className={Number(form.durationMin) === m ? 'on' : ''} aria-pressed={Number(form.durationMin) === m} onClick={() => setForm((current) => ({ ...current, durationMin: m }))}>{durationLabel(m)}</button>
                ))}
                <select aria-label="A longer meeting" className={quick ? '' : 'on'} value={quick ? '' : form.durationMin} onChange={set('durationMin')}>
                  <option value="" disabled>Longer…</option>
                  {DURATIONS.filter((m) => !QUICK.includes(m)).map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
                </select>
              </div>
            </div>

            <div className="sm-field">
              <span className="sm-label">Invite teammates {form.invitees.size > 0 && <em>{form.invitees.size} selected</em>}</span>
              {!team ? <span className="sm-hint">Getting your team…</span> : !team.length ? <span className="sm-hint">No teammates to invite. Share the link instead.</span> : (
                <div className="sm-people">
                  {team.map((person) => {
                    const on = form.invitees.has(person.address);
                    return (
                      <button key={person.address} type="button" className={`sm-person ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(person.address)}>
                        <Avatar url={person.avatarUrl} person={person} color={person.color} size="xs" />
                        <span>{person.name || person.address}</span>
                        <Icon name={on ? 'check' : 'add'} size={15} />
                      </button>
                    );
                  })}
                </div>
              )}
              <span className="sm-hint">They’re told now and reminded 10 minutes before. Anyone else can join with the link.</span>
            </div>

            <label className="sm-field">
              <span className="sm-label">Note <em>optional</em></span>
              <textarea value={form.description} onChange={set('description')} rows={3} maxLength={2000} placeholder="Agenda, links, what to prepare…" />
            </label>

            {error && <div className="alert" role="alert">{error}</div>}
            <footer className="sm-foot">
              <span className="sm-summary"><Icon name="clock" size={16} />{summary}</span>
              <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : meeting ? 'Save changes' : 'Schedule'}</button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
