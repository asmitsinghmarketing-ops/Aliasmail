// The Nextspace mark: N and X joined by a light-blue sweep (vectors redrawn from the supplied
// artwork). It is wider than tall (1.9 : 1); `size` sets its width. public/favicon.svg is the
// same drawing.
import { useId } from 'react';

export default function Logo({ size = 48, className = 'brand-mark' }) {
  // useId() contains colons, which break url(#…) references in some browsers.
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={Math.round(size / 1.9)} viewBox="160 385 950 500" role="img" aria-label="Nextspace">
      <defs>
        <linearGradient id={`${id}-navy`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b3fa8" />
          <stop offset="1" stopColor="#062a73" />
        </linearGradient>
        <linearGradient id={`${id}-sky`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0050d0" />
          <stop offset="0.55" stopColor="#0a9bf2" />
          <stop offset="1" stopColor="#0068e8" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}-navy)`} d="M176 403H293C318 403 336 414 350 428L610 690L505 787L310 578V867H176Z" />
      <path fill={`url(#${id}-navy)`} d="M470 402H670L772 515L668 627Z" />
      <path fill={`url(#${id}-navy)`} d="M884 632L1092 867H888L785 746Z" />
      <path fill={`url(#${id}-sky)`} d="M352 867C470 850 560 790 640 705L898 402H1077L885 633L785 745C730 815 680 867 612 867Z" />
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
