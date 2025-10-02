'use client';

import { useState } from 'react';
import { login, register } from '@/lib/auth';
import styles from './auth.module.css';

export default function AuthPanel({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isRegister = mode === 'register';

  const resetForm = () => {
    setPassword('');
    setConfirm('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!userId.trim()) {
      setError('User ID is required');
      return;
    }

    if (!password) {
      setError('Password is required');
      return;
    }

    if (isRegister && password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      if (isRegister) {
        const result = await register({
          userId: userId.trim(),
          password,
          displayName: displayName.trim() || undefined,
        });
        onAuthenticated?.(result);
      } else {
        const result = await login({
          userId: userId.trim(),
          password,
        });
        onAuthenticated?.(result);
      }
      resetForm();
    } catch (err) {
      setError(err?.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1>{isRegister ? 'Create an account' : 'Sign in to continue'}</h1>
        <p className={styles.subtitle}>
          {isRegister
            ? 'Register to access your personal study coach.'
            : 'Welcome back! Enter your details to continue.'}
        </p>

        <label className={styles.field}>
          <span>User ID</span>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. alex_123"
            disabled={loading}
          />
        </label>

        {isRegister ? (
          <label className={styles.field}>
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alex"
              disabled={loading}
            />
          </label>
        ) : null}

        <label className={styles.field}>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={loading}
          />
        </label>

        {isRegister ? (
          <label className={styles.field}>
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
            />
          </label>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

        <button type="submit" className={styles.submit} disabled={loading}>
          {loading ? 'Please wait…' : (isRegister ? 'Create account' : 'Sign in')}
        </button>
      </form>

      <div className={styles.footer}>
        {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
        <button
          type="button"
          className={styles.switcher}
          onClick={() => {
            setMode(isRegister ? 'login' : 'register');
            setError('');
            resetForm();
          }}
          disabled={loading}
        >
          {isRegister ? 'Sign in' : 'Create one'}
        </button>
      </div>
    </div>
  );
}
