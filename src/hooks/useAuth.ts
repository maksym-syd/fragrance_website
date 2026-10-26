import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { db } from '../lib/supabase';

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const client = db();
    client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

/** Return to the page the user started from (e.g. /r/K7P2QX) after signing in. */
const redirectTo = () => window.location.origin + window.location.pathname;

export const signInWithGoogle = () =>
  db().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });

export const sendMagicLink = (email: string) =>
  db().auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } });

export const signOut = () => db().auth.signOut();
