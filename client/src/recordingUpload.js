// Sends a call recording to Nextspace while it is being made: about 2 MB (or 10 seconds) at a time,
// in order, retrying a piece a few times when the network hiccups. Closing the tab loses at most
// the last few seconds. If saving fails for good, `failed` says why and the caller keeps the
// recording on this computer instead.
import { api } from './api.js';
import { wait } from './format.js';

const PART_BYTES = 2 * 1024 * 1024; // small enough for shared-hosting database limits
const FLUSH_MS = 10_000;
const RETRIES = [1000, 3000, 8000];

export function createRecordingUpload({ callId, peerId, onFail }) {
  let id = null;
  let creating = null;
  let type = 'video/webm';
  let buffered = [];
  let bufferedBytes = 0;
  let next = 0;
  let queue = Promise.resolve();
  let flushTimer = null;
  let failed = null;

  const create = () => {
    creating ||= api('/recordings', { method: 'POST', body: { callId, peerId, type } }).then((made) => {
      id = made.id;
      return id;
    });
    return creating;
  };

  /** One piece. Network trouble and server hiccups are retried; a clear refusal is not. */
  async function sendPart(index, blob) {
    for (let attempt = 0; ; attempt++) {
      let res = null;
      try {
        res = await fetch(`/api/recordings/${id}/parts/${index}`, {
          method: 'PUT', credentials: 'same-origin', body: blob,
          headers: { 'X-Requested-With': 'AliasMail', 'Content-Type': type.split(';')[0] },
        });
      } catch {
        // offline for a moment: try again below
      }
      if (res?.ok) return;
      // Refused for a reason that won't change (storage full, recording gone): stop trying.
      if (res && (res.status < 500 || res.status === 507)) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Couldn’t save the recording to Nextspace.');
      }
      if (attempt >= RETRIES.length) throw new Error(res ? 'Nextspace couldn’t save the recording just now.' : 'Lost the connection while saving the recording.');
      await wait(RETRIES[attempt]);
    }
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!bufferedBytes || failed) return queue;
    const blob = new Blob(buffered, { type });
    buffered = [];
    bufferedBytes = 0;
    const index = next++;
    queue = queue
      .then(async () => {
        if (failed) return;
        await create();
        await sendPart(index, blob);
      })
      .catch((err) => {
        if (failed) return;
        failed = err;
        onFail?.(err);
      });
    return queue;
  }

  return {
    /**
     * Register the recording with Nextspace right away, while this window is surely still in the
     * call: the server only accepts new recordings from people in a call that's going on.
     */
    start(recordedType) {
      if (recordedType) type = recordedType;
      return create();
    },
    /** A piece from MediaRecorder (about a second of video). */
    add(chunk) {
      if (failed || !chunk?.size) return;
      if (chunk.type) type = chunk.type;
      buffered.push(chunk);
      bufferedBytes += chunk.size;
      if (bufferedBytes >= PART_BYTES) flush();
      else flushTimer ||= setTimeout(flush, FLUSH_MS);
    },
    /** Everything sent and the recording marked finished. Throws if it couldn't be saved. */
    async finish(durationMs) {
      await flush();
      if (failed) throw failed;
      if (!id) return null; // nothing was recorded
      return api(`/recordings/${id}/finish`, { method: 'POST', body: { durationMs } });
    },
    get failed() {
      return failed;
    },
  };
}
