// The AliasMail mark: one envelope fanning out into several (one mailbox, many addresses), sealed
// with an @. public/favicon.svg is the same drawing; change both together.
import { useId } from 'react';

export default function Logo({ size = 38, className = 'brand-mark' }) {
  // useId() contains colons, which break url(#…) references in some browsers.
  const id = useId().replace(/:/g, '');
  const url = (name) => `url(#${id}-${name})`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="AliasMail">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f76707" />
          <stop offset="0.55" stopColor="#d6336c" />
          <stop offset="1" stopColor="#7048e8" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-ink`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8590c" />
          <stop offset="1" stopColor="#c2255c" />
        </linearGradient>
      </defs>

      {/* Tile with a soft top highlight */}
      <rect width="48" height="48" rx="12" fill={url('bg')} />
      <path d="M0 12A12 12 0 0 1 12 0h24a12 12 0 0 1 12 12v5C33 23 15 23 0 17z" fill={url('shine')} />

      {/* Alias envelopes fanning out behind the mailbox */}
      <rect x="11" y="15" width="24" height="17" rx="3" fill="#fff" opacity="0.3" transform="rotate(-16 24 26)" />
      <rect x="11.5" y="15.5" width="24" height="17" rx="3" fill="#fff" opacity="0.55" transform="rotate(-7 24 26)" />

      {/* The mailbox */}
      <rect x="11" y="17" width="26" height="18" rx="3" fill="#fff" />
      <path d="M13 33.5l7.6-6.4M35 33.5l-7.6-6.4" stroke="#f3d9e1" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 19.5l11 8 11-8" fill="none" stroke={url('ink')} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />

      {/* @ seal */}
      <circle cx="35.5" cy="34.5" r="7.5" fill={url('ink')} stroke="#fff" strokeWidth="2" />
      <circle cx="35.5" cy="34.5" r="2.1" fill="none" stroke="#fff" strokeWidth="1.5" />
      <path
        d="M37.6 34.5v.9a1.3 1.3 0 0 0 2.6 0v-.9a4.7 4.7 0 1 0-1.9 3.8"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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
