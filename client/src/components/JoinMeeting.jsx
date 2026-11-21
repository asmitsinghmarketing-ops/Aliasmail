// /join/<code>: the page a meeting link opens. Signed-in teammates join straight away; anyone else
// types their name, asks to join, and waits until someone in the call lets them in.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import { callState, guestTransport, joinAsGuest, joinByCode, toggleMute, watchCall } from '../calls.js';
import CallRoom from './CallRoom.jsx';
import Icon from './Icon.jsx';
import { hideBoot } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';

const NAME_KEY = 'aliasmail:guest-name';
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' };

function readName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

/** The camera, shown before joining so people can check how they look. */
function useCameraPreview(on) {
  const [stream, setStream] = useState(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!on || !navigator.mediaDevices?.getUserMedia) {
      setStream(null);
      return undefined;
    }
    let alive = true;
    let opened = null;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((media) => {
        opened = media;
        if (alive) {
          setStream(media);
          setProblem('');
        } else media.getTracks().forEach((track) => track.stop());
      })
      .catch((err) => alive && setProblem(err?.name === 'NotAllowedError' ? 'Your browser is blocking the camera.' : 'No camera is available.'));
    return () => {
      alive = false;
      opened?.getTracks().forEach((track) => track.stop());
      setStream(null);
    };
  }, [on]);
  return { stream, problem };
}

function Preview({ stream, cameraOn, micOn, name, onCamera, onMic }) {
  const video = useRef(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream || null;
  }, [stream]);
  return (
    <div className="join-preview">
      {cameraOn && stream
        ? <video ref={video} autoPlay playsInline muted className="mirrored" />
        : <span className="join-preview-off">{cameraOn ? 'Starting camera…' : 'Camera is off'}</span>}
      {name && <span className="join-preview-name">{name}</span>}
      <div className="join-preview-controls">
        <button type="button" className={`call-control ${micOn ? '' : 'off'}`} aria-pressed={!micOn} aria-label={micOn ? 'Join muted' : 'Join with microphone on'} title={micOn ? 'Microphone on' : 'You will join muted'} onClick={onMic}>
          <Icon name={micOn ? 'mic' : 'micOff'} />
        </button>
        <button type="button" className={`call-control ${cameraOn ? '' : 'off'}`} aria-pressed={!cameraOn} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'} title={cameraOn ? 'Camera on' : 'Camera off'} onClick={onCamera}>
          <Icon name={cameraOn ? 'videocam' : 'videocamOff'} />
        </button>
      </div>
    </div>
  );
}

const ENDINGS = {
  denied: ['You weren’t let in', 'Someone in the meeting declined your request to join.'],
  expired: ['Nobody let you in', 'Nobody answered your request in time. You can ask again.'],
  ended: ['The meeting has ended', 'Thanks for joining.'],
  left: ['You left the meeting', 'You can join again with the same link.'],
  missing: ['This link doesn’t work', 'The meeting has ended, or the link is wrong. Ask the person who sent it for a new one.'],
};

export default function JoinMeeting({ code, onJoinedAsMember }) {
  const room = useSyncExternalStore(watchCall, callState);
  const [meeting, setMeeting] = useState(null);
  const [me, setMe] = useState(undefined); // undefined: checking; null: not signed in
  const [phase, setPhase] = useState('form'); // form | knocking | waiting | joining | in-call | denied | expired | ended | left | missing
  const [error, setError] = useState('');
  const [name, setName] = useState(readName);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const choices = useRef({ cameraOn, micOn });
  choices.current = { cameraOn, micOn };
  const session = useRef(null); // { guestId, token, source, listeners, joined }
  const preview = useCameraPreview(cameraOn && ['form', 'knocking', 'waiting'].includes(phase));

  const loadMeeting = () => fetch(`/api/meet/${encodeURIComponent(code)}`, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : Promise.reject()))
    .then(setMeeting)
    .catch(() => setPhase('missing'));
  useEffect(() => {
    hideBoot(); // the loading splash: this page doesn't wait for the mailbox
    loadMeeting();
    api('/auth/me', { signInFlow: true }).then(setMe).catch(() => setMe(null));
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  // A scheduled meeting nobody from the team has opened yet: check again every few seconds.
  const notStarted = meeting && !meeting.started && !me && phase === 'form';
  useEffect(() => {
    if (!notStarted) return undefined;
    const timer = setInterval(loadMeeting, 8000);
    return () => clearInterval(timer);
  }, [notStarted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Out of the call: say why, and stop listening.
  const wasInCall = useRef(false);
  useEffect(() => {
    if (room.phase === 'in-call') {
      wasInCall.current = true;
      setPhase('in-call');
    } else if (wasInCall.current && (room.phase === 'ended' || room.phase === 'idle')) {
      wasInCall.current = false;
      setPhase(room.phase === 'ended' ? 'ended' : 'left');
      closeSession();
    }
  }, [room.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the page while waiting: leave the queue at once.
  useEffect(() => {
    const leave = () => {
      const current = session.current;
      if (!current || current.joined) return;
      fetch(`/api/meet/${encodeURIComponent(code)}/leave`, {
        method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { ...HEADERS, 'X-Guest-Id': current.guestId, 'X-Guest-Token': current.token }, body: '{}',
      }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [code]);

  useEffect(() => () => closeSession(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function closeSession() {
    session.current?.source.close();
    session.current = null;
  }

  const afterJoining = () => {
    if (!choices.current.micOn) toggleMute();
  };

  async function joinAsTeammate() {
    setError('');
    setPhase('joining');
    try {
      await joinByCode(code, { video: choices.current.cameraOn });
      afterJoining();
      onJoinedAsMember();
    } catch (err) {
      setError(err.message);
      setPhase('form');
    }
  }

  function onLobby(message) {
    const current = session.current;
    if (!current) return;
    if (message.status === 'admitted') {
      if (current.joined) return; // the stream reconnected and repeated it
      current.joined = true;
      setPhase('joining');
      const via = guestTransport({
        code, guestId: current.guestId, token: current.token,
        subscribe: (fn) => {
          current.listeners.add(fn);
          // Messages that came while the camera and microphone were opening (someone's first
          // connection offer, typically): without them the call never connects.
          current.early.splice(0).forEach(fn);
          return () => current.listeners.delete(fn);
        },
      });
      joinAsGuest({ call: message.call, peerId: message.peerId, iceServers: message.iceServers }, via, { video: choices.current.cameraOn })
        .then(afterJoining)
        .catch((err) => {
          setError(err.message);
          setPhase('form');
          closeSession();
        });
    } else if (['denied', 'expired', 'ended'].includes(message.status)) {
      closeSession();
      setPhase(message.status);
    }
  }

  async function askToJoin(event) {
    event.preventDefault();
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return setError('Enter your name so they know who is asking.');
    setError('');
    setPhase('knocking');
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch { /* private window */ }
    try {
      const res = await fetch(`/api/meet/${encodeURIComponent(code)}/knock`, { method: 'POST', credentials: 'same-origin', headers: HEADERS, body: JSON.stringify({ name: clean }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 404) setPhase('missing');
        else {
          setError(data?.error || 'Couldn’t ask to join. Try again.');
          setPhase('form');
        }
        return undefined;
      }
      const listeners = new Set();
      const source = new EventSource(`/api/meet/${encodeURIComponent(code)}/events?guest=${encodeURIComponent(data.guestId)}&token=${encodeURIComponent(data.token)}`);
      const early = [];
      session.current = { guestId: data.guestId, token: data.token, source, listeners, early, joined: false };
      source.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'lobby') onLobby(message);
        else if (listeners.size) listeners.forEach((fn) => fn(message));
        else early.push(message); // let in, but the call isn't listening yet
      };
      source.onopen = () => listeners.forEach((fn) => fn({ type: 'open' }));
      setPhase('waiting');
    } catch {
      setError('Couldn’t reach Nextspace. Check your connection and try again.');
      setPhase('form');
    }
    return undefined;
  }

  async function cancel() {
    const current = session.current;
    closeSession();
    setPhase('form');
    if (current) {
      await fetch(`/api/meet/${encodeURIComponent(code)}/leave`, {
        method: 'POST', credentials: 'same-origin', headers: { ...HEADERS, 'X-Guest-Id': current.guestId, 'X-Guest-Token': current.token }, body: '{}',
      }).catch(() => {});
    }
  }

  if (phase === 'in-call' && room.phase === 'in-call') return <CallRoom state={room} />;

  const ending = ENDINGS[phase];
  const host = meeting?.hostName;
  const signedIn = Boolean(me);
  const myName = me?.displayName || me?.email || '';

  return (
    <div className="join-page">
      <header className="join-brand"><Logo size={34} /><Wordmark /></header>
      <main className="join-main">
        {ending ? (
          <section className="join-ending">
            <h1>{ending[0]}</h1>
            <p>{ending[1]}</p>
            {['left', 'expired', 'denied'].includes(phase) && meeting && <button type="button" className="btn btn-primary" onClick={() => setPhase('form')}>Ask to join again</button>}
            <a className="btn btn-outline" href="/">Go to Nextspace</a>
          </section>
        ) : (
          <>
            <Preview
              stream={preview.stream}
              cameraOn={cameraOn}
              micOn={micOn}
              name={signedIn ? myName : name}
              onCamera={() => setCameraOn((on) => !on)}
              onMic={() => setMicOn((on) => !on)}
            />
            <section className="join-panel">
              <h1>{meeting?.title || (host ? `${host}’s meeting` : 'Meeting')}</h1>
              {meeting?.title && host && <p className="join-note">Organised by {host}</p>}
              {meeting && !meeting.started && (
                <p className="join-starts">
                  <Icon name="event" size={18} />
                  {new Date(meeting.startAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
              {preview.problem && cameraOn && <p className="join-note">{preview.problem} You can still join without it.</p>}
              {me === undefined || !meeting ? (
                <p className="join-note">Getting the meeting ready…</p>
              ) : phase === 'waiting' || phase === 'knocking' ? (
                <div className="join-waiting" role="status">
                  <span className="join-spinner" aria-hidden="true" />
                  <strong>{phase === 'knocking' ? 'Asking to join…' : 'Waiting for someone to let you in'}</strong>
                  <p>You’ll join as soon as someone in the meeting admits you.</p>
                  <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
                </div>
              ) : phase === 'joining' ? (
                <div className="join-waiting" role="status"><span className="join-spinner" aria-hidden="true" /><strong>Joining…</strong></div>
              ) : signedIn ? (
                <>
                  <p className="join-note">
                    You’re signed in as {myName}, so you can {meeting.started ? 'join straight away' : 'start the meeting now; guests can ask to join once you’re in'}.
                  </p>
                  <button type="button" className="btn btn-primary join-go" onClick={joinAsTeammate}>{meeting.started ? 'Join now' : 'Start meeting'}</button>
                </>
              ) : !meeting.started ? (
                <div className="join-waiting" role="status">
                  <span className="join-spinner" aria-hidden="true" />
                  <strong>The meeting hasn’t started yet</strong>
                  <p>Keep this page open. You can ask to join as soon as someone from the team opens the meeting.</p>
                </div>
              ) : (
                <form className="join-form" onSubmit={askToJoin}>
                  <label>
                    <span>Your name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="name" placeholder="How others will see you" autoFocus />
                  </label>
                  <button type="submit" className="btn btn-primary join-go">Ask to join</button>
                  <p className="join-note small">Someone in the meeting will let you in. Your camera and microphone are only used during the call.</p>
                </form>
              )}
              {error && <div className="alert" role="alert">{error}</div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
