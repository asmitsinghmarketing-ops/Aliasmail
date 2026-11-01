// If something on the page breaks, say so (with a way back) instead of leaving a blank screen.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Nextspace page error:', error, info?.componentStack);
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
      </div>
    );
  }
}
