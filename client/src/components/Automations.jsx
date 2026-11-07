// Automations: describe an idea, the AI model works out which functions to run, check the list in
// plain words, and run it. The list is saved, so it can be run again from here or the Assistant.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { PanelSkeleton, PeopleSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { ask } from './Dialog.jsx';

const FUNCTIONS = {
  create_task: { label: 'Create a task', icon: 'checkCircle' },
  send_note: { label: 'Send an instant note', icon: 'chat' },
  create_draft: { label: 'Write an email draft', icon: 'draft' },
  notify_user: { label: 'Notify a teammate', icon: 'bell' },
};

const EXAMPLES = [
  'When a new lead comes in, create a high-priority task and tell the sales team',
  'Write a welcome email draft to a new client and remind me to follow up',
  'Log a customer complaint as a task and notify the support lead',
];

const INPUT_FIELDS = {
  text: { label: 'Details', placeholder: 'What should this run be about?' },
  name: { label: 'Name', placeholder: 'Their name' },
  email: { label: 'Email', placeholder: 'name@example.com', type: 'email' },
};

const VARIABLE = /(\{\{\s*[\w.-]+\s*\}\})/g;

/** Which details have to be given at run time (the server checks this too). */
function inputsOf(steps) {
  const text = JSON.stringify(steps.map((step) => step.params));
  return Object.keys(INPUT_FIELDS).filter((key) => new RegExp(`\\{\\{\\s*input\\.${key}\\s*\\}\\}`).test(text));
}

function variableLabel(name) {
  const earlier = /^steps\.(\d+)\.(\w+)$/.exec(name);
  if (earlier) return `${{ id: 'link', title: 'title', subject: 'subject' }[earlier[2]] || earlier[2]} from step ${earlier[1]}`;
  return {
    'input.text': 'the details you enter', 'input.name': 'the name you enter', 'input.email': 'the email you enter',
    'actor.email': 'your email', 'automation.name': 'this automation’s name',
  }[name] || name;
}

/** A value from a step, with anything filled in later shown in words rather than {{code}}. */
function Filled({ value }) {
  return String(value).split(VARIABLE).map((part, i) => (
    i % 2 ? <mark key={i}>{variableLabel(part.replace(/[{}\s]/g, ''))}</mark> : part
  ));
}

/** What a step will do, in the words someone would use: names instead of ids. */
function stepDetails({ action, params = {} }, context) {
  const person = (value) => context.team?.find((p) => p.address === String(value).toLowerCase())?.name || value;
  const rows = {
    create_task: [
      ['Task', params.title],
      ['Project', context.projects?.find((p) => p.id === params.projectId)?.name || params.projectId],
      ['For', params.assignee && person(params.assignee)],
      ['Priority', params.priority && params.priority !== 'medium' && params.priority[0].toUpperCase() + params.priority.slice(1)],
      ['Due', params.dueDate],
      ['Notes', params.description],
    ],
    send_note: [['To', person(params.to)], ['Message', params.text]],
    create_draft: [['To', params.to], ['Cc', params.cc], ['Subject', params.subject], ['Message', params.body]],
    notify_user: [['To', person(params.to)], ['Title', params.title], ['Message', params.body]],
  }[action] || [];
  return rows.filter(([, value]) => value);
}

function StepList({ steps, context, statuses }) {
  return (
    <ol className="auto-steps">
      {steps.map((step, index) => {
        const status = statuses?.[index];
        const fn = FUNCTIONS[step.action];
        return (
          <li key={step.id || index} className={status || ''}>
            <span className="auto-step-mark">{status === 'completed' ? <Icon name="check" size={16} /> : status === 'failed' ? <Icon name="close" size={16} /> : index + 1}</span>
            <div>
              <span className="auto-step-function"><Icon name={fn?.icon || 'info'} size={15} /> {fn?.label || step.action}</span>
              <strong>{step.label}</strong>
              <dl>
                {stepDetails(step, context).map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd><Filled value={value} /></dd></div>
                ))}
              </dl>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function InputFields({ fields, values, onChange }) {
  if (!fields.length) return null;
  return (
    <div className="auto-inputs">
      {fields.map((key) => {
        const field = INPUT_FIELDS[key];
        return (
          <label key={key}>
            <span>{field.label}</span>
            {key === 'text'
              ? <textarea rows="3" value={values[key] || ''} placeholder={field.placeholder} maxLength="4000" onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
              : <input type={field.type || 'text'} value={values[key] || ''} placeholder={field.placeholder} maxLength="200" onChange={(event) => onChange({ ...values, [key]: event.target.value })} />}
          </label>
        );
      })}
    </div>
  );
}

const when = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const RUN_WORDS = { queued: 'Starting…', running: 'Running…', completed: 'Finished', failed: 'Stopped' };
const STEP_WORDS = { completed: 'Done', failed: 'Failed', skipped: 'Not run', running: 'Running…' };

function RunEntry({ run, open }) {
  const done = run.steps.filter((step) => step.status === 'completed').length;
  return (
    <details className={`auto-run ${run.status}`} open={open}>
      <summary>
        <span className="auto-run-state"><Icon name={run.status === 'completed' ? 'checkCircle' : run.status === 'failed' ? 'info' : 'refresh'} size={18} /></span>
        <span className="auto-run-title"><strong>{RUN_WORDS[run.status] || run.status}</strong><small>{when(run.createdAt)}</small></span>
        <b>{done} of {run.steps.length || '…'} done</b>
      </summary>
      <div>
        {run.status === 'failed' && done > 0 && <p className="auto-run-note">Steps marked Done really happened and weren’t undone.</p>}
        <ul>
          {run.steps.map((step) => (
            <li key={step.stepId} className={step.status}>
              <span>{step.label}</span>
              <em>{STEP_WORDS[step.status] || step.status}</em>
              {step.error && <small>{step.error}</small>}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export default function Automations({ onClose }) {
  const [data, setData] = useState({ automations: [], runs: [], context: { actions: [] }, aiEnabled: false });
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showList, setShowList] = useState(true); // Phones show the list or one automation, not both.
  const [idea, setIdea] = useState('');
  const [plan, setPlan] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const next = await api('/automations');
      setData(next);
      setSelectedId((current) => (next.automations.some((item) => item.id === current) ? current : next.automations[0]?.id || null));
      return next;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  useEffect(() => {
    load().then((next) => {
      setLoaded(true);
      // Nothing saved yet: go straight to making the first one.
      if (next && !next.automations.length) { setCreating(true); setShowList(false); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running = data.runs.some((run) => run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = data.automations.find((item) => item.id === selectedId) || null;
  const runs = useMemo(() => data.runs.filter((run) => run.automationId === selectedId), [data.runs, selectedId]);
  const latest = runs[0];
  const steps = creating ? plan?.steps || [] : selected?.steps || [];
  const fields = useMemo(() => inputsOf(steps), [steps]);
  const missing = fields.some((key) => !String(values[key] || '').trim());
  const onSelected = latest && latest.status !== 'queued' ? latest.steps.map((step) => step.status) : null;

  const startNew = () => {
    setCreating(true); setShowList(false); setPlan(null); setIdea(''); setValues({}); setError('');
  };

  const open = (id) => {
    setSelectedId(id); setCreating(false); setShowList(false); setValues({}); setError('');
  };

  const design = async () => {
    setBusy('design'); setError(''); setPlan(null); setValues({});
    try {
      setPlan(await api('/automations/plan', { method: 'POST', body: { prompt: idea } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const runSaved = (id) => api(`/automations/${id}/run`, { method: 'POST', body: { input: values } });

  const saveAnd = async (thenRun) => {
    setBusy(thenRun ? 'run' : 'save'); setError('');
    try {
      const saved = await api('/automations', { method: 'POST', body: { prompt: idea, plan } });
      if (thenRun) {
        try {
          await runSaved(saved.id);
        } catch (err) {
          setError(`Saved, but it couldn’t start: ${err.message}`);
        }
      }
      setCreating(false); setPlan(null); setIdea('');
      if (!thenRun) setValues({});
      setSelectedId(saved.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const runNow = async () => {
    setBusy('run'); setError('');
    try {
      await runSaved(selected.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!(await ask({ title: `Delete “${selected.name}”?`, message: 'This can’t be undone. What it already did, like tasks it created, stays.', confirmLabel: 'Delete', danger: true }))) return;
    setBusy('delete'); setError('');
    try {
      await api(`/automations/${selected.id}`, { method: 'DELETE' });
      setSelectedId(null);
      setShowList(true);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const backToList = data.automations.length > 0 && (
    <button type="button" className="auto-back" onClick={() => { setShowList(true); setCreating(false); setError(''); }}><Icon name="back" size={18} /> All automations</button>
  );

  return (
    <div className="automations-app">
      <header className="tasks-topbar">
        <button type="button" className="icon-btn tasks-back" onClick={onClose} title="Back to mailbox" aria-label="Back to mailbox"><Icon name="back" /></button>
        <button className="tasks-brand" type="button" onClick={onClose}><Logo /><Wordmark /></button>
        <span className="tasks-divider" /><strong>Automations</strong><span className="push-right" />
        <button type="button" className="btn btn-primary" onClick={startNew}><Icon name="add" size={18} /> New</button>
      </header>

      <div className={`automations-layout ${showList ? '' : 'detail'}`}>
        <aside className="automations-list">
          {!loaded ? <PeopleSkeleton rows={3} /> : data.automations.map((item) => {
            const last = data.runs.find((run) => run.automationId === item.id);
            return (
              <button type="button" key={item.id} className={!creating && item.id === selectedId ? 'active' : ''} onClick={() => open(item.id)}>
                <strong>{item.name}</strong>
                <small>{item.steps.length} step{item.steps.length === 1 ? '' : 's'}{last ? ` · last run ${when(last.createdAt)}` : ' · not run yet'}</small>
              </button>
            );
          })}
          {loaded && !data.automations.length && <p className="auto-list-empty">Automations you save appear here.</p>}
        </aside>

        <main className="automations-main">
          <div className="auto-column">
            {!showList && backToList}
            {error && <div className="alert"><span>{error}</span><button type="button" className="link" onClick={() => setError('')}>Dismiss</button></div>}

            {!loaded ? (
              <PanelSkeleton />
            ) : creating ? (
              <>
                <h1>What should happen?</h1>
                <p className="auto-lead">Describe it in your own words. AI works out the steps, and you check them before anything runs.</p>
                {!data.aiEnabled && <div className="alert"><span>AI isn’t set up yet. An administrator can add it in Admin console → Assistant.</span></div>}
                <textarea className="auto-idea" rows="4" autoFocus value={idea} maxLength="5000" placeholder="Example: when a new lead comes in, create a task in Sales and notify Amit" onChange={(event) => { setIdea(event.target.value); setPlan(null); }} />
                {!idea.trim() && (
                  <div className="auto-examples">
                    {EXAMPLES.map((example) => <button type="button" key={example} onClick={() => setIdea(example)}>{example}</button>)}
                  </div>
                )}
                {!plan && (
                  <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || !idea.trim() || !data.aiEnabled} onClick={design}>
                    <Icon name="sparkle" size={18} /> {busy === 'design' ? 'Working out the steps…' : 'Work out the steps'}
                  </button>
                )}
                {plan && (
                  <section className="auto-plan">
                    <h2>{plan.name}</h2>
                    {plan.description && <p className="auto-lead">{plan.description}</p>}
                    <StepList steps={plan.steps} context={data.context} />
                    <InputFields fields={fields} values={values} onChange={setValues} />
                    <div className="auto-actions">
                      <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || missing} onClick={() => saveAnd(true)}>
                        <Icon name="play" size={18} /> {busy === 'run' ? 'Starting…' : 'Run now'}
                      </button>
                      <button type="button" className="btn btn-outline" disabled={Boolean(busy)} onClick={() => saveAnd(false)}>{busy === 'save' ? 'Saving…' : 'Save for later'}</button>
                      <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={design}><Icon name="refresh" size={17} /> Try again</button>
                    </div>
                    <p className="auto-hint">Run now also saves it, so you can run it again.</p>
                  </section>
                )}
              </>
            ) : selected ? (
              <>
                <div className="auto-title">
                  <div>
                    <h1>{selected.name}</h1>
                    <p className="auto-lead">{selected.description || selected.prompt}</p>
                  </div>
                  <button type="button" className="icon-btn danger" disabled={Boolean(busy)} title="Delete" aria-label={`Delete ${selected.name}`} onClick={remove}><Icon name="trash" size={20} /></button>
                </div>
                <section className="auto-plan">
                  <StepList steps={selected.steps} context={data.context} statuses={onSelected} />
                  <InputFields fields={fields} values={values} onChange={setValues} />
                  <div className="auto-actions">
                    <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || running || missing} onClick={runNow}>
                      <Icon name="play" size={18} /> {busy === 'run' || running ? 'Running…' : runs.length ? 'Run again' : 'Run now'}
                    </button>
                  </div>
                </section>
                {runs.length > 0 && (
                  <section className="auto-history">
                    <h2>Runs</h2>
                    {runs.slice(0, 20).map((run, index) => <RunEntry key={run.id} run={run} open={index === 0} />)}
                  </section>
                )}
              </>
            ) : (
              <div className="auto-none">
                <p>Choose an automation, or make a new one.</p>
                <button type="button" className="btn btn-primary" onClick={startNew}><Icon name="add" size={18} /> New automation</button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
