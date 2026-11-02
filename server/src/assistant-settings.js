// The Assistant's AI settings: which provider, its API key and model. Set by the admin in
// Admin console → Assistant (kept in the database, keys encrypted), or in the hosting's
// environment variables; a value saved in Nextspace wins over the hosting's.
import config from './config.js';
import { db, save } from './store.js';
import { HttpError } from './errors.js';
import { seal as sealWith, unseal as unsealWith } from './secret-box.js';

// Keys are encrypted (secret-box.js); the purpose keeps them apart from other secrets.
const PURPOSE = 'nextspace-assistant-keys';
const seal = (text) => sealWith(text, PURPOSE);
const unseal = (sealed) => unsealWith(sealed, PURPOSE);

const stored = () => ((db().assistant ||= {}).settings ||= {});

const KEYS = { anthropic: 'apiKey', gemini: 'geminiKey', openrouter: 'openrouterKey' };
const PROVIDERS = ['anthropic', 'gemini', 'openrouter'];
const NAMES = { anthropic: 'Claude', gemini: 'Google Gemini', openrouter: 'OpenRouter' };
// How each service's API keys begin (to catch a key pasted into the wrong tab).
const KEY_STARTS = { anthropic: 'sk-ant-', gemini: 'AIza', openrouter: 'sk-or-' };
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
      // A key pasted into the wrong tab: each service's keys start their own way.
      const owner = Object.entries(KEY_STARTS).find(([, start]) => key.startsWith(start))?.[0];
      if (owner && owner !== p) throw new HttpError(400, `That looks like a ${NAMES[owner]} key. Paste it in the ${NAMES[owner]} tab instead.`);
      s.keys[name] = seal(key);
    }
  }
  for (const field of ['model', 'geminiModel', 'openrouterModel']) {
    if (!(field in patch)) continue;
    const value = String(patch[field] || '').trim();
    if (value && !MODEL.test(value)) throw new HttpError(400, `“${value.slice(0, 60)}” isn’t a valid model name`);
    if (value && field === 'model' && !value.startsWith('claude')) throw new HttpError(400, `“${value.slice(0, 60)}” isn’t a Claude model. Claude models start with claude-, e.g. claude-opus-5-5.`);
    if (value && field === 'geminiModel' && (value.startsWith('claude') || value.includes('/'))) throw new HttpError(400, `“${value.slice(0, 60)}” isn’t a Gemini model, e.g. gemini-3.8-flash.`);
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
