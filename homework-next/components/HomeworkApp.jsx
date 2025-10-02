'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  startHomeworkSession,
  sendHomeworkMessage,
  fetchHomeworkSessions,
  updateHomeworkSession,
  closeSession,
} from '@/lib/api';
import {
  SettingOutlined,
  LogoutOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import styles from './homework.module.css';

const LEVEL_OPTIONS = [
  { value: 'primary', label: 'Primary School' },
  { value: 'secondary', label: 'Secondary School' },
];

function MessageBubble({ entry }) {
  const role = entry.role === 'assistant' ? 'assistant' : 'user';
  return (
    <div className={`${styles.message} ${styles[`message--${role}`]}`}>
      <div className={styles.messageRole}>{role === 'assistant' ? 'Study Coach' : 'You'}</div>
      <div className={styles.messageContent}>{entry.content}</div>
    </div>
  );
}

function HistoryView({ history, bottomRef }) {
  if (!history.length) {
    return <div className={styles.placeholder}>Ask a homework question to get started.</div>;
  }
  return (
    <div className={styles.history}>
      {history.map((entry, idx) => (
        <MessageBubble key={`${entry.role}-${idx}-${entry.content.slice(0, 12)}`} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

const hydrateHistory = (items = []) => items.map((entry) => ({
  role: entry.role,
  content: entry.content,
  createdAt: entry.createdAt ? new Date(entry.createdAt) : null,
}));

const formatTimestamp = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return String(value);
  }
};

export default function HomeworkApp({ currentUser, onLogout }) {
  const [studentName, setStudentName] = useState('');
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState('primary');
  const [session, setSession] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [history, setHistory] = useState([]);
  const [sessionsList, setSessionsList] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [newSessionModalOpen, setNewSessionModalOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [deleteSessionModalOpen, setDeleteSessionModalOpen] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configNameInput, setConfigNameInput] = useState('');
  const [configLevelInput, setConfigLevelInput] = useState('primary');
  const historyEndRef = useRef(null);

  useEffect(() => {
    if (historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [history]);

  useEffect(() => {
    if (currentUser) {
      setStudentName(currentUser.displayName || currentUser.userId);
    }
  }, [currentUser]);

  const loadSessions = useCallback(async () => {
    if (!currentUser) return;
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const payload = await fetchHomeworkSessions();
      setSessionsList(payload.sessions || []);
    } catch (err) {
      setSessionsError(err?.message || 'Failed to load sessions');
    } finally {
      setSessionsLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      setSessionsList([]);
      return;
    }
    loadSessions();
  }, [currentUser, loadSessions]);

  const applySessionResponse = useCallback((data) => {
    if (!data) return;
    setSession(data);
    setSelectedSessionId(data.sessionId);
    if (data.level) setLevel(data.level);
    if (data.title !== undefined) setTitle(data.title || '');
    setHistory(hydrateHistory(data.messages || data.history || []));
    setQuestion('');
    setError('');
    setConfigOpen(false);
    setCopied(false);
  }, []);

  const startSession = useCallback(async (options = {}) => {
    if (!currentUser && !studentName.trim()) {
      setError('Student name is required');
      return;
    }

    setError('');
    setStarting(true);
    try {
      const baseTitle = options.title !== undefined ? options.title : title;
      const trimmedTitle = baseTitle ? baseTitle.trim() : '';
      const payload = {
        level: options.level || level,
        studentId: currentUser?.userId || studentName.trim() || undefined,
        displayName: currentUser?.displayName || studentName.trim() || undefined,
      };
      if (trimmedTitle) payload.title = trimmedTitle;
      const sessionIdToUse = options.forceNew
        ? null
        : options.sessionId ?? selectedSessionId ?? null;
      if (sessionIdToUse) {
        payload.sessionId = sessionIdToUse;
      }

      const response = await startHomeworkSession(payload);
      applySessionResponse(response);
      await loadSessions();
    } catch (err) {
      setError(err?.message || 'Failed to start homework session');
    } finally {
      setStarting(false);
    }
  }, [applySessionResponse, currentUser, level, loadSessions, selectedSessionId, studentName, title]);

  const handleSubmit = useCallback(async () => {
    if (!session?.sessionId || !question.trim()) return;
    setError('');
    setLoading(true);
    try {
      const result = await sendHomeworkMessage(session.sessionId, question.trim());
      setHistory(hydrateHistory(result.messages || result.history));
      setQuestion('');
      await loadSessions();
    } catch (err) {
      setError(err?.message || 'Homework helper is unavailable right now');
    } finally {
      setLoading(false);
    }
  }, [loadSessions, question, session?.sessionId]);

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (Boolean(session?.sessionId) && question.trim() && !loading) {
        handleSubmit();
      }
    }
  };

  const handleCopySession = async () => {
    if (!session?.sessionId) return;
    try {
      await navigator.clipboard.writeText(session.sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      setCopied(false);
    }
  };

  const handleResumeSession = (entry) => {
    if (!entry?.sessionId) return;
    if (entry.level) setLevel(entry.level);
    setTitle(entry.title || '');
    startSession({ sessionId: entry.sessionId, level: entry.level || level, title: entry.title });
    setConfigOpen(false);
  };

  const handleNewSession = () => {
    setNewSessionTitle('');
    setNewSessionModalOpen(true);
  };

  const handleConfirmNewSession = () => {
    const trimmed = newSessionTitle.trim();
    if (!trimmed) {
      setError('Please provide a session title.');
      return;
    }
    setNewSessionModalOpen(false);
    startSession({ title: trimmed, forceNew: true });
  };

  const handleCancelNewSession = () => {
    setNewSessionModalOpen(false);
    setNewSessionTitle('');
  };

  const handleRenameSession = async () => {
    if (!session?.sessionId) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Please enter a session title.');
      return;
    }
    try {
      await updateHomeworkSession(session.sessionId, { title: trimmed });
      setSession((prev) => (prev ? { ...prev, title: trimmed } : prev));
      await loadSessions();
      setError('');
    } catch (err) {
      setError(err?.message || 'Failed to rename session');
    }
  };

  const handleDeleteSession = async () => {
    if (!session?.sessionId) return;
    setDeleteSessionModalOpen(true);
  };

  const handleConfirmDeleteSession = async () => {
    if (!session?.sessionId) return;
    try {
      await closeSession(session.sessionId);
      setSession(null);
      setSelectedSessionId(null);
      setHistory([]);
      setTitle('');
      setQuestion('');
      await loadSessions();
      setDeleteSessionModalOpen(false);
    } catch (err) {
      setError(err?.message || 'Failed to delete session');
    }
  };

  const handleCancelDeleteSession = () => {
    setDeleteSessionModalOpen(false);
  };

  const openConfigModal = () => {
    setConfigNameInput(studentName);
    setConfigLevelInput(level);
    setConfigModalOpen(true);
  };

  const handleConfirmConfig = () => {
    setStudentName(configNameInput.trim());
    setLevel(configLevelInput);
    setConfigModalOpen(false);
  };

  const handleCancelConfig = () => {
    setConfigModalOpen(false);
  };

  const handleTitleBlur = async () => {
    if (!session?.sessionId) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(session.title || '');
      return;
    }
     if ((session.title || '').trim() === trimmed) return;
    try {
      await updateHomeworkSession(session.sessionId, { title: trimmed });
      setSession((prev) => (prev ? { ...prev, title: trimmed } : prev));
      await loadSessions();
    } catch (err) {
      setError(err?.message || 'Failed to update session title');
    }
  };

  const personaName = session?.persona?.name || (level === 'secondary' ? 'Secondary Study Coach' : 'Primary Homework Buddy');
  const canAsk = useMemo(() => Boolean(session?.sessionId) && question.trim() && !loading, [session?.sessionId, question, loading]);

  const sessionCountLabel = sessionsList.length ? `${sessionsList.length} session${sessionsList.length === 1 ? '' : 's'}` : 'No saved sessions';

  return (
    <div className={styles.wrapper}>
      <div className={styles.mobileBar}>
        <button
          type="button"
          className={styles.mobileToggle}
          onClick={() => setConfigOpen((open) => !open)}
        >
          {configOpen ? 'Hide session panel' : 'Session panel'}
        </button>
        <div className={styles.mobileActions}>
          <button type="button" className={styles.secondaryButton} onClick={handleNewSession}>
            New
          </button>
          <button type="button" className={styles.secondaryButton} onClick={openConfigModal}>
            Config
          </button>
        </div>
      </div>

      {configOpen ? <div className={styles.mobileOverlay} onClick={() => setConfigOpen(false)} /> : null}

      <div className={styles.layout}>
        <aside className={`${styles.sidebar} ${configOpen ? styles.sidebarOpen : ''}`}>
          <div className={styles.sidebarInner}>
            <header className={styles.sidebarHeader}>
              <p className={styles.tagline}>Personalised study support for {level} students.</p>
            </header>

            <div className={styles.sessionActions}>
              {session?.sessionId ? (
                <button type="button" className={styles.copyButton} onClick={handleCopySession}>
                  <span>{copied ? 'Copied!' : 'Session ID'}</span>
                  <code>{session.sessionId}</code>
                </button>
              ) : null}
            </div>

            <section className={styles.section}>
              <label className={`${styles.field} ${styles.inlineField}`}>
                <span>Session title</span>
                <div className={styles.inlineInputGroup}>
                  <input
                    type="text"
                    value={title}
                    placeholder="e.g. Algebra practice"
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={handleTitleBlur}
                    disabled={starting || loading}
                  />
                  <button
                    type="button"
                    className={styles.iconButtonSecondary}
                    onClick={handleRenameSession}
                    disabled={!session?.sessionId || starting || loading}
                    aria-label="Rename session"
                  >
                    <EditOutlined />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButtonSecondaryDanger}
                    onClick={handleDeleteSession}
                    disabled={!session?.sessionId || starting || loading}
                    aria-label="Delete session"
                  >
                    <DeleteOutlined />
                  </button>
                </div>
              </label>
              <div className={styles.sessionActionRow}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={handleNewSession}
                  disabled={starting || loading}
                >
                  Create New
                </button>
              </div>
            </section>

            <section className={styles.sessionListSection}>
              <div className={styles.sessionListHeader}>
                <span>{sessionCountLabel}</span>
                <div className={styles.sessionListHeaderActions}>
                  <button type="button" className={styles.iconButtonSecondary} onClick={handleNewSession} aria-label="Create new session">
                    <PlusCircleOutlined />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButtonSecondary}
                    onClick={loadSessions}
                    disabled={sessionsLoading}
                    aria-label="Refresh sessions"
                  >
                    <ReloadOutlined spin={sessionsLoading} />
                  </button>
                </div>
              </div>
              {sessionsError ? <div className={styles.sessionListError}>{sessionsError}</div> : null}
              <ul className={styles.sessionList}>
                {!sessionsList.length ? (
                  <li className={styles.sessionListEmpty}>No saved sessions yet.</li>
                ) : sessionsList.map((entry) => (
                  <li key={entry.sessionId} className={`${styles.sessionListItem}${selectedSessionId === entry.sessionId ? ` ${styles.sessionListItemActive}` : ''}`}>
                    <button
                      type="button"
                      className={styles.sessionListButton}
                      onClick={() => handleResumeSession(entry)}
                    >
                      <strong>{entry.title || 'Untitled session'}</strong>
                      <span className={styles.sessionListMeta}>{formatTimestamp(entry.lastActiveAt || entry.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </aside>

       <section className={styles.chatColumn}>
          <header className={styles.chatHeader}>
            <div className={styles.chatHeaderLeft}>
              <div className={styles.chatCoach}>
                <span>Coach</span>
                <strong>{personaName}</strong>
              </div>
              {currentUser ? (
                <div className={styles.chatLearner}>
                  <span>Learner</span>
                  <strong>{currentUser.displayName || currentUser.userId}</strong>
                </div>
              ) : null}
            </div>
            <div className={styles.chatHeaderRight}>
              <button type="button" className={styles.iconButton} onClick={openConfigModal} aria-label="Configure learner">
                <SettingOutlined />
              </button>
              {currentUser && onLogout ? (
                <button type="button" className={styles.iconButtonDanger} onClick={onLogout} aria-label="Logout">
                  <LogoutOutlined />
                </button>
              ) : null}
            </div>
          </header>

          <main className={styles.main}>
            <HistoryView history={history} bottomRef={historyEndRef} />
          </main>

          <section className={styles.inputPanel}>
            <textarea
              placeholder="Ask a homework question or describe what you need help with."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!session?.sessionId || loading}
              rows={3}
            />
            <div className={styles.inputActions}>
              <button
                type="button"
                className={styles.button}
                onClick={handleSubmit}
                disabled={!canAsk}
              >
                {loading ? 'Thinking…' : 'Send'}
              </button>
              {!session?.sessionId ? (
                <span className={styles.hint}>Start or resume a session to unlock the helper.</span>
              ) : null}
            </div>
          </section>

          {error ? <div className={styles.error}>{error}</div> : null}
        </section>
      </div>

      {newSessionModalOpen ? (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard}>
            <h2>Create new session</h2>
            <p className={styles.modalNote}>Give this session a name to keep things organised.</p>
            <input
              type="text"
              value={newSessionTitle}
              onChange={(e) => setNewSessionTitle(e.target.value)}
              placeholder="e.g. Fractions practice"
              className={styles.modalInput}
              autoFocus
            />
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={handleCancelNewSession}>
                Cancel
              </button>
              <button type="button" className={styles.button} onClick={handleConfirmNewSession}>
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteSessionModalOpen ? (
        <div className={styles.modalOverlay}>
          <div className={`${styles.modalCard} ${styles.modalCardDanger}`}>
            <h2>Delete session?</h2>
            <p className={styles.modalNote}>
              This will remove <strong>{session?.title || 'this session'}</strong> and its conversation history. This action cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={handleCancelDeleteSession}>
                Cancel
              </button>
              <button type="button" className={styles.secondaryButtonDanger} onClick={handleConfirmDeleteSession}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {configModalOpen ? (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard}>
            <h2>Session configuration</h2>
            <label className={styles.field}>
              <span>Student name</span>
              <input
                type="text"
                value={configNameInput}
                onChange={(e) => setConfigNameInput(e.target.value)}
                placeholder="e.g. Alex"
              />
            </label>
            <label className={styles.field}>
              <span>School level</span>
              <select value={configLevelInput} onChange={(e) => setConfigLevelInput(e.target.value)}>
                {LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={handleCancelConfig}>
                Cancel
              </button>
              <button type="button" className={styles.button} onClick={handleConfirmConfig}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
