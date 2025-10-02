'use client';

import { useEffect, useState } from 'react';
import HomeworkApp from './HomeworkApp';
import AuthPanel from './AuthPanel';
import styles from './homeScreen.module.css';

const STORAGE_KEY = 'homework-assistant-user';

export default function HomeScreen() {
  const [authState, setAuthState] = useState(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.user) {
          setAuthState(parsed);
        }
      }
    } catch (_) {
      // ignore storage errors
    }
  }, []);

  const handleAuthenticated = (payload) => {
    if (!payload?.user) return;
    const next = {
      user: payload.user,
      token: payload.token,
      timestamp: Date.now(),
    };
    setAuthState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      // ignore storage errors
    }
  };

  const handleLogout = () => {
    setAuthState(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      // ignore storage errors
    }
  };

  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        {authState?.user ? (
          <HomeworkApp
            currentUser={authState.user}
            onLogout={handleLogout}
          />
        ) : (
          <AuthPanel onAuthenticated={handleAuthenticated} />
        )}
      </div>
    </div>
  );
}
