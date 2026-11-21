// Schedule a meeting ahead (or change one): title, date, time, length, teammates to invite, a note.
// Afterwards it shows the meeting link to send anyone else.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { meetingLink } from '../calls.js';
import Icon from './Icon.jsx';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export default function ScheduleMeeting({ me, day, meeting, onSaved, onClose, onEmail, onOpenMeetings }) {
  const start = meeting ? new Date(meeting.startAt) : defaultStart(day);
  const [form, setForm] = useState({
    title: meeting?.title || '',
    date: localDate(start),
    time: localTime(start),
    durationMin: meeting?.durationMin || 30,
    invitees: new Set((meeting?.invitees || []).map((person) => person.address)),
    description: meeting?.description || '',
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
    try {
      await navigator.clipboard.writeText(meetingLink(saved.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the link is selectable */ }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal meet-modal schedule-modal" role="dialog" aria-label={meeting ? 'Change meeting' : 'Schedule a meeting'} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="meet-title">
            <span className="meet-badge"><Icon name="event" size={20} /></span>
            {saved ? 'Meeting scheduled' : meeting ? 'Change meeting' : 'Schedule a meeting'}
          </h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>

        {saved ? (
          <div className="meet-done">
            <p className="muted small">
              {new Date(saved.startAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
              {saved.invitees.length ? ` · ${saved.invitees.length} teammate${saved.invitees.length === 1 ? '' : 's'} told` : ''}
            </p>
            <p className="small">Send this link to anyone else. Teammates come straight in; you’ll be asked before guests join.</p>
            <div className="meet-link">
              <Icon name="link" size={18} />
              <span className="grow" title={meetingLink(saved.code)}>{meetingLink(saved.code).replace(/^https?:\/\//, '')}</span>
              <button type="button" className="icon-btn" title="Copy link" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} /></button>
            </div>
            {copied && <span className="muted small">Link copied</span>}
            <div className="meet-actions">
              {onOpenMeetings && <button type="button" className="btn btn-outline" onClick={() => { onClose(); onOpenMeetings(); }}><Icon name="event" size={18} /> Open Meetings</button>}
              {onEmail && <button type="button" className="btn btn-outline" onClick={() => onEmail({ ...saved, link: meetingLink(saved.code) })}><Icon name="mail" size={18} /> Send by email</button>}
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="meet-form" onSubmit={submit}>
            <label>
              Title
              <input type="text" value={form.title} onChange={set('title')} placeholder="Meeting" maxLength={120} autoFocus />
            </label>
            <div className="meet-row">
              <label>Date<input type="date" value={form.date} onChange={set('date')} required /></label>
              <label>Time<input type="time" value={form.time} onChange={set('time')} required /></label>
              <label>
                Length
                <select value={form.durationMin} onChange={set('durationMin')}>
                  {DURATIONS.map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
                </select>
              </label>
            </div>
            <div className="schedule-invitees">
              <span className="meet-label">Invite teammates</span>
              {!team ? <span className="muted small">Getting your team…</span> : !team.length ? <span className="muted small">No teammates to invite. Send the link instead.</span> : (
                <div className="schedule-people">
                  {team.map((person) => (
                    <label key={person.address} className={`schedule-person ${form.invitees.has(person.address) ? 'on' : ''}`}>
                      <input type="checkbox" checked={form.invitees.has(person.address)} onChange={() => toggle(person.address)} />
                      <span>{person.name || person.address}</span>
                    </label>
                  ))}
                </div>
              )}
              <span className="muted small">They’re told now and reminded 10 minutes before. Anyone else can join with the link.</span>
            </div>
            <label>
              Note
              <textarea value={form.description} onChange={set('description')} rows={3} maxLength={2000} placeholder="Agenda, notes (optional)" />
            </label>
            {error && <div className="alert">{error}</div>}
            <div className="meet-actions">
              <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : meeting ? 'Save changes' : 'Schedule'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
