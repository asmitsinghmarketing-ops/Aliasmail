// The AliasMail mark: a mailbox with a second address behind it (one mailbox, many aliases).
// Drawn on a 40px grid with straight edges and bold strokes so it stays sharp at small sizes;
// shown at 40px, every edge lands on a whole pixel. public/favicon.svg is the same drawing.
import { useId } from 'react';

export default function Logo({ size = 40, className = 'brand-mark' }) {
  // useId() contains colons, which break url(#…) references in some browsers.
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="AliasMail">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f76707" />
          <stop offset="0.55" stopColor="#d6336c" />
          <stop offset="1" stopColor="#7048e8" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill={`url(#${id}-bg)`} />
      <rect x="14" y="8" width="20" height="15" rx="3" fill="#fff" fillOpacity="0.45" />
      <rect x="6" y="14" width="24" height="18" rx="3" fill="#fff" />
      <path d="M9.5 18 18 24.5 26.5 18" fill="none" stroke="#d6336c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "AliasMail" with "Mail" in the brand gradient. */
export function Wordmark() {
  return (
    <span className="wordmark">
      Alias<span className="wordmark-accent">Mail</span>
    </span>
  );
}
