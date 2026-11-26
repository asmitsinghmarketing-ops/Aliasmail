import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeScreenShare = registerPlugin('NativeScreenShare');
const FIRST_FRAME_TIMEOUT_MS = 8_000;

export const canNativeScreenShare = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/**
 * Android MediaProjection frames cross the Capacitor bridge and are painted onto a canvas. The
 * canvas track then enters the exact same WebRTC/SFU screen channel as browser getDisplayMedia.
 */
export async function startNativeScreenShare(onStopped) {
  if (!canNativeScreenShare()) return null;
  const canvas = document.createElement('canvas');
  if (!canvas.captureStream) throw new Error('This Android WebView cannot publish captured screen frames.');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d', { alpha: false });
  const stream = canvas.captureStream(10);
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail';
  let released = false;
  let drawing = false;
  let pending = null;
  let frameHandle;
  let stopHandle;
  let nativeStarted = false;
  let firstFrameReady = false;
  let resolveFirstFrame;
  let rejectFirstFrame;
  const firstFrame = new Promise((resolve, reject) => {
    resolveFirstFrame = resolve;
    rejectFirstFrame = reject;
  });

  const drawNext = () => {
    if (released || drawing || !pending) return;
    const frame = pending;
    pending = null;
    drawing = true;
    const image = new Image();
    image.onload = () => {
      if (!released) {
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        track.requestFrame?.();
        if (!firstFrameReady) {
          firstFrameReady = true;
          resolveFirstFrame();
        }
      }
      drawing = false;
      drawNext();
    };
    image.onerror = () => {
      drawing = false;
      drawNext();
    };
    image.src = `data:image/jpeg;base64,${frame.jpeg}`;
  };

  const release = async (tellNative = true) => {
    if (released) return;
    released = true;
    pending = null;
    await frameHandle?.remove?.();
    await stopHandle?.remove?.();
    if (tellNative) await NativeScreenShare.stop().catch(() => {});
  };

  frameHandle = await NativeScreenShare.addListener('frame', (frame) => {
    pending = frame; // keep only the newest frame if image decoding falls behind
    drawNext();
  });
  stopHandle = await NativeScreenShare.addListener('stopped', () => {
    if (!firstFrameReady) rejectFirstFrame(new Error('Android screen capture stopped before video was available.'));
    void release(false);
    if (track.readyState !== 'ended') track.stop();
    onStopped?.();
  });
  try {
    await NativeScreenShare.start();
    nativeStarted = true;
    let timeout;
    await Promise.race([
      firstFrame,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Android screen capture did not produce video.')), FIRST_FRAME_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (released || track.readyState === 'ended') throw new Error('Android screen capture stopped during startup.');
  } catch (error) {
    await release(nativeStarted);
    track.stop();
    throw error;
  }
  track.nextspaceRelease = release;
  track.nextspaceNativeScreen = true;
  return track;
}
