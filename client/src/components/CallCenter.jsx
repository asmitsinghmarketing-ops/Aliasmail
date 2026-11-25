// Team calls: rings for incoming ones (the live socket in open windows, Web Push when Nextspace is
// closed), and shows the call itself. It stays on screen while moving around the app.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import { callState, joinCall, watchCall } from '../calls.js';
import { subscribe } from '../live.js';
import Avatar from './Avatar.jsx';
import CallRoom from './CallRoom.jsx';
import Icon from './Icon.jsx';

let audioContext = null;
let audioUnlocked = false;

function contextForCall() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return null;
  audioContext ||= new Audio();
  return audioContext;
}

// Chrome and Safari only allow later background audio after audio has been unlocked by a real
// click/key press. Do that silently on the person's first interaction with Nextspace.
async function unlockCallAudio() {
  try {
    const context = contextForCall();
    if (!context) return;
    await context.resume();
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.connect(context.destination);
    source.start();
    audioUnlocked = true;
  } catch { /* desktop notification remains the fallback */ }
}

// Nextspace's call signature: a soft glassy rise for incoming calls and a quiet answer tone
// for the caller. The phrases leave plenty of silence so they get attention without nagging.
const D5 = 587.33, FS5 = 739.99, A5 = 880, D6 = 1174.66, A4 = 440, E5 = 659.25;
const RINGTONES = {
  // Someone is calling you: two short rising phrases, then a generous pause.
  incoming: {
    seconds: 4.4,
    notes: [[0, D5], [0.16, FS5], [0.34, A5], [0.56, D6], [1.3, D5], [1.46, FS5], [1.64, A5], [1.86, D6]],
  },
  // You are calling: a restrained two-note reply while it rings at the other end.
  waiting: { seconds: 4.2, notes: [[0, A4], [0.28, E5]] },
};

function chime(t, frequency) {
  if (t < 0) return 0;
  const attack = Math.min(1, t / 0.006);
  const phase = 2 * Math.PI * frequency * t;
  return attack * (
    Math.sin(phase) * Math.exp(-t / 0.42)
    + 0.3 * Math.sin(phase * 4) * Math.exp(-t / 0.09) // the bright "tock" at the start
    + 0.12 * Math.sin(phase * 2) * Math.exp(-t / 0.2)
  );
}

// `level`: quieter for the sound a caller hears while waiting.
function startRingtone(level = 0.11, kind = 'incoming') {
  try {
    const context = contextForCall();
    if (!context) return null;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const { seconds, notes } = RINGTONES[kind];
    const buffer = context.createBuffer(1, Math.round(context.sampleRate * seconds), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const t = i / context.sampleRate;
      let sum = 0;
      for (const [start, frequency] of notes) if (t >= start && t - start < 2) sum += chime(t - start, frequency);
      samples[i] = sum * level;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
    return source;
  } catch {
    return null;
  }
}

function desktopRing(call) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((worker) => worker.showNotification(`Incoming call from ${call.fromName}`, {
    body: 'Open Nextspace to answer the call.',
    tag: `call-${call.id}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: `/?call=${encodeURIComponent(call.id)}`, callId: call.id },
    actions: [
      { action: 'accept-call', title: 'Accept' },
      { action: 'decline-call', title: 'Decline' },
    ],
  })).catch(() => {});
}

function closeDesktopRing(id) {
  navigator.serviceWorker?.ready
    .then((worker) => worker.getNotifications({ tag: `call-${id}` }))
    .then((notifications) => notifications.forEach((notification) => notification.close()))
    .catch(() => {});
}

export default function CallCenter() {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const room = useSyncExternalStore(watchCall, callState);
  const current = useRef(null);
  current.current = call;

  useEffect(() => {
    if (audioUnlocked) return undefined;
    const unlock = () => {
      void unlockCallAudio();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const answer = async (active, choice, video) => {
    setBusy(true);
    setError('');
    setCall(null); // stop ringing the instant Accept or Decline is pressed
    closeDesktopRing(active.id);
    try {
      if (choice === 'accept') await joinCall(active.id, { video });
      else await api(`/calls/${active.id}/respond`, { method: 'POST', body: { answer: 'decline' } });
    } catch (err) {
      setError(err.message);
      setTimeout(() => setError(''), 6000);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const showFromUrl = (href) => {
      const url = new URL(href, window.location.origin);
      const id = url.searchParams.get('call');
      if (!id) return;
      const accept = url.searchParams.has('answer');
      api(`/calls/${encodeURIComponent(id)}`)
        .then((found) => {
          if (!found.ringingForMe) return;
          if (accept) answer(found, 'accept', found.video);
          else setCall(found);
        })
        .catch(() => {});
      url.searchParams.delete('call');
      url.searchParams.delete('answer');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    };
    showFromUrl(window.location.href);
    const onWorker = (event) => event.data?.type === 'open' && showFromUrl(event.data.url);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    const stop = subscribe((message) => {
      if (message.type === 'incoming-call') {
        setCall(message.call);
        desktopRing(message.call);
      } else if (message.type === 'call-ended') {
        closeDesktopRing(message.id);
        if (message.id === current.current?.id) setCall(null);
      }
    });
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // One looping audio buffer keeps ringing when Chrome throttles timers in a minimized tab.
  useEffect(() => {
    if (!call) return undefined;
    const ringtone = startRingtone();
    const expires = setTimeout(() => setCall(null), Math.max(0, Date.parse(call.expiresAt) - Date.now()));
    return () => { ringtone?.stop(); clearTimeout(expires); };
  }, [call]);

  // The caller hears it ringing, until someone answers.
  const waiting = room.phase === 'in-call' && !room.peers.length && room.call.invited.some((invite) => invite.status === 'ringing');
  useEffect(() => {
    if (!waiting) return undefined;
    const ringtone = startRingtone(0.07, 'waiting');
    return () => ringtone?.stop();
  }, [waiting]);

  return (
    <>
      {room.phase === 'in-call' && <CallRoom state={room} />}
      {room.phase === 'joining' && <div className="nx-status-toast" role="status"><Icon name="refresh" size={18} className="spin" /> Connecting your microphone…</div>}
      {room.phase === 'ended' && <div className="nx-status-toast" role="status"><Icon name="callEnd" size={18} /> {room.endReason}</div>}
      {error && <div className="nx-status-toast error" role="alert">{error}</div>}
      {call && (
        <div className="nx-ring-backdrop" role="dialog" aria-modal="true" aria-label={`Incoming call from ${call.fromName}`}>
          <section className="nx-ring">
            <div className="nx-ring-avatar">
              <span className="nx-ring-wave" aria-hidden="true" />
              <span className="nx-ring-wave two" aria-hidden="true" />
              <Avatar person={{ name: call.fromName, address: call.from }} size="lg" />
            </div>
            <p className="nx-ring-kind"><Icon name={call.video ? 'videocam' : 'call'} size={15} /> Incoming {call.video ? 'video' : 'voice'} call</p>
            <h2>{call.fromName}</h2>
            {call.invited?.length > 1 && <span className="nx-ring-note">with {call.invited.length - 1} other{call.invited.length > 2 ? 's' : ''}</span>}
            {room.phase === 'in-call' && <span className="nx-ring-note">Answering ends your current call.</span>}
            <div className="nx-ring-actions">
              <button type="button" className="nx-ring-btn decline" disabled={busy} onClick={() => answer(call, 'decline')}>
                <span><Icon name="callEnd" /></span>Decline
              </button>
              {call.video && (
                <button type="button" className="nx-ring-btn audio" disabled={busy} onClick={() => answer(call, 'accept', false)}>
                  <span><Icon name="call" /></span>Audio only
                </button>
              )}
              <button type="button" className="nx-ring-btn accept" disabled={busy} onClick={() => answer(call, 'accept', call.video)}>
                <span><Icon name={call.video ? 'videocam' : 'call'} /></span>Accept
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
