'use client';

import { useState } from 'react';
import styles from './adminLogin.module.css';

export default function AdminLogin({ onSubmit, loading = false, error = '' }) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    setLocalError('');

    if (!userId.trim()) {
      setLocalError('User ID is required');
      return;
    }
    if (!password) {
      setLocalError('Password is required');
      return;
    }

    onSubmit?.({
      userId: userId.trim(),
      password,
    });
  };

  const mergedError = localError || error;

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <span className={styles.brand}>Homework Admin</span>
        <h1 className={styles.title}>Welcome back, admin</h1>
        <p className={styles.subtitle}>
          Sign in with your administrator credentials to create new floppy experiences and test them instantly.
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>Admin user ID</span>
            <input
              className={styles.input}
              type="text"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="e.g. admin"
              autoComplete="username"
              disabled={loading}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={loading}
            />
          </label>

          {mergedError ? <div className={styles.error}>{mergedError}</div> : null}

          <div className={styles.actions}>
            <button type="submit" className={styles.submit} disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            <span className={styles.hint}>Need access? Contact the platform owner to receive admin credentials.</span>
          </div>
        </form>
      </div>
    </div>
  );
}

