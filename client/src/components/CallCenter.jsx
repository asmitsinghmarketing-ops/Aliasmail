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

// `level`: quieter for the sound a caller hears while waiting.
function startRingtone(level = 0.14) {
  try {
    const context = contextForCall();
    if (!context) return null;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const seconds = 2;
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const t = i / context.sampleRate;
      const tone = t < 0.24 ? { start: 0, frequency: 660 } : t >= 0.32 && t < 0.56 ? { start: 0.32, frequency: 880 } : null;
      if (!tone) continue;
      const local = t - tone.start;
      const envelope = Math.min(1, local / 0.025, (0.24 - local) / 0.035);
      samples[i] = Math.sin(2 * Math.PI * tone.frequency * local) * Math.max(0, envelope) * level;
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
    const ringtone = startRingtone(0.05);
    return () => ringtone?.stop();
  }, [waiting]);

  return (
    <>
      {room.phase === 'in-call' && <CallRoom state={room} />}
      {room.phase === 'joining' && <div className="call-joining" role="status"><Icon name="refresh" size={18} /> Connecting your microphone…</div>}
      {room.phase === 'ended' && <div className="call-ended-toast" role="status">{room.endReason}</div>}
      {error && <div className="call-error-toast" role="alert">{error}</div>}
      {call && (
        <div className="call-backdrop" role="dialog" aria-modal="true" aria-label={`Incoming call from ${call.fromName}`}>
          <section className="incoming-call">
            <span className="incoming-call-avatar"><Avatar person={{ name: call.fromName, address: call.from }} size="lg" /></span>
            <span className="incoming-call-pulse" />
            <p>Incoming {call.video ? 'video' : 'voice'} call</p>
            <h2>{call.fromName}</h2>
            {call.invited?.length > 1 && <span className="muted">with {call.invited.length - 1} other{call.invited.length > 2 ? 's' : ''}</span>}
            {room.phase === 'in-call' && <span className="muted">Answering ends your current call.</span>}
            <div className="incoming-call-actions">
              <button type="button" className="call-decline" disabled={busy} onClick={() => answer(call, 'decline')}><Icon name="callEnd" /> Decline</button>
              <button type="button" className="call-accept" disabled={busy} onClick={() => answer(call, 'accept', call.video)}><Icon name={call.video ? 'videocam' : 'call'} /> Accept</button>
            </div>
            {call.video && <button type="button" className="incoming-call-alt" disabled={busy} onClick={() => answer(call, 'accept', false)}>Answer without video</button>}
          </section>
        </div>
      )}
    </>
  );
}
