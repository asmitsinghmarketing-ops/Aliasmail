// Settings card: which Nextspace app this is, its version, and a "Check for updates" button.
// Android and the web use the same checks as the automatic update banner (UpdateNotice); the
// Windows app checks itself and shows its own dialog.
import { useEffect, useState } from 'react';
import { installedNativeAppInfo, nativeCallsAvailable } from '../nativeCalls.js';
import Icon from './Icon.jsx';
import { CHECK_EVENT, RESULT_EVENT } from './UpdateNotice.jsx';

const RESULTS = {
  current: 'You’re up to date.',
  available: 'An update is available. Follow the update bar at the bottom of the screen.',
  busy: 'Already checking…',
  error: 'Couldn’t check for updates. Check your connection and try again.',
  dev: 'Updates are checked only in the installed app.',
};

function askForCheck() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { window.removeEventListener(RESULT_EVENT, onResult); resolve('error'); }, 30_000);
    function onResult(event) {
      clearTimeout(timer);
      window.removeEventListener(RESULT_EVENT, onResult);
      resolve(event.detail);
    }
    window.addEventListener(RESULT_EVENT, onResult);
    window.dispatchEvent(new Event(CHECK_EVENT));
  });
}

export default function AppUpdates() {
  const desktop = typeof window !== 'undefined' ? window.nextspaceDesktop : null;
  const android = nativeCallsAvailable();
  const [version, setVersion] = useState(desktop?.appVersion || null);
  const [state, setState] = useState({ checking: false, result: null });

  useEffect(() => {
    if (android) installedNativeAppInfo().then((info) => info?.versionName && setVersion(info.versionName)).catch(() => {});
  }, [android]);

  const kind = desktop?.isDesktop ? 'Windows app' : android ? 'Android app' : 'Web app';
  const icon = desktop?.isDesktop ? 'computer' : android ? 'phone' : 'apps';

  async function check() {
    setState({ checking: true, result: null });
    let result;
    try {
      // Desktop builds from 1.1 check the installer themselves; 1.0.0 builds fall back to the web check,
      // whose banner offers them the new installer.
      result = desktop?.checkForUpdates ? await desktop.checkForUpdates() : await askForCheck();
    } catch {
      result = 'error';
    }
    setState({ checking: false, result: result || 'current' });
  }

  return (
    <section className="sec-card app-updates-card">
      <div className="app-updates-head">
        <span className="sec-icon on"><Icon name={icon} size={20} /></span>
        <div>
          <h3>Nextspace {kind}</h3>
          <p className="muted small">{version ? `Version ${version}` : desktop?.isDesktop ? 'Version 1.0.0' : 'Always the latest version when you reload.'}</p>
        </div>
      </div>
      <div className="app-updates-actions">
        <button type="button" className="btn btn-outline" disabled={state.checking} onClick={check}>
          <Icon name="refresh" size={18} /> {state.checking ? 'Checking…' : 'Check for updates'}
        </button>
        {state.result && <span className={`small app-updates-result ${state.result}`} role="status">{RESULTS[state.result] || RESULTS.current}</span>}
      </div>
    </section>
  );
}
