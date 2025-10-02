'use client';

import { useMemo } from 'react';
import {
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import styles from './admin.module.css';

const formatTimestamp = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return '—';
  }
};

export default function SandboxManager({
  sandboxes = [],
  loading = false,
  error = '',
  onRefresh,
  onSelect,
  onDelete,
  onCreateNew,
  activeSandboxId,
  deletingSandboxId = '',
  floppies = [],
}) {
  const floppyLookup = useMemo(() => {
    const map = new Map();
    (floppies || []).forEach((floppy) => {
      if (floppy?.id) {
        map.set(floppy.id, floppy);
      }
    });
    return map;
  }, [floppies]);

  const handleRefresh = () => {
    const result = onRefresh?.();
    if (result && typeof result.then === 'function') {
      result.catch((err) => {
        console.warn('[Admin] Failed to refresh sandboxes:', err?.message || err);
      });
    }
  };

  const handleOpen = (sandbox) => {
    onSelect?.(sandbox);
  };

  const handleCreate = () => {
    onCreateNew?.();
  };

  const handleDelete = (sandbox) => {
    if (!onDelete) return;
    if (typeof window === 'undefined') {
      const result = onDelete(sandbox);
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.warn('[Admin] Failed to delete sandbox:', err?.message || err);
        });
      }
      return;
    }
    const confirmed = window.confirm(`Delete “${sandbox?.title || 'Sandbox'}”? This cannot be undone.`);
    if (confirmed) {
      const result = onDelete(sandbox);
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.warn('[Admin] Failed to delete sandbox:', err?.message || err);
        });
      }
    }
  };

  return (
    <div className={styles.contentColumn}>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>Saved sandboxes</h2>
            <p className={styles.cardSubtitle}>
              Manage reusable character cards and prompts for quick sandbox testing.
            </p>
          </div>
          <div className={styles.managerActions}>
            <button
              type="button"
              className={styles.iconButtonSecondary}
              onClick={handleRefresh}
              disabled={loading}
              aria-label="Refresh sandboxes"
            >
              <ReloadOutlined aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleCreate}
              aria-label="Create sandbox"
            >
              <PlusOutlined aria-hidden="true" />
              <span>New sandbox</span>
            </button>
          </div>
        </div>

        {error ? <div className={styles.statusError}>{error}</div> : null}

        {loading ? (
          <div className={styles.loader}>Loading sandboxes…</div>
        ) : sandboxes.length ? (
          <ul className={styles.sandboxList}>
            {sandboxes.map((sandbox) => {
              const linkedFloppy = sandbox?.floppyId ? floppyLookup.get(sandbox.floppyId) : null;
              const isActive = activeSandboxId === sandbox.id;
              const avatar = sandbox?.characterCard?.avatar?.dataUrl || '';
              const background = sandbox?.characterCard?.background?.dataUrl || '';
              const deleting = deletingSandboxId === sandbox.id;
              return (
                <li
                  key={sandbox.id}
                  className={`${styles.sandboxCard} ${isActive ? styles.sandboxCardActive : ''}`}
                >
                  <div className={styles.sandboxCardMain}>
                    <div
                      className={styles.sandboxCardVisual}
                      style={background ? { backgroundImage: `url(${background})` } : undefined}
                    >
                      {avatar ? (
                        <img src={avatar} alt="Sandbox avatar" />
                      ) : (
                        <PictureOutlined aria-hidden="true" />
                      )}
                    </div>
                    <div className={styles.sandboxCardBody}>
                      <strong className={styles.sandboxCardTitle}>{sandbox.title || 'Untitled sandbox'}</strong>
                      <span className={styles.sandboxCardMeta}>
                        {linkedFloppy ? `Linked floppy: ${linkedFloppy.title}` : 'No linked floppy'}
                      </span>
                      <span className={styles.sandboxCardMeta}>Updated {formatTimestamp(sandbox.updatedAt)}</span>
                    </div>
                  </div>
                  <div className={styles.sandboxCardActions}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => handleOpen(sandbox)}
                      aria-label="Open sandbox in builder"
                    >
                      <EditOutlined aria-hidden="true" />
                      <span>Open in builder</span>
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      onClick={() => handleDelete(sandbox)}
                      aria-label="Delete sandbox"
                      disabled={deleting}
                    >
                      {deleting ? <LoadingOutlined aria-hidden="true" spin /> : <DeleteOutlined aria-hidden="true" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={styles.emptyState}>
            No sandboxes saved yet. Create one in the builder and it will appear here.
          </div>
        )}
      </section>
    </div>
  );
}
