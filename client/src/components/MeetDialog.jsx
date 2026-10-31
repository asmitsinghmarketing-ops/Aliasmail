import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import RecipientField from './RecipientField.jsx';
import { createMeeting, meetingWhen } from '../meet.js';
import { api } from '../api.js';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// The next half hour from now, as the default start of a scheduled meeting.
function nextSlot() {
  const d = new Date(Date.now() + 30 * 60e3);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

/**
 * New meeting: start one now, or schedule one with guests (Google emails them the invitation).
 * onEmail(meeting) opens a draft with the invitation.
 */
export default function MeetDialog({ onClose, onEmail }) {
  const [view, setView] = useState('choose'); // choose | schedule | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [meeting, setMeeting] = useState(null);
  const [copied, setCopied] = useState(false);
  const [contacts, setContacts] = useState([]);
  const slot = nextSlot();
  const [form, setForm] = useState({ title: '', date: localDate(slot), time: localTime(slot), minutes: 30, guests: '', description: '' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => {
    if (view === 'schedule' && !contacts.length) api('/mail/contacts').then(setContacts).catch(() => {});
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create(details) {
    setBusy(true);
    setError('');
    try {
      const made = await createMeeting(details);
      if (made) {
        setMeeting(made);
        setView('done');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function schedule(e) {
    e.preventDefault();
    const start = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(start.getTime())) return setError('Choose a date and time');
    create({
      title: form.title.trim() || 'Meeting',
      start: start.toISOString(),
      minutes: Number(form.minutes),
      guests: form.guests.split(',').map((g) => g.replace(/.*<([^>]+)>.*/, '$1').trim()).filter(Boolean),
      description: form.description,
    });
  }

  async function copy() {
    await navigator.clipboard?.writeText(meeting.link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal meet-modal" role="dialog" aria-label="Google Meet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="meet-title">
            <span className="meet-badge"><Icon name="videocam" size={20} /></span>
            {view === 'done' ? (meeting.guests.length ? 'Meeting scheduled' : 'Your meeting is ready') : view === 'schedule' ? 'Schedule a meeting' : 'New meeting'}
          </h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {view === 'choose' && (
          <div className="meet-choices">
            <button type="button" className="meet-choice" disabled={busy} onClick={() => create({ title: 'Instant meeting' })}>
              <Icon name="add" size={22} />
              <span>
                <strong>{busy ? 'Creating…' : 'Start an instant meeting'}</strong>
                <span className="muted small">Get a Meet link to join now and share</span>
              </span>
            </button>
            <button type="button" className="meet-choice" disabled={busy} onClick={() => setView('schedule')}>
              <Icon name="event" size={22} />
              <span>
                <strong>Schedule for later</strong>
                <span className="muted small">Pick a time and invite people; it’s added to your Google Calendar</span>
              </span>
            </button>
          </div>
        )}

        {view === 'schedule' && (
          <form className="meet-form" onSubmit={schedule}>
            <label>
              Title
              <input type="text" value={form.title} onChange={set('title')} placeholder="Meeting" maxLength={200} autoFocus />
            </label>
            <div className="meet-row">
              <label>
                Date
                <input type="date" value={form.date} onChange={set('date')} required />
              </label>
              <label>
                Time
                <input type="time" value={form.time} onChange={set('time')} required />
              </label>
              <label>
                Duration
                <select value={form.minutes} onChange={set('minutes')}>
                  {DURATIONS.map((m) => (
                    <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ` ${m % 60} min` : ''}`.replace('1.5 h', '1 h 30 min')}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="meet-guests">
              <span className="meet-label">Guests</span>
              <RecipientField
                fieldKey="guests"
                label=""
                value={form.guests}
                onChange={(guests) => setForm((f) => ({ ...f, guests }))}
                contacts={contacts}
                placeholder="Add guests by email"
              />
            </div>
            <label>
              Description
              <textarea value={form.description} onChange={set('description')} rows={3} maxLength={4000} placeholder="Agenda, notes (optional)" />
            </label>
            <div className="meet-actions">
              <button type="button" className="btn btn-outline" onClick={() => setView('choose')}>Back</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Scheduling…' : form.guests ? 'Schedule and invite' : 'Schedule'}</button>
            </div>
          </form>
        )}

        {view === 'done' && (
          <div className="meet-done">
            <p className="muted small">
              {meeting.guests.length
                ? `${meetingWhen(meeting)} · Google emailed the invitation to ${meeting.guests.length} guest${meeting.guests.length > 1 ? 's' : ''}.`
                : 'Share this link with the people you want to meet. Keep it to join later too.'}
            </p>
            <div className="meet-link">
              <Icon name="videocam" size={18} />
              <span className="grow" title={meeting.link}>{meeting.link.replace(/^https:\/\//, '')}</span>
              <button type="button" className="icon-btn" title="Copy link" onClick={copy}>
                <Icon name={copied ? 'check' : 'copy'} size={18} />
              </button>
            </div>
            {copied && <span className="muted small">Link copied</span>}
            <div className="meet-actions">
              {meeting.calendarLink && (
                <a className="btn btn-outline" href={meeting.calendarLink} target="_blank" rel="noreferrer">Open in Calendar</a>
              )}
              <button type="button" className="btn btn-outline" onClick={() => onEmail(meeting)}>
                <Icon name="mail" size={18} /> Send by email
              </button>
              <a className="btn btn-primary" href={meeting.link} target="_blank" rel="noreferrer">Join now</a>
            </div>
          </div>
        )}

        {error && <div className="alert">{error}</div>}
      </div>
    </div>
  );
}
