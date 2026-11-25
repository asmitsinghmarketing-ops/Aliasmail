import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareSfuEnabled, cloudflareSfuRequest, createCloudflareSfuSession } from '../src/cloudflare-sfu.js';

const settings = { cloudflareSfuAppId: 'app-id', cloudflareSfuAppSecret: 'server-secret' };

test('Cloudflare SFU requires both server-side credentials', () => {
  assert.equal(cloudflareSfuEnabled(settings), true);
  assert.equal(cloudflareSfuEnabled({ cloudflareSfuAppId: 'only-id' }), false);
});

test('Cloudflare SFU requests keep the secret in the authorization header', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 'session-1' }) };
  };
  const result = await createCloudflareSfuSession({ settings, fetcher });
  assert.deepEqual(result, { sessionId: 'session-1' });
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/new');
  assert.equal(request.options.headers.Authorization, 'Bearer server-secret');
  assert.equal(request.options.body, undefined);
});

test('Cloudflare SFU errors are safe and preserve the provider status', async () => {
  const fetcher = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ errorDescription: 'Not authorized' }) });
  await assert.rejects(
    cloudflareSfuRequest('sessions/new', { settings, fetcher }),
    (err) => err.message === 'Not authorized' && err.status === 401 && err.providerStatus === 401,
  );
});

