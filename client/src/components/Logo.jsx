// The Nextspace mark: the NX monogram in bold round strokes on the brand gradient.
// Drawn on a 40px grid so the two letters stay distinct down to a 16px tab icon.
// public/favicon.svg is the same drawing.
import { useId } from 'react';

export default function Logo({ size = 40, className = 'brand-mark' }) {
  // useId() contains colons, which break url(#…) references in some browsers.
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="Nextspace">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f76707" />
          <stop offset="0.55" stopColor="#d6336c" />
          <stop offset="1" stopColor="#7048e8" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill={`url(#${id}-bg)`} />
      <path d="M8 28V12l11 16V12" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23.5 12l9 16M32.5 12l-9 16" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "Nextspace" with "space" in the brand gradient. */
export function Wordmark() {
  return (
    <span className="wordmark">
      Next<span className="wordmark-accent">space</span>
    </span>
  );
}
