// Login codes that arrived in the last 15 minutes, above the inbox: "Claude · 482 913 [Copy]".
// Most useful in a shared mailbox like access@, where only people with the role see the codes.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { timeAgo } from '../format.js';
import Icon from './Icon.jsx';

// 482913 → "482 913", easier to read out and type.
const spaced = (code) => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

export default function LoginCodes({ reloadKey, onOpen }) {
  const [codes, setCodes] = useState([]);
  const [copied, setCopied] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [, tick] = useState(0);

  useEffect(() => {
    let current = true;
    api('/mail/login-codes')
      .then((data) => current && setCodes(data.items))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [reloadKey]);

  // Codes drop off on their own once they're too old to use.
  useEffect(() => {
    if (!codes.length) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [codes.length]);

  const shown = codes.filter((c) => !hidden.has(c.id) && Date.parse(c.expiresAt) > Date.now());
  if (!shown.length) return null;

  async function copy(item) {
    try {
      await navigator.clipboard.writeText(item.code);
      setCopied(item.id);
      setTimeout(() => setCopied((id) => (id === item.id ? null : id)), 2000);
    } catch {
      onOpen(item);
    }
  }

  return (
    <div className="login-codes" aria-label="Recent login codes">
      {shown.map((item) => (
        <div key={item.id} className="login-code">
          <span className="login-code-icon" aria-hidden="true">
            <Icon name="key" size={20} />
          </span>
          <button type="button" className="login-code-text" title={item.subject} onClick={() => onOpen(item)}>
            <span className="login-code-service">{item.service} login code</span>
            <span className="muted small"> · {timeAgo(item.date)}</span>
          </button>
          <code className="login-code-value">{spaced(item.code)}</code>
          <button type="button" className="btn btn-outline login-code-copy" onClick={() => copy(item)}>
            <Icon name={copied === item.id ? 'check' : 'copy'} size={16} /> {copied === item.id ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="icon-btn" title="Hide" aria-label={`Hide ${item.service} code`} onClick={() => setHidden((h) => new Set(h).add(item.id))}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
