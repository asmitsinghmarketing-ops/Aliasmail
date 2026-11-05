// Incoming team calls. The secure live socket rings open windows; Web Push opens the same call
// when Nextspace is closed. Google Meet carries the actual audio and video.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { subscribe } from '../live.js';
import Avatar from './Avatar.jsx';
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

function startRingtone() {
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
      samples[i] = Math.sin(2 * Math.PI * tone.frequency * local) * Math.max(0, envelope) * 0.14;
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
    data: { url: `/?call=${encodeURIComponent(call.id)}` },
  })).catch(() => {});
}

export default function CallCenter() {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    const showFromUrl = (href) => {
      const url = new URL(href, window.location.origin);
      const id = url.searchParams.get('call');
      if (!id) return;
      api(`/calls/${encodeURIComponent(id)}`).then((found) => found.status === 'ringing' && setCall(found)).catch(() => {});
      url.searchParams.delete('call');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    };
    showFromUrl(window.location.href);
    const onWorker = (event) => event.data?.type === 'open' && showFromUrl(event.data.url);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    const stop = subscribe((message) => {
      if (message.type === 'incoming-call') {
        setCall(message.call);
        desktopRing(message.call);
      }
      else if (message.type === 'call-ended' && message.id === current.current?.id) setCall(null);
    });
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      stop();
    };
  }, []);

  // One looping audio buffer keeps ringing when Chrome throttles timers in a minimized tab.
  useEffect(() => {
    if (!call) return undefined;
    const ringtone = startRingtone();
    const expires = setTimeout(() => setCall(null), Math.max(0, Date.parse(call.expiresAt) - Date.now()));
    return () => { ringtone?.stop(); clearTimeout(expires); };
  }, [call]);

  if (!call) return null;
  const answer = async (choice) => {
    setBusy(true); setError('');
    try {
      const answered = await api(`/calls/${call.id}/respond`, { method: 'POST', body: { answer: choice } });
      setCall(null);
      if (choice === 'accept') window.open(answered.link, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="call-backdrop" role="dialog" aria-modal="true" aria-label={`Incoming call from ${call.fromName}`}>
      <section className="incoming-call">
        <span className="incoming-call-avatar"><Avatar person={{ name: call.fromName, address: call.from }} size="lg" /></span>
        <span className="incoming-call-pulse" />
        <p>Incoming team call</p>
        <h2>{call.fromName}</h2>
        <span className="muted">Google Meet video call</span>
        {error && <div className="alert">{error}</div>}
        <div className="incoming-call-actions">
          <button type="button" className="call-decline" disabled={busy} onClick={() => answer('decline')}><Icon name="close" /> Decline</button>
          <button type="button" className="call-accept" disabled={busy} onClick={() => answer('accept')}><Icon name="videocam" /> Accept</button>
        </div>
      </section>
    </div>
  );
}
