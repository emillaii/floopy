'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import {
  DeleteOutlined,
  LoadingOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import styles from './admin.module.css';

const IMAGE_MAX_BYTES = 1.2 * 1024 * 1024;
const IMAGE_LIMIT_LABEL = '1.2 MB';

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Unable to read image'));
  reader.readAsDataURL(file);
});

const buildAsset = (file, dataUrl) => ({
  dataUrl,
  name: file?.name || '',
  mimeType: file?.type || '',
});

function MessageBubble({ entry }) {
  const role = entry.role || 'assistant';
  const bubbleClass = role === 'user' ? styles.chatBubbleUser : styles.chatBubbleAssistant;
  const label = role === 'user' ? 'Admin' : 'Agent';
  return (
    <div className={`${styles.chatBubble} ${bubbleClass}`}>
      <div className={styles.chatBubbleLabel}>{label}</div>
      <div>{entry.content}</div>
    </div>
  );
}

export default function SandboxBuilder({
  floppies = [],
  loadingFloppies = false,
  onRefresh,
  sandboxSession,
  sandboxLoading = false,
  sandboxError = '',
  sandboxSending = false,
  onStartSandbox,
  onSaveSandbox,
  savingSandbox = false,
  activeSandbox = null,
  onResetActiveSandbox = () => {},
}) {
  const [selectedFloppyIds, setSelectedFloppyIds] = useState([]);
  const [localError, setLocalError] = useState('');
  const [isKnowledgeModalOpen, setIsKnowledgeModalOpen] = useState(false);
  const [sandboxName, setSandboxName] = useState('');
  const [characterPrompt, setCharacterPrompt] = useState('');
  const [avatarAsset, setAvatarAsset] = useState(null);
  const [backgroundAsset, setBackgroundAsset] = useState(null);
  const [currentSandboxId, setCurrentSandboxId] = useState('');
  const [localStatus, setLocalStatus] = useState('');
  const [sandboxMetadata, setSandboxMetadata] = useState(null);
  const [messageApi, contextHolder] = message.useMessage();

  const hasFloppies = floppies.length > 0;

  const selectedFloppies = useMemo(() => {
    if (!selectedFloppyIds.length) return [];
    const lookup = new Map((floppies || []).map((item) => [item.id, item]));
    return selectedFloppyIds
      .map((id) => lookup.get(id))
      .filter(Boolean);
  }, [floppies, selectedFloppyIds]);

  const sessionFloppies = useMemo(() => {
    if (Array.isArray(sandboxSession?.floppies) && sandboxSession.floppies.length) {
      return sandboxSession.floppies;
    }
    if (sandboxSession?.floppy) {
      return [sandboxSession.floppy];
    }
    return [];
  }, [sandboxSession]);

  const activeFloppies = sessionFloppies.length ? sessionFloppies : selectedFloppies;
  const primaryFloppy = activeFloppies[0] || null;
  const knowledgeSnippetItems = useMemo(() => {
    return activeFloppies
      .flatMap((floppy) => {
        if (!floppy) return [];
        const chunks = Array.isArray(floppy.knowledgeChunks) ? floppy.knowledgeChunks : [];
        return chunks.map((chunk, index) => {
          if (!chunk) return null;
          const rawText = typeof chunk === 'string' ? chunk : (chunk?.text || '');
          const text = String(rawText || '').trim();
          if (!text) return null;
          const baseKey = typeof chunk === 'object' && chunk?.id
            ? chunk.id
            : `${floppy.id || 'floppy'}-${index}-${text.slice(0, 16) || 'empty'}`;
          return {
            key: `${floppy.id || 'floppy'}-${baseKey}`,
            text,
            floppyTitle: floppy.title || 'Untitled floppy',
          };
        });
      })
      .filter(Boolean);
  }, [activeFloppies]);
  const knowledgeSnippetCount = knowledgeSnippetItems.length;
  const selectedFloppySummary = useMemo(() => {
    if (!selectedFloppies.length) return '';
    return selectedFloppies
      .map((item) => item?.title || 'Untitled floppy')
      .join(', ');
  }, [selectedFloppies]);
  const floppySelectSize = useMemo(() => {
    const count = Array.isArray(floppies) ? floppies.length : 0;
    return Math.min(8, Math.max(3, count || 0));
  }, [floppies]);
  const knowledgeModalSubject = useMemo(() => {
    if (!activeFloppies.length) return '.';
    if (activeFloppies.length === 1) {
      return ` for “${activeFloppies[0].title || 'Untitled floppy'}”.`;
    }
    const titles = activeFloppies
      .map((floppy) => `“${floppy.title || 'Untitled floppy'}”`);
    if (titles.length <= 3) {
      return ` for ${titles.join(', ')}.`;
    }
    const displayed = titles.slice(0, 3).join(', ');
    return ` for ${displayed}, and ${titles.length - 3} more.`;
  }, [activeFloppies]);

  const resetCharacterCard = useCallback(() => {
    setCurrentSandboxId('');
    setSandboxName('');
    setCharacterPrompt('');
    setAvatarAsset(null);
    setBackgroundAsset(null);
    setLocalStatus('');
    setSelectedFloppyIds([]);
    setSandboxMetadata(null);
  }, []);

  const applyActiveSandbox = useCallback((sandbox) => {
    if (!sandbox) {
      resetCharacterCard();
      return;
    }
    setCurrentSandboxId(sandbox.id || '');
    setSandboxName(sandbox.title || '');
    setCharacterPrompt(
      sandbox.characterCard?.prompt
        || sandbox.personaPrompt
        || ''
    );
    const metadata = sandbox.metadata && typeof sandbox.metadata === 'object'
      ? { ...sandbox.metadata }
      : null;
    setSandboxMetadata(metadata);
    const metadataFloppyIds = Array.isArray(metadata?.floppyIds)
      ? metadata.floppyIds
      : Array.isArray(metadata?.selectedFloppyIds)
        ? metadata.selectedFloppyIds
        : [];
    const normalisedMetadataIds = metadataFloppyIds
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const fallbackIds = sandbox.floppyId ? [sandbox.floppyId] : [];
    const resolvedIds = normalisedMetadataIds.length ? normalisedMetadataIds : fallbackIds;
    setSelectedFloppyIds(resolvedIds);
    setAvatarAsset(sandbox.characterCard?.avatar ? { ...sandbox.characterCard.avatar } : null);
    setBackgroundAsset(sandbox.characterCard?.background ? { ...sandbox.characterCard.background } : null);
    setLocalStatus('');
  }, [resetCharacterCard]);

  useEffect(() => {
    if (activeSandbox) {
      applyActiveSandbox(activeSandbox);
    } else {
      resetCharacterCard();
    }
  }, [activeSandbox, applyActiveSandbox, resetCharacterCard]);

  useEffect(() => {
    if (!knowledgeSnippetCount) {
      setIsKnowledgeModalOpen(false);
    }
  }, [knowledgeSnippetCount]);

  useEffect(() => {
    if (!selectedFloppyIds.length) return;
    const availableIds = new Set((floppies || []).map((item) => item.id));
    const filtered = selectedFloppyIds.filter((id) => availableIds.has(id));
    if (filtered.length !== selectedFloppyIds.length) {
      setSelectedFloppyIds(filtered);
    }
  }, [floppies, selectedFloppyIds]);

  useEffect(() => {
    if (!isKnowledgeModalOpen) {
      return undefined;
    }
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsKnowledgeModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isKnowledgeModalOpen]);

  const handleStart = async () => {
    setLocalError('');
    if (!selectedFloppyIds.length) {
      setLocalError('Select at least one floppy to load into the sandbox.');
      return;
    }
    try {
      await onStartSandbox?.({
        floppyIds: selectedFloppyIds,
        floppyId: selectedFloppyIds[0],
        sandboxId: currentSandboxId || undefined,
        personaPrompt: characterPrompt,
      });
    } catch (err) {
      setLocalError(err?.message || 'Unable to start sandbox session.');
    }
  };

  const handleAvatarChange = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > IMAGE_MAX_BYTES) {
      messageApi.open({
        type: 'error',
        content: `Avatar must be smaller than ${IMAGE_LIMIT_LABEL}.`,
      });
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAvatarAsset(buildAsset(file, dataUrl));
      setLocalStatus('');
    } catch (err) {
      messageApi.open({ type: 'error', content: err?.message || 'Unable to load avatar image.' });
    }
  }, [messageApi]);

  const handleBackgroundChange = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > IMAGE_MAX_BYTES) {
      messageApi.open({
        type: 'error',
        content: `Background image must be smaller than ${IMAGE_LIMIT_LABEL}.`,
      });
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setBackgroundAsset(buildAsset(file, dataUrl));
      setLocalStatus('');
    } catch (err) {
      messageApi.open({ type: 'error', content: err?.message || 'Unable to load background image.' });
    }
  }, [messageApi]);

  const handleFloppySelectionChange = useCallback((event) => {
    const options = Array.from(event.target.selectedOptions || []);
    const ids = Array.from(new Set(options.map((option) => String(option.value || '').trim()).filter(Boolean)));
    setSelectedFloppyIds(ids);
    setLocalStatus('');
    setLocalError('');
  }, []);

  const handleSaveSandboxClick = useCallback(async () => {
    if (!onSaveSandbox) return;
    const trimmedName = sandboxName.trim();
    if (!trimmedName) {
      messageApi.open({ type: 'error', content: 'Sandbox name is required.' });
      return;
    }
    if (!selectedFloppyIds.length) {
      messageApi.open({ type: 'error', content: 'Select at least one floppy before saving the sandbox.' });
      return;
    }
    const metadataPayload = sandboxMetadata && typeof sandboxMetadata === 'object'
      ? { ...sandboxMetadata }
      : {};
    metadataPayload.floppyIds = selectedFloppyIds;
    metadataPayload.selectedFloppyIds = selectedFloppyIds;
    const payload = {
      id: currentSandboxId || undefined,
      title: trimmedName,
      floppyId: selectedFloppyIds[0],
      personaPrompt: characterPrompt,
      characterCard: {
        name: trimmedName,
        prompt: characterPrompt,
        avatar: avatarAsset,
        background: backgroundAsset,
      },
      metadata: Object.keys(metadataPayload).length ? metadataPayload : undefined,
    };
    try {
      const saved = await onSaveSandbox(payload);
      if (saved?.id) {
        setCurrentSandboxId(saved.id);
        setSandboxMetadata(saved.metadata && typeof saved.metadata === 'object' ? { ...saved.metadata } : metadataPayload);
        setLocalStatus('Sandbox saved.');
        messageApi.open({ type: 'success', content: 'Sandbox saved.' });
      }
    } catch (err) {
      messageApi.open({ type: 'error', content: err?.message || 'Unable to save sandbox.' });
    }
  }, [avatarAsset, backgroundAsset, characterPrompt, currentSandboxId, messageApi, onSaveSandbox, sandboxMetadata, sandboxName, selectedFloppyIds]);

  const handleClearSandboxSelection = useCallback(() => {
    resetCharacterCard();
    onResetActiveSandbox();
  }, [onResetActiveSandbox, resetCharacterCard]);

  const handleRemoveAvatar = useCallback(() => {
    setAvatarAsset(null);
    setLocalStatus('');
  }, []);

  const handleRemoveBackground = useCallback(() => {
    setBackgroundAsset(null);
    setLocalStatus('');
  }, []);

  const sessionId = sandboxSession?.sessionId || '';
  useEffect(() => {
    if (sessionId) {
      messageApi.open({ type: 'success', content: `Sandbox ready — session ${sessionId.slice(0, 8)}…`, key: 'admin-sandbox-status' });
    }
  }, [messageApi, sessionId]);

  useEffect(() => {
    if (sandboxError) {
      messageApi.open({ type: 'error', content: sandboxError, key: 'admin-sandbox-error' });
    }
  }, [messageApi, sandboxError]);

  useEffect(() => {
    if (localError) {
      messageApi.open({ type: 'error', content: localError, key: 'admin-sandbox-local-error' });
    }
  }, [localError, messageApi]);

  const knowledgeButtonClass = `${styles.ghostButton} ${styles.snippetsButton}`;
  const canSaveSandbox = Boolean(onSaveSandbox) && sandboxName.trim() && selectedFloppyIds.length && !savingSandbox;
  const canLoadSandbox = hasFloppies && selectedFloppyIds.length && !sandboxLoading;
  const showClearSandboxButton = Boolean(
    currentSandboxId
      || sandboxName.trim()
      || characterPrompt.trim()
      || avatarAsset
      || backgroundAsset
      || selectedFloppyIds.length,
  );

  return (
    <>
      {contextHolder}
      <div className={styles.contentColumn}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Load a floppy</h2>
              <p className={styles.cardSubtitle}>
                Pick any floppy and spin up a dedicated sandbox chat. The agent will ingest the floppy knowledge as a retrieval source.
              </p>
            </div>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={onRefresh}
              disabled={loadingFloppies || sandboxLoading || sandboxSending}
            >
              {loadingFloppies ? 'Refreshing…' : 'Refresh floppies'}
            </button>
          </div>

          {hasFloppies ? (
            <div className={styles.formGrid}>
              <label className={`${styles.formField} ${styles.formFieldFull}`}>
                <span className={styles.label}>Available floppies</span>
                <select
                  className={styles.select}
                  value={selectedFloppyIds}
                  onChange={handleFloppySelectionChange}
                  disabled={sandboxLoading}
                  multiple
                  size={floppySelectSize}
                >
                  {floppies.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
                <span className={styles.hint}>
                  Hold ⌘ (Mac) or Ctrl (Windows) to select multiple floppies.
                </span>
                {selectedFloppySummary ? (
                  <span className={styles.hint}>Selected: {selectedFloppySummary}</span>
                ) : null}
              </label>

              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <span className={styles.label}>Description</span>
                <div className={styles.readonlyBox}>
                  {activeFloppies.length
                    ? activeFloppies.map((floppy) => {
                      const description = floppy.description || 'No description provided yet.';
                      return `${floppy.title || 'Untitled floppy'} — ${description}`;
                    }).join('\n\n')
                    : 'Select one or more floppies to read their descriptions.'}
                </div>
              </div>

              <div className={`${styles.formField} ${styles.formFieldFull}`}>
                <span className={styles.label}>Knowledge snippets ({knowledgeSnippetCount})</span>
                {knowledgeSnippetCount ? (
                  <div className={styles.fieldActionRow}>
                    <button
                      type="button"
                      className={knowledgeButtonClass}
                      onClick={() => setIsKnowledgeModalOpen(true)}
                    >
                      Show knowledge snippets
                    </button>
                    <span className={styles.hint}>Opens a modal with the loaded snippets.</span>
                  </div>
                ) : (
                  <div className={styles.readonlyBox}>
                    No knowledge snippets were provided for the selected floppies yet.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.emptyState}>
              No floppies available. Create one in the Floppy builder tab to get started.
            </div>
          )}

          {localError ? (
            <div className={styles.statusError}>{localError}</div>
          ) : null}

        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Character card</h2>
              <p className={styles.cardSubtitle}>
                Upload persona visuals and prompts to reuse whenever you launch a sandbox session.
              </p>
            </div>
          </div>

          <div className={styles.characterCardLayout}>
            <div className={styles.characterCardForm}>
              <label className={styles.formField}>
                <span className={styles.label}>Sandbox name</span>
                <input
                  className={styles.input}
                  value={sandboxName}
                  onChange={(event) => setSandboxName(event.target.value)}
                  placeholder="e.g. Primary Maths Buddy"
                  disabled={savingSandbox}
                />
              </label>

              <label className={styles.formField}>
                <span className={styles.label}>Character prompt</span>
                <textarea
                  className={styles.textarea}
                  rows={4}
                  value={characterPrompt}
                  onChange={(event) => setCharacterPrompt(event.target.value)}
                  placeholder="Describe the persona, tone, and context for this sandbox."
                />
              </label>

              <div className={styles.characterAssetRow}>
                <div className={styles.characterAssetField}>
                  <span className={styles.label}>Avatar image</span>
                  <div className={styles.characterAssetControls}>
                    <label className={styles.uploadButton}>
                      <UploadOutlined aria-hidden="true" />
                      <span>{avatarAsset ? 'Replace avatar' : 'Upload avatar'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        className={styles.uploadInput}
                        onChange={handleAvatarChange}
                      />
                    </label>
                    {avatarAsset ? (
                      <button
                        type="button"
                        className={styles.iconButtonSecondary}
                        onClick={handleRemoveAvatar}
                        aria-label="Remove avatar"
                      >
                        <DeleteOutlined aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  <span className={styles.hint}>PNG or JPG up to {IMAGE_LIMIT_LABEL}.</span>
                </div>

                <div className={styles.characterAssetField}>
                  <span className={styles.label}>Background image</span>
                  <div className={styles.characterAssetControls}>
                    <label className={styles.uploadButton}>
                      <UploadOutlined aria-hidden="true" />
                      <span>{backgroundAsset ? 'Replace background' : 'Upload background'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        className={styles.uploadInput}
                        onChange={handleBackgroundChange}
                      />
                    </label>
                    {backgroundAsset ? (
                      <button
                        type="button"
                        className={styles.iconButtonSecondary}
                        onClick={handleRemoveBackground}
                        aria-label="Remove background"
                      >
                        <DeleteOutlined aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  <span className={styles.hint}>Shown behind the avatar in the sandbox manager.</span>
                </div>
              </div>
            </div>

            <div className={styles.characterCardPreview}>
              <div
                className={styles.characterPreviewFrame}
                style={backgroundAsset?.dataUrl ? { backgroundImage: `url(${backgroundAsset.dataUrl})` } : undefined}
              >
                <div className={styles.characterPreviewAvatar}>
                  {avatarAsset?.dataUrl ? (
                    <img src={avatarAsset.dataUrl} alt="Sandbox avatar preview" />
                  ) : (
                    <div className={styles.characterPreviewPlaceholder}>
                      <PictureOutlined aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className={styles.characterPreviewName}>{sandboxName || 'Sandbox persona'}</div>
              </div>
            </div>
          </div>

          <div className={styles.formSectionActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSaveSandboxClick}
              disabled={!canSaveSandbox}
            >
              <SaveOutlined aria-hidden="true" />
              <span>{savingSandbox ? 'Saving…' : currentSandboxId ? 'Update sandbox' : 'Save sandbox'}</span>
            </button>
            <button
              type="button"
              className={styles.loadSandboxButton}
              onClick={handleStart}
              disabled={!canLoadSandbox}
              title={selectedFloppyIds.length ? 'Load the selected floppies into the sandbox' : 'Select at least one floppy to enable loading'}
            >
              {sandboxLoading ? <LoadingOutlined aria-hidden="true" spin /> : <PlayCircleOutlined aria-hidden="true" />}
              <span>{sandboxLoading ? 'Loading…' : 'Load into sandbox'}</span>
            </button>
            {showClearSandboxButton ? (
              <button
                type="button"
                className={styles.ghostButton}
                onClick={handleClearSandboxSelection}
                disabled={savingSandbox}
              >
                Clear selection
              </button>
            ) : null}
            {sandboxSession?.sessionId ? (
              <span className={styles.statusSuccess}>
                Sandbox ready — session {sandboxSession.sessionId.slice(0, 8)}…
              </span>
            ) : null}
            {localStatus ? (
              <span className={styles.statusSuccess} role="status">{localStatus}</span>
            ) : null}
          </div>
        </section>

        {isKnowledgeModalOpen ? (
          <div
            className={`${styles.modalOverlay} ${styles.modalOverlayCentered}`}
            role="dialog"
            aria-modal="true"
            aria-label="Knowledge snippets"
          >
            <div className={styles.modalContent} tabIndex={-1}>
              <div className={styles.modalHeader}>
                <div>
                  <h2 className={styles.modalTitle}>Knowledge snippets</h2>
                  <p className={styles.modalSubtitle}>
                    {`Showing ${knowledgeSnippetCount} snippet${knowledgeSnippetCount === 1 ? '' : 's'}`}
                    {knowledgeModalSubject}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.modalCloseButton}
                  onClick={() => setIsKnowledgeModalOpen(false)}
                  aria-label="Close knowledge snippets"
                >
                  Close
                </button>
              </div>
              <div className={styles.modalBody}>
                <div className={styles.snippetModalList}>
                  <ul className={styles.knowledgeList}>
                    {knowledgeSnippetItems.map(({ key, text, floppyTitle }) => (
                      <li key={key}>
                        <span className={styles.snippetText}>
                          {activeFloppies.length > 1 ? `${floppyTitle}: ` : ''}
                          {text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function SandboxConversation({
  sandboxSession,
  sandboxHistory = [],
  sandboxLoading = false,
  sandboxSending = false,
  sandboxError = '',
  onSendMessage,
}) {
  const [inputMessage, setInputMessage] = useState('');
  const [localError, setLocalError] = useState('');

  const currentStatus = sandboxLoading
    ? 'Preparing sandbox session…'
    : sandboxSending
      ? 'Agent is thinking…'
      : '';

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLocalError('');
    const trimmed = inputMessage.trim();
    if (!trimmed) {
      setLocalError('Enter a message to send to the sandbox agent.');
      return;
    }
    try {
      await onSendMessage?.(trimmed);
      setInputMessage('');
    } catch (err) {
      setLocalError(err?.message || 'The sandbox agent could not process your message.');
    }
  };

  const statusMessage = sandboxError || localError;

  return (
    <section className={`${styles.card} ${styles.conversationCard}`}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>Sandbox conversation</h2>
          <p className={styles.cardSubtitle}>
            Ask questions and validate responses against the floppy knowledge. Reset by loading a new sandbox session.
          </p>
        </div>
        {currentStatus ? <span className={styles.loader}>{currentStatus}</span> : null}
      </div>

      {statusMessage ? <div className={styles.statusError}>{statusMessage}</div> : null}

      {sandboxSession?.sessionId ? (
        <>
          <div className={styles.chatWindow}>
            {sandboxHistory.length ? (
              <div className={styles.chatHistory}>
                {sandboxHistory.map((entry, index) => (
                  <MessageBubble key={`${entry.role}-${index}-${entry.content.slice(0, 12)}`} entry={entry} />
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                Start the conversation by asking the agent a question about the loaded floppies.
              </div>
            )}
          </div>
          <form className={styles.chatInputRow} onSubmit={handleSubmit}>
            <input
              className={styles.chatInput}
              type="text"
              value={inputMessage}
              onChange={(event) => setInputMessage(event.target.value)}
              placeholder="Ask the agent to explain or verify something…"
              disabled={sandboxSending}
            />
            <button type="submit" className={styles.primaryButton} disabled={sandboxSending}>
              {sandboxSending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </>
      ) : (
        <div className={styles.emptyState}>
          Load at least one floppy into the sandbox to open an interactive chat.
        </div>
      )}
    </section>
  );
}
