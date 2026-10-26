import { useEffect, useState } from 'react';

const hosts = new Set();

/**
 * In-app replacement for confirm() and prompt(). Resolves true/false, or with `input` set,
 * the entered text (null when cancelled).
 * ask({ title, message, confirmLabel, cancelLabel, danger, input: { label, value, placeholder } })
 */
export function ask(options) {
  return new Promise((resolve) => {
    if (!hosts.size) return resolve(options.input ? null : false);
    for (const show of hosts) show({ ...options, resolve });
  });
}

/** Mounted once at the top of the app; shows one dialog at a time. */
export function DialogHost() {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const show = (options) => {
      setValue(options.input?.value || '');
      setDialog(options);
    };
    hosts.add(show);
    return () => hosts.delete(show);
  }, []);

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!dialog) return null;
  const { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger, input } = dialog;

  function finish(ok) {
    dialog.resolve(input ? (ok ? value.trim() : null) : ok);
    setDialog(null);
  }

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={() => finish(false)}>
      <form
        className="modal dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <h2 id="dialog-title">{title}</h2>
        {message && <p className="dialog-text">{message}</p>}
        {input && (
          <input
            type="text"
            aria-label={input.label || title}
            placeholder={input.placeholder}
            maxLength={input.maxLength}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => finish(false)}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} autoFocus={!input} disabled={Boolean(input) && !value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
