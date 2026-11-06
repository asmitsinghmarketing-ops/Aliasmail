// Admin → Assistant: the AI settings (provider, key, model), this month's usage per person (tokens
// and estimated cost) and the monthly spending limits that stop the Assistant once reached.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import AdminAiSettings from './AdminAiSettings.jsx';
import Icon from './Icon.jsx';
import { TextSkeleton } from './Loading.jsx';

const PROVIDERS = { anthropic: 'Claude', gemini: 'Google Gemini (free tier)', openrouter: 'OpenRouter' };
const usd = (n) => `$${(n || 0).toFixed(2)}`;
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

export default function AdminAssistant() {
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState({ monthlyUsd: '', perPersonUsd: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = () =>
    api('/assistant/usage')
      .then((d) => {
        setData(d);
        setLimits({ monthlyUsd: String(d.limits.monthlyUsd), perPersonUsd: String(d.limits.perPersonUsd) });
      })
      .catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    try {
      await api('/assistant/limits', { method: 'PUT', body: { monthlyUsd: Number(limits.monthlyUsd), perPersonUsd: Number(limits.perPersonUsd) } });
      setSaved('Limits saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <div className="alert">{error}</div> : <TextSkeleton />;
  const share = data.limits.monthlyUsd > 0 ? Math.min(100, (data.total.usd / data.limits.monthlyUsd) * 100) : 0;
  const cached = data.total.cacheRead + data.total.cacheWrite + data.total.input;

  return (
    <div className="ai-admin">
      <AdminAiSettings onChanged={load} />
      {data.enabled && data.provider !== 'anthropic' && (
        <div className="alert warning">
          <strong>Test mode: {PROVIDERS[data.provider]}.</strong> With free models, the provider may keep or use what is
          sent (including email content the Assistant reads) to improve its products. Use it for testing, and switch to
          Claude in AI settings for real company mail.
        </div>
      )}

      <div className="ai-admin-tiles">
        <div className="card speed-tile">
          <span className="muted small">Spent this month ({data.month})</span>
          <strong>{usd(data.total.usd)}</strong>
          {data.limits.monthlyUsd > 0 && (
            <>
              <span className="ai-meter"><span style={{ width: `${share}%` }} /></span>
              <span className="muted small">of {usd(data.limits.monthlyUsd)} company limit</span>
            </>
          )}
        </div>
        <div className="card speed-tile">
          <span className="muted small">Requests to the AI</span>
          <strong>{data.total.requests}</strong>
          <span className="muted small">{tokens(cached)} tokens read · {tokens(data.total.output)} written</span>
        </div>
        <div className="card speed-tile">
          <span className="muted small">Saved by caching</span>
          <strong>{cached ? `${Math.round((data.total.cacheRead / cached) * 100)}%` : '—'}</strong>
          <span className="muted small">of input reused at a tenth of the price</span>
        </div>
        <div className="card speed-tile">
          <span className="muted small">{PROVIDERS[data.provider]}</span>
          <strong className="ai-admin-model">{data.model}</strong>
          <span className="muted small">
            {{ gemini: 'change with GEMINI_MODEL', openrouter: 'change with OPENROUTER_MODEL' }[data.provider] ?? `effort: ${data.effort} · change with ASSISTANT_MODEL / ASSISTANT_EFFORT`}
          </span>
        </div>
      </div>

      <section className="card speed-card">
        <h2 className="card-title">Usage by person this month</h2>
        {data.people.length === 0 ? (
          <p className="muted">Nobody has used the Assistant this month yet.</p>
        ) : (
          <div className="ai-admin-table" role="table">
            <div className="ai-admin-row head" role="row">
              <span>Person</span><span>Requests</span><span>Tokens in</span><span>Tokens out</span><span>Cost</span>
            </div>
            {data.people.map((p) => (
              <div key={p.address} className="ai-admin-row" role="row">
                <span><strong>{p.name || p.address}</strong>{p.name && <span className="muted small"> {p.address}</span>}</span>
                <span>{p.requests}</span>
                <span>{tokens(p.input + p.cacheRead + p.cacheWrite)}</span>
                <span>{tokens(p.output)}</span>
                <span>{usd(p.usd)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">Costs are estimates from list prices (free models count as $0); the provider’s own invoice is the final word.</p>
      </section>

      <section className="card speed-card">
        <h2 className="card-title">Monthly spending limits</h2>
        <p className="muted">When a limit is reached the Assistant stops until next month (or until you raise it). 0 means no limit.</p>
        <form className="ai-admin-limits" onSubmit={save}>
          <label className="field">
            <span>Whole company (US$ / month)</span>
            <input type="number" min="0" step="1" value={limits.monthlyUsd} onChange={(e) => setLimits({ ...limits, monthlyUsd: e.target.value })} />
          </label>
          <label className="field">
            <span>Each person (US$ / month)</span>
            <input type="number" min="0" step="1" value={limits.perPersonUsd} onChange={(e) => setLimits({ ...limits, perPersonUsd: e.target.value })} />
          </label>
          <button className="btn btn-primary"><Icon name="checkCircle" size={18} /> Save limits</button>
        </form>
        {saved && <p className="ai-admin-saved">{saved}</p>}
        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  );
}
