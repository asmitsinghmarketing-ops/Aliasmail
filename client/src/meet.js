// Google Meet: meetings are created in the person's own Google Calendar through the app.
import { api } from './api.js';
import { ask } from './components/Dialog.jsx';

export const MEET_CONNECT_URL = '/api/auth/google/start?mode=meet';

/**
 * Create a meeting: { title, start, minutes, guests, description } (all optional; none = now).
 * The first time, Google Meet has to be connected (a Google screen): `beforeLeave` runs first,
 * e.g. to save a draft. Returns the meeting, or null when the person didn't go ahead.
 */
export async function createMeeting(details = {}, { beforeLeave } = {}) {
  try {
    return await api('/mail/meet', { method: 'POST', body: details });
  } catch (err) {
    if (err.status !== 409) throw err;
    const go = await ask({
      title: 'Connect Google Meet?',
      message: 'To create Meet links, connect your Google account once. Meetings are added to your Google Calendar, and Google sends the invitations.',
      confirmLabel: 'Connect Google Meet',
    });
    if (!go) return null;
    await beforeLeave?.();
    window.location.href = MEET_CONNECT_URL;
    return null;
  }
}

export const meetingWhen = (meeting) =>
  new Date(meeting.start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Plain-text invitation for an email body. */
export const meetingText = (meeting) =>
  `${meeting.title}\n${meetingWhen(meeting)} (${Math.round((Date.parse(meeting.end) - Date.parse(meeting.start)) / 60e3)} min)\n\nJoin with Google Meet: ${meeting.link}\n`;
