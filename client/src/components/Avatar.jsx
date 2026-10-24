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

/** Center-crop an image file to a square and shrink it, returning a JPEG data URL. */
export async function squareImage(file, size = 256) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP)');
  if (file.size > 20 * 1024 * 1024) throw new Error('That image is larger than 20 MB');

  let image;
  try {
    image = await createImageBitmap(file); // applies the photo's EXIF rotation
  } catch {
    throw new Error('This image format can’t be read here — try a JPG or PNG');
  }
  const side = Math.min(image.width, image.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
  image.close?.();
  return canvas.toDataURL('image/jpeg', 0.9);
}
