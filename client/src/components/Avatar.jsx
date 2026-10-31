import { useState } from 'react';
import { colorFor, initial } from '../format.js';

/** Profile picture, or a coloured initial when there is none (or it fails to load). */
export default function Avatar({ url, person, color, size = '', className = '' }) {
  const [broken, setBroken] = useState(null);
  const classes = `avatar ${size} ${className}`;
  if (url && broken !== url) return <img className={`${classes} avatar-img`} src={url} alt="" onError={() => setBroken(url)} />;
  return (
    <span className={classes} style={{ background: color || colorFor(person?.address) }}>
      {initial(person)}
    </span>
  );
}

/** Whether a picked file can be used as a profile picture; throws a readable reason if not. */
export function checkImageFile(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP)');
  if (file.size > 20 * 1024 * 1024) throw new Error('That image is larger than 20 MB');
}
