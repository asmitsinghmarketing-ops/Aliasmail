import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice } from '../src/security.js';
import { createLocator } from '../src/geo.js';

const UA = {
  androidReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidOld: 'Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};
const device = (ua, hints = {}) => describeDevice({ headers: { 'user-agent': ua, ...hints } });

test('device names come from the user agent and Chrome client hints', () => {
  assert.deepEqual(device(UA.androidReduced, { 'sec-ch-ua-model': '"SM-S911B"', 'sec-ch-ua-mobile': '?1' }), { label: 'Android phone (Samsung SM-S911B) · Chrome', kind: 'phone' });
  assert.equal(device(UA.androidReduced).label, 'Android phone · Chrome');
  assert.equal(device(UA.androidOld).label, 'Android phone (Samsung SM-G991B) · Chrome');
  assert.deepEqual(device(UA.iphone), { label: 'iPhone · Safari', kind: 'phone' });
  assert.equal(device(UA.windowsEdge, { 'sec-ch-ua-platform-version': '"15.0.0"' }).label, 'Windows 11 computer · Edge');
  assert.equal(device(UA.windowsEdge, { 'sec-ch-ua-platform-version': '"10.0.0"' }).label, 'Windows 10 computer · Edge');
  assert.equal(device(UA.mac).label, 'Mac · Safari');
});

test('locations are looked up once per IP, never for private addresses, and failures stay blank', async () => {
  const asked = [];
  const locate = createLocator({
    fetcher: async (url) => {
      asked.push(url);
      if (url.includes('198.51.100.9')) throw new Error('offline');
      return { ok: true, json: async () => ({ city: 'Mumbai', region: 'Maharashtra', country_name: 'India' }) };
    },
  });
  assert.equal(await locate('203.0.113.7'), 'Mumbai, Maharashtra, India');
  assert.equal(await locate('203.0.113.7'), 'Mumbai, Maharashtra, India');
  assert.equal(asked.length, 1);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '::1', 'fd12:3456::1']) assert.equal(await locate(ip), null);
  assert.equal(asked.length, 1);
  assert.equal(await locate('198.51.100.9'), null);
  assert.equal(await createLocator({ enabled: false, fetcher: () => assert.fail('must not call') })('203.0.113.7'), null);
});
