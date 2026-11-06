// Swipe a mail row sideways to act on it, with one thumb. The row follows the finger directly
// (no re-render on each move), and `touch-action: pan-y` in the styles leaves up-and-down to the
// browser, so scrolling the list stays exactly as it was.
import { useRef } from 'react';

const LOCK_DISTANCE = 12; // How far the finger moves before we decide: swipe, or scroll?
const DRAWER_EDGE = 24; // A swipe from the very edge opens the menu instead (Mailbox).
const COMMIT_SHARE = 0.35; // How far across the row a swipe has to go to count.

export function useRowSwipe({ enabled, onSwipe }) {
  const swipe = useRef(null);
  const justSwiped = useRef(false);

  const settle = (row) => {
    row.classList.remove('swipe-left', 'swipe-right', 'swipe-ready');
    row.style.transform = '';
    row.style.transition = '';
  };

  const finish = () => {
    const current = swipe.current;
    swipe.current = null;
    if (!current?.locked) return;
    const { row, dx, id } = current;
    justSwiped.current = true;
    setTimeout(() => { justSwiped.current = false; }, 350);
    row.style.transition = 'transform 0.18s ease-out';
    if (Math.abs(dx) >= row.offsetWidth * COMMIT_SHARE) {
      row.style.transform = `translateX(${dx > 0 ? '100%' : '-100%'})`;
      setTimeout(() => Promise.resolve(onSwipe(id)).finally(() => settle(row)), 170);
    } else {
      row.style.transform = 'translateX(0)';
      setTimeout(() => settle(row), 190);
    }
  };

  return {
    onTouchStart(event) {
      swipe.current = null;
      if (!enabled || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const row = event.target.closest?.('.row[data-swipe-id]');
      if (!row || touch.clientX <= DRAWER_EDGE) return;
      swipe.current = { row, id: row.dataset.swipeId, x: touch.clientX, y: touch.clientY, dx: 0, locked: false };
    },
    onTouchMove(event) {
      const current = swipe.current;
      if (!current) return;
      if (event.touches.length !== 1) { swipe.current = null; return; }
      const touch = event.touches[0];
      const dx = touch.clientX - current.x;
      const dy = touch.clientY - current.y;
      if (!current.locked) {
        if (Math.abs(dy) >= LOCK_DISTANCE && Math.abs(dy) >= Math.abs(dx)) { swipe.current = null; return; }
        if (Math.abs(dx) < LOCK_DISTANCE) return;
        current.locked = true;
        // Without this the row's entrance animation would hold it in place.
        current.row.classList.add('swiped');
      }
      current.dx = dx;
      const { row } = current;
      row.classList.toggle('swipe-right', dx > 0);
      row.classList.toggle('swipe-left', dx < 0);
      row.classList.toggle('swipe-ready', Math.abs(dx) >= row.offsetWidth * COMMIT_SHARE);
      row.style.transform = `translateX(${dx}px)`;
    },
    onTouchEnd: finish,
    onTouchCancel() {
      const current = swipe.current;
      swipe.current = null;
      if (current?.locked) settle(current.row);
    },
    // The tap that ends a swipe must not also open the message.
    onClickCapture(event) {
      if (!justSwiped.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
