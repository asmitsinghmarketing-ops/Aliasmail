// If something on the page breaks, say so (with a way back) instead of leaving a blank screen,
// and send the details to the server's log so the cause can be found.
import React from 'react';
import { hideBoot } from './Loading.jsx';

// After a new version goes live, a page left open asks for code files that no longer exist. Loading
// the page again fixes that, so do it once without troubling anyone.
const RELOAD_KEY = 'nextspace-reloaded-for-update';
function reloadForNewVersion(error) {
  if (!/dynamically imported module|importing a module script failed|error loading dynamically/i.test(String(error?.message))) return false;
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) || 0) < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

const firstLines = (text, n) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join('\n');

export default class ErrorBoundary extends React.Component {
  state = { error: null, where: '' };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    hideBoot();
    if (reloadForNewVersion(error)) return;
    console.error('Nextspace page error:', error, info?.componentStack);
    const where = firstLines(info?.componentStack, 4);
    this.setState({ where });
    // Into the host's runtime logs ([client-error]): no message content, just where it broke.
    fetch('/api/client-error', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AliasMail' },
      body: JSON.stringify({
        message: String(error?.message || error).slice(0, 300),
        stack: firstLines(error?.stack, 8).slice(0, 2000),
        components: where.slice(0, 1000),
        page: window.location.pathname,
        browser: navigator.userAgent.slice(0, 200),
      }),
    }).catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong on this page</h1>
        <p className="muted">Reload to carry on. Nothing you sent has been lost.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <code>{String(this.state.error?.message || this.state.error).slice(0, 300)}</code>
        {(this.state.where || this.state.error?.stack) && (
          <pre className="crash-details">{firstLines(this.state.error?.stack, 3)}{this.state.where && `\n${this.state.where}`}</pre>
        )}
      </div>
    );
  }
}
