// The Assistant's AI settings: which provider, its API key and model. Set by the admin in
// Admin console → Assistant (kept in the database, keys encrypted), or in the hosting's
// environment variables; a value saved in Nextspace wins over the hosting's.
import crypto from 'node:crypto';
import config from './config.js';
import { db, save } from './store.js';
import { HttpError } from './errors.js';

// Keys are encrypted with a key derived from the app's secret (JWT_SECRET).
const SECRET = crypto.createHash('sha256').update(`nextspace-assistant-keys:${config.jwtSecret}`).digest();

function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function unseal(sealed) {
  try {
    const [version, iv, tag, data] = String(sealed).split(':');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return ''; // the app's secret changed: the saved key can't be read any more
  }
}

const stored = () => ((db().assistant ||= {}).settings ||= {});

const KEYS = { anthropic: 'apiKey', gemini: 'geminiKey', openrouter: 'openrouterKey' };
const PROVIDERS = ['anthropic', 'gemini', 'openrouter'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const THINKING = ['minimal', 'low', 'medium', 'high', 'off'];
const MODEL = /^[\w.:/@-]{1,120}$/;

/** What the Assistant uses now: the same shape as config.assistant. */
export function settings() {
  const s = stored();
  const env = config.assistant;
  const key = (name) => (s.keys?.[name] ? unseal(s.keys[name]) : '') || env[name] || '';
  return {
    ...env,
    provider: s.provider ?? env.provider,
    apiKey: key('apiKey'),
    model: s.model || env.model,
    effort: s.effort || env.effort,
    geminiKey: key('geminiKey'),
    geminiModel: s.geminiModel || env.geminiModel,
    geminiThinking: s.geminiThinking || env.geminiThinking,
    openrouterKey: key('openrouterKey'),
    openrouterModel: s.openrouterModel || env.openrouterModel,
  };
}

/** For the admin page: never the keys themselves, only whether one is set, where, and its end. */
export function describeSettings() {
  const s = stored();
  const env = config.assistant;
  const current = settings();
  const keyInfo = (name) => {
    const saved = s.keys?.[name] ? unseal(s.keys[name]) : '';
    const value = saved || env[name] || '';
    return { set: Boolean(value), ending: value ? value.slice(-4) : '', from: saved ? 'nextspace' : env[name] ? 'hosting' : null };
  };
  return {
    provider: s.provider ?? '',
    providerFromHosting: env.provider || '',
    keys: Object.fromEntries(Object.entries(KEYS).map(([p, name]) => [p, keyInfo(name)])),
    model: current.model,
    effort: current.effort,
    geminiModel: current.geminiModel,
    geminiThinking: current.geminiThinking,
    openrouterModel: current.openrouterModel,
  };
}

/**
 * Save what the admin changed. Keys: a string sets it, null removes the saved one (the hosting's
 * value, if any, applies again). provider '' means "whichever key is set".
 */
export function updateSettings(patch = {}) {
  const s = stored();
  if ('provider' in patch) {
    if (patch.provider && !PROVIDERS.includes(patch.provider)) throw new HttpError(400, 'Unknown AI provider');
    s.provider = patch.provider || '';
  }
  for (const [p, name] of Object.entries(KEYS)) {
    if (!patch.keys || !(p in patch.keys)) continue;
    const value = patch.keys[p];
    s.keys ||= {};
    if (value === null || value === '') delete s.keys[name];
    else {
      const key = String(value).trim();
      if (key.length < 10 || key.length > 400 || /\s/.test(key)) throw new HttpError(400, 'That doesn’t look like an API key');
      s.keys[name] = seal(key);
    }
  }
  for (const field of ['model', 'geminiModel', 'openrouterModel']) {
    if (!(field in patch)) continue;
    const value = String(patch[field] || '').trim();
    if (value && !MODEL.test(value)) throw new HttpError(400, `“${value.slice(0, 60)}” isn’t a valid model name`);
    s[field] = value;
  }
  if ('effort' in patch) {
    if (patch.effort && !EFFORTS.includes(patch.effort)) throw new HttpError(400, 'Unknown effort level');
    s.effort = patch.effort || '';
  }
  if ('geminiThinking' in patch) {
    if (patch.geminiThinking && !THINKING.includes(patch.geminiThinking)) throw new HttpError(400, 'Unknown thinking level');
    s.geminiThinking = patch.geminiThinking || '';
  }
  save();
  return describeSettings();
}
