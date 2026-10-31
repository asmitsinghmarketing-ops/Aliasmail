// Google Meet: a meeting is a Google Calendar event with a Meet link, created in the person's
// own calendar (calendar.events scope). Google sends the invitations when there are guests.
import crypto from 'node:crypto';
import config from './config.js';
import { HttpError } from './errors.js';
import { googleTokenFor } from './google-drive.js';

const VALID_EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_GUESTS = 50;

/** Checked meeting details from a request: { title, start, minutes, guests, description }. */
export function readMeeting(input = {}) {
  const start = input.start ? new Date(input.start) : new Date();
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Choose when the meeting starts');
  if (start.getTime() < Date.now() - 24 * 3600e3) throw new HttpError(400, 'That time has already passed');
  const minutes = Math.min(Math.max(Math.round(Number(input.minutes) || 30), 5), 24 * 60);
  const guests = [...new Set((Array.isArray(input.guests) ? input.guests : String(input.guests || '').split(/[,;\s]+/))
    .map((g) => String(g).trim().toLowerCase())
    .filter(Boolean))];
  const bad = guests.find((g) => !VALID_EMAIL.test(g));
  if (bad) throw new HttpError(400, `“${bad.slice(0, 80)}” isn’t a valid email address`);
  if (guests.length > MAX_GUESTS) throw new HttpError(400, `Up to ${MAX_GUESTS} guests`);
  return {
    title: String(input.title || '').trim().slice(0, 200) || 'Meeting',
    start,
    minutes,
    guests,
    description: String(input.description || '').slice(0, 4000),
  };
}

/** Create the meeting; returns { id, link, title, start, end, guests, calendarLink }. */
export async function createMeeting(role, email, meeting, fetcher = (...args) => fetch(...args)) {
  const { accessToken } = await googleTokenFor('meet', role, email);
  const end = new Date(meeting.start.getTime() + meeting.minutes * 60e3);
  const notify = meeting.guests.length ? 'all' : 'none';
  const url = `${config.google.calendarApiUrl}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=${notify}`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: meeting.title,
      description: meeting.description || undefined,
      start: { dateTime: meeting.start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: meeting.guests.map((address) => ({ email: address })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok) {
    const reason = data.error?.message || (res ? `Google answered ${res.status}` : 'Google Calendar didn’t answer');
    if (res?.status === 403 && /has not been used|is disabled/i.test(reason)) {
      throw new HttpError(502, 'Google Meet isn’t switched on yet: the Google Calendar API must be enabled in the Cloud project.');
    }
    throw new HttpError(502, `Couldn’t create the meeting: ${reason}`);
  }
  const link = data.hangoutLink || data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || '';
  if (!link) throw new HttpError(502, 'Google created the event but gave it no Meet link. Try again.');
  return {
    id: data.id,
    link,
    title: data.summary || meeting.title,
    start: meeting.start.toISOString(),
    end: end.toISOString(),
    guests: meeting.guests,
    calendarLink: data.htmlLink || '',
  };
}
