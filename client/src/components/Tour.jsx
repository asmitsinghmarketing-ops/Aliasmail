// The guided tour on someone's first sign-in: it highlights each part of the real screen with a short
// explanation. It changes nothing and can be left at any step. A step whose part of the screen isn't
// there for this person (no shared mailboxes, say) is left out.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const GAP = 12;
const EDGE = 12;
const CARD_WIDTH = 340;

function stepsFor({ phone, isAdmin }) {
  const welcome = {
    title: 'Welcome to Nextspace',
    text: 'Here’s a quick look around, so you know where everything is. It takes about a minute, and you can skip it at any time.',
  };
  const done = {
    title: 'You’re all set',
    text: phone
      ? 'You can take this tour again from the menu. One more tip: add Nextspace to your Home Screen, so it opens like any other app.'
      : 'You can take this tour again any time with Tour in the left bar.',
    finish: true,
  };
  if (phone) {
    return [
      welcome,
      { target: '.mobile-menu-toggle', title: 'Your menu', text: 'Tap here, or swipe in from the left edge of the screen, to see all your folders and Settings. Swipe left to close it.' },
      { target: '.rows .row', title: 'Your mail', text: 'Tap a conversation to read it. Swipe it sideways to archive it, and you can undo that straight away. Tap the picture to select several.' },
      { target: '.search', title: 'Find anything', text: 'Search all your mail by name, subject or words in the message.' },
      { target: '.compose-fab', title: 'Write an email', text: 'Tap here to start a new message.' },
      { target: '[data-tour="nav-assistant"]', title: 'Assistant', text: 'Ask AI to find mail, summarise it or draft a reply. It checks with you before sending anything.' },
      { target: '[data-tour="nav-tasks"]', title: 'Tasks', text: 'Plan your team’s work: projects, who’s doing what, and when it’s due.' },
      { target: '[data-tour="nav-automations"]', title: 'Automations', text: 'Describe a job in your own words and AI works out the steps. It can run when you ask, or when an email arrives.' },
      { target: '[data-tour="nav-notes"]', title: 'Notes and calls', text: 'Message your team instantly, and start voice or video calls from any conversation.' },
      { target: '.notification-bell', title: 'Notifications', text: 'Tasks given to you, missed calls and other updates collect here.' },
      done,
    ];
  }
  return [
    welcome,
    { target: '.compose-btn', title: 'Write an email', text: 'Start a new message here. It opens in the corner, so you can keep reading your mail while you write.' },
    { target: '#mail-sidebar nav', title: 'Your folders', text: 'Everything is here: Inbox, Starred, Sent, Drafts and more. Labels you create appear underneath.' },
    { target: '.tabs', title: 'Your Inbox, sorted', text: 'Mail is sorted for you. Primary is mail from real people, and All shows everything together. Nextspace remembers the tab you were on.' },
    { target: '.rows .row', title: 'Your conversations', text: 'Click one to read it. Tick the box to select several, and star the ones that matter. You can also give a conversation an owner, so your team knows who’s handling it.' },
    { target: '.search', title: 'Find anything', text: 'Search all your mail by name, subject or words in the message.' },
    { target: '.rail-mailboxes', onlyIf: () => document.querySelectorAll('.rail-box').length > 1, title: 'Shared mailboxes', text: 'Your own mailbox is at the top. Below it are shared mailboxes you can open, such as your team’s. Click one to switch.' },
    { target: '[data-tour="tasks"]', title: 'Tasks', text: 'Plan your team’s work: projects, who’s doing what, and when it’s due.' },
    { target: '[data-tour="automations"]', title: 'Automations', text: 'Describe a job in your own words and AI works out the steps. It can run when you ask, or when an email arrives.' },
    { target: '[data-tour="assistant"]', title: 'Assistant', text: 'Ask AI to find mail, summarise it or draft a reply. It checks with you before sending anything.' },
    { target: '[data-tour="notes"]', title: 'Notes and calls', text: 'Message your team instantly, and start voice or video calls from any conversation. A red number means you have unread notes.' },
    { target: '[data-tour="meet"]', title: 'Meetings', text: 'Set up a Google Meet and invite people.' },
    { target: '.notification-bell', title: 'Notifications', text: 'Tasks given to you, missed calls and other updates collect here.' },
    ...(isAdmin ? [{ target: '[data-tour="admin"]', title: 'Admin console', text: 'As the administrator, this is where you add people, set up shared mailboxes and roles, and see how mail is running.' }] : []),
    { target: '[data-tour="settings"]', title: 'Settings', text: 'Your name, photo and signature, plus notifications and two-step sign-in. It’s worth turning on notifications, so you don’t miss mail or calls.' },
    done,
  ];
}

const isShown = (element) => {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
};

/** Where the card goes: beside the highlighted part if there's room, otherwise above or below it. */
function cardPosition(box, cardHeight) {
  const width = Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2);
  const center = { left: (window.innerWidth - width) / 2, top: Math.max(EDGE, (window.innerHeight - cardHeight) / 2), width };
  if (!box) return center;
  const clampTop = (top) => Math.min(Math.max(EDGE, top), window.innerHeight - cardHeight - EDGE);
  const clampLeft = (left) => Math.min(Math.max(EDGE, left), window.innerWidth - width - EDGE);
  const room = { right: window.innerWidth - box.right, left: box.left, below: window.innerHeight - box.bottom, above: box.top };
  if (room.below >= cardHeight + GAP + EDGE) return { left: clampLeft(box.left), top: box.bottom + GAP, width };
  if (room.right >= width + GAP + EDGE) return { left: box.right + GAP, top: clampTop(box.top), width };
  if (room.above >= cardHeight + GAP + EDGE) return { left: clampLeft(box.left), top: box.top - cardHeight - GAP, width };
  if (room.left >= width + GAP + EDGE) return { left: box.left - width - GAP, top: clampTop(box.top), width };
  return center;
}

export default function Tour({ phone, isAdmin, onClose }) {
  // Worked out once at the start, so the count doesn't change part way through.
  const steps = useMemo(() => stepsFor({ phone, isAdmin }).filter((step) => {
    if (step.onlyIf && !step.onlyIf()) return false;
    return !step.target || isShown(document.querySelector(step.target));
  }), [phone, isAdmin]);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState(null);
  const [cardHeight, setCardHeight] = useState(220);
  const card = useRef(null);
  const next = useRef(null);
  const step = steps[index];

  // Keep the highlight on its target, even if the window changes size or the page moves.
  useLayoutEffect(() => {
    const target = step?.target ? document.querySelector(step.target) : null;
    target?.scrollIntoView({ block: 'nearest' });
    const measure = () => {
      const rect = target?.getBoundingClientRect();
      setBox(rect ? { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null);
      if (card.current) setCardHeight(card.current.offsetHeight);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  useEffect(() => { next.current?.focus({ preventScroll: true }); }, [index]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, steps.length - 1));
      else if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
      else return;
      // The mailbox has keyboard shortcuts of its own, which mustn't act while this is open.
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, steps.length]);

  if (!step) return null;
  const position = cardPosition(box, cardHeight);
  const last = index === steps.length - 1;

  return (
    // Nothing behind it can be clicked, and the swipe that opens the phone menu is kept out too.
    <div className="tour" onTouchStart={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}>
      <div
        className={`tour-spot ${box ? '' : 'none'}`}
        style={box ? { top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 } : undefined}
      />
      <section ref={card} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" style={position}>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-text">{step.text}</p>
        <div className="tour-progress" role="img" aria-label={`Step ${index + 1} of ${steps.length}`}>
          <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="tour-actions">
          <span className="tour-count">{index + 1} of {steps.length}</span>
          {!last && <button type="button" className="tour-skip" onClick={onClose}>Skip</button>}
          {index > 0 && <button type="button" className="btn btn-outline" onClick={() => setIndex(index - 1)}>Back</button>}
          <button ref={next} type="button" className="btn btn-primary" onClick={() => (last ? onClose() : setIndex(index + 1))}>
            {last ? 'Get started' : index === 0 ? 'Show me' : 'Next'}
          </button>
        </div>
      </section>
    </div>
  );
}
