// /install: the link to send people so they can install Nextspace. It works without signing in.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { askToInstall, canOfferInstall, detectDevice, justInstalled, watchInstall } from '../install.js';
import Icon from './Icon.jsx';
import { hideBoot } from './Loading.jsx';
import { Wordmark } from './Logo.jsx';

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function Steps({ items }) {
  return <ol className="install-steps">{items.map((item, i) => <li key={i}>{item}</li>)}</ol>;
}

function CopyLink() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      window.prompt('Copy this link:', window.location.href); // eslint-disable-line no-alert
    }
  };
  return <button type="button" className="btn btn-primary btn-block" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} /> {copied ? 'Link copied' : 'Copy link'}</button>;
}

/** Steps for when the browser can't show its own install question. */
function Manual({ device }) {
  if (device === 'ios') {
    return (
      <Steps items={[
        <>Tap the <strong>Share</strong> button at the bottom of Safari (the square with an arrow).</>,
        <>Scroll down and tap <strong>Add to Home Screen</strong>.</>,
        <>Tap <strong>Add</strong>. Nextspace appears on your Home Screen.</>,
      ]} />
    );
  }
  if (device === 'ios-in-app') {
    return (
      <>
        <p className="install-lead">This app’s built-in browser can’t install Nextspace. Open this page in Safari instead.</p>
        <Steps items={[<>Copy the link below.</>, <>Open <strong>Safari</strong> and paste it into the address bar.</>, <>Follow the steps shown there.</>]} />
        <CopyLink />
      </>
    );
  }
  if (device === 'android-in-app') {
    const url = `intent://${window.location.host}/install#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(window.location.href)};end`;
    return (
      <>
        <p className="install-lead">This app’s built-in browser can’t install Nextspace. Open this page in Chrome instead.</p>
        <a className="btn btn-primary btn-block" href={url}>Open in Chrome</a>
        <div className="install-alt"><CopyLink /></div>
      </>
    );
  }
  if (device === 'android') {
    return <Steps items={[<>Tap the <strong>⋮</strong> menu at the top right of Chrome.</>, <>Tap <strong>Add to Home screen</strong>, or <strong>Install app</strong>.</>, <>Tap <strong>Install</strong>.</>]} />;
  }
  if (device === 'desktop-safari') {
    return <Steps items={[<>In Safari’s menu bar, choose <strong>File</strong>.</>, <>Choose <strong>Add to Dock</strong>.</>, <>Click <strong>Add</strong>.</>]} />;
  }
  if (device === 'desktop-firefox') {
    return (
      <>
        <p className="install-lead">Firefox can’t install apps like this on a computer. Open this page in Chrome or Edge, or just use Nextspace here in Firefox.</p>
        <a className="btn btn-primary btn-block" href="/">Open Nextspace</a>
      </>
    );
  }
  return <Steps items={[<>Look at the right end of the address bar for the <strong>install</strong> icon.</>, <>Click it, then click <strong>Install</strong>.</>, <>Or open the browser’s <strong>⋮</strong> menu and look for <strong>Install Nextspace</strong>.</>]} />;
}

export default function InstallPage() {
  useEffect(() => { hideBoot(); }, []);
  const offered = useSyncExternalStore(watchInstall, canOfferInstall);
  const done = useSyncExternalStore(watchInstall, justInstalled);
  const [device] = useState(() => detectDevice(navigator.userAgent, { standalone: standalone(), touchPoints: navigator.maxTouchPoints }));
  // The browser's offer can take a moment to arrive; wait briefly before showing steps instead.
  const [waited, setWaited] = useState(false);
  const [declined, setDeclined] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  const install = async () => {
    const accepted = await askToInstall();
    if (!accepted) setDeclined(true);
  };

  const finished = device === 'installed' || done;
  const canAsk = ['android', 'desktop'].includes(device);

  return (
    <main className="install-page">
      <section className="install-card">
        <div className="install-brand"><img src="/favicon.svg" width="56" height="56" alt="" /><Wordmark /></div>
        {finished ? (
          <>
            <h1><Icon name="checkCircle" size={26} /> Nextspace is installed</h1>
            <p className="install-lead">Open it from your {device === 'installed' ? 'apps' : 'Home screen or apps'} any time.</p>
            <a className="btn btn-primary btn-block" href="/">Open Nextspace</a>
          </>
        ) : (
          <>
            <h1>Install Nextspace</h1>
            <p className="install-lead">Your team’s mail, tasks, notes and calls, in an app of its own.</p>
            {offered && canAsk ? (
              <button type="button" className="btn btn-primary btn-block install-button" onClick={install}><Icon name="download" size={20} /> Install</button>
            ) : canAsk && !waited && !declined ? (
              <button type="button" className="btn btn-primary btn-block install-button" disabled>Getting ready…</button>
            ) : (
              <Manual device={device} />
            )}
            {declined && <p className="install-note">Not installed. You can try again any time from this page.</p>}
            {!['ios-in-app', 'android-in-app', 'desktop-firefox'].includes(device) && <a className="install-skip" href="/">Continue in the browser instead</a>}
          </>
        )}
      </section>
      <p className="install-foot">You’ll need the sign-in details from your administrator.</p>
    </main>
  );
}
