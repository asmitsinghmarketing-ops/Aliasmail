// Records an Instant Notes call in this browser. Media still travels peer-to-peer; the browser
// mixes what this person can hear and see into one video, which recordingUpload.js keeps in
// Nextspace (downloaded here only if saving it there fails).

import { initials } from './format.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;

export const recordingSupported = () => Boolean(
  window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && (window.AudioContext || window.webkitAudioContext),
);

function recordingType() {
  return [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}


/** Download a completed recording without keeping it in application or server storage. */
export function downloadRecording(blob, startedAt = new Date()) {
  if (!blob?.size) return;
  const stamp = startedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `nextspace-call-${stamp}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Calls `tick` FPS times a second, also while the tab is in the background. Returns a stop function. */
function startClock(tick) {
  try {
    const worker = new Worker(new URL('./recordingClock.js', import.meta.url));
    worker.onmessage = tick;
    worker.postMessage(Math.round(1000 / FPS));
    return () => worker.terminate();
  } catch {
    const timer = setInterval(tick, Math.round(1000 / FPS));
    return () => clearInterval(timer);
  }
}

/** Draws a label on a dark pill. The font is set before measuring, so the pill fits the text. */
function label(context, text, x, y, { size = 15, maxWidth = Infinity } = {}) {
  context.font = `500 ${size}px sans-serif`;
  const width = Math.min(maxWidth, context.measureText(text).width + 24);
  const height = size + 13;
  context.fillStyle = 'rgba(8, 13, 22, .75)';
  context.beginPath();
  context.roundRect ? context.roundRect(x, y, width, height, 8) : context.rect(x, y, width, height);
  context.fill();
  context.fillStyle = '#fff';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, x + 12, y + height / 2 + 1, width - 24);
}

/**
 * A live recorder. `sync` adds newly joined people and follows camera/screen changes.
 * `onError` is called if the browser stops the recording by itself (what was recorded is kept).
 */
export async function createCallRecorder(initialState, { onError, onChunk } = {}) {
  if (!recordingSupported()) throw new Error('Call recording needs a current version of Chrome or Edge.');

  const Audio = window.AudioContext || window.webkitAudioContext;
  const audio = new Audio();
  await audio.resume();
  const audioOut = audio.createMediaStreamDestination();
  const audioSources = new Map();
  const videos = new Map();
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  let state = initialState;
  let stopClock = null;
  let stopped = false;

  function syncAudio(next) {
    const streams = [next.localAudio, ...next.peers.map((peer) => peer.audio)].filter(Boolean);
    const wanted = new Set(streams.flatMap((stream) => stream.getAudioTracks()).map((track) => track.id));
    for (const [id, source] of audioSources) {
      if (!wanted.has(id)) {
        source.disconnect();
        audioSources.delete(id);
      }
    }
    for (const stream of streams) {
      const track = stream.getAudioTracks()[0];
      if (!track || audioSources.has(track.id)) continue;
      const source = audio.createMediaStreamSource(new MediaStream([track]));
      source.connect(audioOut);
      audioSources.set(track.id, source);
    }
  }

  function videoFor(stream) {
    const track = stream?.getVideoTracks()[0];
    if (!track) return null;
    if (!videos.has(track.id)) {
      const video = document.createElement('video');
      video.srcObject = new MediaStream([track]);
      video.muted = true;
      video.playsInline = true;
      video.play().catch(() => {});
      videos.set(track.id, video);
    }
    return videos.get(track.id);
  }

  function people(next) {
    const me = next.call.peers.find((peer) => peer.id === next.me) || { name: 'You' };
    return [
      { id: next.me, name: `${me.name || 'You'} (you)`, stream: next.cameraOn ? next.localCamera : null, mirrored: true },
      ...next.peers.map((peer) => ({ id: peer.id, name: peer.name, stream: peer.camera ? peer.cameraStream : null })),
    ];
  }

  function screen(next) {
    if (next.sharing && next.localScreen) return { name: 'You are sharing', stream: next.localScreen };
    const peer = next.peers.find((item) => item.sharing && item.screenStream);
    return peer ? { name: `${peer.name} is sharing`, stream: peer.screenStream } : null;
  }

  function drawVideo(video, x, y, width, height, contain = false, mirrored = false) {
    if (!video || video.readyState < 2 || !video.videoWidth) return false;
    // A phone's tall picture in a wide tile would be cropped to a sliver of face: show it whole.
    const ratio = (video.videoWidth / video.videoHeight) / (width / height);
    if (Math.max(ratio, 1 / ratio) > 1.4) contain = true;
    const scale = contain
      ? Math.min(width / video.videoWidth, height / video.videoHeight)
      : Math.max(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    context.save();
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    if (mirrored) {
      context.translate(x * 2 + width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, x + (width - w) / 2, y + (height - h) / 2, w, h);
    context.restore();
    return true;
  }

  function drawPerson(person, x, y, width, height) {
    context.fillStyle = '#182234';
    context.fillRect(x, y, width, height);
    const shown = drawVideo(videoFor(person.stream), x, y, width, height, false, person.mirrored);
    if (!shown) {
      context.fillStyle = '#2d66c3';
      context.beginPath();
      context.arc(x + width / 2, y + height / 2, Math.min(width, height) * 0.16, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#fff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(22, Math.min(width, height) * 0.12)}px sans-serif`;
      context.fillText(initials(person.name), x + width / 2, y + height / 2);
    }
    const size = height < 160 ? 12 : 15;
    label(context, person.name, x + 10, y + height - size - 23, { size, maxWidth: width - 20 });
  }

  function render() {
    if (stopped) return;
    context.fillStyle = '#0f1624';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const sharing = screen(state);
    const members = people(state);
    if (sharing) {
      drawVideo(videoFor(sharing.stream), 0, 0, WIDTH, HEIGHT, true);
      label(context, sharing.name, 16, 16, { size: 16 });
      const thumbW = 210;
      const thumbH = 118;
      members.slice(0, 5).forEach((person, index) => drawPerson(person, WIDTH - thumbW - 16, 16 + index * (thumbH + 10), thumbW, thumbH));
    } else {
      const columns = members.length <= 1 ? 1 : members.length <= 4 ? 2 : 3;
      const rows = Math.ceil(members.length / columns);
      const gap = 10;
      const tileW = (WIDTH - gap * (columns + 1)) / columns;
      const tileH = (HEIGHT - gap * (rows + 1)) / rows;
      members.forEach((person, index) => drawPerson(person, gap + (index % columns) * (tileW + gap), gap + Math.floor(index / columns) * (tileH + gap), tileW, tileH));
    }
    context.fillStyle = '#e5484d';
    context.beginPath();
    context.arc(WIDTH - 62, HEIGHT - 28, 7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#fff';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.font = '600 14px sans-serif';
    context.fillText('REC', WIDTH - 48, HEIGHT - 27);
  }

  const output = canvas.captureStream(FPS);
  audioOut.stream.getAudioTracks().forEach((track) => output.addTrack(track));
  const type = recordingType();
  const chunks = [];
  const recorder = new MediaRecorder(output, type ? { mimeType: type, videoBitsPerSecond: 2_500_000 } : undefined);
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data); // kept here too, so it can still be downloaded if saving fails
    onChunk?.(event.data);
  };
  recorder.onerror = () => onError?.('Recording stopped unexpectedly. What was recorded so far has been saved.');

  const cleanup = () => {
    stopped = true;
    stopClock?.();
    audioSources.forEach((source) => source.disconnect());
    videos.forEach((video) => { video.pause(); video.srcObject = null; });
    output.getTracks().forEach((track) => track.stop());
    audio.close().catch(() => {});
  };

  syncAudio(state);
  render();
  stopClock = startClock(render);
  recorder.start(1000);

  return {
    startedAt: new Date(),
    type: recorder.mimeType || type || 'video/webm',
    sync(next) {
      state = next;
      syncAudio(next);
    },
    stop() {
      return new Promise((resolve) => {
        const finish = () => {
          const blob = chunks.length ? new Blob(chunks, { type: recorder.mimeType || type || 'video/webm' }) : null;
          cleanup();
          resolve(blob);
        };
        // Already stopped by the browser (an error): keep what was recorded.
        if (recorder.state === 'inactive') return finish();
        recorder.onstop = finish;
        recorder.stop();
      });
    },
  };
}
