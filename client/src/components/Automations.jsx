import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { ask } from './Dialog.jsx';

const ACTION_LABELS = {
  create_task: 'Create task',
  send_note: 'Send instant note',
  create_draft: 'Create email draft',
  notify_user: 'Notify teammate',
};

const dateTime = (value) => value ? new Date(value).toLocaleString() : '';

export default function Automations({ onClose }) {
  const [data, setData] = useState({ automations: [], runs: [], context: { actions: [] }, aiEnabled: false });
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState(null);
  const [runInput, setRunInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const next = await api('/automations');
      setData(next);
      setSelectedId((current) => current && next.automations.some((item) => item.id === current) ? current : next.automations[0]?.id || null);
    } catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!data.runs.some((run) => run.status === 'queued' || run.status === 'running')) return undefined;
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [data.runs]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = data.automations.find((item) => item.id === selectedId) || null;
  const runs = useMemo(() => data.runs.filter((run) => run.automationId === selectedId), [data.runs, selectedId]);

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setError(''); setPlan(null);
    try { setPlan(await api('/automations/plan', { method: 'POST', body: { prompt } })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const savePlan = async () => {
    setBusy(true); setError('');
    try {
      const saved = await api('/automations', { method: 'POST', body: { prompt, plan } });
      await load();
      setSelectedId(saved.id); setCreating(false); setPrompt(''); setPlan(null);
      setNotice('Automation saved as a draft. Review it, then activate it.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const toggle = async () => {
    setBusy(true); setError('');
    try {
      const updated = await api(`/automations/${selected.id}`, { method: 'PATCH', body: { enabled: !selected.enabled } });
      setData((current) => ({ ...current, automations: current.automations.map((item) => item.id === updated.id ? updated : item) }));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setError('');
    try {
      await api(`/automations/${selected.id}/run`, { method: 'POST', body: { input: { text: runInput } } });
      setRunInput(''); setNotice('Automation queued. Its progress appears below.'); await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!(await ask({ title: `Delete “${selected.name}”?`, message: 'Its previous run history will remain, but the automation cannot be used again.', confirmLabel: 'Delete automation', danger: true }))) return;
    setBusy(true);
    try { await api(`/automations/${selected.id}`, { method: 'DELETE' }); setSelectedId(null); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="automations-app">
      <header className="tasks-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose}><Logo /><Wordmark /></button>
        <span className="tasks-divider" /><strong>Automations</strong><span className="push-right" />
        <button type="button" className="btn btn-primary" onClick={() => { setCreating(true); setPlan(null); setPrompt(''); setError(''); }}><Icon name="sparkle" size={18} /> Create with AI</button>
      </header>

      <div className="automations-layout">
        <aside className="automations-list">
          <div className="automation-list-head"><span>Your workflows</span><b>{data.automations.length}</b></div>
          {data.automations.map((item) => (
            <button key={item.id} className={item.id === selectedId ? 'active' : ''} onClick={() => { setSelectedId(item.id); setCreating(false); setError(''); }}>
              <span className={`automation-dot ${item.enabled ? 'on' : ''}`} /><span><strong>{item.name}</strong><small>{item.enabled ? 'Active' : 'Draft'} · {item.steps.length} step{item.steps.length === 1 ? '' : 's'}</small></span>
            </button>
          ))}
          {!data.automations.length && <div className="automation-list-empty"><Icon name="scheduleSend" size={28} /><p>No automations yet.</p></div>}
        </aside>

        <main className="automations-main">
          {error && <div className="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
          {notice && <div className="alert ok"><span>{notice}</span><button className="link" onClick={() => setNotice('')}>Dismiss</button></div>}

          {creating ? (
            <section className="automation-builder">
              <div className="automation-hero-icon"><Icon name="sparkle" size={26} /></div>
              <span className="eyebrow">AI workflow builder</span><h1>What should AliasMail automate?</h1>
              <p>Describe the result in plain language. AI can choose only approved AliasMail functions; it cannot create or execute code.</p>
              <textarea rows="6" autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Example: Create a high-priority task in the Sales project and notify amit@example.com with the information I provide when I run it." maxLength="5000" />
              <div className="automation-builder-actions"><button className="btn btn-ghost" onClick={() => { setCreating(false); setPlan(null); }}>Cancel</button><button className="btn btn-primary" disabled={busy || !prompt.trim()} onClick={generate}><Icon name="sparkle" size={17} /> {busy ? 'Designing…' : plan ? 'Generate again' : 'Design automation'}</button></div>
              {plan && <Plan plan={plan} />}
              {plan && <div className="automation-save"><div><strong>Ready to save?</strong><span>It will remain inactive until you turn it on.</span></div><button className="btn btn-primary" disabled={busy} onClick={savePlan}>Save automation</button></div>}
            </section>
          ) : selected ? (
            <section className="automation-detail">
              <header><div><span className="eyebrow">Manual trigger</span><h1>{selected.name}</h1><p>{selected.description || selected.prompt}</p></div><span className={`automation-status ${selected.enabled ? 'active' : ''}`}>{selected.enabled ? 'Active' : 'Draft'}</span></header>
              <div className="automation-controls"><button className={`btn ${selected.enabled ? 'btn-outline' : 'btn-primary'}`} disabled={busy} onClick={toggle}>{selected.enabled ? 'Pause automation' : 'Activate automation'}</button><button className="btn btn-ghost automation-delete" disabled={busy} onClick={remove}><Icon name="trash" size={17} /> Delete</button></div>
              <Plan plan={selected} compact />
              <section className="automation-run-box"><div><h2>Run now</h2><p>Information entered here is available to steps as <code>{'{{input.text}}'}</code>.</p></div><textarea rows="3" value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder="Optional information for this run…" /><button className="btn btn-primary" disabled={busy || !selected.enabled} onClick={run}><Icon name="scheduleSend" size={17} /> Run automation</button>{!selected.enabled && <small>Activate the automation before running it.</small>}</section>
              <section className="automation-history"><h2>Run history</h2>{runs.length ? runs.map((item) => <Run key={item.id} run={item} />) : <p className="muted">This automation has not run yet.</p>}</section>
            </section>
          ) : (
            <div className="automations-empty"><span><Icon name="scheduleSend" size={38} /></span><h1>Build repeatable workflows</h1><p>Describe a process once, review the AI-generated steps, and run it from here or through the Assistant.</p><button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="sparkle" size={18} /> Create your first automation</button></div>
          )}
        </main>
      </div>
    </div>
  );
}

function Plan({ plan, compact = false }) {
  return <div className={`automation-plan ${compact ? 'compact' : ''}`}><div className="automation-plan-head"><div><span className="eyebrow">Workflow plan</span><h2>{plan.name}</h2>{plan.description && <p>{plan.description}</p>}</div><span>{plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}</span></div><ol>{plan.steps.map((step, index) => <li key={step.id || `${step.action}-${index}`}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{ACTION_LABELS[step.action] || step.action}</small>{!compact && <dl>{Object.entries(step.params || {}).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}</div></li>)}</ol></div>;
}

function Run({ run }) {
  return <details className={`automation-run ${run.status}`}><summary><span className="automation-run-state"><Icon name={run.status === 'completed' ? 'checkCircle' : run.status === 'failed' ? 'info' : 'refresh'} size={18} /></span><span><strong>{run.status[0].toUpperCase() + run.status.slice(1)}</strong><small>{dateTime(run.createdAt)}</small></span><b>{run.steps.filter((step) => step.status === 'completed').length}/{Math.max(run.steps.length, 1)}</b></summary><div>{run.error && <p className="automation-run-error">{run.error}</p>}{run.steps.map((step) => <p key={step.stepId}><Icon name={step.status === 'completed' ? 'check' : step.status === 'failed' ? 'close' : 'refresh'} size={15} /> {step.label}{step.error && <small>{step.error}</small>}</p>)}</div></details>;
}
