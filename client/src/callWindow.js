// Google Meet blocks being embedded in another site's iframe. Open it in a compact,
// reusable browser window instead, so AliasMail remains visible during the call.
const WIDTH = 480;
const HEIGHT = 680;
const WINDOW_NAME = 'aliasmail-team-call';

function features() {
  const screenLeft = window.screen.availLeft ?? 0;
  const screenTop = window.screen.availTop ?? 0;
  const screenWidth = window.screen.availWidth || window.innerWidth;
  const screenHeight = window.screen.availHeight || window.innerHeight;
  const width = Math.min(WIDTH, Math.max(360, screenWidth - 32));
  const height = Math.min(HEIGHT, Math.max(520, screenHeight - 32));
  const left = Math.max(screenLeft, screenLeft + screenWidth - width - 16);
  const top = Math.max(screenTop, screenTop + 16);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}

/** Open synchronously from the click, before any API request, so popup blockers allow it. */
export function openCallWindow() {
  const callWindow = window.open('', WINDOW_NAME, features());
  if (!callWindow) return null;

  try {
    callWindow.document.title = 'Starting AliasMail call…';
    callWindow.document.body.textContent = 'Creating your secure Google Meet call…';
    Object.assign(callWindow.document.body.style, {
      alignItems: 'center',
      background: '#f7f9fc',
      color: '#26334d',
      display: 'flex',
      font: '600 15px system-ui, sans-serif',
      justifyContent: 'center',
      margin: '0',
      minHeight: '100vh',
      padding: '24px',
      textAlign: 'center',
    });
  } catch {
    // A reused window may already be on Meet's origin; it can still be navigated below.
  }
  callWindow.focus();
  return callWindow;
}

export function joinCall(callWindow, link) {
  if (!callWindow) {
    window.open(link, '_blank', 'noopener,noreferrer');
    return;
  }
  callWindow.opener = null;
  callWindow.location.replace(link);
  callWindow.focus();
}
