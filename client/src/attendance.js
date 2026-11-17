// Presence for attendance. It runs across every signed-in workspace, but only sends heartbeats
// after an explicit clock-in. No keys, URLs, files, screenshots or location are collected.
import { api } from './api.js';

export const ATTENDANCE_CHANGED = 'nextspace:attendance-changed';
export const attendanceChanged = () => window.dispatchEvent(new Event(ATTENDANCE_CHANGED));

const HEARTBEAT_MS = 30_000;
const IDLE_MS = 5 * 60_000;

export function startAttendanceHeartbeat() {
  let clockedIn = false;
  let stopped = false;
  let sending = false;
  let lastActivity = Date.now();

  const activeNow = () => document.visibilityState === 'visible' && navigator.onLine !== false && Date.now() - lastActivity < IDLE_MS;
  const heartbeat = async () => {
    if (stopped || !clockedIn || sending || navigator.onLine === false) return;
    sending = true;
    try {
      await api('/attendance/heartbeat', { method: 'POST', body: { active: activeNow() } });
    } catch (err) {
      if (err.status === 409) clockedIn = false;
    } finally {
      sending = false;
    }
  };
  const refresh = () => api('/attendance/status')
    .then((status) => { clockedIn = status.clockedIn; if (clockedIn) return heartbeat(); return null; })
    .catch(() => {});
  const activity = () => { lastActivity = Date.now(); };
  const wake = () => { activity(); void heartbeat(); };
  const changed = () => void refresh();

  ['pointerdown', 'keydown', 'touchstart'].forEach((name) => window.addEventListener(name, activity, { passive: true }));
  document.addEventListener('visibilitychange', heartbeat);
  window.addEventListener('online', wake);
  window.addEventListener(ATTENDANCE_CHANGED, changed);
  const timer = setInterval(heartbeat, HEARTBEAT_MS);
  void refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    ['pointerdown', 'keydown', 'touchstart'].forEach((name) => window.removeEventListener(name, activity));
    document.removeEventListener('visibilitychange', heartbeat);
    window.removeEventListener('online', wake);
    window.removeEventListener(ATTENDANCE_CHANGED, changed);
  };
}
