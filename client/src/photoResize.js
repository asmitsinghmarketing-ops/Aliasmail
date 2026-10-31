// Photos straight from a phone camera are often 3–8 MB. Like WhatsApp, attached photos go out
// resized (long side at most 2560 px, still sharp on any screen) unless the person asks for the
// original. That makes uploading and sending several times faster. Resizing also drops the
// photo's hidden details (EXIF), such as where it was taken.
const PHOTO_TYPES = new Set(['image/jpeg', 'image/webp']);
const WORTH_SHRINKING = 1.5 * 1024 * 1024;
const MAX_SIDE = 2560;
const QUALITY = 0.85;

export const canShrink = (file) => PHOTO_TYPES.has(file.type) && file.size > WORTH_SHRINKING;

/** A smaller copy of a large photo, or null when it isn't one (or wouldn't get much smaller). */
export async function shrinkPhoto(file) {
  if (!canShrink(file)) return null;
  let image;
  try {
    image = await createImageBitmap(file); // turns the photo the right way up (EXIF rotation)
  } catch {
    return null;
  }
  try {
    const ratio = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const width = Math.round(image.width * ratio);
    const height = Math.round(image.height * ratio);
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size > file.size * 0.7) return null;
    const name = file.name.replace(/\.(jpe?g|webp)$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    image.close?.();
  }
}
