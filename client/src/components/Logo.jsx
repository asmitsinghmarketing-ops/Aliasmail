// The Nextspace mark: an N whose last stroke rises towards a spark (what's next, and space).
// Drawn on a 40px grid with bold round strokes so it stays clear down to a 16px tab icon.
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
      <path d="M11.5 29V12.5L26 28V16" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 4l1.4 3.6L35 9l-3.6 1.4L30 14l-1.4-3.6L25 9l3.6-1.4z" fill="#fff" />
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
