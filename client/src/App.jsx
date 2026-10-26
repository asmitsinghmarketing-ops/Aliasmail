import { useEffect, useState } from 'react';
import { api, LOGOUT_EVENT, signOut } from './api.js';
import Login from './components/Login.jsx';
import Mailbox from './components/Mailbox.jsx';
import Admin from './components/Admin.jsx';
import { DialogHost } from './components/Dialog.jsx';

const OWNER_COLOR = '#e8590c';

export default function App() {
  return (
    <>
      <Screen />
      <DialogHost />
    </>
  );
}

function Screen() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [adminView, setAdminView] = useState('mail'); // admin only: 'mail' | 'console'

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener(LOGOUT_EVENT, onLogout);
    // The session cookie (if any) decides whether we're signed in.
    api('/auth/me', { signInFlow: true })
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, []);

  const logout = async () => {
    await signOut();
    setUser(null);
  };

  if (checking) return <div className="splash">Loading…</div>;
  if (!user) {
    return (
      <Login
        onLogin={({ user }) => {
          setUser(user);
          setAdminView('mail');
        }}
      />
    );
  }

  if (user.role !== 'admin') return <Mailbox user={user} onLogout={logout} onUserChange={setUser} />;

  // The admin is the owner of the main mailbox address: a full mailbox, plus the console.
  if (adminView === 'console' || !user.mailbox) return <Admin user={user} onLogout={logout} onOpenMail={user.mailbox ? () => setAdminView('mail') : null} />;
  return (
    <Mailbox
      key="owner"
      user={{ ...user, email: user.mailbox, color: OWNER_COLOR }}
      onLogout={logout}
      onUserChange={(u) => setUser({ ...user, displayName: u.displayName, avatarUrl: u.avatarUrl })}
      onOpenAdmin={() => setAdminView('console')}
    />
  );
}
