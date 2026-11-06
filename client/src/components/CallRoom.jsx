// The call on screen: everyone's pictures, the controls, and a small version to keep working in.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  canShareScreen, chooseDevice, clearNotice, dismissSharedDesktop, hangUp, inviteToCall, shareRemoteDesktop,
  toggleCamera, toggleHand, toggleMute, toggleScreen,
} from '../calls.js';
import { onlineNow } from '../live.js';
import { openRemoteDesktop } from '../rdpFile.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

function Video({ stream, muted = true, className }) {
  const element = useRef(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  return <video ref={element} className={className} autoPlay playsInline muted={muted} />;
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

function ControlButton({ icon, label, on, danger, disabled, onClick, badge }) {
  return (
    <button type="button" className={`call-control ${on ? 'on' : ''} ${danger ? 'danger' : ''}`} aria-label={label} aria-pressed={on === undefined ? undefined : on} title={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      {badge > 0 && <span className="call-control-badge">{badge}</span>}
      <span className="call-control-label">{label}</span>
    </button>
  );
}

/* ---------------------------------- side panels ---------------------------------- */

function PeoplePanel({ state }) {
  const [team, setTeam] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/mail/team').then(setTeam).catch((err) => setError(err.message)); }, []);
  const inCall = new Set(state.call.peers.map((peer) => peer.address));
  const ringing = new Set(state.call.invited.filter((invite) => invite.status === 'ringing').map((invite) => invite.address));
  const online = onlineNow();
  const others = (team || []).filter((person) => !inCall.has(person.address));
  const invite = (address) => inviteToCall([address]).catch((err) => setError(err.message));
  return (
    <>
      <h3>In this call ({state.call.peers.length})</h3>
      <ul className="call-people">
        {state.call.peers.map((peer) => (
          <li key={peer.id}>
            <Avatar person={peer} size="sm" />
            <span>{peer.name}{peer.id === state.me ? ' (you)' : ''}</span>
            {peer.hand && <Icon name="hand" size={17} />}
            <Icon name={peer.muted ? 'micOff' : 'mic'} size={17} />
          </li>
        ))}
      </ul>
      <h3>Add someone</h3>
      {error && <p className="call-panel-error">{error}</p>}
      {!team && !error && <p className="call-panel-note">Getting your team…</p>}
      {team && !others.length && <p className="call-panel-note">Everyone on your team is here.</p>}
      <ul className="call-people">
        {others.map((person) => (
          <li key={person.address}>
            <Avatar person={person} size="sm" />
            <span>{person.name || person.address}{online?.has(person.address) ? <small> · online</small> : null}</span>
            <button type="button" className="btn btn-outline" disabled={ringing.has(person.address)} onClick={() => invite(person.address)}>
              {ringing.has(person.address) ? 'Ringing…' : 'Call'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function DevicesPanel({ state }) {
  const [devices, setDevices] = useState([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, []);
  const speakerChoice = 'setSinkId' in HTMLMediaElement.prototype;
  const picker = (kind, label, value) => {
    const options = devices.filter((device) => device.kind === kind);
    return (
      <label className="call-device">
        <span>{label}</span>
        <select value={value || ''} disabled={!options.length} onChange={(event) => chooseDevice(kind, event.target.value)}>
          {!value && <option value="">Default</option>}
          {options.map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `${label} ${i + 1}`}</option>)}
        </select>
      </label>
    );
  };
  return (
    <>
      <h3>Devices</h3>
      {picker('audioinput', 'Microphone', state.micDevice)}
      {speakerChoice && picker('audiooutput', 'Speaker', state.speakerDevice)}
      {picker('videoinput', 'Camera', state.cameraDevice)}
    </>
  );
}

function DesktopPanel({ alone }) {
  const [list, setList] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { api('/remote-desktops').then(setList).catch((err) => setMessage(err.message)); }, []);
  const share = (item) => shareRemoteDesktop(item.id).then(() => setMessage(`Shared “${item.name}”. They still need their own sign-in.`)).catch((err) => setMessage(err.message));
  return (
    <>
      <h3>Remote desktop</h3>
      <p className="call-panel-note">Opens in this computer’s Remote Desktop app. Add computers in Settings → Remote desktop.</p>
      {message && <p className="call-panel-note strong">{message}</p>}
      {list?.length === 0 && <p className="call-panel-note">No computers saved yet.</p>}
      <ul className="call-people">
        {list?.map((item) => (
          <li key={item.id}>
            <Icon name="computer" size={20} />
            <span>{item.name}<small>{item.host}</small></span>
            <button type="button" className="btn btn-outline" onClick={() => openRemoteDesktop(item)}>Open</button>
            {!alone && <button type="button" className="btn btn-outline" onClick={() => share(item)}>Share</button>}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ---------------------------------- the room ---------------------------------- */

export default function CallRoom({ state }) {
  const [minimized, setMinimized] = useState(false);
  const [panel, setPanel] = useState(null); // 'people' | 'devices' | 'desktop'
  const duration = useDuration(state.startedAt);
  const { call, me, peers } = state;

  const voices = useMemo(() => [
    ...(state.localAudio && !state.muted ? [{ id: me, stream: state.localAudio }] : []),
    ...peers.filter((peer) => !peer.muted).map((peer) => ({ id: peer.id, stream: peer.audio })),
  ], [state.localAudio, state.muted, me, peers]);
  const speaker = useSpeaker(voices);

  const ringing = call.invited.filter((invite) => invite.status === 'ringing');
  const presenter = peers.find((peer) => peer.sharing && peer.screenStream) || null;
  const title = peers.length
    ? peers.map((peer) => peer.name).join(', ')
    : ringing.length ? `Calling ${ringing.map((invite) => invite.name).join(', ')}…` : 'Waiting for others…';

  const myName = call.peers.find((peer) => peer.id === me)?.name || 'You';
  const tiles = [
    { key: me, name: `${myName} (you)`, address: call.peers.find((peer) => peer.id === me)?.address, stream: state.localCamera, videoOn: state.cameraOn, muted: state.muted || !state.micAvailable, hand: state.hand, speaking: speaker === me, mirrored: true },
    ...peers.map((peer) => ({
      key: peer.id, name: peer.name, address: peer.address, stream: peer.cameraStream, videoOn: peer.camera, muted: peer.muted, hand: peer.hand, speaking: speaker === peer.id,
      status: ['connected', 'new'].includes(peer.connection) ? null : peer.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…',
    })),
    ...ringing.map((invite) => ({ key: invite.address, name: invite.name, address: invite.address, status: 'Ringing…' })),
  ];
  const leading = presenter ? null : tiles.find((tile) => tile.speaking && tile.key !== me) || tiles.find((tile) => tile.key !== me) || tiles[0];

  const voicesPlayed = peers.map((peer) => peer.audio && <Voice key={peer.id} stream={peer.audio} speaker={state.speakerDevice} />);

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
          <button type="button" className={`call-mini-btn ${state.muted ? 'on' : ''}`} aria-label={state.muted ? 'Unmute' : 'Mute'} title={state.muted ? 'Unmute' : 'Mute'} disabled={!state.micAvailable} onClick={toggleMute}>
            <Icon name={state.muted ? 'micOff' : 'mic'} size={20} />
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
        <button type="button" className="call-head-btn" aria-label="Keep working (make the call small)" title="Keep working (make the call small)" onClick={() => setMinimized(true)}><Icon name="minimize" /></button>
      </header>

      {state.notice && (
        <div className="call-notice" role="alert">
          <span>{state.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={clearNotice}><Icon name="close" size={18} /></button>
        </div>
      )}
      {state.sharedDesktops.map((shared) => (
        <div className="call-notice desktop" role="alert" key={shared.host}>
          <Icon name="computer" size={20} />
          <span><strong>{shared.fromName}</strong> shared the remote desktop “{shared.name}” at <strong>{shared.host}{shared.port !== 3389 ? `:${shared.port}` : ''}</strong>. Only open it if you were expecting this. It opens without access to your files or clipboard.</span>
          <button type="button" className="btn btn-outline" onClick={() => { openRemoteDesktop(shared, { shared: true }); dismissSharedDesktop(shared.host); }}>Open</button>
          <button type="button" aria-label="Dismiss" onClick={() => dismissSharedDesktop(shared.host)}><Icon name="close" size={18} /></button>
        </div>
      ))}

      <div className="call-room-body">
        {presenter ? (
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
            {panel === 'desktop' && <DesktopPanel alone={!peers.length} />}
          </aside>
        )}
      </div>

      <footer className="call-controls">
        <ControlButton icon={state.muted || !state.micAvailable ? 'micOff' : 'mic'} label={state.muted ? 'Unmute' : 'Mute'} on={state.muted || !state.micAvailable} disabled={!state.micAvailable} onClick={toggleMute} />
        <ControlButton icon={state.cameraOn ? 'videocam' : 'videocamOff'} label={state.cameraOn ? 'Camera off' : 'Camera on'} on={!state.cameraOn} onClick={toggleCamera} />
        {canShareScreen() && <ControlButton icon="screenShare" label={state.sharing ? 'Stop sharing' : 'Share screen'} on={state.sharing} onClick={toggleScreen} />}
        <ControlButton icon="hand" label={state.hand ? 'Lower hand' : 'Raise hand'} on={state.hand} onClick={toggleHand} />
        <ControlButton icon="personAdd" label="People" on={panel === 'people'} badge={peers.filter((peer) => peer.hand).length} onClick={() => setPanel(panel === 'people' ? null : 'people')} />
        <ControlButton icon="computer" label="Remote desktop" on={panel === 'desktop'} onClick={() => setPanel(panel === 'desktop' ? null : 'desktop')} />
        <ControlButton icon="settings" label="Devices" on={panel === 'devices'} onClick={() => setPanel(panel === 'devices' ? null : 'devices')} />
        <ControlButton icon="callEnd" label="Leave" danger onClick={hangUp} />
      </footer>
    </div>
  );
}
