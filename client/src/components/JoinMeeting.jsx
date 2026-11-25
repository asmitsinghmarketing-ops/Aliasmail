// /join/<code>: the page a meeting link opens. Signed-in teammates join straight away; anyone else
// types their name, asks to join, and waits until someone in the call lets them in. Before joining,
// people see themselves, check their microphone moves the meter, and pick a camera and microphone.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import { callState, guestTransport, joinAsGuest, joinByCode, rememberDevice, rememberedDevices, watchCall } from '../calls.js';
import CallRoom, { playTestSound, useMicLevel } from './CallRoom.jsx';
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

const problemText = (err, what) => (err?.name === 'NotAllowedError'
  ? `Your browser is blocking the ${what}. Allow it from the address bar.`
  : err?.name === 'NotReadableError' ? `Another app is using the ${what}.` : `No ${what} is available.`);

/**
 * The camera and microphone, opened before joining so people can check how they look and sound.
 * Each is opened on its own, so a missing camera doesn't stop the microphone check (and the
 * other way round). `stop()` lets go of both straight away, before the call opens them again:
 * phones can't share a camera between two requests.
 */
function useMediaPreview({ camera, mic, cameraId, micId }) {
  const [video, setVideo] = useState(null);
  const [audio, setAudio] = useState(null);
  const [problem, setProblem] = useState({ camera: '', mic: '' });
  const opened = useRef({ video: null, audio: null });

  useEffect(() => {
    if (!camera || !navigator.mediaDevices?.getUserMedia) {
      setVideo(null);
      return undefined;
    }
    let alive = true;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(cameraId && { deviceId: { ideal: cameraId } }) } })
      .then((media) => {
        if (!alive) return media.getTracks().forEach((track) => track.stop());
        opened.current.video = media;
        setVideo(media);
        setProblem((current) => ({ ...current, camera: '' }));
        return undefined;
      })
      .catch((err) => alive && setProblem((current) => ({ ...current, camera: problemText(err, 'camera') })));
    return () => {
      alive = false;
      opened.current.video?.getTracks().forEach((track) => track.stop());
      opened.current.video = null;
      setVideo(null);
    };
  }, [camera, cameraId]);

  useEffect(() => {
    if (!mic || !navigator.mediaDevices?.getUserMedia) {
      setAudio(null);
      return undefined;
    }
    let alive = true;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(micId && { deviceId: { ideal: micId } }) } })
      .then((media) => {
        if (!alive) return media.getTracks().forEach((track) => track.stop());
        opened.current.audio = media;
        setAudio(media);
        setProblem((current) => ({ ...current, mic: '' }));
        return undefined;
      })
      .catch((err) => alive && setProblem((current) => ({ ...current, mic: problemText(err, 'microphone') })));
    return () => {
      alive = false;
      opened.current.audio?.getTracks().forEach((track) => track.stop());
      opened.current.audio = null;
      setAudio(null);
    };
  }, [mic, micId]);

  const stop = () => {
    for (const media of [opened.current.video, opened.current.audio]) media?.getTracks().forEach((track) => track.stop());
  };
  return { video, audio, problem, stop };
}

/** The cameras and microphones on this device (names appear once a permission is given). */
function useDevices(refreshKey) {
  const [devices, setDevices] = useState([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, [refreshKey]);
  return devices;
}

function Preview({ video, audio, cameraOn, micOn, name, onCamera, onMic }) {
  const element = useRef(null);
  const level = useMicLevel(micOn ? audio : null);
  useEffect(() => {
    if (element.current) element.current.srcObject = video || null;
  }, [video]);
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div className={`nx-join-preview ${cameraOn && video ? 'live' : ''}`}>
      {cameraOn && video
        ? <video ref={element} autoPlay playsInline muted className="mirrored" />
        : (
          <span className="nx-join-off">
            <span className="nx-join-initial" aria-hidden="true">{initial}</span>
            <span>{cameraOn ? 'Starting camera…' : 'Camera is off'}</span>
          </span>
        )}
      <span className="nx-join-chip">
        {micOn
          ? <span className="nx-join-level" aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>{[0, 1, 2, 3, 4].map((i) => <i key={i} className={level * 5 > i ? 'lit' : ''} />)}</span>
          : <Icon name="micOff" size={15} />}
        {name || 'You'}
      </span>
      <div className="nx-join-toggles">
        <button type="button" className={`nx-ctl ${micOn ? '' : 'off'}`} aria-pressed={!micOn} aria-label={micOn ? 'Join muted' : 'Join with microphone on'} title={micOn ? 'Microphone on' : 'You will join muted'} onClick={onMic}>
          <Icon name={micOn ? 'mic' : 'micOff'} size={22} />
        </button>
        <button type="button" className={`nx-ctl ${cameraOn ? '' : 'off'}`} aria-pressed={!cameraOn} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'} title={cameraOn ? 'Camera on' : 'Camera off'} onClick={onCamera}>
          <Icon name={cameraOn ? 'videocam' : 'videocamOff'} size={22} />
        </button>
      </div>
    </div>
  );
}

function DevicePicker({ devices, kind, label, icon, value, onChange }) {
  const options = devices.filter((device) => device.kind === kind && device.deviceId);
  if (options.length < 1 || !options.some((device) => device.label)) return null;
  const known = options.some((device) => device.deviceId === value);
  return (
    <label className="nx-join-device">
      <Icon name={icon} size={17} />
      <select aria-label={label} value={known ? value : ''} onChange={(event) => onChange(event.target.value)}>
        {!known && <option value="">Default {label.toLowerCase()}</option>}
        {options.map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${i + 1}`}</option>)}
      </select>
    </label>
  );
}

const ENDINGS = {
  denied: ['You weren’t let in', 'Someone in the meeting declined your request to join.', 'close'],
  expired: ['Nobody let you in', 'Nobody answered your request in time. You can ask again.', 'clock'],
  ended: ['The meeting has ended', 'Thanks for joining.', 'checkCircle'],
  left: ['You left the meeting', 'You can join again with the same link.', 'callEnd'],
  missing: ['This link doesn’t work', 'The meeting has ended, or the link is wrong. Ask the person who sent it for a new one.', 'link'],
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
  const [chosen, setChosen] = useState(() => ({
    videoinput: rememberedDevices().videoinput || '',
    audioinput: rememberedDevices().audioinput || '',
    audiooutput: rememberedDevices().audiooutput || 'default',
  }));
  const [speakerTest, setSpeakerTest] = useState({ playing: false, error: '' });
  const choices = useRef({ cameraOn, micOn });
  choices.current = { cameraOn, micOn };
  const session = useRef(null); // { guestId, token, source, listeners, joined }
  const knocking = useRef(null); // the current lobby request, so Cancel can clean it up even after the server accepted it
  const previewing = ['form', 'knocking', 'waiting'].includes(phase);
  const preview = useMediaPreview({ camera: cameraOn && previewing, mic: micOn && previewing, cameraId: chosen.videoinput, micId: chosen.audioinput });
  const devices = useDevices(`${Boolean(preview.video)}:${Boolean(preview.audio)}`);

  const pickDevice = (kind) => (deviceId) => {
    rememberDevice(kind, deviceId);
    setChosen((current) => ({ ...current, [kind]: deviceId }));
  };

  async function testSpeaker() {
    setSpeakerTest({ playing: true, error: '' });
    try {
      await playTestSound(chosen.audiooutput);
      setSpeakerTest({ playing: false, error: '' });
    } catch (err) {
      setSpeakerTest({ playing: false, error: err.message });
    }
  }

  // `quiet`: a background re-check; a hiccup there shouldn't tell someone the link is broken.
  const loadMeeting = (signal, quiet = false) => fetch(`/api/meet/${encodeURIComponent(code)}`, { credentials: 'same-origin', signal })
    .then((res) => (res.ok ? res.json() : Promise.reject(Object.assign(new Error('missing'), { status: res.status }))))
    .then(setMeeting)
    .catch((err) => {
      if (err?.name === 'AbortError') return;
      if (!quiet || err?.status === 404) setPhase('missing');
    });
  useEffect(() => {
    const controller = new AbortController();
    setMeeting(null);
    setMe(undefined);
    setError('');
    setPhase('form');
    hideBoot(); // the loading splash: this page doesn't wait for the mailbox
    loadMeeting(controller.signal);
    api('/auth/me', { signInFlow: true }).then(setMe).catch(() => setMe(null));
    return () => controller.abort();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  // A scheduled meeting nobody from the team has opened yet: check again every few seconds.
  const notStarted = meeting && !meeting.started && !me && phase === 'form';
  useEffect(() => {
    if (!notStarted) return undefined;
    const timer = setInterval(() => loadMeeting(undefined, true), 8000);
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

  useEffect(() => () => {
    if (knocking.current) knocking.current.cancelled = true;
    const current = session.current;
    closeSession();
    if (current && !current.joined) leaveSession(current, true);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  function closeSession() {
    session.current?.source.close();
    session.current = null;
  }

  function leaveSession(current, keepalive = false) {
    return fetch(`/api/meet/${encodeURIComponent(code)}/leave`, {
      method: 'POST', keepalive, credentials: 'same-origin',
      headers: { ...HEADERS, 'X-Guest-Id': current.guestId, 'X-Guest-Token': current.token }, body: '{}',
    }).catch(() => {});
  }

  async function joinAsTeammate() {
    setError('');
    setPhase('joining');
    preview.stop();
    try {
      await joinByCode(code, { video: choices.current.cameraOn, muted: !choices.current.micOn });
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
      preview.stop();
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
      joinAsGuest({ call: message.call, peerId: message.peerId, iceServers: message.iceServers }, via, { video: choices.current.cameraOn, muted: !choices.current.micOn })
        .catch((err) => {
          setError(err.message);
          setPhase('form');
          leaveSession(current);
          closeSession();
        });
    } else if (['denied', 'expired', 'ended'].includes(message.status)) {
      closeSession();
      setPhase(message.status);
    }
  }

  async function askToJoin(event) {
    event.preventDefault();
    if (knocking.current) return undefined;
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return setError('Enter your name so they know who is asking.');
    const request = { cancelled: false };
    knocking.current = request;
    setError('');
    setPhase('knocking');
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch { /* private window */ }
    try {
      const res = await fetch(`/api/meet/${encodeURIComponent(code)}/knock`, { method: 'POST', credentials: 'same-origin', headers: HEADERS, body: JSON.stringify({ name: clean }) });
      const data = await res.json().catch(() => null);
      if (request.cancelled) {
        if (res.ok && data?.guestId && data?.token) leaveSession(data);
        return undefined;
      }
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
      source.onmessage = (message) => {
        let parsed;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (parsed.type === 'lobby') onLobby(parsed);
        else if (listeners.size) listeners.forEach((fn) => fn(parsed));
        else early.push(parsed); // let in, but the call isn't listening yet
      };
      source.onopen = () => listeners.forEach((fn) => fn({ type: 'open' }));
      setPhase('waiting');
    } catch {
      if (request.cancelled) return undefined;
      setError('Couldn’t reach Nextspace. Check your connection and try again.');
      setPhase('form');
    } finally {
      if (knocking.current === request) knocking.current = null;
    }
    return undefined;
  }

  async function cancel() {
    if (knocking.current) knocking.current.cancelled = true;
    knocking.current = null;
    const current = session.current;
    closeSession();
    setPhase('form');
    if (current) await leaveSession(current);
  }

  if (phase === 'in-call' && room.phase === 'in-call') return <CallRoom state={room} />;

  const ending = ENDINGS[phase];
  const host = meeting?.hostName;
  const signedIn = Boolean(me);
  const myName = me?.displayName || me?.email || '';
  const heading = meeting?.title || (host ? `${host}’s meeting` : 'Meeting');
  const problems = [cameraOn && preview.problem.camera, micOn && preview.problem.mic].filter(Boolean);

  return (
    <div className="nx-join">
      <header className="nx-join-brand"><Logo size={32} /><Wordmark /></header>
      <main className="nx-join-main">
        {ending ? (
          <section className="nx-join-card nx-join-ending">
            <span className="nx-join-ending-icon"><Icon name={ending[2]} size={28} /></span>
            <h1>{ending[0]}</h1>
            <p>{ending[1]}</p>
            {['left', 'expired', 'denied'].includes(phase) && meeting && <button type="button" className="nx-btn primary big" onClick={() => setPhase('form')}>{phase === 'left' ? 'Rejoin' : 'Ask to join again'}</button>}
            <a className="nx-btn big" href="/">Go to Nextspace</a>
          </section>
        ) : (
          <>
            <div className="nx-join-stage">
              <Preview
                video={preview.video}
                audio={preview.audio}
                cameraOn={cameraOn}
                micOn={micOn}
                name={signedIn ? myName : name}
                onCamera={() => setCameraOn((on) => !on)}
                onMic={() => setMicOn((on) => !on)}
              />
              <div className="nx-join-devices">
                <DevicePicker devices={devices} kind="audioinput" label="Microphone" icon="mic" value={chosen.audioinput} onChange={pickDevice('audioinput')} />
                <DevicePicker devices={devices} kind="videoinput" label="Camera" icon="videocam" value={chosen.videoinput} onChange={pickDevice('videoinput')} />
                {'setSinkId' in HTMLMediaElement.prototype ? (
                  <>
                    <DevicePicker devices={devices} kind="audiooutput" label="Speaker" icon="volume" value={chosen.audiooutput} onChange={pickDevice('audiooutput')} />
                    <button type="button" className="nx-join-device nx-join-speaker-test" disabled={speakerTest.playing} onClick={testSpeaker}>
                      <Icon name="volume" size={17} /> {speakerTest.playing ? 'Playing…' : 'Test speaker'}
                    </button>
                  </>
                ) : (
                  <span className="nx-join-device nx-join-system-audio"><Icon name="volume" size={17} /> Speaker: system default</span>
                )}
              </div>
              {speakerTest.error && <p className="nx-join-problem"><Icon name="info" size={16} />{speakerTest.error}</p>}
              {problems.length > 0 && <p className="nx-join-problem"><Icon name="info" size={16} />{problems.join(' ')} You can still join.</p>}
            </div>

            <section className="nx-join-card">
              <span className="nx-join-kicker"><i /> {meeting?.started === false ? 'Scheduled meeting' : 'Ready to join'}</span>
              <h1>{heading}</h1>
              {meeting?.title && host && <p className="nx-join-note">Organised by {host}</p>}
              {meeting && !meeting.started && (
                <p className="nx-join-starts">
                  <Icon name="event" size={18} />
                  {new Date(meeting.startAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
              {me === undefined || !meeting ? (
                <div className="nx-join-wait" role="status"><span className="nx-spinner" aria-hidden="true" /><strong>Getting the meeting ready…</strong></div>
              ) : phase === 'waiting' || phase === 'knocking' ? (
                <div className="nx-join-wait" role="status">
                  <span className="nx-join-pulse" aria-hidden="true"><Icon name="people" size={22} /></span>
                  <strong>{phase === 'knocking' ? 'Asking to join…' : 'Waiting for someone to let you in'}</strong>
                  <p>You’ll join as soon as someone in the meeting admits you. Keep this page open.</p>
                  <button type="button" className="nx-btn big" onClick={cancel}>Cancel</button>
                </div>
              ) : phase === 'joining' ? (
                <div className="nx-join-wait" role="status"><span className="nx-spinner" aria-hidden="true" /><strong>Joining…</strong></div>
              ) : signedIn ? (
                <>
                  <p className="nx-join-note">
                    Signed in as <strong>{myName}</strong>, so you can {meeting.started ? 'join straight away' : 'start the meeting now; guests can ask to join once you’re in'}.
                  </p>
                  <button type="button" className="nx-btn primary big" onClick={joinAsTeammate}><Icon name="videocam" size={20} />{meeting.started ? 'Join now' : 'Start meeting'}</button>
                </>
              ) : !meeting.started ? (
                <div className="nx-join-wait" role="status">
                  <span className="nx-spinner" aria-hidden="true" />
                  <strong>The meeting hasn’t started yet</strong>
                  <p>Keep this page open. You can ask to join as soon as someone from the team opens the meeting.</p>
                </div>
              ) : (
                <form className="nx-join-form" onSubmit={askToJoin}>
                  <label>
                    <span>Your name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="name" placeholder="How others will see you" enterKeyHint="go" />
                  </label>
                  <button type="submit" className="nx-btn primary big">Ask to join</button>
                  <p className="nx-join-note small"><Icon name="lock" size={14} /> Someone in the meeting lets you in. Your camera and microphone are only used during the call.</p>
                </form>
              )}
              {error && <div className="nx-join-error" role="alert">{error}</div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
