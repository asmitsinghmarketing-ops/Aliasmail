import { Suspense, useEffect, useState } from 'react';
import { api, LOGOUT_EVENT, MAILBOX_REVOKED_EVENT, setActiveMailbox, signOut } from './api.js';
import Login from './components/Login.jsx';
import { hideBoot, lazyPage, ShellSkeleton, whenIdle } from './components/Loading.jsx';
import { isInstallPage } from './install.js';
import { DialogHost } from './components/Dialog.jsx';
import UpdateNotice from './components/UpdateNotice.jsx';
import AriaTooltip from './components/AriaTooltip.jsx';
import { startAttendanceHeartbeat } from './attendance.js';

const Mailbox = lazyPage(() => import('./components/Mailbox.jsx'));
const Admin = lazyPage(() => import('./components/Admin.jsx'));
const Tasks = lazyPage(() => import('./components/Tasks.jsx'));
const CallCenter = lazyPage(() => import('./components/CallCenter.jsx'));
const Automations = lazyPage(() => import('./components/Automations.jsx'));
const Attendance = lazyPage(() => import('./components/Attendance.jsx'));
const Recordings = lazyPage(() => import('./components/Recordings.jsx'));
const JoinMeeting = lazyPage(() => import('./components/JoinMeeting.jsx'));
const InstallPage = lazyPage(() => import('./components/InstallPage.jsx'));

// A meeting link: /join/abc-defg-hij
const joinCodeOf = () => /^\/join\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i.exec(window.location.pathname)?.[1]?.toLowerCase() || null;

// Start on the mailbox's code straight away, while the sign-in check runs, so one doesn't wait for
// the other. The sign-in page doesn't depend on it and shows as soon as the check answers.
if (!isInstallPage()) Mailbox.preload();

const OWNER_COLOR = '#e8590c';

export default function App() {
  const [joinCode, setJoinCode] = useState(joinCodeOf);
  if (isInstallPage()) return <Suspense fallback={null}><InstallPage /></Suspense>;
  // A teammate who joined from the link carries on in the app, with the call on screen.
  if (joinCode) {
    return (
      <>
        <Suspense fallback={null}>
          <JoinMeeting code={joinCode} onJoinedAsMember={() => { window.history.replaceState(null, '', '/'); setJoinCode(null); }} />
        </Suspense>
        <DialogHost />
      </>
    );
  }
  return (
    <>
      <Screen />
      <DialogHost />
      <UpdateNotice />
      <AriaTooltip />
    </>
  );
}

function Screen() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [adminView, setAdminView] = useState('mail'); // admin only: 'mail' | 'console'
  const [workspace, setWorkspace] = useState(() => new URLSearchParams(window.location.search).has('task') ? 'tasks' : 'mail'); // mail | tasks | automations | attendance
  const [taskToOpen, setTaskToOpen] = useState(() => new URLSearchParams(window.location.search).get('task'));
  const [shared, setShared] = useState(null); // address of an open group mailbox, or null

  const switchMailbox = (address) => {
    setActiveMailbox(address);
    setShared(address);
  };
  // Roles can change while someone is signed in; refresh the list of switchable mailboxes.
  const refreshAccount = () => api('/auth/me').then((me) => setUser((u) => (u ? { ...u, mailboxes: me.mailboxes } : u))).catch(() => {});

  useEffect(() => {
    const onLogout = () => {
      setUser(null);
      setShared(null);
      setWorkspace('mail');
    };
    const onRevoked = () => {
      switchMailbox(null);
      refreshAccount();
    };
    window.addEventListener(LOGOUT_EVENT, onLogout);
    window.addEventListener(MAILBOX_REVOKED_EVENT, onRevoked);
    // The session cookie (if any) decides whether we're signed in.
    api('/auth/me', { signInFlow: true })
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return () => {
      window.removeEventListener(LOGOUT_EVENT, onLogout);
      window.removeEventListener(MAILBOX_REVOKED_EVENT, onRevoked);
    };
  }, []);

  useEffect(() => {
    const onOpen = (event) => {
      if (event.data?.type !== 'open') return;
      const id = new URL(event.data.url, window.location.origin).searchParams.get('task');
      if (id) { setTaskToOpen(id); setWorkspace('tasks'); }
    };
    navigator.serviceWorker?.addEventListener('message', onOpen);
    return () => navigator.serviceWorker?.removeEventListener('message', onOpen);
  }, []);

  // The logo screen stays up until the sign-in check has answered.
  useEffect(() => {
    if (!checking) hideBoot();
  }, [checking]);

  // Once signed in, fetch the other screens in the background so switching to them is instant.
  const signedIn = Boolean(user);
  const isAdmin = user?.role === 'admin';
  useEffect(() => {
    if (!signedIn) return undefined;
    return whenIdle(() => {
      Tasks.preload();
      Automations.preload();
      Attendance.preload();
      Recordings.preload();
      if (isAdmin) Admin.preload();
    });
  }, [signedIn, isAdmin]);

  // Once clocked in, presence continues across Mail, Tasks, Automations and other workspaces.
  useEffect(() => (signedIn ? startAttendanceHeartbeat() : undefined), [signedIn]);

  const logout = async () => {
    switchMailbox(null);
    await signOut();
    setUser(null);
    setWorkspace('mail');
  };

  if (checking) return null;
  if (!user) {
    return (
      <Login
        onLogin={({ user }) => {
          switchMailbox(null);
          setUser(user);
          setAdminView('mail');
          setWorkspace('mail');
        }}
      />
    );
  }

  const own =
    user.role === 'admin'
      ? { ...user, email: user.mailbox, color: OWNER_COLOR }
      : user;
  const onUserChange =
    user.role === 'admin' ? (u) => setUser({ ...user, displayName: u.displayName, avatarUrl: u.avatarUrl }) : (u) => setUser({ ...user, ...u });

  // The admin is the owner of the main mailbox address: a full mailbox, plus the console.
  const sharedBox = shared ? user.mailboxes?.find((m) => m.address === shared) : null;
  const view = sharedBox ? { ...own, email: sharedBox.address, displayName: sharedBox.displayName, color: sharedBox.color, avatarUrl: sharedBox.avatarUrl } : own;
  const inConsole = user.role === 'admin' && (adminView === 'console' || !user.mailbox);
  return (
    <>
    <Suspense fallback={<ShellSkeleton plain={inConsole || workspace !== 'mail'} />}>
      {inConsole ? (
        <Admin
            user={user}
            onLogout={logout}
            onRolesChanged={refreshAccount}
            onOpenMail={user.mailbox ? () => setAdminView('mail') : null}
          />
      ) : workspace === 'tasks' ? (
        <Tasks user={user} startTask={taskToOpen} onClose={() => { setTaskToOpen(null); setWorkspace('mail'); }} />
      ) : workspace === 'automations' ? (
        <Automations onClose={() => setWorkspace('mail')} />
      ) : workspace === 'attendance' ? (
        <Attendance user={user} onClose={() => setWorkspace('mail')} />
      ) : workspace === 'recordings' ? (
        <Recordings me={user.role === 'admin' ? user.mailbox : user.email} onClose={() => setWorkspace('mail')} />
      ) : (
        <Mailbox
            key={sharedBox ? `shared:${sharedBox.address}` : 'own'}
            user={view}
            account={own}
            mailboxes={user.mailboxes || []}
            shared={sharedBox}
            onSwitchMailbox={switchMailbox}
            onRefreshMailboxes={refreshAccount}
            onLogout={logout}
            onUserChange={onUserChange}
            onOpenAdmin={user.role === 'admin' ? () => setAdminView('console') : undefined}
            onOpenTasks={() => setWorkspace('tasks')}
            onOpenAutomations={() => setWorkspace('automations')}
            onOpenAttendance={() => setWorkspace('attendance')}
            onOpenRecordings={() => setWorkspace('recordings')}
          />
      )}
    </Suspense>
    <Suspense fallback={null}><CallCenter /></Suspense>
    </>
  );
}
