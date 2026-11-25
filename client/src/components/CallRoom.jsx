// The call on screen: everyone's pictures, chat, reactions, the controls, and a small version to
// keep working in. Layout adapts to the window: a gallery that fills the space for any number of
// people, a spotlight with a filmstrip, a presenter view, and a phone-style 1:1.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  admitGuest, canShareScreen, chooseDevice, clearNotice, hangUp, inviteToCall, meetingCode, meetingLink, react, REACTIONS,
  resendChat, retryMicrophone, sendChat, setChatOpen, setRecording, sharePicture, toggleCamera, toggleHand, toggleMute, toggleScreen,
} from '../calls.js';
import { createCallRecorder, downloadRecording, recordingSupported } from '../callRecording.js';
import { createRecordingUpload } from '../recordingUpload.js';
import { hrefFor, LINK } from '../linkify.js';
import { onlineNow } from '../live.js';
import Avatar from './Avatar.jsx';
import { colorFor } from '../format.js';
import Icon from './Icon.jsx';

/**
 * A person's name for the call screen. Someone without a display name arrives as their email
 * address: show "Admin" for admin@example.com, "Priya Nair" for priya.nair@…, never the address.
 */
export function personName(name = '') {
  const text = String(name || '').trim();
  if (!text.includes('@')) return text;
  const local = text.split('@')[0].replace(/[._+-]+/g, ' ').trim();
  return local ? local.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : text;
}

const AudioContextClass = () => window.AudioContext || window.webkitAudioContext;
const RESUME_CALL_AUDIO = 'nextspace:resume-call-audio';
const ALONE_STOP_MS = 15_000; // recording with nobody left: stop and save after this
const SPEAKER_HOLD_MS = 900; // keep the highlight on someone through short pauses between words
const REACTION_FLOAT_MS = 4200;
const LAYOUT_KEY = 'nextspace:call-layout';
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/* ---------------------------------- media ---------------------------------- */

/** Filling the box would crop too much (a phone's tall picture in a wide tile): show it whole. */
const shapesDiffer = (videoRatio, boxRatio) => Math.max(videoRatio / boxRatio, boxRatio / videoRatio) > 1.4;

function Video({ stream, className, contain = false, onShape }) {
  const element = useRef(null);
  const [fit, setFit] = useState(false);
  const shapeReport = useRef(onShape);
  shapeReport.current = onShape;
  useEffect(() => {
    const video = element.current;
    if (!video) return undefined;
    if (video.srcObject !== stream) video.srcObject = stream;
    // A video element is replaced when the room becomes mini (or expands again). Explicit play
    // makes that hand-off reliable in browsers that do not always honour autoplay on a remount.
    const play = () => video.play().catch(() => {});
    play();
    video.addEventListener('loadedmetadata', play);
    return () => video.removeEventListener('loadedmetadata', play);
  }, [stream]);
  // Phones turn sideways and windows resize: check again whenever either shape changes.
  useEffect(() => {
    const video = element.current;
    if (!video || contain) return undefined;
    const check = () => {
      if (!video.videoWidth || !video.videoHeight || !video.clientWidth || !video.clientHeight) return;
      shapeReport.current?.(video.videoWidth / video.videoHeight);
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
  }, [contain]);
  return <video ref={element} className={[className, (fit || contain) && 'fit'].filter(Boolean).join(' ')} autoPlay playsInline muted />;
}

/** Plays one person's voice. Kept apart from the pictures so it carries on when they aren't shown. */
function Voice({ stream, speaker, onBlocked, onOutputError, onSpeakerFallback }) {
  const element = useRef(null);
  const reports = useRef({ onBlocked, onOutputError, onSpeakerFallback });
  reports.current = { onBlocked, onOutputError, onSpeakerFallback };
  useEffect(() => {
    const audio = element.current;
    if (!audio) return undefined;
    let alive = true;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    const play = async () => {
      if (!alive) return;
      if (audio.setSinkId) {
        const output = speaker || 'default';
        try {
          await audio.setSinkId(output);
        } catch {
          // A saved USB/Bluetooth output may have disappeared. Keep the call audible on default.
          if (output !== 'default') {
            await audio.setSinkId('default').catch(() => {});
            reports.current.onSpeakerFallback?.();
          }
        }
      }
      try {
        await audio.play();
      } catch (err) {
        if (!alive) return;
        if (err?.name === 'NotAllowedError') reports.current.onBlocked?.();
        else reports.current.onOutputError?.('Call audio could not start. Check your speaker and browser sound settings.');
      }
    };
    const resume = () => { void play(); };
    const track = stream?.getAudioTracks?.()[0];
    track?.addEventListener('unmute', resume);
    window.addEventListener(RESUME_CALL_AUDIO, resume);
    void play();
    return () => {
      alive = false;
      track?.removeEventListener('unmute', resume);
      window.removeEventListener(RESUME_CALL_AUDIO, resume);
      if (audio.srcObject === stream) audio.srcObject = null;
    };
  }, [stream, speaker]);
  return <audio ref={element} autoPlay />;
}

/** Who is talking right now: the loudest voice above a low level, held briefly through pauses. */
function useSpeaker(voices) {
  const [speaker, setSpeaker] = useState(null);
  const key = voices.map(({ id, stream }) => `${id}:${stream?.id}`).join();
  useEffect(() => {
    const Context = AudioContextClass();
    const live = voices.filter((voice) => voice.stream?.getAudioTracks?.().length);
    if (!Context || !live.length) {
      setSpeaker(null);
      return undefined;
    }
    const context = new Context();
    // Created outside a click, it can start suspended: without this nobody is ever highlighted.
    context.resume().catch(() => {});
    const meters = live.map(({ id, stream }) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      return { id, analyser, samples: new Uint8Array(analyser.frequencyBinCount) };
    });
    let current = null;
    let heardAt = 0;
    const timer = setInterval(() => {
      if (context.state === 'suspended') context.resume().catch(() => {});
      let loudest = null;
      let level = 14;
      for (const meter of meters) {
        meter.analyser.getByteFrequencyData(meter.samples);
        const average = meter.samples.reduce((sum, value) => sum + value, 0) / meter.samples.length;
        if (average > level) {
          level = average;
          loudest = meter.id;
        }
      }
      const now = Date.now();
      if (loudest) {
        current = loudest;
        heardAt = now;
      } else if (now - heardAt > SPEAKER_HOLD_MS) current = null;
      setSpeaker(current);
    }, 250);
    return () => {
      clearInterval(timer);
      context.close().catch(() => {});
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return speaker;
}

/**
 * How loud the microphone is, 0–1. Measured on a copy of the microphone that stays on, so the
 * meter works while muted too (muting only silences what the others receive).
 */
export function useMicLevel(stream, every = 80) {
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
    }, every);
    return () => {
      clearInterval(timer);
      track.stop();
      context.close().catch(() => {});
    };
  }, [stream, every]);
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

/* ---------------------------------- small pieces ---------------------------------- */

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0'));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${parts.join(':')}` : parts.join(':');
}

/** A running timer. Its own component, so the rest of the call doesn't redraw every second. */
function Elapsed({ since, fallback = '' }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? formatElapsed(Date.now() - since) : fallback;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Closes a menu when clicking or tapping anywhere outside it. */
function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!ref.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The largest tile size that fits `count` tiles in the box, between 3:4 (phones) and 16:9. */
function bestFit(count, width, height, gap) {
  if (!count || !width || !height) return null;
  let best = null;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    let w = (width - gap * (cols - 1)) / cols;
    let h = (height - gap * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    if (w / h > 16 / 9) w = h * (16 / 9);
    if (w / h < 3 / 4) h = w * (4 / 3);
    const area = w * h;
    if (!best || area > best.area + 1) best = { cols, w: Math.floor(w), h: Math.floor(h), area };
  }
  return best;
}

function useBoxSize() {
  const ref = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element || !window.ResizeObserver) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox((current) => (Math.abs(current.w - width) < 1 && Math.abs(current.h - height) < 1 ? current : { w: width, h: height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}

/* ---------------------------------- tiles ---------------------------------- */

const Tile = memo(function Tile({ tile, size, compact, onPin, pinned, hug }) {
  // The main picture takes the video's own shape: a phone held upright gets a tall box, not a
  // wide one with black bars either side.
  const [ratio, setRatio] = useState(null);
  const { name, address, stream, videoOn, muted, hand, speaking, status, mirrored, isMe, reaction, ringing } = tile;
  const classes = ['nx-tile', speaking && 'speaking', compact && 'compact', ringing && 'ringing', videoOn && stream && 'has-video'].filter(Boolean).join(' ');
  return (
    <div
      className={classes}
      // Each person's own colour lights their tile while the camera is off.
      style={{
        '--tile': colorFor(address || name),
        ...(size && { width: size.w, height: size.h }),
        ...(hug && ratio && videoOn && stream && { aspectRatio: String(ratio), width: 'auto', height: '100%', maxWidth: '100%' }),
      }}
      onDoubleClick={onPin}
    >
      {videoOn && stream
        ? <Video stream={stream} className={mirrored ? 'mirrored' : ''} onShape={hug ? (r) => setRatio((old) => (old && Math.abs(old - r) < 0.01 ? old : r)) : undefined} />
        : (
          <span className="nx-tile-face">
            <span className="nx-tile-ring" aria-hidden="true" />
            <Avatar person={{ name, address }} size="lg" />
          </span>
        )}
      {status && <span className="nx-tile-status">{ringing && <i />}{status}</span>}
      {hand && <span className="nx-tile-hand" title="Hand raised"><Icon name="hand" size={16} /></span>}
      {reaction && <span key={reaction.key} className="nx-tile-reaction" aria-hidden="true">{reaction.emoji}</span>}
      <span className="nx-tile-name">
        {muted
          ? <span className="nx-tile-mic off" title="Muted"><Icon name="micOff" size={14} /></span>
          : <span className={`nx-tile-bars ${speaking ? 'on' : ''}`} aria-hidden="true"><i /><i /><i /></span>}
        <span className="nx-tile-label">{name}{isMe ? ' (you)' : ''}</span>
      </span>
      {onPin && !ringing && (
        <button type="button" className={`nx-tile-pin ${pinned ? 'on' : ''}`} onClick={onPin} aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} title={pinned ? 'Unpin' : 'Pin to the main view'}>
          <Icon name="pin" size={16} />
        </button>
      )}
    </div>
  );
});

function Gallery({ tiles, pinned, onPin }) {
  const [ref, box] = useBoxSize();
  const gap = box.w < 600 ? 8 : 12;
  const fit = useMemo(() => bestFit(tiles.length, box.w, box.h, gap), [tiles.length, box.w, box.h, gap]);
  return (
    <div className={`nx-gallery count-${Math.min(tiles.length, 9)}`} ref={ref}>
      <div className="nx-gallery-inner" style={{ gap }}>
        {fit && tiles.map((tile) => <Tile key={tile.key} tile={tile} size={fit} pinned={pinned === tile.key} onPin={tile.ringing ? null : () => onPin(tile.key)} />)}
      </div>
    </div>
  );
}

function Filmstrip({ tiles, pinned, onPin }) {
  if (!tiles.length) return null;
  return (
    <div className="nx-strip">
      {tiles.map((tile) => <Tile key={tile.key} tile={tile} compact pinned={pinned === tile.key} onPin={tile.ringing ? null : () => onPin(tile.key)} />)}
    </div>
  );
}

/** Emoji floating up from the bottom of the stage, with who sent them. */
function ReactionLayer({ items }) {
  return (
    <div className="nx-reactions" aria-live="polite">
      {items.map((item) => (
        <span key={item.key} className="nx-float" style={{ left: `${item.lane}%`, '--drift': `${item.drift}px` }}>
          <b>{item.emoji}</b>
          <small>{item.name}</small>
        </span>
      ))}
    </div>
  );
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
  async function share() {
    try {
      await navigator.share({ title: state.call.title || 'Join my meeting', url: link });
    } catch { /* closed the share sheet */ }
  }
  return (
    <div className="nx-share">
      {intro && <p className="nx-note">{intro}</p>}
      {code ? (
        <>
          <div className="nx-share-link">
            <Icon name="link" size={18} />
            <input readOnly value={link} aria-label="Meeting link" onFocus={(event) => event.target.select()} />
          </div>
          <div className="nx-share-actions">
            <button type="button" className="nx-btn primary" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={17} />{copied ? 'Copied' : 'Copy link'}</button>
            {navigator.share && <button type="button" className="nx-btn" onClick={share}><Icon name="forward" size={17} />Share</button>}
          </div>
        </>
      ) : (
        <button type="button" className="nx-btn" disabled={busy} onClick={make}><Icon name="link" size={17} />{busy ? 'Making a link…' : 'Get a meeting link'}</button>
      )}
      {error && <p className="nx-error">{error}</p>}
    </div>
  );
}

/** One person in the call: picture, name, and what they're doing (hand up, muted). */
function InCall({ peer, me, pinned, onPin }) {
  return (
    <li>
      <Avatar person={peer} size="sm" />
      <span className="nx-person">
        <strong>{personName(peer.name)}{peer.id === me ? ' (you)' : ''}</strong>
        <small>{peer.guest ? 'Guest' : peer.recording ? 'Recording' : peer.sharing ? 'Presenting' : 'In the call'}</small>
      </span>
      {peer.hand && <span className="nx-person-hand" title="Hand raised"><Icon name="hand" size={15} /></span>}
      {onPin && (
        <button type="button" className={`nx-icon-btn ${pinned ? 'on' : ''}`} onClick={onPin} aria-label={pinned ? `Unpin ${peer.name}` : `Pin ${peer.name}`} title={pinned ? 'Unpin' : 'Pin'}>
          <Icon name="pin" size={16} />
        </button>
      )}
      <span className={`nx-person-mic ${peer.muted ? 'off' : ''}`} title={peer.muted ? 'Muted' : 'Microphone on'}><Icon name={peer.muted ? 'micOff' : 'mic'} size={16} /></span>
    </li>
  );
}

function LobbyList({ lobby, compact = false }) {
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
  const admitAll = async () => {
    for (const guest of lobby) await answer(guest, true); // eslint-disable-line no-await-in-loop
  };
  return (
    <div className={compact ? 'nx-lobby' : ''} role="region" aria-label="Waiting to join" aria-live="polite">
      {compact && lobby.length > 1 && (
        <div className="nx-lobby-card nx-lobby-all">
          <span><strong>{lobby.length} people</strong> are waiting to join</span>
          <button type="button" className="nx-btn primary small" disabled={Boolean(busy)} onClick={admitAll}>Admit all</button>
        </div>
      )}
      {lobby.map((guest) => (
        <div className={compact ? 'nx-lobby-card' : 'nx-row'} key={guest.id}>
          <Avatar person={{ name: guest.name, address: `guest:${guest.id}` }} size="sm" />
          <span className="nx-person"><strong>{guest.name}</strong><small>{compact ? 'wants to join this call' : 'Guest'}</small></span>
          <button type="button" className="nx-btn small" disabled={busy === guest.id} onClick={() => answer(guest, false)}>Deny</button>
          <button type="button" className="nx-btn primary small" disabled={busy === guest.id} onClick={() => answer(guest, true)}>Admit</button>
        </div>
      ))}
      {error && <p className="nx-error">{error}</p>}
    </div>
  );
}

function PeoplePanel({ state, pinned, onPin }) {
  const [team, setTeam] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const lobby = state.guest ? [] : state.call.lobby || [];
  useEffect(() => {
    if (!state.guest) api('/mail/team').then(setTeam).catch((err) => setError(err.message));
  }, [state.guest]);
  const inCall = new Set(state.call.peers.map((peer) => peer.address));
  const ringing = new Set(state.call.invited.filter((invite) => invite.status === 'ringing').map((invite) => invite.address));
  const online = onlineNow();
  const query = search.trim().toLowerCase();
  const others = (team || [])
    .filter((person) => !inCall.has(person.address))
    .filter((person) => !query || `${person.name} ${person.address}`.toLowerCase().includes(query))
    .sort((a, b) => Number(Boolean(online?.has(b.address))) - Number(Boolean(online?.has(a.address))));
  const invite = (address) => inviteToCall([address]).catch((err) => setError(err.message));
  const peers = [...state.call.peers].sort((a, b) => Number(b.hand) - Number(a.hand));
  return (
    <>
      {lobby.length > 0 && (
        <section className="nx-section">
          <h3>Waiting to join <span>{lobby.length}</span></h3>
          <LobbyList lobby={lobby} />
        </section>
      )}
      <section className="nx-section">
        <h3>In the call <span>{state.call.peers.length}</span></h3>
        <ul className="nx-list">
          {peers.map((peer) => <InCall key={peer.id} peer={peer} me={state.me} pinned={pinned === peer.id} onPin={() => onPin(peer.id)} />)}
        </ul>
      </section>
      {!state.guest && (
        <section className="nx-section">
          <h3>Add people</h3>
          <ShareLink state={state} intro="Teammates come straight in. You’ll be asked before guests join." />
          {(team?.length || 0) > 5 && (
            <label className="nx-search">
              <Icon name="search" size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your team" aria-label="Search your team" />
            </label>
          )}
          {error && <p className="nx-error">{error}</p>}
          {!team && !error && <p className="nx-note">Getting your team…</p>}
          {team && !others.length && <p className="nx-note">{query ? 'Nobody on your team matches.' : 'Everyone on your team is here.'}</p>}
          <ul className="nx-list">
            {others.map((person) => (
              <li key={person.address}>
                <span className="presence-wrap">
                  <Avatar person={person} size="sm" />
                  {online?.has(person.address) && <span className="presence-dot" title="Online" />}
                </span>
                <span className="nx-person">
                  <strong>{person.name || person.address}</strong>
                  <small>{online?.has(person.address) ? 'Online now' : person.address}</small>
                </span>
                <button type="button" className="nx-btn small" disabled={ringing.has(person.address)} onClick={() => invite(person.address)}>
                  <Icon name="call" size={15} />{ringing.has(person.address) ? 'Ringing…' : 'Ring'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Text with its links made clickable. */
function Linked({ text }) {
  const parts = text.split(new RegExp(LINK.source, 'gi'));
  return parts.map((part, i) => (i % 2
    ? <a key={i} href={hrefFor(part)} target="_blank" rel="noopener noreferrer">{part}</a>
    : <span key={i}>{part}</span>));
}

function ChatPanel({ state }) {
  const [text, setText] = useState('');
  const list = useRef(null);
  const input = useRef(null);
  const stick = useRef(true);
  const { chat, me } = state;
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const element = list.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [chat.length]);
  const onScroll = () => {
    const element = list.current;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  };
  const send = (event) => {
    event?.preventDefault();
    if (!text.trim()) return;
    stick.current = true;
    void sendChat(text);
    setText('');
  };
  const onKey = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
  };
  // Resize the box to its text, up to a few lines.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  }, [text]);
  let previous = null;
  return (
    <div className="nx-chat">
      <div className="nx-chat-list" ref={list} onScroll={onScroll} aria-live="polite">
        {!chat.length && (
          <div className="nx-chat-empty">
            <span><Icon name="chat" size={26} /></span>
            <strong>Say hello</strong>
            <p>Messages are seen by everyone in the call, including people who join later, and disappear when the call ends.</p>
          </div>
        )}
        {chat.map((message) => {
          const mine = message.from === me;
          const grouped = previous && previous.from === message.from && message.at - previous.at < 3 * 60_000;
          previous = message;
          return (
            <div key={message.id} className={`nx-msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${message.failed ? 'failed' : ''}`}>
              {!grouped && (
                <div className="nx-msg-head">
                  <strong>{mine ? 'You' : personName(message.name)}</strong>
                  {message.guest && <small>Guest</small>}
                  <time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
              )}
              <p className="nx-bubble"><Linked text={message.text} /></p>
              {message.pending && <small className="nx-msg-state">Sending…</small>}
              {message.failed && (
                <small className="nx-msg-state">
                  {message.failed} · <button type="button" onClick={() => resendChat(message.id)}>Try again</button>
                </small>
              )}
            </div>
          );
        })}
      </div>
      <form className="nx-chat-form" onSubmit={send}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={1000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          placeholder="Message everyone"
          aria-label="Message everyone in the call"
        />
        <button type="submit" className="nx-send" disabled={!text.trim()} aria-label="Send message" title="Send (Enter)"><Icon name="send" size={19} /></button>
      </form>
    </div>
  );
}

const SHORTCUTS = [
  [`${MOD} + D`, 'Mute or unmute'],
  [`${MOD} + E`, 'Camera on or off'],
  ['Hold Space', 'Talk while muted'],
  [`${MOD} + Alt + H`, 'Raise or lower hand'],
  [`${MOD} + Alt + C`, 'Open or close chat'],
  [`${MOD} + Alt + P`, 'Open or close people'],
  ['F', 'Full screen'],
  ['Esc', 'Close a panel or menu'],
];

function InfoPanel({ state }) {
  const { call } = state;
  return (
    <>
      <section className="nx-section">
        <h3>Meeting</h3>
        <dl className="nx-facts">
          <div><dt>Name</dt><dd>{call.title || (call.code ? 'Instant meeting' : call.video ? 'Video call' : 'Voice call')}</dd></div>
          <div><dt>Started</dt><dd><Elapsed since={state.startedAt} fallback="Waiting for others" />{state.startedAt ? ' ago' : ''}</dd></div>
          {call.code && <div><dt>Code</dt><dd className="mono">{call.code}</dd></div>}
          <div><dt>People</dt><dd>{call.peers.length}</dd></div>
        </dl>
        {call.code && <p className="nx-note nx-secure"><Icon name="lock" size={15} /> Guests can’t enter until someone here lets them in.</p>}
      </section>
      {!state.guest && (
        <section className="nx-section">
          <h3>Joining info</h3>
          <ShareLink state={state} />
        </section>
      )}
      <section className="nx-section nx-only-desktop">
        <h3>Keyboard shortcuts</h3>
        <ul className="nx-keys">
          {SHORTCUTS.map(([keys, what]) => <li key={keys}><kbd>{keys}</kbd><span>{what}</span></li>)}
        </ul>
      </section>
    </>
  );
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
  const picker = (kind, label, value, icon) => {
    const options = devices.filter((device) => device.kind === kind && device.deviceId);
    const known = options.some((device) => device.deviceId === value);
    return (
      <label className="nx-device">
        <span><Icon name={icon} size={16} />{label}</span>
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
  return (
    <>
      <section className="nx-section">
        <h3>Audio</h3>
        {picker('audioinput', 'Microphone', state.micDevice, 'mic')}
        {state.micAvailable ? (
          <>
            <div className="nx-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              {Array.from({ length: 16 }, (_, i) => <span key={i} className={level * 16 > i ? 'lit' : ''} />)}
            </div>
            <p className="nx-note">{state.muted ? 'You’re muted, so others can’t hear you. The bar still shows your microphone working.' : 'Say something: the bar should move.'}</p>
          </>
        ) : (
          <p className="nx-note">No microphone is on. <button type="button" className="nx-link" onClick={retryMicrophone}>Try again</button></p>
        )}
        {speakerChoice
          ? picker('audiooutput', 'Speaker', state.speakerDevice, 'volume')
          : <p className="nx-note">This browser plays calls through your computer’s current speaker. Change it in your sound settings.</p>}
        <button type="button" className="nx-btn" disabled={testing} onClick={testSpeaker}>
          <Icon name="volume" size={17} /> {testing ? 'Playing…' : 'Play test sound'}
        </button>
        {testError && <p className="nx-error">{testError}</p>}
      </section>
      <section className="nx-section">
        <h3>Video</h3>
        {picker('videoinput', 'Camera', state.cameraDevice, 'videocam')}
      </section>
    </>
  );
}

const PANELS = { people: 'People', chat: 'In-call messages', info: 'Meeting details', devices: 'Settings' };

/* ---------------------------------- hints ---------------------------------- */

/** "You're muted": shown when someone talks for a moment with the microphone off. */
function MutedTalkHint({ stream, muted, onUnmute }) {
  const level = useMicLevel(muted ? stream : null, 120);
  const [show, setShow] = useState(false);
  const loudSince = useRef(0);
  useEffect(() => {
    if (!muted) {
      loudSince.current = 0;
      setShow(false);
      return;
    }
    if (level > 0.32) {
      loudSince.current ||= Date.now();
      if (Date.now() - loudSince.current > 1100) setShow(true);
    } else if (level < 0.12) loudSince.current = 0;
  }, [level, muted]);
  useEffect(() => {
    if (!show) return undefined;
    const timer = setTimeout(() => setShow(false), 5000);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show) return null;
  return (
    <div className="nx-toast nx-toast-muted" role="status">
      <Icon name="micOff" size={18} />
      <span><strong>You’re muted</strong><small>Hold Space to talk, or press {MOD} + D</small></span>
      <button type="button" className="nx-btn small primary" onClick={() => { setShow(false); onUnmute(); }}>Unmute</button>
    </div>
  );
}

/* ---------------------------------- the dock ---------------------------------- */

/** A dock button: icon, a short name under it (on wide screens), and the full name as its tooltip. */
function DockButton({ icon, label, text, onClick, state: look, badge, wide, className = '', disabled, ...rest }) {
  return (
    <button
      type="button"
      className={['nx-ctl', look, wide && 'wide', text && 'labelled', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      {...rest}
    >
      <span className="nx-ctl-icon"><Icon name={icon} size={22} /></span>
      {text && <span className="nx-ctl-label" aria-hidden="true">{text}</span>}
      {wide && <span className="nx-ctl-text">{wide}</span>}
      {badge > 0 && <span className="nx-badge">{badge > 9 ? '9+' : badge}</span>}
    </button>
  );
}

function MenuItem({ icon, label, hint, onClick, checked, className = '', badge }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} className={`nx-menu-item ${checked ? 'checked' : ''} ${className}`} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
      {badge > 0 && <span className="nx-badge inline">{badge}</span>}
      {hint && <kbd>{hint}</kbd>}
      {checked && <Icon name="check" size={18} className="nx-menu-check" />}
    </button>
  );
}

/* ---------------------------------- the room ---------------------------------- */

const readLayout = () => {
  try {
    return ['auto', 'grid', 'spotlight'].includes(localStorage.getItem(LAYOUT_KEY)) ? localStorage.getItem(LAYOUT_KEY) : 'auto';
  } catch {
    return 'auto';
  }
};

export default function CallRoom({ state }) {
  const [minimized, setMinimized] = useState(false);
  const [panel, setPanel] = useState(null); // 'people' | 'chat' | 'info' | 'devices'
  const [menu, setMenu] = useState(null); // 'react' | 'more'
  const [chromeHidden, setChromeHidden] = useState(false); // phones: tap the picture to hide the controls
  const picturePicker = useRef(null);
  const [layout, setLayoutState] = useState(readLayout);
  const [pinned, setPinned] = useState(null);
  const [hideSelf, setHideSelf] = useState(false);
  const [swapped, setSwapped] = useState(false); // 1:1: you big, them small
  const [fullscreen, setFullscreen] = useState(false);
  const [talking, setTalking] = useState(false); // holding Space to talk
  const [recordError, setRecordError] = useState('');
  const [confirmRecord, setConfirmRecord] = useState(false);
  const [recordStatus, setRecordStatus] = useState(null); // null | 'saving' | 'saved'
  const [mobileShareHelp, setMobileShareHelp] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [floating, setFloating] = useState([]);
  const [chatToast, setChatToast] = useState(null);
  const recorder = useRef(null); // { rec, upload } while recording
  const room = useRef(null);
  const menus = useRef(null);
  const latest = useRef(state);
  latest.current = state;
  const { call, me, peers } = state;
  const lobby = state.guest ? [] : call.lobby || [];

  const setLayout = (value) => {
    setLayoutState(value);
    setPinned(null);
    try { localStorage.setItem(LAYOUT_KEY, value); } catch { /* private window */ }
  };
  const togglePanel = useCallback((name) => setPanel((open) => (open === name ? null : name)), []);
  const togglePin = useCallback((key) => setPinned((current) => (current === key ? null : key)), []);
  useOutside(menus, Boolean(menu), () => setMenu(null));

  // Chat counts as read while it's open.
  useEffect(() => {
    setChatOpen(panel === 'chat' && !minimized);
    return () => setChatOpen(false);
  }, [panel, minimized]);

  // A new message while chat is closed: a short preview.
  const lastChat = state.chat[state.chat.length - 1];
  useEffect(() => {
    if (!lastChat || lastChat.from === me || panel === 'chat' || Date.now() - lastChat.at > 10_000) return undefined;
    setChatToast(lastChat);
    const timer = setTimeout(() => setChatToast(null), 5000);
    return () => clearTimeout(timer);
  }, [lastChat?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reactions: each one floats once.
  const seenReactions = useRef(new Set());
  useEffect(() => {
    const fresh = [];
    for (const peer of call.peers) {
      const reaction = peer.reaction;
      if (!reaction) continue;
      const key = `${peer.id}:${reaction.at}`;
      if (seenReactions.current.has(key)) continue;
      seenReactions.current.add(key);
      if (Date.now() - reaction.at > 5000) continue; // already old when this window saw it
      fresh.push({ key, peer: peer.id, emoji: reaction.emoji, name: peer.id === me ? 'You' : peer.name, lane: 4 + Math.random() * 22, drift: Math.round(Math.random() * 60 - 30) });
    }
    if (!fresh.length) return;
    setFloating((current) => [...current, ...fresh].slice(-24));
    setTimeout(() => setFloating((current) => current.filter((item) => !fresh.includes(item))), REACTION_FLOAT_MS);
  }, [call.peers, me]);
  const reactionByPeer = useMemo(() => {
    const map = new Map();
    for (const item of floating) map.set(item.peer, item);
    return map;
  }, [floating]);

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

  // Full screen follows the browser (Esc leaves it there too).
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else room.current?.requestFullscreen?.().catch(() => {});
  }, []);

  // Keyboard shortcuts, and holding Space to talk while muted.
  const holding = useRef(false);
  useEffect(() => {
    if (minimized) return undefined;
    const typing = (target) => target?.closest?.('input, textarea, select, [contenteditable="true"]');
    const onDown = (event) => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        if (menu) setMenu(null);
        else if (confirmRecord) setConfirmRecord(false);
        else if (panel && !document.fullscreenElement) setPanel(null);
        return;
      }
      if (mod && !event.altKey && key === 'd') { event.preventDefault(); toggleMute(); return; }
      if (mod && !event.altKey && key === 'e') { event.preventDefault(); toggleCamera(); return; }
      if (mod && event.altKey && event.code === 'KeyH') { event.preventDefault(); toggleHand(); return; }
      if (mod && event.altKey && event.code === 'KeyC') { event.preventDefault(); togglePanel('chat'); return; }
      if (mod && event.altKey && event.code === 'KeyP') { event.preventDefault(); togglePanel('people'); return; }
      if (typing(event.target)) return;
      if (key === 'f' && !mod && !event.altKey && canFullscreen) { toggleFullscreen(); return; }
      if (event.code === 'Space' && !event.repeat && !event.target?.closest?.('button, a')) {
        const now = latest.current;
        if (now.muted && now.micAvailable) {
          event.preventDefault();
          holding.current = true;
          setTalking(true);
          toggleMute();
        }
      }
    };
    const onUp = (event) => {
      if (event.code !== 'Space' || !holding.current) return;
      holding.current = false;
      setTalking(false);
      if (!latest.current.muted) toggleMute();
    };
    const onBlur = () => onUp({ code: 'Space' });
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [minimized, menu, panel, confirmRecord, canFullscreen, togglePanel, toggleFullscreen]);

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
    setMenu(null);
    setRecordError('');
    setRecordStatus(null);
    if (recorder.current) return stopRecording();
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
      try {
        await upload.start(rec.type);
      } catch (err) {
        await rec.stop();
        throw err;
      }
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
    ...peers.filter((peer) => !peer.muted && peer.audio).map((peer) => ({ id: peer.id, stream: peer.audio })),
  ], [state.localAudio, state.muted, me, peers]);
  const speaker = useSpeaker(voices);
  const lastSpoke = useRef(null);
  if (speaker && speaker !== me) lastSpoke.current = speaker;

  const ringing = call.invited.filter((invite) => invite.status === 'ringing');
  const myPeer = call.peers.find((peer) => peer.id === me);
  const remotePresenter = peers.find((peer) => peer.sharing && peer.screenStream) || null;
  // Local screen share is a separate WebRTC channel. Treat it exactly like a remote presenter so
  // the sharer gets a preview in the main stage and in the persistent mini meeting window.
  const presenter = state.sharing && state.localScreen
    ? { id: me, name: 'You', address: myPeer?.address, sharing: true, screenStream: state.localScreen, isMe: true }
    : remotePresenter;
  const title = call.title
    ? call.title
    : peers.length
      ? peers.map((peer) => personName(peer.name)).join(', ')
      : ringing.length ? `Calling ${ringing.map((invite) => invite.name).join(', ')}…` : call.code ? 'Your meeting' : 'Waiting for others…';

  const tiles = [
    {
      key: me, isMe: true, name: personName(myPeer?.name) || 'You', address: myPeer?.address, stream: state.localCamera, videoOn: state.cameraOn,
      muted: state.muted || !state.micAvailable, hand: state.hand, speaking: speaker === me, mirrored: true, reaction: reactionByPeer.get(me),
    },
    ...peers.map((peer) => ({
      // Their picture only once connected; until then a black box looks like a broken camera.
      key: peer.id, name: personName(peer.name), address: peer.address, stream: peer.cameraStream, videoOn: peer.camera && peer.connection === 'connected',
      muted: peer.muted, hand: peer.hand, speaking: speaker === peer.id, reaction: reactionByPeer.get(peer.id),
      status: peer.connection === 'connected' ? null
        : peer.stuck ? 'Can’t connect'
          : peer.connection === 'new' || peer.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…',
    })),
    ...ringing.map((invite) => ({ key: invite.address, name: invite.name, address: invite.address, status: 'Ringing…', ringing: true })),
  ];
  const selfTile = tiles[0];
  const pinnedTile = tiles.find((tile) => tile.key === pinned && !tile.ringing) || null;
  const others = tiles.filter((tile) => !tile.isMe);
  const leading = others.find((tile) => tile.speaking) || others.find((tile) => tile.key === lastSpoke.current) || others[0] || selfTile;
  const solo = peers.length === 1 && !ringing.length;
  const view = presenter ? 'present'
    : pinnedTile ? 'spotlight'
      : layout === 'spotlight' && tiles.length > 1 ? 'spotlight'
        : layout !== 'grid' && solo ? 'solo'
          : 'grid';
  const focus = pinnedTile || leading;
  const shownTiles = hideSelf && tiles.length > 1 ? tiles.slice(1) : tiles;
  const alone = !state.guest && Boolean(call.code) && !peers.length && !ringing.length;

  const speakerFallback = () => {
    setAudioError('The selected speaker is no longer available. The call is using the default speaker.');
    void chooseDevice('audiooutput', 'default');
  };
  const voicesPlayed = peers.map((peer) => peer.audio && (
    <Voice key={peer.id} stream={peer.audio} speaker={state.speakerDevice} onBlocked={() => setAudioBlocked(true)} onOutputError={setAudioError} onSpeakerFallback={speakerFallback} />
  ));
  const resumeAudio = () => {
    setAudioBlocked(false);
    setAudioError('');
    window.dispatchEvent(new Event(RESUME_CALL_AUDIO));
  };
  const recordingPeers = call.peers.filter((peer) => peer.recording);
  const recordingActive = state.recording || recordingPeers.length > 0;
  const otherRecorders = recordingPeers.filter((peer) => peer.id !== me).map((peer) => peer.name);
  const recordingText = state.recording
    ? 'You are recording this call'
    : otherRecorders.length ? `${otherRecorders.join(', ')} ${otherRecorders.length === 1 ? 'is' : 'are'} recording this call` : 'This call is being recorded';
  const micOff = state.muted || !state.micAvailable;
  const micLabel = !state.micAvailable ? 'Turn on microphone' : state.muted ? `Unmute (${MOD} + D)` : `Mute (${MOD} + D)`;
  const hands = call.peers.filter((peer) => peer.hand).length;
  const peopleBadge = lobby.length + peers.filter((peer) => peer.hand).length;

  /**
   * One tap, like Teams and Meet: stops sharing, or starts it. Where the browser can share the screen
   * its own picker opens; phones that can't (iPhone, most Android) open their photos instead, so a
   * screenshot can be shown to everyone.
   */
  function share() {
    setMenu(null);
    if (state.sharing || canShareScreen()) return void toggleScreen();
    setMobileShareHelp(true);
    return undefined;
  }

  if (minimized) {
    const shown = presenter
      ? { key: 'screen', name: `${presenter.name} is presenting`, address: presenter.address, stream: presenter.screenStream, videoOn: true }
      : leading;
    return (
      <div className={`nx-mini ${presenter ? 'presenting' : ''}`} role="region" aria-label="Call in progress">
        {voicesPlayed}
        <button type="button" className="nx-mini-picture" aria-label="Back to the call" onClick={() => setMinimized(false)}>
          <Tile tile={shown} />
          <span className="nx-mini-expand"><Icon name="expand" size={16} /></span>
          {presenter && <span className="nx-mini-mode"><Icon name="screenShare" size={13} />{presenter.isMe ? 'You are presenting' : `${presenter.name} is presenting`}</span>}
          {state.unread > 0 && <span className="nx-mini-unread"><Icon name="chat" size={14} />{state.unread}</span>}
        </button>
        <div className="nx-mini-bar">
          <span className="nx-mini-time">
            {recordingActive && <i className="nx-rec-dot" title={recordingText} />}
            <Elapsed since={state.startedAt} fallback="Calling…" />
          </span>
          {lobby.length > 0 && <button type="button" className="nx-mini-lobby" onClick={() => { setMinimized(false); setPanel('people'); }}>{lobby.length} waiting</button>}
          <button type="button" className={`nx-mini-btn ${micOff ? 'off' : ''}`} aria-label={micLabel} title={micLabel} onClick={toggleMute}>
            <Icon name={micOff ? 'micOff' : 'mic'} size={19} />
          </button>
          <button type="button" className={`nx-mini-btn ${state.cameraOn ? 'on' : 'off'}`} aria-label={state.cameraOn ? 'Turn camera off' : 'Turn camera on'} title={state.cameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={toggleCamera}>
            <Icon name={state.cameraOn ? 'videocam' : 'videocamOff'} size={19} />
          </button>
          {state.sharing && <button type="button" className="nx-mini-btn sharing" aria-label="Stop presenting" title="Stop presenting" onClick={share}><Icon name="screenShare" size={19} /></button>}
          <button type="button" className="nx-mini-btn leave" aria-label="Leave call" title="Leave call" onClick={hangUp}><Icon name="callEnd" size={19} /></button>
        </div>
      </div>
    );
  }

  const onlyMe = !hideSelf || tiles.length === 1;
  let stage;
  if (view === 'present') {
    stage = (
      <div className="nx-stage-split">
        <div className="nx-screen">
          <Video stream={presenter.screenStream} contain />
          <span className="nx-screen-label"><Icon name="screenShare" size={15} />{presenter.name} is presenting</span>
        </div>
        <Filmstrip tiles={shownTiles} pinned={pinned} onPin={togglePin} />
      </div>
    );
  } else if (view === 'spotlight') {
    const rest = shownTiles.filter((tile) => tile.key !== focus.key);
    stage = (
      <div className="nx-stage-split">
        <div className="nx-focus"><Tile tile={focus} hug pinned={pinned === focus.key} onPin={() => togglePin(focus.key)} /></div>
        <Filmstrip tiles={rest} pinned={pinned} onPin={togglePin} />
      </div>
    );
  } else if (view === 'solo') {
    const big = swapped ? selfTile : others[0];
    const small = swapped ? others[0] : selfTile;
    stage = (
      <div className="nx-solo">
        <div className="nx-focus"><Tile tile={big} hug /></div>
        {(onlyMe || swapped) && (
          <button type="button" className="nx-pip" onClick={() => setSwapped((s) => !s)} aria-label="Swap pictures" title="Swap pictures">
            <Tile tile={small} compact />
          </button>
        )}
      </div>
    );
  } else {
    stage = <Gallery tiles={shownTiles} pinned={pinned} onPin={togglePin} />;
  }

  const layoutChoices = [
    ['auto', 'mosaic', 'Auto'],
    ['grid', 'grid', 'Gallery'],
    ['spotlight', 'spotlight', 'Spotlight'],
  ];
  const toasts = [];
  if (state.notice) toasts.push(<div key="notice" className="nx-toast warn" role="alert"><Icon name="info" size={18} /><span>{state.notice}</span><button type="button" className="nx-icon-btn" aria-label="Dismiss" onClick={clearNotice}><Icon name="close" size={17} /></button></div>);
  if (audioBlocked) toasts.push(<div key="blocked" className="nx-toast warn" role="alert"><Icon name="volume" size={18} /><span>Your browser paused call audio.</span><button type="button" className="nx-btn small primary" onClick={resumeAudio}>Play audio</button></div>);
  if (audioError && !audioBlocked) toasts.push(<div key="audio" className="nx-toast warn" role="alert"><Icon name="volume" size={18} /><span>{audioError}</span><button type="button" className="nx-icon-btn" aria-label="Dismiss" onClick={() => setAudioError('')}><Icon name="close" size={17} /></button></div>);
  if (recordError) toasts.push(<div key="rec-error" className="nx-toast warn" role="alert"><Icon name="record" size={18} /><span>{recordError}</span><button type="button" className="nx-icon-btn" aria-label="Dismiss" onClick={() => setRecordError('')}><Icon name="close" size={17} /></button></div>);
  if (recordStatus) {
    toasts.push(
      <div key="rec-status" className="nx-toast ok" role="status">
        <Icon name={recordStatus === 'saved' ? 'checkCircle' : 'refresh'} size={18} className={recordStatus === 'saving' ? 'spin' : ''} />
        {recordStatus === 'saved'
          ? <span><strong>Recording saved</strong><small>Everyone from your team in this call can watch it in Meet.</small></span>
          : <span><strong>Saving the recording…</strong><small>Keep this window open for a moment.</small></span>}
        {recordStatus === 'saved' && <button type="button" className="nx-icon-btn" aria-label="Dismiss" onClick={() => setRecordStatus(null)}><Icon name="close" size={16} /></button>}
      </div>,
    );
  }
  if (state.sharing) toasts.push(<div key="sharing" className="nx-toast live" role="status"><Icon name="screenShare" size={18} /><span>You’re presenting to everyone</span><button type="button" className="nx-btn small" onClick={toggleScreen}>Stop presenting</button></div>);
  if (talking) toasts.push(<div key="ptt" className="nx-toast live" role="status"><Icon name="mic" size={18} /><span>Talking — release Space to mute</span></div>);

  return (
    <div ref={room} className={`nx-room view-${view} ${panel ? 'with-panel' : ''} ${chromeHidden && !panel && !menu ? 'chrome-hidden' : ''}`} role="dialog" aria-label="Call">
      <input
        ref={picturePicker}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void sharePicture(file); }}
      />
      {voicesPlayed}

      <header className="nx-top">
        <div className="nx-top-meta">
          <span className={`nx-live ${peers.length ? 'on' : ''}`} aria-hidden="true"><i /></span>
          <div className="nx-title">
            <strong>{title}</strong>
            <span>
              <Elapsed since={state.startedAt} fallback={call.video ? 'Video call' : 'Voice call'} />
              <em>·</em>{call.peers.length} {call.peers.length === 1 ? 'person' : 'people'}
              {call.code && <><em>·</em><Icon name="lock" size={12} /> Protected</>}
              {state.networkQuality !== 'unknown' && (
                <span className={`nx-quality ${state.networkQuality}`} title={`Connection quality: ${state.networkQuality}`}>
                  <i />{state.networkQuality}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="nx-top-actions">
          {recordingActive && (
            <div className={`nx-rec ${state.recording ? 'mine' : ''}`} role="status" aria-label={recordingText} title={recordingText}>
              <i className="nx-rec-dot" aria-hidden="true" />
              <span className="nx-rec-label">{state.recording ? 'REC' : otherRecorders.length ? `${otherRecorders[0]} is recording` : 'Recording'}</span>
              {state.recording && <time><Elapsed since={recordingStartedAt} fallback="00:00" /></time>}
              {state.recording && <button type="button" onClick={toggleRecording}>Stop</button>}
            </div>
          )}
          {hands > 0 && <button type="button" className="nx-hands" onClick={() => setPanel('people')} title="Raised hands"><Icon name="hand" size={15} />{hands}</button>}
          <div className="nx-segment nx-only-desktop" role="radiogroup" aria-label="Layout">
            {layoutChoices.map(([value, icon, label]) => (
              <button key={value} type="button" role="radio" aria-checked={layout === value && !pinned} className={layout === value && !pinned ? 'on' : ''} title={`${label} layout`} aria-label={`${label} layout`} onClick={() => setLayout(value)}>
                <Icon name={icon} size={18} />
              </button>
            ))}
          </div>
          {canFullscreen && <button type="button" className="nx-top-btn nx-only-desktop" aria-label={fullscreen ? 'Leave full screen' : 'Full screen (F)'} title={fullscreen ? 'Leave full screen' : 'Full screen (F)'} onClick={toggleFullscreen}><Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={20} /></button>}
          <button type="button" className="nx-top-btn nx-only-mobile" aria-label="People" title="People" onClick={() => togglePanel('people')}>
            <Icon name="people" size={20} />{peopleBadge > 0 && <span className="nx-badge">{peopleBadge}</span>}
          </button>
          {!state.guest && <button type="button" className="nx-top-btn" aria-label="Keep working (make the call small)" title="Keep working (make the call small)" onClick={() => { setMinimized(true); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }}><Icon name="minimize" size={20} /></button>}
        </div>
      </header>

      <div className="nx-body">
        <main
          className={`nx-stage ${alone ? 'is-alone' : ''}`}
          aria-label="Video"
          onClick={(event) => {
            // Phones: a tap on the pictures (not on a button) hides or brings back the controls.
            if (!window.matchMedia('(max-width: 760px)').matches || event.target.closest('button, a, input, .nx-ready')) return;
            setChromeHidden((hidden) => !hidden);
          }}
        >
          {stage}
          <ReactionLayer items={floating} />
          {pinnedTile && (
            <button type="button" className="nx-pinned-chip" onClick={() => setPinned(null)}>
              <Icon name="pin" size={15} /> {pinnedTile.isMe ? 'You are' : `${pinnedTile.name} is`} pinned · <u>Unpin</u>
            </button>
          )}
          {alone && (
            <div className="nx-ready" role="region" aria-label="Invite people to this meeting">
              <div className="nx-ready-head">
                <span className="nx-ready-art" aria-hidden="true"><Icon name="people" size={24} /></span>
                <span>
                  <small>Private meeting space</small>
                  <strong>Your room is ready</strong>
                </span>
              </div>
              <ShareLink state={state} intro="Share this link with anyone you want in the meeting. You’ll be asked before guests come in." />
              <button type="button" className="nx-link nx-invite-team" onClick={() => setPanel('people')}><Icon name="personAdd" size={16} /> Invite teammates from Nextspace</button>
            </div>
          )}
        </main>

        {panel && (
          <>
            <button type="button" className="nx-sheet-backdrop" aria-label="Close panel" onClick={() => setPanel(null)} />
            <aside className="nx-panel" aria-label={PANELS[panel]}>
              <span className="nx-sheet-grip" aria-hidden="true" />
              <header className="nx-panel-head">
                <h2>{PANELS[panel]}</h2>
                <button type="button" className="nx-icon-btn" aria-label="Close" onClick={() => setPanel(null)}><Icon name="close" size={20} /></button>
              </header>
              <div className={`nx-panel-body ${panel === 'chat' ? 'flush' : ''}`}>
                {panel === 'people' && <PeoplePanel state={state} pinned={pinned} onPin={togglePin} />}
                {panel === 'chat' && <ChatPanel state={state} />}
                {panel === 'info' && <InfoPanel state={state} />}
                {panel === 'devices' && <DevicesPanel state={state} />}
              </div>
            </aside>
          </>
        )}

        <div className="nx-toasts">
          {toasts}
          <MutedTalkHint stream={state.localAudio} muted={state.muted && state.micAvailable && !talking} onUnmute={toggleMute} />
          {chatToast && panel !== 'chat' && (
            <button type="button" className="nx-toast nx-chat-toast" onClick={() => { setChatToast(null); setPanel('chat'); }}>
              <Avatar person={{ name: chatToast.name, address: chatToast.guest ? `guest:${chatToast.from}` : chatToast.from }} size="sm" />
              <span><strong>{chatToast.name}</strong><small>{chatToast.text}</small></span>
            </button>
          )}
        </div>

        {panel !== 'people' && <LobbyList lobby={lobby} compact />}

        {confirmRecord && !state.recording && (
          <div className="nx-dialog" role="alertdialog" aria-labelledby="nx-record-title">
            <span className="nx-dialog-icon"><Icon name="record" size={22} /></span>
            <strong id="nx-record-title">Record this call?</strong>
            <p>Everyone in the call will see that recording is on. It’s saved in Nextspace for your team members in the call, and copied to your Google Drive if connected. Make sure everyone agrees.</p>
            <div className="nx-dialog-actions">
              <button type="button" className="nx-btn" onClick={() => setConfirmRecord(false)}>Cancel</button>
              <button type="button" className="nx-btn danger" autoFocus onClick={startRecording}>Start recording</button>
            </div>
          </div>
        )}

        {mobileShareHelp && !state.sharing && (
          <div className="nx-dialog nx-mobile-share" role="dialog" aria-labelledby="nx-mobile-share-title">
            <span className="nx-dialog-icon"><Icon name="screenShare" size={22} /></span>
            <strong id="nx-mobile-share-title">Present from your phone</strong>
            <p>This mobile browser cannot broadcast your device screen live. Take a screenshot first, then present it to everyone while your camera and microphone keep running.</p>
            <div className="nx-dialog-actions">
              <button type="button" className="nx-btn" onClick={() => setMobileShareHelp(false)}>Cancel</button>
              <button type="button" className="nx-btn primary" autoFocus onClick={() => { setMobileShareHelp(false); picturePicker.current?.click(); }}><Icon name="image" size={17} />Choose screen capture</button>
            </div>
          </div>
        )}
      </div>

      <footer className="nx-bar">
        <div className="nx-bar-info nx-only-desktop" aria-hidden="true">
          <strong><Clock /></strong>
          <span>{call.code || (call.video ? 'Video call' : 'Voice call')}</span>
        </div>

        <div className="nx-dock" ref={menus}>
          <DockButton icon={micOff ? 'micOff' : 'mic'} label={micLabel} text={micOff ? 'Unmute' : 'Mic'} state={micOff ? 'off' : ''} onClick={toggleMute} aria-pressed={micOff} />
          <DockButton icon={state.cameraOn ? 'videocam' : 'videocamOff'} label={state.cameraOn ? `Turn camera off (${MOD} + E)` : `Turn camera on (${MOD} + E)`} text="Camera" state={state.cameraOn ? '' : 'off'} onClick={toggleCamera} aria-pressed={!state.cameraOn} />
          <DockButton icon="screenShare" label={state.sharing ? 'Stop presenting' : canShareScreen() ? 'Share your screen' : 'Present a screen capture'} text={state.sharing ? 'Stop' : canShareScreen() ? 'Share' : 'Present'} state={state.sharing ? 'on' : ''} onClick={share} aria-pressed={state.sharing} />
          <DockButton icon="mood" label="Send a reaction" text="React" className="nx-only-desktop" state={menu === 'react' ? 'on' : ''} onClick={() => setMenu(menu === 'react' ? null : 'react')} aria-expanded={menu === 'react'} />
          <DockButton icon="hand" label={state.hand ? 'Lower hand' : `Raise hand (${MOD} + Alt + H)`} text={state.hand ? 'Lower' : 'Raise'} state={state.hand ? 'on hand' : ''} className="nx-only-desktop" onClick={toggleHand} aria-pressed={state.hand} />
          <DockButton icon="chat" label="Chat" state={panel === 'chat' ? 'on' : ''} badge={panel === 'chat' ? 0 : state.unread} className="nx-only-mobile" onClick={() => togglePanel('chat')} />
          <DockButton icon="moreVert" label="More options" text="More" state={menu === 'more' ? 'on' : ''} badge={0} onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-expanded={menu === 'more'} />
          <span className="nx-ctl-sep nx-only-desktop" aria-hidden="true" />
          <DockButton icon="info" label="Meeting details" text="Details" state={panel === 'info' ? 'on' : ''} className="flat nx-only-desktop" onClick={() => togglePanel('info')} />
          <DockButton icon="people" label={`People (${MOD} + Alt + P)`} text="People" state={panel === 'people' ? 'on' : ''} className="flat nx-only-desktop" badge={peopleBadge} onClick={() => togglePanel('people')} />
          <DockButton icon="chat" label={`Chat (${MOD} + Alt + C)`} text="Chat" state={panel === 'chat' ? 'on' : ''} className="flat nx-only-desktop" badge={panel === 'chat' ? 0 : state.unread} onClick={() => togglePanel('chat')} />
          <span className="nx-ctl-sep nx-only-desktop" aria-hidden="true" />
          <DockButton icon="callEnd" label="Leave call" state="leave" wide="Leave" onClick={hangUp} />

          {menu === 'react' && (
            <div className="nx-popover nx-react-pop" role="menu" aria-label="Reactions">
              {REACTIONS.map((emoji) => (
                <button key={emoji} type="button" role="menuitem" onClick={() => react(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>
              ))}
            </div>
          )}

          {menu === 'more' && (
            <div className="nx-popover nx-menu" role="menu" aria-label="More options">
              <span className="nx-sheet-grip nx-only-mobile" aria-hidden="true" />
              <div className="nx-only-mobile nx-menu-reactions" role="group" aria-label="Reactions">
                {REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { void react(emoji); setMenu(null); }}>{emoji}</button>)}
              </div>
              <div className="nx-only-mobile nx-menu-grid">
                <button type="button" className={state.hand ? 'on' : ''} onClick={() => { toggleHand(); setMenu(null); }}><Icon name="hand" size={22} /><span>{state.hand ? 'Lower hand' : 'Raise hand'}</span></button>
                <button type="button" onClick={() => { setPanel('devices'); setMenu(null); }}><Icon name="settings" size={22} /><span>Settings</span></button>
                <button type="button" onClick={() => { setPanel('info'); setMenu(null); }}><Icon name="info" size={22} /><span>Details</span></button>
                <button type="button" onClick={() => { setPanel('people'); setMenu(null); }}><Icon name="people" size={22} /><span>People</span>{peopleBadge > 0 && <span className="nx-badge">{peopleBadge}</span>}</button>
              </div>
              <MenuItem icon="image" label="Present a photo or screenshot" onClick={() => { setMenu(null); picturePicker.current?.click(); }} />
              {recordingSupported() && !state.guest && <MenuItem icon="record" label={state.recording ? 'Stop recording' : 'Record meeting'} className={state.recording ? 'danger' : ''} onClick={toggleRecording} />}
              <div className="nx-menu-label">Layout</div>
              {layoutChoices.map(([value, icon, label]) => <MenuItem key={value} icon={icon} label={label} checked={layout === value && !pinned} onClick={() => { setLayout(value); setMenu(null); }} />)}
              <div className="nx-menu-sep" />
              <MenuItem icon={hideSelf ? 'visibility' : 'visibilityOff'} label={hideSelf ? 'Show my tile' : 'Hide my tile'} onClick={() => { setHideSelf((h) => !h); setMenu(null); }} />
              {canFullscreen && <MenuItem icon={fullscreen ? 'fullscreenExit' : 'fullscreen'} label={fullscreen ? 'Leave full screen' : 'Full screen'} hint="F" className="nx-only-desktop" onClick={() => { toggleFullscreen(); setMenu(null); }} />}
              <MenuItem icon="settings" label="Audio and video settings" onClick={() => { setPanel('devices'); setMenu(null); }} />
              <MenuItem icon="keyboard" label="Keyboard shortcuts" className="nx-only-desktop" onClick={() => { setPanel('info'); setMenu(null); }} />
            </div>
          )}
        </div>

      </footer>
    </div>
  );
}
