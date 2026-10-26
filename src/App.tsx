import type { User } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { signOut, useSession } from './hooks/useAuth';
import { supabase } from './lib/supabase';
import Home from './pages/Home';
import RoomPage from './pages/Room';
import SignIn from './pages/SignIn';

export default function App() {
  if (!supabase) return <SetupNeeded />;
  return (
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  );
}

function AuthGate() {
  const { session, loading } = useSession();
  if (loading) return <div className="splash" aria-busy="true"><span className="wordmark">Scent Tiers</span></div>;
  if (!session) return <SignIn />;
  const user = session.user;
  return (
    <Shell user={user}>
      <Routes>
        <Route path="/" element={<Home user={user} />} />
        <Route path="/r/:code/*" element={<RoomPage user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ user, children }: { user: User; children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">Scent Tiers</Link>
        <div className="topbar-user">
          <span className="mono muted ellipsis" title={user.email}>{user.email}</span>
          <button className="btn-link" onClick={() => signOut()}>Sign out</button>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function SetupNeeded() {
  return (
    <main className="page narrow center-page">
      <h1 className="display">Scent Tiers</h1>
      <div className="card">
        <p>Supabase isn't configured yet.</p>
        <p className="muted">
          Copy <code>.env.example</code> to <code>.env.local</code>, fill in <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code>, then restart <code>npm run dev</code>. See the README.
        </p>
      </div>
    </main>
  );
}
