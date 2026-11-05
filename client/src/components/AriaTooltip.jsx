import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const TARGETS = 'button[aria-label], [role="button"][aria-label], label[aria-label]';
const HOVER_DELAY = 350;
const EDGE = 8;

// A single floating tooltip keeps icon controls readable without adding a component around
// every button. aria-label remains the accessible name; this is only its visual counterpart.
export default function AriaTooltip() {
  const [tip, setTip] = useState(null);
  const [position, setPosition] = useState(null);
  const bubble = useRef(null);
  const active = useRef(null);
  const timer = useRef(null);
  const pointerFocus = useRef(false);
  const savedTitle = useRef(new WeakMap());

  const restoreTitle = (target) => {
    if (!target || !savedTitle.current.has(target)) return;
    target.setAttribute('title', savedTitle.current.get(target));
    savedTitle.current.delete(target);
  };

  const hide = (target = active.current) => {
    window.clearTimeout(timer.current);
    restoreTitle(target);
    if (active.current === target) active.current = null;
    setTip(null);
    setPosition(null);
  };

  const show = (target, delayed) => {
    const label = target?.getAttribute('aria-label')?.trim();
    if (!label || target.disabled) return;
    window.clearTimeout(timer.current);
    if (active.current && active.current !== target) restoreTitle(active.current);
    active.current = target;
    if (target.hasAttribute('title') && !savedTitle.current.has(target)) {
      savedTitle.current.set(target, target.getAttribute('title'));
      target.removeAttribute('title');
    }
    const open = () => {
      if (active.current !== target || !target.isConnected) return;
      setPosition(null);
      setTip({ label, rect: target.getBoundingClientRect() });
    };
    if (delayed) timer.current = window.setTimeout(open, HOVER_DELAY);
    else open();
  };

  useEffect(() => {
    const targetOf = (event) => event.target instanceof Element ? event.target.closest(TARGETS) : null;
    const over = (event) => {
      if (event.pointerType === 'touch') return;
      const target = targetOf(event);
      if (!target || target.contains(event.relatedTarget)) return;
      show(target, true);
    };
    const out = (event) => {
      const target = targetOf(event);
      if (!target || target.contains(event.relatedTarget)) return;
      if (document.activeElement !== target) hide(target);
    };
    const focus = (event) => {
      if (pointerFocus.current) return;
      const target = targetOf(event);
      if (target) show(target, false);
    };
    const blur = (event) => {
      const target = targetOf(event);
      if (target) hide(target);
    };
    const dismiss = () => {
      pointerFocus.current = true;
      window.setTimeout(() => { pointerFocus.current = false; }, 0);
      hide();
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.clearTimeout(timer.current);
      restoreTitle(active.current);
      active.current = null;
    };
  }, []); // Event delegation also covers controls rendered later.

  useLayoutEffect(() => {
    if (!tip || !bubble.current) return;
    const box = bubble.current.getBoundingClientRect();
    const above = tip.rect.top >= box.height + EDGE * 2;
    const left = Math.min(
      window.innerWidth - box.width - EDGE,
      Math.max(EDGE, tip.rect.left + tip.rect.width / 2 - box.width / 2),
    );
    const top = above ? tip.rect.top - box.height - EDGE : tip.rect.bottom + EDGE;
    const arrow = Math.min(box.width - 10, Math.max(10, tip.rect.left + tip.rect.width / 2 - left));
    setPosition({ left, top, arrow, placement: above ? 'top' : 'bottom' });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={bubble}
      className={`aria-tooltip ${position ? 'ready' : ''}`}
      data-placement={position?.placement}
      style={position ? { left: position.left, top: position.top, '--tooltip-arrow': `${position.arrow}px` } : undefined}
      role="tooltip"
      aria-hidden="true"
    >
      {tip.label}
    </div>
  );
}
