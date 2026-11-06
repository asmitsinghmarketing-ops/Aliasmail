// Everything the app shows while something loads, so waiting looks the same everywhere: the shape
// of what is coming (not the word "Loading"), and nothing at all when it arrives quickly.
import { lazy } from 'react';
import Icon from './Icon.jsx';
import Logo, { Wordmark } from './Logo.jsx';

/** A lazily loaded screen that can also be fetched ahead of time with `.preload()`. */
export function lazyPage(load) {
  let pending = null;
  const get = () => (pending ??= load().catch((err) => { pending = null; throw err; }));
  const Page = lazy(get);
  Page.preload = () => get().catch(() => {}); // A failed preload is tried again when it is opened.
  return Page;
}

/** Run once the browser has nothing better to do; skipped for people saving data. Returns a cancel. */
export function whenIdle(fn) {
  if (navigator.connection?.saveData) return () => {};
  if (window.requestIdleCallback) {
    const id = window.requestIdleCallback(fn, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1500);
  return () => clearTimeout(id);
}

/** Fade out the logo screen from index.html, once there is something to show under it. */
export function hideBoot() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 220);
}

const Bone = ({ className = '', style }) => <span className={`skeleton ${className}`} style={style} />;

const Busy = ({ className = '', children }) => (
  <div className={`skeleton-group ${className}`} role="status" aria-label="Loading">{children}</div>
);

// Line lengths that read like text, repeated for as many lines as asked for.
const LINE_WIDTHS = ['100%', '92%', '97%', '64%', '88%', '76%'];

/** Lines of text: a message body, or a small section of settings. */
export function TextSkeleton({ lines = 3 }) {
  return (
    <Busy className="sk-text">
      {Array.from({ length: lines }, (_, i) => <Bone key={i} style={{ width: LINE_WIDTHS[i % LINE_WIDTHS.length] }} />)}
    </Busy>
  );
}

const ROW_WIDTHS = [[62, 48, 58], [78, 66, 92], [54, 40, 74], [70, 58, 84], [46, 52, 66]];

/** The mail list: same columns as real rows, so nothing jumps when they arrive. */
export function MailListSkeleton({ rows = 10, immediate = false }) {
  return (
    <Busy className={immediate ? 'no-delay' : ''}>
      {Array.from({ length: rows }, (_, i) => {
        const [from, subject, snippet] = ROW_WIDTHS[i % ROW_WIDTHS.length];
        return (
          <div className="sk-row" key={i}>
            <Bone className="sk-box sk-hide-phone" />
            <Bone className="sk-box sk-hide-phone" />
            <Bone className="sk-circle" />
            <span className="sk-stack sk-hide-phone"><Bone style={{ width: `${from}%` }} /><Bone className="thin" style={{ width: `${from - 18}%` }} /></span>
            <span className="sk-stack"><Bone style={{ width: `${subject}%` }} /><Bone className="thin" style={{ width: `${snippet}%` }} /></span>
            <span className="sk-hide-phone" />
            <span className="sk-owner sk-hide-phone"><Bone className="sk-circle small" /><Bone style={{ width: '60%' }} /></span>
            <Bone className="sk-date" />
          </div>
        );
      })}
    </Busy>
  );
}

/** A list of people or items: a circle and two lines each. */
export function PeopleSkeleton({ rows = 5 }) {
  return (
    <Busy className="sk-people">
      {Array.from({ length: rows }, (_, i) => {
        const [name, , detail] = ROW_WIDTHS[i % ROW_WIDTHS.length];
        return (
          <div className="sk-person" key={i}>
            <Bone className="sk-circle" />
            <span className="sk-stack"><Bone style={{ width: `${name}%` }} /><Bone className="thin" style={{ width: `${detail}%` }} /></span>
          </div>
        );
      })}
    </Busy>
  );
}

/** A full page of content: a heading, some tiles, and a table. */
export function PanelSkeleton({ immediate = false }) {
  return (
    <Busy className={`sk-panel ${immediate ? 'no-delay' : ''}`}>
      <Bone className="sk-heading" />
      <div className="sk-tiles"><Bone /><Bone /><Bone /></div>
      <div className="sk-table">
        {LINE_WIDTHS.map((width, i) => <Bone key={i} style={{ width }} />)}
      </div>
    </Busy>
  );
}

/** A panel that opens over the page while its code arrives (only ever seen on a slow connection). */
export function OpeningPill() {
  return <div className="opening-pill" role="status"><Icon name="refresh" size={16} /> Opening…</div>;
}

/** The app itself, before its code has arrived. `plain`: a page without the mailbox's rail and folders. */
export function ShellSkeleton({ plain = false }) {
  return (
    <div className={`app skeleton-shell ${plain ? '' : 'has-rail'}`}>
      {!plain && (
        <nav className="rail" aria-hidden="true">
          <Logo inverse size={46} className="rail-logo" />
          <span className="rail-divider" />
          <Bone className="rail-box" />
        </nav>
      )}
      <header className="topbar" aria-hidden="true">
        <div className="brand"><Logo /><span className="brand-text"><Wordmark /></span></div>
        {!plain && <Bone className="search" />}
        <span className="account"><Bone className="sk-circle" /></span>
      </header>
      <div className="layout">
        {!plain && (
          <aside className="sidebar" aria-hidden="true">
            <Bone className="sk-compose" />
            {[70, 52, 60, 64, 44, 58, 66].map((width) => (
              <span className="sk-nav" key={width}><Bone className="sk-box" /><Bone style={{ width: `${width}%` }} /></span>
            ))}
          </aside>
        )}
        <main className={`content ${plain ? 'padded' : ''}`}>
          {plain ? <PanelSkeleton immediate /> : <MailListSkeleton immediate />}
        </main>
      </div>
    </div>
  );
}
