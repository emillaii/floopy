'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdminLogin from './AdminLogin';
import AdminShell, { NAV_ITEMS } from './AdminShell';
import FloppyBuilder from './FloppyBuilder';
import SandboxBuilder, { SandboxConversation } from './SandboxBuilder';
import SandboxManager from './SandboxManager';
import styles from './admin.module.css';
import {
  adminLogin,
  adminLogout,
  fetchAdminProfile,
  fetchFloppies,
  createFloppy,
  updateFloppy,
  deleteFloppy,
  uploadFloppyKnowledge,
  deleteFloppyKnowledgeFile,
  startSandboxSession,
  sendSandboxMessage,
  fetchSandboxes,
  createSandbox,
  updateSandbox,
  deleteSandbox,
} from '@/lib/admin';

const STORAGE_KEY = 'homework-admin-session';

export default function AdminPortal() {
  const [session, setSession] = useState(null);
  const [initialising, setInitialising] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [activePage, setActivePage] = useState('floppy');
  const [floppies, setFloppies] = useState([]);
  const [floppyError, setFloppyError] = useState('');
  const [floppyLoading, setFloppyLoading] = useState(false);
  const [creatingFloppy, setCreatingFloppy] = useState(false);
  const [sandboxSession, setSandboxSession] = useState(null);
  const [sandboxHistory, setSandboxHistory] = useState([]);
  const [sandboxError, setSandboxError] = useState('');
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxSending, setSandboxSending] = useState(false);
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [sandboxes, setSandboxes] = useState([]);
  const [sandboxesLoading, setSandboxesLoading] = useState(false);
  const [sandboxesError, setSandboxesError] = useState('');
  const [savingSandbox, setSavingSandbox] = useState(false);
  const [activeSandbox, setActiveSandbox] = useState(null);
  const [sandboxDeletingId, setSandboxDeletingId] = useState('');

  const persistSession = useCallback((payload) => {
    if (!payload) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {
        // ignore storage access issues
      }
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // ignore storage access issues
    }
  }, []);

  const loadFloppiesWithToken = useCallback(async (token) => {
    if (!token) return;
    setFloppyLoading(true);
    setFloppyError('');
    try {
      const payload = await fetchFloppies(token);
      setFloppies(payload?.floppies || []);
    } catch (err) {
      setFloppyError(err?.message || 'Unable to load floppies.');
      throw err;
    } finally {
      setFloppyLoading(false);
    }
  }, []);

  const loadSandboxesWithToken = useCallback(async (token) => {
    if (!token) return;
    setSandboxesLoading(true);
    setSandboxesError('');
    try {
      const payload = await fetchSandboxes(token);
      setSandboxes(payload?.sandboxes || []);
    } catch (err) {
      setSandboxesError(err?.message || 'Unable to load sandboxes.');
      throw err;
    } finally {
      setSandboxesLoading(false);
    }
  }, []);

  const resetSandboxState = useCallback(() => {
    setSandboxSession(null);
    setSandboxHistory([]);
    setSandboxError('');
    setSandboxLoading(false);
    setSandboxSending(false);
    setActiveSandbox(null);
    setSavingSandbox(false);
    setSandboxDeletingId('');
  }, []);

  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed?.token) return;

        try {
          const profile = await fetchAdminProfile(parsed.token);
          const nextSession = {
            token: parsed.token,
            role: profile?.user?.role || parsed.role || 'admin',
            user: profile?.user || parsed.user,
          };
          if (!mounted) return;
          setSession(nextSession);
          persistSession(nextSession);
          try {
            await loadFloppiesWithToken(parsed.token);
          } catch (err) {
            console.warn('[Admin] Failed to load floppies during bootstrap:', err?.message || err);
          }
          try {
            await loadSandboxesWithToken(parsed.token);
          } catch (err) {
            console.warn('[Admin] Failed to load sandboxes during bootstrap:', err?.message || err);
          }
        } catch (err) {
          if (!mounted) return;
          setSession(null);
          persistSession(null);
          console.warn('[Admin] Failed to restore session:', err?.message || err);
        }
      } catch (err) {
        console.warn('[Admin] Failed to read stored session:', err?.message || err);
      } finally {
        if (mounted) {
          setInitialising(false);
        }
      }
    };

    bootstrap();

    return () => {
      mounted = false;
    };
  }, [loadFloppiesWithToken, loadSandboxesWithToken, persistSession]);

  const handleLogin = useCallback(async ({ userId, password }) => {
    setAuthLoading(true);
    setLoginError('');
    try {
      const payload = await adminLogin({ userId, password });
      const nextSession = {
        token: payload?.token,
        role: payload?.role || 'admin',
        user: payload?.user || { userId },
      };
      setSession(nextSession);
      persistSession(nextSession);
      resetSandboxState();
      try {
        await loadFloppiesWithToken(nextSession.token);
      } catch (err) {
        console.warn('[Admin] Failed to load floppies after login:', err?.message || err);
      }
      try {
        await loadSandboxesWithToken(nextSession.token);
      } catch (err) {
        console.warn('[Admin] Failed to load sandboxes after login:', err?.message || err);
      }
    } catch (err) {
      setLoginError(err?.message || 'Unable to sign in.');
      setSession(null);
      persistSession(null);
    } finally {
      setAuthLoading(false);
      setInitialising(false);
    }
  }, [loadFloppiesWithToken, loadSandboxesWithToken, persistSession, resetSandboxState]);

  const handleLogout = useCallback(async () => {
    if (session?.token) {
      try {
        await adminLogout(session.token);
      } catch (err) {
        console.warn('[Admin] Logout request failed:', err?.message || err);
      }
    }
    setSession(null);
    setFloppies([]);
    setSandboxes([]);
    setSandboxesError('');
    setSandboxesLoading(false);
    setSavingSandbox(false);
    setActiveSandbox(null);
    setSandboxDeletingId('');
    resetSandboxState();
    persistSession(null);
  }, [persistSession, resetSandboxState, session]);

  const handleCreateFloppy = useCallback(async (payload) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to create floppies.');
    }
    setCreatingFloppy(true);
    setFloppyError('');
    try {
      const result = await createFloppy(session.token, payload);
      setFloppies((previous) => [result?.floppy, ...(previous || [])].filter(Boolean));
      return result?.floppy;
    } catch (err) {
      const message = err?.message || 'Unable to create floppy.';
      setFloppyError(message);
      throw err;
    } finally {
      setCreatingFloppy(false);
    }
  }, [session]);

  const handleUpdateFloppy = useCallback(async (id, payload) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to update floppies.');
    }
    setFloppyError('');
    try {
      const result = await updateFloppy(session.token, id, payload);
      if (result?.floppy) {
        setFloppies((previous) => {
          const others = (previous || []).filter((item) => item.id !== result.floppy.id);
          return [result.floppy, ...others];
        });
      }
      return result?.floppy;
    } catch (err) {
      const message = err?.message || 'Unable to update floppy.';
      setFloppyError(message);
      throw err;
    }
  }, [session]);

  const handleDeleteFloppy = useCallback(async (id) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to delete floppies.');
    }
    setFloppyError('');
    try {
      await deleteFloppy(session.token, id);
      setFloppies((previous) => (previous || []).filter((item) => item.id !== id));
    } catch (err) {
      const message = err?.message || 'Unable to delete floppy.';
      setFloppyError(message);
      throw err;
    }
  }, [session]);

  const handleUploadKnowledge = useCallback(async ({ floppyId, files, group = null }) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to upload documents.');
    }
    if (!floppyId) {
      throw new Error('Select a floppy before uploading documents.');
    }
    const fileList = Array.isArray(files) ? files : [];
    if (!fileList.length) {
      return null;
    }

    setUploadingKnowledge(true);
    setUploadError('');
    try {
      const result = await uploadFloppyKnowledge(session.token, floppyId, fileList, group);
      if (result?.floppy) {
        setFloppies((previous) => {
          const others = (previous || []).filter((item) => item.id !== result.floppy.id);
          return [result.floppy, ...others];
        });
      }
      return result;
    } catch (err) {
      const message = err?.message || 'Unable to upload knowledge documents.';
      setUploadError(message);
      throw err;
    } finally {
      setUploadingKnowledge(false);
    }
  }, [session]);

  const handleDeleteKnowledgeFile = useCallback(async ({ floppyId, fileId }) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to remove documents.');
    }
    if (!floppyId || !fileId) {
      throw new Error('Missing floppy or file id.');
    }
    setUploadError('');
    try {
      const result = await deleteFloppyKnowledgeFile(session.token, floppyId, fileId);
      if (result?.floppy) {
        setFloppies((previous) => {
          const others = (previous || []).filter((item) => item.id !== result.floppy.id);
          return [result.floppy, ...others];
        });
      }
      return result;
    } catch (err) {
      const message = err?.message || 'Unable to remove document.';
      setUploadError(message);
      throw err;
    }
  }, [session]);

  const handleSaveSandbox = useCallback(async (payload = {}) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to save sandboxes.');
    }
    setSavingSandbox(true);
    setSandboxesError('');
    try {
      const isUpdate = Boolean(payload?.id);
      const response = isUpdate
        ? await updateSandbox(session.token, payload.id, payload)
        : await createSandbox(session.token, payload);
      const sandbox = response?.sandbox;
      if (sandbox) {
        setSandboxes((previous) => {
          const others = (previous || []).filter((item) => item.id !== sandbox.id);
          return [sandbox, ...others];
        });
        setActiveSandbox(sandbox);
      }
      return sandbox;
    } catch (err) {
      const message = err?.message || 'Unable to save sandbox.';
      setSandboxesError(message);
      throw err;
    } finally {
      setSavingSandbox(false);
    }
  }, [session]);

  const handleDeleteSandbox = useCallback(async (sandbox) => {
    if (!session?.token) {
      throw new Error('You must be signed in as an admin to delete sandboxes.');
    }
    if (!sandbox?.id) return;
    setSandboxesError('');
    setSandboxDeletingId(sandbox.id);
    try {
      await deleteSandbox(session.token, sandbox.id);
      setSandboxes((previous) => (previous || []).filter((item) => item.id !== sandbox.id));
      if (activeSandbox?.id === sandbox.id) {
        setActiveSandbox(null);
      }
      if (sandboxSession?.sandbox?.id === sandbox.id) {
        resetSandboxState();
      }
    } catch (err) {
      const message = err?.message || 'Unable to delete sandbox.';
      setSandboxesError(message);
      throw err;
    } finally {
      setSandboxDeletingId('');
    }
  }, [activeSandbox?.id, resetSandboxState, sandboxSession?.sandbox?.id, session]);

  const handleSelectSandbox = useCallback((sandbox) => {
    setActiveSandbox(sandbox ? { ...sandbox } : null);
    setActivePage('sandbox');
  }, [setActivePage]);

  const handleCreateNewSandboxDraft = useCallback(() => {
    handleSelectSandbox(null);
  }, [handleSelectSandbox]);

  const handleClearActiveSandbox = useCallback(() => {
    handleSelectSandbox(null);
  }, [handleSelectSandbox]);

  const handleRefreshSandboxes = useCallback(async () => {
    if (!session?.token) return;
    try {
      await loadSandboxesWithToken(session.token);
    } catch (err) {
      console.warn('[Admin] Failed to refresh sandboxes:', err?.message || err);
    }
  }, [loadSandboxesWithToken, session]);

  const navKeys = useMemo(() => NAV_ITEMS.map((item) => item.key), []);

  const handleStartSandbox = useCallback(async (options) => {
    if (!session?.token) {
      throw new Error('You must be signed in to start a sandbox session.');
    }
    const payloadInput = typeof options === 'object' && options !== null
      ? options
      : { floppyId: options };
    const incomingFloppyIds = Array.isArray(payloadInput?.floppyIds)
      ? payloadInput.floppyIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const singleFloppyId = String(payloadInput?.floppyId || '').trim();
    const resolvedFloppyIds = Array.from(new Set([
      ...incomingFloppyIds,
      ...(singleFloppyId ? [singleFloppyId] : []),
    ]));
    if (!resolvedFloppyIds.length) {
      throw new Error('Select at least one floppy to load into the sandbox.');
    }
    setSandboxLoading(true);
    setSandboxError('');
    setSandboxHistory([]);
    try {
      const requestBody = { floppyIds: resolvedFloppyIds };
      if (resolvedFloppyIds.length === 1) {
        requestBody.floppyId = resolvedFloppyIds[0];
      }
      if (payloadInput?.sandboxId) {
        requestBody.sandboxId = payloadInput.sandboxId;
      }
      if (payloadInput?.personaPrompt) {
        requestBody.personaPrompt = payloadInput.personaPrompt;
      }
      const response = await startSandboxSession(session.token, requestBody);
      const responseFloppies = Array.isArray(response?.floppies)
        ? response.floppies
        : response?.floppy
          ? [response.floppy]
          : [];
      setSandboxSession({
        sessionId: response?.sessionId,
        persona: response?.persona,
        floppy: response?.floppy,
        floppies: responseFloppies,
        floppyIds: responseFloppies.map((item) => item.id).filter(Boolean),
        sandbox: response?.sandbox || null,
      });
      return response;
    } catch (err) {
      const message = err?.message || 'Unable to start sandbox session.';
      setSandboxError(message);
      throw err;
    } finally {
      setSandboxLoading(false);
    }
  }, [session]);

  const handleSendSandboxMessage = useCallback(async (text) => {
    if (!session?.token || !sandboxSession?.sessionId) {
      throw new Error('No active sandbox session.');
    }
    setSandboxSending(true);
    setSandboxError('');
    try {
      const response = await sendSandboxMessage(session.token, sandboxSession.sessionId, text);
      setSandboxHistory(response?.history || []);
      return response;
    } catch (err) {
      const message = err?.message || 'Unable to process sandbox message.';
      setSandboxError(message);
      throw err;
    } finally {
      setSandboxSending(false);
    }
  }, [sandboxSession, session]);

  useEffect(() => {
    if (!navKeys.includes(activePage)) {
      setActivePage(navKeys[0]);
    }
  }, [activePage, navKeys]);

  if (!session?.token) {
    if (initialising) {
      return null;
    }
    return (
      <AdminLogin
        onSubmit={handleLogin}
        loading={authLoading}
        error={loginError}
      />
    );
  }

  return (
    <AdminShell
      user={session.user}
      activePage={activePage}
      onSelectPage={setActivePage}
      onLogout={handleLogout}
    >
      {activePage === 'floppy' ? (
        <FloppyBuilder
          floppies={floppies}
          onCreate={handleCreateFloppy}
          onUpdate={handleUpdateFloppy}
          onDelete={handleDeleteFloppy}
          loading={floppyLoading}
          creating={creatingFloppy}
          error={floppyError}
          onRefresh={() => loadFloppiesWithToken(session.token)}
          onUploadKnowledge={handleUploadKnowledge}
          uploadingKnowledge={uploadingKnowledge}
          uploadError={uploadError}
          onDeleteKnowledgeFile={handleDeleteKnowledgeFile}
        />
      ) : null}

      {activePage === 'sandbox' ? (
        <div className={styles.sandboxStudio}>
          <div className={styles.sandboxStudioPrimary}>
            <SandboxBuilder
              floppies={floppies}
              loadingFloppies={floppyLoading}
              onRefresh={() => loadFloppiesWithToken(session.token)}
              sandboxSession={sandboxSession}
              sandboxLoading={sandboxLoading}
              sandboxSending={sandboxSending}
              sandboxError={sandboxError}
              onStartSandbox={handleStartSandbox}
              onSaveSandbox={handleSaveSandbox}
              savingSandbox={savingSandbox}
              activeSandbox={activeSandbox}
              onResetActiveSandbox={handleClearActiveSandbox}
            />
          </div>
          <aside className={styles.sandboxStudioAside}>
            <SandboxManager
              sandboxes={sandboxes}
              loading={sandboxesLoading}
              error={sandboxesError}
              onRefresh={handleRefreshSandboxes}
              onSelect={handleSelectSandbox}
              onDelete={handleDeleteSandbox}
              onCreateNew={handleCreateNewSandboxDraft}
              activeSandboxId={activeSandbox?.id}
              deletingSandboxId={sandboxDeletingId}
              floppies={floppies}
            />
          </aside>
          <div className={styles.sandboxStudioConversation}>
            <SandboxConversation
              sandboxSession={sandboxSession}
              sandboxHistory={sandboxHistory}
              sandboxLoading={sandboxLoading}
              sandboxSending={sandboxSending}
              sandboxError={sandboxError}
              onSendMessage={handleSendSandboxMessage}
            />
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}
