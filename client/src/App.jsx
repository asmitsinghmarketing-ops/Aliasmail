import { useEffect, useState } from 'react';
import { api, LOGOUT_EVENT, MAILBOX_REVOKED_EVENT, setActiveMailbox, signOut } from './api.js';
import Login from './components/Login.jsx';
import Mailbox from './components/Mailbox.jsx';
import Admin from './components/Admin.jsx';
import { DialogHost } from './components/Dialog.jsx';
import UpdateNotice from './components/UpdateNotice.jsx';

const OWNER_COLOR = '#e8590c';

export default function App() {
  return (
    <>
      <Screen />
      <DialogHost />
      <UpdateNotice />
    </>
  );
}

function Screen() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [adminView, setAdminView] = useState('mail'); // admin only: 'mail' | 'console'
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

  const logout = async () => {
    switchMailbox(null);
    await signOut();
    setUser(null);
  };

  if (checking) return <div className="splash">Loading…</div>;
  if (!user) {
    return (
      <Login
        onLogin={({ user }) => {
          switchMailbox(null);
          setUser(user);
          setAdminView('mail');
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
  if (user.role === 'admin' && (adminView === 'console' || !user.mailbox)) {
    return (
      <Admin
        user={user}
        onLogout={logout}
        onRolesChanged={refreshAccount}
        onOpenMail={user.mailbox ? () => setAdminView('mail') : null}
      />
    );
  }

  const sharedBox = shared ? user.mailboxes?.find((m) => m.address === shared) : null;
  const view = sharedBox ? { ...own, email: sharedBox.address, displayName: sharedBox.displayName, color: sharedBox.color, avatarUrl: sharedBox.avatarUrl } : own;
  return (
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
    />
  );
}
