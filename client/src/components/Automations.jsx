// Automations: describe an idea, the AI model works out which functions to run, check the list in
// plain words, and run it. The list is saved, so it can be run again from here or the Assistant.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { PanelSkeleton, PeopleSkeleton } from './Loading.jsx';
import Logo, { Wordmark } from './Logo.jsx';
import { ask } from './Dialog.jsx';

const EXAMPLES = [
  'Every weekday at 9:00, summarise my unread emails and notify me',
  'When an email arrives, sort it as Urgent or Normal with AI, and if it’s urgent star it and tell me',
  'When an email with invoice in the subject arrives, create a task and add the Clients label',
  'Write a first email to a new client whose address I give, for me to check and send',
];

const INPUT_FIELDS = {
  text: { label: 'Details', placeholder: 'What should this run be about?' },
  name: { label: 'Name', placeholder: 'Their name' },
  email: { label: 'Email', placeholder: 'name@example.com', type: 'email' },
  kind: { label: 'Type of email' },
};

const VARIABLE = /(\{\{\s*[\w.-]+\s*\}\})/g;
const variablesIn = (value) => [...String(value).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(([, name]) => name);

/** What has to be given when someone runs it themselves (the server checks this too). */
function inputsOf(steps, screen = {}) {
  const required = new Set();
  const optional = new Set();
  for (const step of steps) {
    for (const [name, value] of Object.entries(step.params || {})) {
      for (const v of variablesIn(value)) {
        if (!v.startsWith('input.')) continue;
        (screen[step.action]?.fields?.[name]?.optional ? optional : required).add(v.slice(6));
      }
    }
  }
  return Object.keys(INPUT_FIELDS).filter((key) => required.has(key) || optional.has(key)).map((key) => ({ key, optional: !required.has(key) }));
}

function variableLabel(name) {
  const earlier = /^steps\.(\d+)\.(\w+)$/.exec(name);
  if (earlier) {
    const n = earlier[1];
    return { ids: `the emails found in step ${n}`, id: `what step ${n} found or made`, count: `how many step ${n} found`, text: `the text from step ${n}`, value: `the answer from step ${n}`, title: `the title from step ${n}`, subject: `the subject from step ${n}` }[earlier[2]] || `step ${n}`;
  }
  return {
    'input.text': 'the details you enter', 'input.name': 'the name you enter', 'input.email': 'the email you enter', 'input.kind': 'the type you choose',
    'actor.email': 'your email', 'automation.name': 'this automation’s name',
    'email.id': 'the email that arrived', 'email.from': 'the sender’s address', 'email.fromName': 'the sender’s name', 'email.subject': 'the email’s subject', 'email.snippet': 'the start of the email',
  }[name] || name;
}

/** A value from a step, with anything filled in later shown in words rather than {{code}}. */
function Filled({ value }) {
  return String(value).split(VARIABLE).map((part, i) => (
    i % 2 ? <mark key={i}>{variableLabel(part.replace(/[{}\s]/g, ''))}</mark> : part
  ));
}

/** What a step will do, in the words someone would use: names instead of ids, labels instead of codes. */
function stepDetails({ action, params = {} }, context) {
  const fields = context.screen?.[action]?.fields || {};
  const person = (value) => context.team?.find((p) => p.address === String(value).toLowerCase())?.name || value;
  const shown = (field, value) => {
    if (!value) return '';
    if (/\{\{/.test(value) && field.kind !== 'choice') return value;
    if (field.kind === 'choice') return field.options?.find((option) => option.value === value)?.label || value;
    if (field.kind === 'teammate') return person(value);
    if (field.kind === 'project') return context.projects?.find((p) => p.id === value)?.name || value;
    if (field.kind === 'group') return context.groups?.find((g) => g.id === value)?.name || value;
    if (field.kind === 'date') return value === 'today' ? 'The day it runs' : /^\+\d+$/.test(value) ? `${value.slice(1)} days after it runs` : value;
    return value;
  };
  return Object.entries(fields).map(([name, field]) => [field.label, shown(field, params[name])]).filter(([, value]) => value);
}

const isAutomatic = (item) => ['email_received', 'schedule'].includes(item?.trigger?.type);
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function scheduleWords(trigger) {
  if (trigger.every === 'hour') return `Every hour, at ${trigger.time.slice(3)} minutes past`;
  const at = ` at ${trigger.time}`;
  return { day: `Every day${at}`, weekday: `Every weekday (Monday to Friday)${at}`, week: `Every ${DAY_NAMES[trigger.day] || trigger.day}${at}` }[trigger.every] || at;
}

/** When it runs, as the first line of the list. */
function TriggerLine({ trigger }) {
  const type = trigger?.type || 'manual';
  const conditions = type === 'email_received' ? [
    trigger.fromContains && <>from <mark>{trigger.fromContains}</mark></>,
    trigger.subjectContains && <>with <mark>{trigger.subjectContains}</mark> in the subject</>,
  ].filter(Boolean) : [];
  return (
    <div className="auto-trigger">
      <span className="auto-step-mark"><Icon name={type === 'email_received' ? 'mail' : type === 'schedule' ? 'clock' : 'play'} size={16} /></span>
      <div>
        <span className="auto-step-function">When</span>
        <strong>{type === 'email_received' ? 'An email arrives' : type === 'schedule' ? 'On a schedule' : 'You run it'}</strong>
        {conditions.length > 0 && <span className="auto-trigger-if">{conditions.map((condition, i) => <span key={i}>{i > 0 && ' and '}{condition}</span>)}</span>}
        {type === 'email_received' && !conditions.length && <span className="auto-trigger-if">Any email to you</span>}
        {type === 'email_received' && <small>Promotional and social mail, and your own mail, don’t count.</small>}
        {type === 'schedule' && <span className="auto-trigger-if">{scheduleWords(trigger)}{trigger.timeZone ? ` (${trigger.timeZone.replace('_', ' ')} time)` : ''}</span>}
      </div>
    </div>
  );
}

function StepList({ steps, context, statuses }) {
  return (
    <ol className="auto-steps">
      {steps.map((step, index) => {
        const status = statuses?.[index];
        const fn = context.screen?.[step.action];
        return (
          <li key={step.id || index} className={status || ''}>
            <span className="auto-step-mark">{status === 'completed' ? <Icon name="check" size={16} /> : status === 'failed' ? <Icon name="close" size={16} /> : index + 1}</span>
            <div>
              <span className="auto-step-function"><Icon name={fn?.icon || 'info'} size={15} /> {fn?.label || step.action}{fn?.ai && <em className="auto-ai-note">uses AI each run</em>}</span>
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

function InputFields({ fields, values, onChange, kinds }) {
  if (!fields.length) return null;
  const set = (key, value) => onChange({ ...values, [key]: value });
  return (
    <div className="auto-inputs">
      {fields.map(({ key, optional }) => {
        const field = INPUT_FIELDS[key];
        return (
          <label key={key}>
            <span>{field.label}{optional && <small> (optional)</small>}</span>
            {key === 'kind' ? (
              <select value={values.kind || ''} onChange={(event) => set('kind', event.target.value)}>
                <option value="" disabled>Choose…</option>
                {kinds.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : key === 'text'
              ? <textarea rows="3" value={values[key] || ''} placeholder={optional ? 'Anything to mention' : field.placeholder} maxLength="4000" onChange={(event) => set(key, event.target.value)} />
              : <input type={field.type || 'text'} value={values[key] || ''} placeholder={field.placeholder} maxLength="200" onChange={(event) => set(key, event.target.value)} />}
          </label>
        );
      })}
    </div>
  );
}

/** Everything automations can do, grouped: what the AI picks from. */
function FunctionGuide({ screen }) {
  const groups = {};
  for (const fn of Object.values(screen || {})) (groups[fn.group] ||= []).push(fn);
  if (!Object.keys(groups).length) return null;
  return (
    <details className="auto-guide">
      <summary>What can automations do?</summary>
      <p>Describe any mix of these. They can start when you run them, when an email arrives, or on a schedule, such as every weekday at 9:00. Emails they prepare wait in Work items, where you send each one with one click.</p>
      {Object.entries(groups).map(([group, list]) => (
        <div key={group}>
          <h3>{group}</h3>
          <ul>{list.map((fn) => <li key={fn.label}><Icon name={fn.icon} size={16} /> {fn.label}{fn.ai && <small> · uses AI</small>}</li>)}</ul>
        </div>
      ))}
    </details>
  );
}

const when = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const RUN_WORDS = { queued: 'Starting…', running: 'Running…', completed: 'Finished', failed: 'Stopped' };
const runWords = (run) => (run.stopped ? 'Stopped at a condition' : RUN_WORDS[run.status] || run.status);
const STEP_WORDS = { completed: 'Done', failed: 'Failed', skipped: 'Not run', running: 'Running…' };

function RunEntry({ run, open }) {
  const done = run.steps.filter((step) => step.status === 'completed').length;
  return (
    <details className={`auto-run ${run.status}`} open={open}>
      <summary>
        <span className="auto-run-state"><Icon name={run.status === 'completed' ? 'checkCircle' : run.status === 'failed' ? 'info' : 'refresh'} size={18} /></span>
        <span className="auto-run-title"><strong>{runWords(run)}</strong><small>{when(run.createdAt)}{run.trigger?.type === 'email' ? ` · ${run.trigger.fromName}: ${run.trigger.subject || '(no subject)'}` : run.trigger?.type === 'schedule' ? ' · on schedule' : ''}</small></span>
        <b>{done} of {run.steps.length || '…'} done</b>
      </summary>
      <div>
        {run.status === 'failed' && done > 0 && <p className="auto-run-note">Steps marked Done really happened and weren’t undone.</p>}
        <ul>
          {run.steps.map((step) => (
            <li key={step.stepId} className={step.status}>
              <span>{step.label}</span>
              <em>{STEP_WORDS[step.status] || step.status}</em>
              {step.note && <small className="auto-run-stopped">{step.note}</small>}
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
  const watching = !creating && isAutomatic(data.automations.find((item) => item.id === selectedId)) && data.automations.find((item) => item.id === selectedId)?.enabled;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  // It can start at any moment, so keep its list of runs up to date while it's on screen.
  useEffect(() => {
    if (!watching) return undefined;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [watching]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = data.automations.find((item) => item.id === selectedId) || null;
  const runs = useMemo(() => data.runs.filter((run) => run.automationId === selectedId), [data.runs, selectedId]);
  const latest = runs[0];
  const steps = creating ? plan?.steps || [] : selected?.steps || [];
  const fields = useMemo(() => inputsOf(steps, data.context.screen), [steps, data.context.screen]);
  const missing = fields.some(({ key, optional }) => !optional && !String(values[key] || '').trim());
  const kinds = data.context.screen?.write_email?.fields?.kind?.options || [];
  // Ticks show how the last run went; for one that runs itself, that's what the Runs list is for.
  const onSelected = latest && latest.status !== 'queued' && !isAutomatic(selected) ? latest.steps.map((step) => step.status) : null;

  const startNew = () => {
    setCreating(true); setShowList(false); setPlan(null); setIdea(''); setValues({}); setError('');
  };

  const open = (id) => {
    setSelectedId(id); setCreating(false); setShowList(false); setValues({}); setError('');
  };

  const design = async () => {
    setBusy('design'); setError(''); setPlan(null); setValues({});
    try {
      const planned = await api('/automations/plan', { method: 'POST', body: { prompt: idea } });
      // A schedule keeps this computer's clock, shown and saved the same.
      setPlan(planned.trigger?.type === 'schedule' ? { ...planned, trigger: { ...planned.trigger, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } } : planned);
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
      const withClock = plan.trigger?.type === 'schedule' ? { ...plan, trigger: { ...plan.trigger, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } } : plan;
      const saved = await api('/automations', { method: 'POST', body: { prompt: idea, plan: withClock, enabled: thenRun } });
      if (thenRun && !isAutomatic(plan)) {
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

  const setOn = async (enabled) => {
    setBusy('switch'); setError('');
    try {
      await api(`/automations/${selected.id}`, { method: 'PATCH', body: { enabled } });
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
                <small>{isAutomatic(item) ? (item.enabled ? 'On · ' : 'Off · ') : ''}{item.steps.length} step{item.steps.length === 1 ? '' : 's'}{last ? ` · last run ${when(last.createdAt)}` : ' · not run yet'}</small>
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
                <FunctionGuide screen={data.context.screen} />
                {!plan && (
                  <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || !idea.trim() || !data.aiEnabled} onClick={design}>
                    <Icon name="sparkle" size={18} /> {busy === 'design' ? 'Working out the steps…' : 'Work out the steps'}
                  </button>
                )}
                {plan && (
                  <section className="auto-plan">
                    <h2>{plan.name}</h2>
                    {plan.description && <p className="auto-lead">{plan.description}</p>}
                    <TriggerLine trigger={plan.trigger} />
                    <StepList steps={plan.steps} context={data.context} />
                    <InputFields fields={fields} values={values} onChange={setValues} kinds={kinds} />
                    <div className="auto-actions">
                      <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || missing} onClick={() => saveAnd(true)}>
                        <Icon name={isAutomatic(plan) ? 'check' : 'play'} size={18} /> {busy === 'run' ? 'Starting…' : isAutomatic(plan) ? 'Turn on' : 'Run now'}
                      </button>
                      <button type="button" className="btn btn-outline" disabled={Boolean(busy)} onClick={() => saveAnd(false)}>{busy === 'save' ? 'Saving…' : isAutomatic(plan) ? 'Save, leave off' : 'Save for later'}</button>
                      <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={design}><Icon name="refresh" size={17} /> Try again</button>
                    </div>
                    <p className="auto-hint">{plan.trigger?.type === 'schedule' ? 'Once on, these steps run by themselves on that schedule, without asking.' : isAutomatic(plan) ? 'Once on, these steps run by themselves each time a matching email arrives, without asking.' : 'Run now also saves it, so you can run it again.'}</p>
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
                  <TriggerLine trigger={selected.trigger} />
                  <StepList steps={selected.steps} context={data.context} statuses={onSelected} />
                  {isAutomatic(selected) ? (
                    <>
                    <div className={`auto-switch ${selected.enabled ? 'on' : ''}`}>
                      <span><strong>{selected.enabled ? 'On' : 'Off'}</strong><small>{!selected.enabled ? 'Nothing runs until you turn it on.' : selected.trigger?.type === 'schedule' ? 'Runs by itself on its schedule.' : 'Runs by itself when a matching email arrives.'}</small></span>
                      <button type="button" className={`btn ${selected.enabled ? 'btn-outline' : 'btn-primary'}`} disabled={Boolean(busy)} onClick={() => setOn(!selected.enabled)}>{selected.enabled ? 'Turn off' : 'Turn on'}</button>
                    </div>
                    {selected.trigger?.type === 'schedule' && (
                      <div className="auto-actions">
                        <button type="button" className="btn btn-outline" disabled={Boolean(busy) || running} onClick={runNow}><Icon name="play" size={18} /> {busy === 'run' || running ? 'Running…' : 'Run it now to try it'}</button>
                      </div>
                    )}
                    </>
                  ) : (
                    <>
                      <InputFields fields={fields} values={values} onChange={setValues} kinds={kinds} />
                      <div className="auto-actions">
                        <button type="button" className="btn btn-primary auto-main-button" disabled={Boolean(busy) || running || missing} onClick={runNow}>
                          <Icon name="play" size={18} /> {busy === 'run' || running ? 'Running…' : runs.length ? 'Run again' : 'Run now'}
                        </button>
                      </div>
                    </>
                  )}
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
