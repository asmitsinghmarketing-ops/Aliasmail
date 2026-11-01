// Admin → Assistant → AI settings: which AI the Assistant uses, its API key and model, and a
// connection test. Keys are only ever shown by their last 4 characters (server: assistant-settings.js).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Claude',
    note: 'Best quality and fast. Paid per use; your mail isn’t used for training.',
    keyFrom: { label: 'console.anthropic.com → API Keys', url: 'https://console.anthropic.com/settings/keys' },
    modelField: 'model',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    modelHint: 'Opus 5.5: most capable · Sonnet 5.5: half the price · Haiku 5.5: fastest and cheapest',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    note: 'Free tier for testing. Google may use what is sent to improve its products.',
    keyFrom: { label: 'aistudio.google.com → Get API key', url: 'https://aistudio.google.com/apikey' },
    modelField: 'geminiModel',
    models: ['gemini-3.8-flash'],
    modelHint: 'Use a model listed under Rate Limit in Google AI Studio.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    note: 'Many models, some free. Free models’ providers may keep what is sent.',
    keyFrom: { label: 'openrouter.ai → Keys', url: 'https://openrouter.ai/settings/keys' },
    modelField: 'openrouterModel',
    models: [],
    modelHint: 'On openrouter.ai/models filter Free + Tools, then copy the model’s name (ends in :free).',
  },
];
const NAMES = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

export default function AdminAiSettings({ onChanged }) {
  const [info, setInfo] = useState(null);
  const [choice, setChoice] = useState('');
  const [editing, setEditing] = useState('anthropic');
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone: 'ok' | 'error', text }

  const apply = (data) => {
    setInfo(data);
    setChoice(data.provider);
    setEditing(data.provider || data.inUse.provider);
    setForm({ key: '', model: data.model, geminiModel: data.geminiModel, openrouterModel: data.openrouterModel, effort: data.effort, geminiThinking: data.geminiThinking });
  };
  useEffect(() => {
    api('/assistant/settings').then(apply).catch((err) => setMessage({ tone: 'error', text: err.message }));
  }, []);

  if (!info) return message ? <div className="alert">{message.text}</div> : null;
  const p = PROVIDERS.find((x) => x.id === editing);
  const key = info.keys[editing];

  async function save(extra = {}) {
    setBusy(true);
    setMessage(null);
    try {
      const body = {
        provider: choice,
        [p.modelField]: form[p.modelField],
        ...(editing === 'anthropic' && { effort: form.effort }),
        ...(editing === 'gemini' && { geminiThinking: form.geminiThinking }),
        ...(form.key.trim() && { keys: { [editing]: form.key.trim() } }),
        ...extra,
      };
      const data = await api('/assistant/settings', { method: 'PUT', body });
      apply(data);
      setEditing(editing);
      setMessage({ tone: 'ok', text: data.inUse.enabled ? `Saved. The Assistant now uses ${NAMES[data.inUse.provider]} (${data.inUse.model}).` : 'Saved. The Assistant is still off: add a key (and a model for OpenRouter).' });
      onChanged?.();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api('/assistant/settings/test', { method: 'POST' });
      setMessage(r.ok
        ? { tone: 'ok', text: `Connected to ${NAMES[r.provider]} (${r.model}). It answered “${r.reply || '…'}” in ${(r.ms / 1000).toFixed(1)} s.` }
        : { tone: 'error', text: `${NAMES[r.provider]} (${r.model}): ${r.error}` });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card speed-card ai-settings">
      <div className="ai-settings-head">
        <h2 className="card-title">AI settings</h2>
        <span className={`ai-settings-state ${info.inUse.enabled ? 'on' : 'off'}`}>
          {info.inUse.enabled ? `In use: ${NAMES[info.inUse.provider]} · ${info.inUse.model}` : 'Assistant is off'}
        </span>
      </div>

      <div className="ai-settings-field">
        <span className="ai-settings-label">Which AI the Assistant uses</span>
        <div className="ai-segments" role="radiogroup" aria-label="AI provider">
          {[{ id: '', name: 'Automatic' }, ...PROVIDERS].map((x) => (
            <button
              key={x.id || 'auto'}
              type="button"
              role="radio"
              aria-checked={choice === x.id}
              className={choice === x.id ? 'on' : ''}
              onClick={() => {
                setChoice(x.id);
                if (x.id) setEditing(x.id);
              }}
            >
              {x.name}
            </button>
          ))}
        </div>
        <span className="muted small">
          {choice ? `Always ${NAMES[choice]}.` : 'Automatic: Claude if it has a key, otherwise Gemini, otherwise OpenRouter.'}
          {info.providerFromHosting && !info.provider && ` The hosting settings choose ${NAMES[info.providerFromHosting] || info.providerFromHosting}.`}
        </span>
      </div>

      <div className="ai-tabs" role="tablist" aria-label="Settings for">
        {PROVIDERS.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={editing === x.id} className={editing === x.id ? 'on' : ''} onClick={() => { setEditing(x.id); setForm((f) => ({ ...f, key: '' })); setMessage(null); }}>
            {x.name}
            {info.keys[x.id].set && <Icon name="checkCircle" size={14} />}
          </button>
        ))}
      </div>

      <form className="ai-provider" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <p className="muted small">{p.note}</p>

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            name="ai-api-key"
            // Not a password: keep it out of the browser's password manager.
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            spellCheck={false}
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            placeholder={key.set ? `${key.from === 'hosting' ? 'From hosting' : 'Saved'} ••••${key.ending} · paste to replace` : 'Paste the key'}
          />
        </label>
        <p className="muted small ai-provider-hint">
          Get one at <a href={p.keyFrom.url} target="_blank" rel="noreferrer">{p.keyFrom.label}</a>. Stored encrypted; only the last 4 characters are ever shown.
          {key.from === 'nextspace' && (
            <>
              {' '}
              <button type="button" className="link" disabled={busy} onClick={() => save({ keys: { [editing]: null } })}>Remove saved key</button>
            </>
          )}
        </p>

        <label className="field">
          <span>Model</span>
          <input
            list={`models-${editing}`}
            spellCheck={false}
            value={form[p.modelField] || ''}
            onChange={(e) => setForm({ ...form, [p.modelField]: e.target.value })}
            placeholder={editing === 'openrouter' ? 'e.g. provider/model-name:free' : ''}
          />
          <datalist id={`models-${editing}`}>
            {p.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
        <p className="muted small ai-provider-hint">{p.modelHint}</p>

        {editing === 'anthropic' && (
          <label className="field">
            <span>Effort</span>
            <select value={form.effort || 'medium'} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
              <option value="low">Low: fastest and cheapest</option>
              <option value="medium">Medium: balanced (default)</option>
              <option value="high">High: more careful, costs more</option>
            </select>
          </label>
        )}
        {editing === 'gemini' && (
          <label className="field">
            <span>Thinking</span>
            <select value={form.geminiThinking || 'low'} onChange={(e) => setForm({ ...form, geminiThinking: e.target.value })}>
              <option value="minimal">Minimal: fastest</option>
              <option value="low">Low: fast (default)</option>
              <option value="high">High: slower, for harder requests</option>
              <option value="off">Google’s default</option>
            </select>
          </label>
        )}

        <div className="ai-provider-actions">
          <button className="btn btn-primary" disabled={busy}>
            <Icon name="checkCircle" size={18} /> {busy ? 'Working…' : 'Save'}
          </button>
          <button type="button" className="btn btn-outline" disabled={busy || !info.inUse.enabled} onClick={test}>
            <Icon name="refresh" size={18} /> Test connection
          </button>
        </div>
        {message && <div className={message.tone === 'ok' ? 'ai-admin-saved' : 'alert'}>{message.text}</div>}
      </form>
    </section>
  );
}
