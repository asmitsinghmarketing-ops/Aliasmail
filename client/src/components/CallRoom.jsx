// The call on screen: everyone's pictures, the controls, and a small version to keep working in.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  admitGuest, canShareScreen, chooseDevice, clearNotice, hangUp, inviteToCall, meetingCode, meetingLink, retryMicrophone,
  setRecording, toggleCamera, toggleHand, toggleMute, toggleScreen,
} from '../calls.js';
import { createCallRecorder, downloadRecording, recordingSupported } from '../callRecording.js';
import { createRecordingUpload } from '../recordingUpload.js';
import { onlineNow } from '../live.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

/** Filling the box would crop too much (a phone's tall picture in a wide tile): show it whole. */
const shapesDiffer = (videoRatio, boxRatio) => Math.max(videoRatio / boxRatio, boxRatio / videoRatio) > 1.4;

function Video({ stream, muted = true, className }) {
  const element = useRef(null);
  const [fit, setFit] = useState(false);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  // Phones turn sideways and windows resize: check again whenever either shape changes.
  useEffect(() => {
    const video = element.current;
    if (!video) return undefined;
    const check = () => {
      if (!video.videoWidth || !video.videoHeight || !video.clientWidth || !video.clientHeight) return;
      setFit(shapesDiffer(video.videoWidth / video.videoHeight, video.clientWidth / video.clientHeight));
    };
    video.addEventListener('loadedmetadata', check);
    video.addEventListener('resize', check);
    const observer = window.ResizeObserver ? new ResizeObserver(check) : null;
    observer?.observe(video);
    check();
    return () => {
      video.removeEventListener('loadedmetadata', check);
      video.removeEventListener('resize', check);
      observer?.disconnect();
    };
  }, []);
  return <video ref={element} className={[className, fit && 'fit'].filter(Boolean).join(' ')} autoPlay playsInline muted={muted} />;
}

/** Plays one person's voice. Kept apart from the pictures so it carries on when they aren't shown. */
function Voice({ stream, speaker }) {
  const element = useRef(null);
  useEffect(() => {
    if (!element.current) return;
    if (element.current.srcObject !== stream) element.current.srcObject = stream;
    element.current.play?.().catch(() => {});
  }, [stream]);
  useEffect(() => {
    if (speaker && element.current?.setSinkId) element.current.setSinkId(speaker).catch(() => {});
  }, [speaker]);
  return <audio ref={element} autoPlay />;
}

/** Who is talking right now: the loudest voice above a low level. */
function useSpeaker(voices) {
  const [speaker, setSpeaker] = useState(null);
  const key = voices.map(({ id, stream }) => `${id}:${stream?.id}`).join();
  useEffect(() => {
    const Audio = window.AudioContext || window.webkitAudioContext;
    const live = voices.filter((voice) => voice.stream);
    if (!Audio || !live.length) return undefined;
    const context = new Audio();
    const meters = live.map(({ id, stream }) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      return { id, analyser, samples: new Uint8Array(analyser.frequencyBinCount) };
    });
    const timer = setInterval(() => {
      let loudest = null;
      let level = 12;
      for (const meter of meters) {
        meter.analyser.getByteFrequencyData(meter.samples);
        const average = meter.samples.reduce((sum, value) => sum + value, 0) / meter.samples.length;
        if (average > level) {
          level = average;
          loudest = meter.id;
        }
      }
      setSpeaker(loudest);
    }, 300);
    return () => {
      clearInterval(timer);
      context.close().catch(() => {});
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return speaker;
}

function useDuration(startedAt) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0'));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${parts.join(':')}` : parts.join(':');
}

function Tile({ name, address, stream, videoOn, muted, hand, speaking, status, mirrored }) {
  return (
    <div className={`call-tile ${speaking ? 'speaking' : ''}`}>
      {videoOn && stream
        ? <Video stream={stream} className={mirrored ? 'mirrored' : ''} />
        : <span className="call-tile-avatar"><Avatar person={{ name, address }} size="lg" /></span>}
      {status && <span className="call-tile-status">{status}</span>}
      {hand && <span className="call-tile-hand" title="Hand raised"><Icon name="hand" size={18} /></span>}
      <span className="call-tile-name">
        {muted && <Icon name="micOff" size={15} />}
        <span>{name}</span>
      </span>
    </div>
  );
}

/**
 * A round call button. `off`: something is switched off (red, like a muted mic); `on`: something
 * is active (sharing, hand raised, a panel open). The label is the tooltip.
 */
function ControlButton({ icon, label, on, off, danger, recording, disabled, onClick, badge, side }) {
  const pressed = off !== undefined ? off : on;
  return (
    <button
      type="button"
      className={`call-control ${on ? 'on' : ''} ${off ? 'off' : ''} ${danger ? 'danger' : ''} ${recording ? 'recording' : ''} ${side ? 'side' : ''}`}
      aria-label={label}
      aria-pressed={pressed === undefined || danger ? undefined : pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      {badge > 0 && <span className="call-control-badge">{badge}</span>}
    </button>
  );
}

/** The time of day, for the corner of the call (like a wall clock in a meeting room). */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------- side panels ---------------------------------- */

/** The meeting link, made on first use, with a Copy button. */
function ShareLink({ state, intro }) {
  const [code, setCode] = useState(state.call.code);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (state.call.code) setCode(state.call.code); }, [state.call.code]);
  const link = code ? meetingLink(code) : '';
  async function make() {
    setBusy(true);
    setError('');
    try {
      setCode(await meetingCode());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Couldn’t copy. Select the link and copy it yourself.');
    }
  }
  return (
    <div className="call-share">
      {intro && <p className="call-panel-note">{intro}</p>}
      {code ? (
        <div className="call-share-link">
          <input readOnly value={link} aria-label="Meeting link" onFocus={(event) => event.target.select()} />
          <button type="button" className="btn btn-primary" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={17} />{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : (
        <button type="button" className="btn btn-outline call-share-make" disabled={busy} onClick={make}><Icon name="link" size={17} />{busy ? 'Making a link…' : 'Get a meeting link'}</button>
      )}
      {error && <p className="call-panel-error">{error}</p>}
    </div>
  );
}

/** One person in the call: picture, name, and what they're doing (hand up, muted). */
function InCall({ peer, me }) {
  return (
    <li>
      <Avatar person={peer} size="sm" />
      <span className="call-person">
        <strong>{peer.name}{peer.id === me ? ' (you)' : ''}</strong>
        {peer.guest && <small>Guest</small>}
      </span>
      {peer.hand && <span className="call-person-hand" title="Hand raised"><Icon name="hand" size={16} /></span>}
      <span className={`call-person-mic ${peer.muted ? 'off' : ''}`} title={peer.muted ? 'Muted' : 'Microphone on'}><Icon name={peer.muted ? 'micOff' : 'mic'} size={17} /></span>
    </li>
  );
}

function PeoplePanel({ state }) {
  if (state.guest) {
    return (
      <>
        <h2 className="call-panel-title">People</h2>
        <h3>In the call <span>{state.call.peers.length}</span></h3>
        <ul className="call-people">{state.call.peers.map((peer) => <InCall key={peer.id} peer={peer} me={state.me} />)}</ul>
      </>
    );
  }
  return <TeamPeoplePanel state={state} />;
}

function TeamPeoplePanel({ state }) {
  const [team, setTeam] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => { api('/mail/team').then(setTeam).catch((err) => setError(err.message)); }, []);
  const inCall = new Set(state.call.peers.map((peer) => peer.address));
  const ringing = new Set(state.call.invited.filter((invite) => invite.status === 'ringing').map((invite) => invite.address));
  const online = onlineNow();
  const query = search.trim().toLowerCase();
  const others = (team || [])
    .filter((person) => !inCall.has(person.address))
    .filter((person) => !query || `${person.name} ${person.address}`.toLowerCase().includes(query))
    .sort((a, b) => Number(Boolean(online?.has(b.address))) - Number(Boolean(online?.has(a.address))));
  const lobby = state.call.lobby || [];
  const invite = (address) => inviteToCall([address]).catch((err) => setError(err.message));
  const answer = async (guest, allow) => {
    setBusy(guest.id);
    setError('');
    try {
      await admitGuest(guest.id, allow);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <h2 className="call-panel-title">People</h2>

      <section className="call-panel-section">
        <h3>Add people</h3>
        <ShareLink state={state} intro="Send this link to anyone. Teammates come straight in; you let others in." />
        {(team?.length || 0) > 5 && (
          <label className="call-people-search">
            <Icon name="search" size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your team" aria-label="Search your team" />
          </label>
        )}
        {error && <p className="call-panel-error">{error}</p>}
        {!team && !error && <p className="call-panel-note">Getting your team…</p>}
        {team && !others.length && <p className="call-panel-note">{query ? 'Nobody on your team matches.' : 'Everyone on your team is here.'}</p>}
        <ul className="call-people">
          {others.map((person) => (
            <li key={person.address}>
              <span className="presence-wrap">
                <Avatar person={person} size="sm" />
                {online?.has(person.address) && <span className="presence-dot" title="Online" />}
              </span>
              <span className="call-person">
                <strong>{person.name || person.address}</strong>
                <small>{online?.has(person.address) ? 'Online now' : person.address}</small>
              </span>
              <button type="button" className="call-pill" disabled={ringing.has(person.address)} onClick={() => invite(person.address)}>
                <Icon name="call" size={15} />{ringing.has(person.address) ? 'Ringing…' : 'Ring'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {lobby.length > 0 && (
        <section className="call-panel-section">
          <h3>Waiting to join <span>{lobby.length}</span></h3>
          <ul className="call-people">
            {lobby.map((guest) => (
              <li key={guest.id}>
                <Avatar person={{ name: guest.name, address: `guest:${guest.id}` }} size="sm" />
                <span className="call-person"><strong>{guest.name}</strong><small>Guest</small></span>
                <button type="button" className="call-pill" disabled={busy === guest.id} onClick={() => answer(guest, false)}>Deny</button>
                <button type="button" className="call-pill primary" disabled={busy === guest.id} onClick={() => answer(guest, true)}>Admit</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="call-panel-section">
        <h3>In the call <span>{state.call.peers.length}</span></h3>
        <ul className="call-people">{state.call.peers.map((peer) => <InCall key={peer.id} peer={peer} me={state.me} />)}</ul>
      </section>
    </>
  );
}

const ALONE_STOP_MS = 15_000; // recording with nobody left: stop and save after this
const AudioContextClass = () => window.AudioContext || window.webkitAudioContext;

/**
 * How loud the microphone is, 0–1. Measured on a copy of the microphone that stays on, so the
 * meter works while muted too (muting only silences what the others receive).
 */
function useMicLevel(stream) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const Context = AudioContextClass();
    const track = stream?.getAudioTracks()[0]?.clone();
    if (!Context || !track) {
      setLevel(0);
      return undefined;
    }
    track.enabled = true;
    const context = new Context();
    context.resume().catch(() => {});
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
      setLevel(Math.min(1, peak / 48));
    }, 80);
    return () => {
      clearInterval(timer);
      track.stop();
      context.close().catch(() => {});
    };
  }, [stream]);
  return level;
}

/** A short three-note chime through the chosen speaker, so people can check they hear the call. */
async function playTestSound(sinkId) {
  const Context = AudioContextClass();
  if (!Context) throw new Error('This browser can’t play a test sound.');
  const context = new Context();
  const output = context.createMediaStreamDestination();
  const element = new Audio();
  element.srcObject = output.stream;
  try {
    if (sinkId && element.setSinkId) await element.setSinkId(sinkId);
    await context.resume();
    await element.play();
  } catch (err) {
    context.close().catch(() => {});
    throw new Error(err?.name === 'NotFoundError' ? 'That speaker isn’t connected any more. Choose another one.' : 'Couldn’t play through that speaker.');
  }
  const start = context.currentTime + 0.05;
  [[660, 0], [880, 0.2], [1320, 0.4]].forEach(([frequency, at]) => {
    const tone = context.createOscillator();
    const envelope = context.createGain();
    tone.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, start + at);
    envelope.gain.exponentialRampToValueAtTime(0.3, start + at + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.38);
    tone.connect(envelope).connect(output);
    tone.start(start + at);
    tone.stop(start + at + 0.4);
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  element.pause();
  element.srcObject = null;
  context.close().catch(() => {});
}

function DevicesPanel({ state }) {
  const [devices, setDevices] = useState([]);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const level = useMicLevel(state.localAudio);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, []);
  const speakerChoice = 'setSinkId' in HTMLMediaElement.prototype;
  const picker = (kind, label, value) => {
    const options = devices.filter((device) => device.kind === kind && device.deviceId);
    const known = options.some((device) => device.deviceId === value);
    return (
      <label className="call-device">
        <span>{label}</span>
        <select value={known ? value : ''} disabled={!options.length} onChange={(event) => chooseDevice(kind, event.target.value)}>
          {!known && <option value="">Default</option>}
          {options.map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${i + 1}`}</option>)}
        </select>
      </label>
    );
  };
  async function testSpeaker() {
    setTesting(true);
    setTestError('');
    try {
      await playTestSound(state.speakerDevice);
    } catch (err) {
      setTestError(err.message);
    } finally {
      setTesting(false);
    }
  }
  const micNote = !state.micAvailable
    ? null
    : state.muted ? 'You’re muted, so others can’t hear you. The bar still shows your microphone working.' : 'Say something: the bar should move.';
  return (
    <>
      <h2 className="call-panel-title">Devices</h2>
      {picker('audioinput', 'Microphone', state.micDevice)}
      {state.micAvailable ? (
        <>
          <div className="call-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            {Array.from({ length: 12 }, (_, i) => <span key={i} className={level * 12 > i ? 'lit' : ''} />)}
          </div>
          <p className="call-panel-note">{micNote}</p>
        </>
      ) : (
        <p className="call-panel-note">
          No microphone is on.{' '}
          <button type="button" className="call-link" onClick={retryMicrophone}>Try again</button>
        </p>
      )}
      {speakerChoice
        ? picker('audiooutput', 'Speaker', state.speakerDevice)
        : <p className="call-panel-note">This browser plays calls through your computer’s current speaker. Change it in your sound settings.</p>}
      <button type="button" className="btn btn-outline call-test-sound" disabled={testing} onClick={testSpeaker}>
        <Icon name="volume" size={18} /> {testing ? 'Playing…' : 'Play test sound'}
      </button>
      {testError && <p className="call-panel-error">{testError}</p>}
      {picker('videoinput', 'Camera', state.cameraDevice)}
    </>
  );
}

/* ---------------------------------- the room ---------------------------------- */

/**
 * Stop a recording and keep it: sent to Nextspace, or, if that failed, downloaded here so nothing
 * is lost. Returns { saved } or { error }.
 */
async function saveRecording({ rec, upload }) {
  const blob = await rec.stop();
  try {
    return { saved: await upload.finish(Date.now() - rec.startedAt.getTime()) };
  } catch (err) {
    downloadRecording(blob, rec.startedAt);
    return { error: `${err.message} It was downloaded to this computer instead.` };
  }
}

/** Two quiet notes, like a knock on the door, when someone asks to join. */
function knock() {
  const Context = AudioContextClass();
  if (!Context) return;
  try {
    const context = new Context();
    const start = context.currentTime + 0.02;
    [[740, 0], [988, 0.16]].forEach(([frequency, at]) => {
      const tone = context.createOscillator();
      const envelope = context.createGain();
      tone.frequency.value = frequency;
      envelope.gain.setValueAtTime(0.0001, start + at);
      envelope.gain.exponentialRampToValueAtTime(0.12, start + at + 0.02);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.3);
      tone.connect(envelope).connect(context.destination);
      tone.start(start + at);
      tone.stop(start + at + 0.32);
    });
    setTimeout(() => context.close().catch(() => {}), 800);
  } catch {
    // no sound; the card still shows
  }
}

/** People waiting outside, each with Admit and Deny. */
function Lobby({ lobby }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  if (!lobby.length) return null;
  const answer = async (guest, allow) => {
    setBusy(guest.id);
    setError('');
    try {
      await admitGuest(guest.id, allow);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="call-lobby" role="region" aria-label="Waiting to join" aria-live="polite">
      {lobby.map((guest) => (
        <div className="call-lobby-item" key={guest.id}>
          <Avatar person={{ name: guest.name, address: `guest:${guest.id}` }} size="sm" />
          <span className="call-lobby-who"><strong>{guest.name}</strong><small>wants to join this call</small></span>
          <button type="button" className="btn btn-outline" disabled={busy === guest.id} onClick={() => answer(guest, false)}>Deny</button>
          <button type="button" className="btn btn-primary" disabled={busy === guest.id} onClick={() => answer(guest, true)}>Admit</button>
        </div>
      ))}
      {error && <p className="call-panel-error">{error}</p>}
    </div>
  );
}

export default function CallRoom({ state }) {
  const [minimized, setMinimized] = useState(false);
  const [panel, setPanel] = useState(null); // 'people' | 'devices'
  const [recordError, setRecordError] = useState('');
  const [confirmRecord, setConfirmRecord] = useState(false);
  const [recordStatus, setRecordStatus] = useState(null); // null | 'saving' | 'saved'
  const [recordingStartedAt, setRecordingStartedAt] = useState(null);
  const recorder = useRef(null); // { rec, upload } while recording
  const duration = useDuration(state.startedAt);
  const clock = useClock();
  const { call, me, peers } = state;
  const lobby = state.guest ? [] : call.lobby || [];

  // Keep a running recording in step with people joining/leaving and camera/screen changes.
  useEffect(() => { recorder.current?.rec.sync(state); }, [state]);

  // Leaving while recording: what was recorded is still saved.
  useEffect(() => () => {
    const active = recorder.current;
    recorder.current = null;
    if (active) {
      setRecording(false);
      void saveRecording(active);
    }
  }, []);

  // Everyone else left while recording: stop and save, after a moment in case someone is just rejoining.
  const nobodyElse = peers.length === 0;
  const hadCompany = useRef(false);
  useEffect(() => {
    if (!state.recording) {
      hadCompany.current = false;
      return undefined;
    }
    if (!nobodyElse) {
      hadCompany.current = true;
      return undefined;
    }
    if (!hadCompany.current) return undefined;
    const timer = setTimeout(() => {
      if (recorder.current) void stopRecording();
    }, ALONE_STOP_MS);
    return () => clearTimeout(timer);
  }, [nobodyElse, state.recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the record confirmation.
  useEffect(() => {
    if (!confirmRecord) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setConfirmRecord(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmRecord]);

  // "Recording saved" goes away by itself.
  useEffect(() => {
    if (recordStatus !== 'saved') return undefined;
    const timer = setTimeout(() => setRecordStatus(null), 7000);
    return () => clearTimeout(timer);
  }, [recordStatus]);

  // A soft knock when someone new is waiting to be let in.
  const lobbyKey = lobby.map((guest) => guest.id).join();
  const lobbySeen = useRef(new Set());
  useEffect(() => {
    const fresh = lobby.filter((guest) => !lobbySeen.current.has(guest.id));
    lobby.forEach((guest) => lobbySeen.current.add(guest.id));
    if (fresh.length) knock();
  }, [lobbyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function stopRecording(reason = '') {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    setRecordingStartedAt(null);
    setRecording(false);
    setRecordStatus('saving');
    const result = await saveRecording(active);
    setRecordStatus(result.saved ? 'saved' : null);
    const problem = result.error || (result.saved ? '' : 'Nothing was recorded.');
    setRecordError([reason, problem].filter(Boolean).join(' '));
  }

  function toggleRecording() {
    setRecordError('');
    setRecordStatus(null);
    if (recorder.current) return stopRecording();
    // Asked inside the call: the app-wide dialog would open behind the call room.
    setConfirmRecord((open) => !open);
    return undefined;
  }

  async function startRecording() {
    setConfirmRecord(false);
    try {
      const upload = createRecordingUpload({
        callId: call.id,
        peerId: me,
        onFail: (err) => setRecordError(`${err.message} Keep recording: it will download to this computer when you stop.`),
      });
      const rec = await createCallRecorder(state, { onError: (message) => stopRecording(message), onChunk: (chunk) => upload.add(chunk) });
      recorder.current = { rec, upload };
      setRecordingStartedAt(rec.startedAt.getTime());
      setRecording(true);
    } catch (err) {
      setRecordingStartedAt(null);
      setRecording(false);
      setRecordError(err.message);
    }
    return undefined;
  }

  const voices = useMemo(() => [
    ...(state.localAudio && !state.muted ? [{ id: me, stream: state.localAudio }] : []),
    ...peers.filter((peer) => !peer.muted).map((peer) => ({ id: peer.id, stream: peer.audio })),
  ], [state.localAudio, state.muted, me, peers]);
  const speaker = useSpeaker(voices);

  const ringing = call.invited.filter((invite) => invite.status === 'ringing');
  const presenter = peers.find((peer) => peer.sharing && peer.screenStream) || null;
  const title = call.title
    ? call.title
    : peers.length
      ? peers.map((peer) => peer.name).join(', ')
    : ringing.length ? `Calling ${ringing.map((invite) => invite.name).join(', ')}…` : 'Waiting for others…';

  const myName = call.peers.find((peer) => peer.id === me)?.name || 'You';
  const tiles = [
    { key: me, name: `${myName} (you)`, address: call.peers.find((peer) => peer.id === me)?.address, stream: state.localCamera, videoOn: state.cameraOn, muted: state.muted || !state.micAvailable, hand: state.hand, speaking: speaker === me, mirrored: true },
    ...peers.map((peer) => ({
      // Their picture only once connected; until then a black box looks like a broken camera.
      key: peer.id, name: peer.name, address: peer.address, stream: peer.cameraStream, videoOn: peer.camera && peer.connection === 'connected', muted: peer.muted, hand: peer.hand, speaking: speaker === peer.id,
      status: peer.connection === 'connected' ? null
        : peer.stuck ? 'Can’t connect'
          : peer.connection === 'new' ? 'Connecting…'
            : peer.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…',
    })),
    ...ringing.map((invite) => ({ key: invite.address, name: invite.name, address: invite.address, status: 'Ringing…' })),
  ];
  const leading = presenter ? null : tiles.find((tile) => tile.speaking && tile.key !== me) || tiles.find((tile) => tile.key !== me) || tiles[0];

  const voicesPlayed = peers.map((peer) => peer.audio && <Voice key={peer.id} stream={peer.audio} speaker={state.speakerDevice} />);
  const recordingPeers = call.peers.filter((peer) => peer.recording);
  const recordingActive = state.recording || recordingPeers.length > 0;
  const recordingDuration = useDuration(recordingStartedAt);
  const otherRecorders = recordingPeers.filter((peer) => peer.id !== me).map((peer) => peer.name);
  const recordingText = state.recording
    ? 'You are recording this call'
    : otherRecorders.length ? `${otherRecorders.join(', ')} ${otherRecorders.length === 1 ? 'is' : 'are'} recording this call` : 'This call is being recorded';
  const micLabel = !state.micAvailable ? 'Turn on microphone' : state.muted ? 'Unmute' : 'Mute';
  // Two people: the other person fills the screen and you sit in a corner, like a phone call.
  const solo = !presenter && peers.length === 1 && !ringing.length;
  // A meeting nobody has joined yet: show its link where it can't be missed.
  const alone = !state.guest && Boolean(call.code) && !peers.length && !ringing.length;

  if (minimized) {
    const shown = presenter
      ? { name: `${presenter.name} is sharing`, address: presenter.address, stream: presenter.screenStream, videoOn: true }
      : leading;
    return (
      <div className="call-mini" role="region" aria-label="Call in progress">
        {voicesPlayed}
        <button type="button" className="call-mini-picture" aria-label="Back to the call" onClick={() => setMinimized(false)}>
          <Tile {...shown} />
          <span className="call-mini-expand"><Icon name="expand" size={18} /></span>
        </button>
        <div className="call-mini-bar">
          <span className="call-mini-time">{duration || 'Calling…'}</span>
          {recordingActive && <span className="call-mini-recording" role="status" title={recordingText}><span /> REC{state.recording && recordingDuration ? ` ${recordingDuration}` : ''}</span>}
          {lobby.length > 0 && (
            <button type="button" className="call-mini-lobby" onClick={() => setMinimized(false)}>
              {lobby.length} waiting
            </button>
          )}
          <button type="button" className={`call-mini-btn ${state.muted || !state.micAvailable ? 'on' : ''}`} aria-label={micLabel} title={micLabel} onClick={toggleMute}>
            <Icon name={state.muted || !state.micAvailable ? 'micOff' : 'mic'} size={20} />
          </button>
          <button type="button" className="call-mini-btn danger" aria-label="Leave call" title="Leave call" onClick={hangUp}><Icon name="callEnd" size={20} /></button>
        </div>
      </div>
    );
  }

  const count = Math.min(tiles.length, 7);
  return (
    <div className={`call-room ${panel ? 'with-panel' : ''}`} role="dialog" aria-label="Call">
      {voicesPlayed}
      <header className="call-room-head">
        <div className="call-room-title">
          <strong>{title}</strong>
          <span>{duration || (call.video ? 'Video call' : 'Voice call')}</span>
        </div>
        {recordingActive && (
          <div className={`call-rec ${state.recording ? 'mine' : ''}`} role="status" aria-label={recordingText} title={recordingText}>
            <span className="call-rec-dot" aria-hidden="true" />
            <span className="call-rec-label">{state.recording ? 'REC' : otherRecorders.length ? `${otherRecorders[0]} is recording` : 'Recording'}</span>
            {state.recording && <time>{recordingDuration || '00:00'}</time>}
            {state.recording && <button type="button" onClick={toggleRecording}>Stop</button>}
          </div>
        )}
        {!state.guest && <button type="button" className="call-head-btn" aria-label="Keep working (make the call small)" title="Keep working (make the call small)" onClick={() => setMinimized(true)}><Icon name="minimize" /></button>}
      </header>

      {state.notice && (
        <div className="call-notice" role="alert">
          <span>{state.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={clearNotice}><Icon name="close" size={18} /></button>
        </div>
      )}

      {recordError && <div className="call-notice" role="alert"><span>{recordError}</span><button type="button" aria-label="Dismiss" onClick={() => setRecordError('')}><Icon name="close" size={18} /></button></div>}

      <div className="call-room-body">
        {recordStatus && (
          <div className="call-recording-saved" role="status">
            <Icon name={recordStatus === 'saved' ? 'checkCircle' : 'refresh'} size={18} />
            {recordStatus === 'saved'
              ? <span><strong>Recording saved</strong><small>Everyone from your team in this call can watch it in Meet.</small></span>
              : <span><strong>Saving the recording…</strong><small>Keep this window open for a moment.</small></span>}
            {recordStatus === 'saved' && <button type="button" aria-label="Dismiss" onClick={() => setRecordStatus(null)}><Icon name="close" size={16} /></button>}
          </div>
        )}
        {confirmRecord && !state.recording && (
          <div className="call-record-confirm" role="alertdialog" aria-labelledby="call-record-confirm-title">
            <strong id="call-record-confirm-title">Record this call?</strong>
            <p>Everyone in the call will see that recording is on. It’s saved in Nextspace for your team members in the call, and copied to your Google Drive if connected. Make sure everyone agrees.</p>
            <div className="call-record-confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirmRecord(false)}>Cancel</button>
              <button type="button" autoFocus onClick={startRecording}>Start recording</button>
            </div>
          </div>
        )}
        <Lobby lobby={panel === 'people' ? [] : lobby} />
        {alone && (
          <div className="call-share-card">
            <strong>Your meeting is ready</strong>
            <ShareLink state={state} intro="Share this link with anyone you want in the meeting. You'll be asked before guests come in." />
          </div>
        )}
        {solo ? (
          <div className="call-grid count-1 call-solo">
            {tiles.slice(1).map(({ key, ...tile }) => <Tile key={key} {...tile} />)}
            <div className="call-pip">{tiles.slice(0, 1).map(({ key, ...tile }) => <Tile key={key} {...tile} />)}</div>
          </div>
        ) : presenter ? (
          <div className="call-stage">
            <div className="call-screen">
              <Video stream={presenter.screenStream} />
              <span className="call-tile-name"><Icon name="screenShare" size={15} /><span>{presenter.name} is sharing</span></span>
            </div>
            <div className="call-strip">{tiles.map(({ key, ...tile }) => <Tile key={key} {...tile} />)}</div>
          </div>
        ) : (
          <div className={`call-grid count-${count}`}>{tiles.map(({ key, ...tile }) => <Tile key={key} {...tile} />)}</div>
        )}
        {state.sharing && (
          <div className="call-sharing-note">
            <Icon name="screenShare" size={18} /> You are sharing your screen
            <button type="button" onClick={toggleScreen}>Stop</button>
          </div>
        )}
        {panel && (
          <aside className="call-panel">
            <button type="button" className="call-panel-close" aria-label="Close" onClick={() => setPanel(null)}><Icon name="close" /></button>
            {panel === 'people' && <PeoplePanel state={state} />}
            {panel === 'devices' && <DevicesPanel state={state} />}
          </aside>
        )}
      </div>

      <footer className="call-controls">
        <div className="call-controls-info" aria-hidden="true">
          <strong>{clock}</strong>
          <span>{call.code || (call.video ? 'Video call' : 'Voice call')}</span>
        </div>
        <div className="call-controls-main">
          <ControlButton icon={state.muted || !state.micAvailable ? 'micOff' : 'mic'} label={micLabel} off={state.muted || !state.micAvailable} onClick={toggleMute} />
          <ControlButton icon={state.cameraOn ? 'videocam' : 'videocamOff'} label={state.cameraOn ? 'Turn camera off' : 'Turn camera on'} off={!state.cameraOn} onClick={toggleCamera} />
          {canShareScreen() && <ControlButton icon="screenShare" label={state.sharing ? 'Stop sharing' : 'Share screen'} on={state.sharing} onClick={toggleScreen} />}
          {recordingSupported() && !state.guest && <ControlButton icon="record" label={state.recording ? 'Stop recording' : 'Record'} recording={state.recording} onClick={toggleRecording} />}
          <ControlButton icon="hand" label={state.hand ? 'Lower hand' : 'Raise hand'} on={state.hand} onClick={toggleHand} />
          <ControlButton icon="callEnd" label="Leave call" danger onClick={hangUp} />
        </div>
        <div className="call-controls-side">
          <ControlButton side icon="personAdd" label={state.guest ? 'People' : 'People and meeting link'} on={panel === 'people'} badge={peers.filter((peer) => peer.hand).length + lobby.length} onClick={() => setPanel(panel === 'people' ? null : 'people')} />
          <ControlButton side icon="settings" label="Microphone, speaker and camera" on={panel === 'devices'} onClick={() => setPanel(panel === 'devices' ? null : 'devices')} />
        </div>
      </footer>
    </div>
  );
}
