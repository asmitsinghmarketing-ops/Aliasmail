// Incoming team calls. The secure live socket rings open windows; Web Push opens the same call
// when Nextspace is closed. Google Meet carries the actual audio and video.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { subscribe } from '../live.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

export default function CallCenter() {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef(null);
  current.current = call;

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
      if (message.type === 'incoming-call') setCall(message.call);
      else if (message.type === 'call-ended' && message.id === current.current?.id) setCall(null);
    });
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      stop();
    };
  }, []);

  // A short repeating ringtone while the incoming-call card is open. Browser autoplay rules can
  // mute it before the person has interacted with the site; the persistent desktop push remains.
  useEffect(() => {
    if (!call) return undefined;
    let context;
    const ring = () => {
      try {
        context ||= new (window.AudioContext || window.webkitAudioContext)();
        for (const [offset, frequency] of [[0, 660], [0.18, 880]]) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.16);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(context.currentTime + offset);
          oscillator.stop(context.currentTime + offset + 0.18);
        }
      } catch { /* visual and push notification still ring */ }
    };
    ring();
    const timer = setInterval(ring, 1800);
    const expires = setTimeout(() => setCall(null), Math.max(0, Date.parse(call.expiresAt) - Date.now()));
    return () => { clearInterval(timer); clearTimeout(expires); context?.close().catch(() => {}); };
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
