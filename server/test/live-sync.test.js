import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSync } from '../src/live-sync.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ watching = false, fail = false } = {}) {
  const calls = [];
  const logs = [];
  const state = { watching, fail };
  const live = createLiveSync({
    liveMs: 20,
    fullMs: 200,
    watching: () => state.watching,
    warm: () => {},
    log: (...args) => logs.push(args.join(' ')),
    sync: async (opts) => {
      calls.push(opts.inboxOnly ? 'inbox' : 'full');
      if (state.fail) throw new Error('bridge down');
    },
  });
  return { live, calls, logs, state };
}

test('while someone has the app open, the inbox is checked often and everything else at the slow pace', async (t) => {
  const { live, calls } = harness({ watching: true });
  t.after(() => live.stop());
  live.start();
  await wait(330);
  const inbox = calls.filter((c) => c === 'inbox').length;
  const full = calls.filter((c) => c === 'full').length;
  // Windows timers tick every ~15ms, so allow for fewer checks than the ideal 330/20.
  assert.ok(inbox >= 5 && inbox > full * 1.5, `quick inbox checks: ${inbox}, full: ${full}`);
  assert.ok(full >= 2 && full <= 3, `full syncs: ${full}`);
});

test('with nobody watching only the slow full sync runs, and opening the app checks at once', async (t) => {
  const { live, calls, state } = harness({ watching: false });
  t.after(() => live.stop());
  live.start();
  await wait(60);
  assert.deepEqual(calls, ['full']);
  state.watching = true;
  live.nudge();
  await wait(560);
  assert.ok(calls.length >= 3, `after opening the app: ${calls.join(',')}`);
});

test('nudges from reconnecting screens never make it check faster than the live pace', async (t) => {
  const { live, calls } = harness({ watching: true });
  t.after(() => live.stop());
  live.start();
  const spam = setInterval(() => live.nudge(), 2);
  await wait(200);
  clearInterval(spam);
  assert.ok(calls.length <= 12, `checks in 200ms at a 20ms pace: ${calls.length}`);
});

test('a failing mailbox backs off and logs once instead of every few seconds', async (t) => {
  const { live, calls, logs } = harness({ watching: true, fail: true });
  t.after(() => live.stop());
  live.start();
  await wait(400);
  assert.ok(calls.length <= 6, `attempts while failing: ${calls.length}`);
  assert.equal(logs.length, 1);
});
