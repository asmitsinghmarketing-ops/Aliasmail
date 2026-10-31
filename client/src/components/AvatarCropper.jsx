// Position a new profile picture before it is saved, like WhatsApp: drag the photo inside the
// round frame, zoom with the slider, the mouse wheel or two fingers, then Done.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const MAX_ZOOM = 4;
const OUTPUT = 512; // pixels per side of the saved picture

export default function AvatarCropper({ file, onCancel, onDone }) {
  const frame = useRef(null);
  const [src, setSrc] = useState('');
  const [natural, setNatural] = useState(null); // { w, h } of the photo
  const [box, setBox] = useState(300); // frame size on screen
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const image = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const measure = () => setBox(Math.round(frame.current?.getBoundingClientRect().width || 300));
    measure();
    window.addEventListener('resize', measure);
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  // At zoom 1 the photo just covers the frame; zooming in shows less of it.
  const scale = natural ? (box / Math.min(natural.w, natural.h)) * zoom : 1;
  const shown = natural ? { w: natural.w * scale, h: natural.h * scale } : { w: box, h: box };

  // The photo always covers the whole frame: no empty edges.
  const clamp = (o, s = shown) => ({
    x: Math.min(Math.max(o.x, (box - s.w) / 2), (s.w - box) / 2),
    y: Math.min(Math.max(o.y, (box - s.h) / 2), (s.h - box) / 2),
  });

  function setZoomKeeping(next) {
    const z = Math.min(Math.max(next, 1), MAX_ZOOM);
    if (!natural) return setZoom(z);
    const ratio = z / zoom;
    const s = { w: shown.w * ratio, h: shown.h * ratio };
    setZoom(z);
    setOffset((o) => clamp({ x: o.x * ratio, y: o.y * ratio }, s));
  }

  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = pointers.current.size === 2
      ? { pinch: distance(), zoom }
      : { x: e.clientX, y: e.clientY, offset };
  }

  function onPointerMove(e) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size === 2 && g.pinch) setZoomKeeping((g.zoom * distance()) / g.pinch);
    else if (pointers.current.size === 1 && g.offset) setOffset(clamp({ x: g.offset.x + e.clientX - g.x, y: g.offset.y + e.clientY - g.y }));
  }

  function onPointerUp(e) {
    pointers.current.delete(e.pointerId);
    const [rest] = pointers.current.values();
    gesture.current = rest ? { x: rest.x, y: rest.y, offset } : null;
  }

  async function done() {
    setBusy(true);
    try {
      // The frame's square, in the photo's own pixels.
      const side = box / scale;
      const left = natural.w / 2 - (box / 2 + offset.x) / scale;
      const top = natural.h / 2 - (box / 2 + offset.y) / scale;
      const size = Math.min(OUTPUT, Math.round(side)) || OUTPUT;
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent PNGs get a white background
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.current, left, top, side, side, 0, 0, size, size);
      await onDone(canvas.toDataURL('image/jpeg', 0.9));
    } catch (err) {
      setError(err.message || 'Couldn’t save the picture');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onCancel}>
      <div className="modal cropper" role="dialog" aria-label="Position your profile picture" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Position your photo</h2>
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Cancel" disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        <div
          ref={frame}
          className="cropper-frame"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => setZoomKeeping(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
        >
          {src && (
            <img
              ref={image}
              src={src}
              alt=""
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setError('This image format can’t be read here — try a JPG or PNG')}
              style={{ width: shown.w, height: shown.h, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }}
            />
          )}
          <span className="cropper-ring" aria-hidden="true" />
        </div>
        <p className="muted small cropper-hint">Drag to move · scroll or pinch to zoom</p>
        <label className="cropper-zoom">
          <Icon name="image" size={16} />
          <input type="range" min="1" max={MAX_ZOOM} step="0.01" value={zoom} aria-label="Zoom" onChange={(e) => setZoomKeeping(Number(e.target.value))} />
          <Icon name="image" size={24} />
        </label>
        {error && <div className="alert">{error}</div>}
        <div className="cropper-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={done} disabled={busy || !natural}>{busy ? 'Saving…' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}
