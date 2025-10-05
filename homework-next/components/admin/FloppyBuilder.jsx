'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message, Modal } from 'antd';
import {
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  FormOutlined,
  LoadingOutlined,
  PlusOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import styles from './admin.module.css';

function normaliseKnowledgeGroupsSnapshot(groups = []) {
  return [...groups]
    .map((group) => ({
      id: group?.id || '',
      name: (group?.name || '').trim(),
      description: (group?.description || '').trim(),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function createFormSnapshot({ title = '', description = '', knowledge = '', knowledgeGroups = [] }) {
  return {
    title: (title || '').trim(),
    description: (description || '').trim(),
    knowledge: knowledge || '',
    groups: normaliseKnowledgeGroupsSnapshot(knowledgeGroups),
  };
}

function snapshotKeyFromValues(values) {
  return JSON.stringify(createFormSnapshot(values));
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return String(value);
  }
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = numeric;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

export default function FloppyBuilder({
  floppies = [],
  onCreate,
  onUpdate,
  onDelete,
  loading = false,
  creating = false,
  error = '',
  onRefresh,
  onUploadKnowledge,
  uploadingKnowledge = false,
  uploadError = '',
  onDeleteKnowledgeFile = null,
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [knowledge, setKnowledge] = useState('');
  const [status, setStatus] = useState('');
  const [formError, setFormError] = useState('');
  const [editingId, setEditingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteFloppyPendingId, setDeleteFloppyPendingId] = useState('');
  const [deleteFilePendingId, setDeleteFilePendingId] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadOutcomes, setUploadOutcomes] = useState([]);
  const [knowledgeGroups, setKnowledgeGroups] = useState([]);
  const [uploadGroupId, setUploadGroupId] = useState('');
  const [initialKnowledgeBaseline, setInitialKnowledgeBaseline] = useState('');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState('create');
  const [deleteConfirm, setDeleteConfirm] = useState({ type: null, floppy: null, file: null });
  const builderRef = useRef(null);
  const titleInputRef = useRef(null);
  const confirmButtonRef = useRef(null);
  const [messageApi, contextHolder] = message.useMessage();

  const isEditing = modalMode === 'edit' && Boolean(editingId);

  const baselineSnapshotRef = useRef(snapshotKeyFromValues({
    title: '',
    description: '',
    knowledge: '',
    knowledgeGroups: [],
  }));

  const setBaselineSnapshot = useCallback((values) => {
    baselineSnapshotRef.current = snapshotKeyFromValues(values);
  }, []);

  const currentSnapshotKey = useMemo(
    () => snapshotKeyFromValues({
      title,
      description,
      knowledge,
      knowledgeGroups,
    }),
    [title, description, knowledge, knowledgeGroups],
  );

  const hasUnsavedChanges = useMemo(
    () => currentSnapshotKey !== baselineSnapshotRef.current,
    [currentSnapshotKey],
  );

  const syncGroupsFromServer = useCallback((incomingGroups) => {
    if (!Array.isArray(incomingGroups)) {
      setKnowledgeGroups([]);
      setUploadGroupId('');
      return [];
    }
    const sanitisedIncoming = incomingGroups.map((group) => ({
      id: group?.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `group-${Date.now()}`),
      name: group?.name || 'Untitled context',
      description: group?.description || '',
    }));

    let mergedResult = [];
    setKnowledgeGroups((previous) => {
      if (!previous.length) {
        mergedResult = sanitisedIncoming.map((group) => ({ ...group }));
        return mergedResult;
      }
      const previousMap = new Map(previous.map((group) => [group.id, group]));
      const merged = sanitisedIncoming.map((group) => {
        const existing = previousMap.get(group.id);
        if (!existing) {
          return { ...group };
        }
        const nameChanged = existing.name !== undefined && existing.name !== group.name;
        const descriptionChanged = existing.description !== undefined && existing.description !== group.description;
        return {
          ...group,
          name: nameChanged ? existing.name : group.name,
          description: descriptionChanged ? existing.description : group.description,
        };
      });
      previous.forEach((group) => {
        if (!sanitisedIncoming.some((incoming) => incoming.id === group.id)) {
          merged.push({ ...group });
        }
      });
      mergedResult = merged;
      return merged;
    });

    setUploadGroupId((current) => {
      if (!mergedResult.some((group) => group.id === current)) {
        return mergedResult[0]?.id || '';
      }
      return current;
    });

    return mergedResult;
  }, []);

  const resetFormState = useCallback(() => {
    setTitle('');
    setDescription('');
    setKnowledge('');
    setInitialKnowledgeBaseline('');
    setStatus('');
    setFormError('');
    setUploadStatus('');
    setUploadOutcomes([]);
    setSaving(false);
    setDeleteFloppyPendingId('');
    setDeleteFilePendingId('');
    setDeleteConfirm({ type: null, floppy: null, file: null });
    setKnowledgeGroups([]);
    setUploadGroupId('');
    setBaselineSnapshot({
      title: '',
      description: '',
      knowledge: '',
      knowledgeGroups: [],
    });
  }, [setBaselineSnapshot]);

  const confirmUnsavedChanges = useCallback(
    ({
      title: confirmTitle = 'Discard unsaved changes?',
      content: confirmContent = 'You have unsaved changes. Continue without saving?',
      okText: confirmOkText = 'Discard changes',
      cancelText: confirmCancelText = 'Keep editing',
    } = {}) =>
      new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        Modal.confirm({
          title: confirmTitle,
          content: confirmContent,
          icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
          okText: confirmOkText,
          cancelText: confirmCancelText,
          okType: 'danger',
          centered: true,
          maskClosable: true,
          closable: true,
          onOk: () => settle(true),
          onCancel: () => settle(false),
          afterClose: () => settle(false),
        });
      }),
    [],
  );

  const openCreateModal = useCallback(async () => {
    if (isModalOpen && hasUnsavedChanges) {
      const confirmed = await confirmUnsavedChanges({
        content: 'Start a new floppy without saving your changes?',
        okText: 'Discard and create new',
      });
      if (!confirmed) {
        return;
      }
    }
    resetFormState();
    setModalMode('create');
    setEditingId('');
    setIsModalOpen(true);
  }, [confirmUnsavedChanges, hasUnsavedChanges, isModalOpen, resetFormState]);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setModalMode('create');
    setEditingId('');
    setDeleteConfirm({ type: null, floppy: null, file: null });
    resetFormState();
  }, [resetFormState]);

  const handleRequestCloseModal = useCallback(
    async ({ force = false } = {}) => {
      if (!force && hasUnsavedChanges) {
        const confirmed = await confirmUnsavedChanges({
          content: 'Close without saving your changes?',
        });
        if (!confirmed) {
          return;
        }
      }
      closeModal();
    },
    [closeModal, confirmUnsavedChanges, hasUnsavedChanges],
  );
  const totalFloppies = useMemo(() => floppies.length, [floppies]);
  const floppyMetrics = useMemo(() => {
    if (!floppies.length) {
      return {
        total: 0,
        documents: 0,
        chunks: 0,
        lastUpdated: null,
      };
    }

    let documents = 0;
    let chunks = 0;
    let latest = 0;

    floppies.forEach((item) => {
      documents += item.knowledgeFiles?.length || 0;
      chunks += item.knowledgeChunkCount || item.knowledgeChunks?.length || 0;
      const timestamp = new Date(item.updatedAt || item.createdAt || 0).getTime();
      if (Number.isFinite(timestamp) && timestamp > latest) {
        latest = timestamp;
      }
    });

    return {
      total: floppies.length,
      documents,
      chunks,
      lastUpdated: latest ? new Date(latest) : null,
    };
  }, [floppies]);

  const editingFloppy = useMemo(() => {
    if (!isEditing) return null;
    return floppies.find((item) => item.id === editingId) || null;
  }, [floppies, isEditing, editingId]);

  const filteredFloppies = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return floppies;

    const matches = floppies.filter((item) => {
      const haystack = [item.title, item.description, item.createdBy]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    if (isEditing && editingId) {
      const editingItem = floppies.find((item) => item.id === editingId);
      if (editingItem && !matches.some((item) => item.id === editingItem.id)) {
        return [editingItem, ...matches];
      }
    }

    return matches;
  }, [floppies, search, isEditing, editingId]);

  const hasActiveFilters = Boolean(search.trim());

  useEffect(() => {
    setUploadStatus('');
    setUploadOutcomes([]);
  }, [editingId, isEditing]);

  useEffect(() => {
    if (status) {
      messageApi.open({ type: 'success', content: status, key: 'admin-floppy-status' });
    }
  }, [messageApi, status]);

  useEffect(() => {
    if (uploadStatus) {
      messageApi.open({ type: 'info', content: uploadStatus, key: 'admin-floppy-upload' });
    }
  }, [messageApi, uploadStatus]);

  useEffect(() => {
    if (formError) {
      messageApi.open({ type: 'error', content: formError, key: 'admin-floppy-form-error' });
    }
  }, [formError, messageApi]);

  useEffect(() => {
    if (error) {
      messageApi.open({ type: 'error', content: error, key: 'admin-floppy-error' });
    }
  }, [error, messageApi]);

  useEffect(() => {
    if (uploadError) {
      messageApi.open({ type: 'error', content: uploadError, key: 'admin-floppy-upload-error' });
    }
  }, [messageApi, uploadError]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');
    setStatus('');

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError('Give your floppy a title before creating it.');
      return;
    }

    const trimmedDescription = description.trim();
    const normalisedGroups = knowledgeGroups.map((group) => ({
      id: group.id,
      name: group.name?.trim() || 'Untitled context',
      description: group.description?.trim() || '',
    }));

    const payload = {
      title: trimmedTitle,
      description: trimmedDescription,
      knowledge,
      knowledgeGroups: normalisedGroups,
    };

    setSaving(true);
    try {
      if (isEditing) {
        const updated = await onUpdate?.(editingId, payload);
        const nextTitle = updated?.title || payload.title;
        const nextDescription = updated?.description || payload.description;
        const nextKnowledge = updated?.knowledge ?? knowledge;
        const nextGroups = Array.isArray(updated?.knowledgeGroups) && updated.knowledgeGroups.length
          ? updated.knowledgeGroups.map((group) => ({
              id: group?.id || '',
              name: (group?.name || '').trim() || 'Untitled context',
              description: (group?.description || '').trim() || '',
            }))
          : normalisedGroups;

        setTitle(nextTitle);
        setDescription(nextDescription);
        setKnowledge(nextKnowledge);
        setInitialKnowledgeBaseline(nextKnowledge || '');
        setKnowledgeGroups(nextGroups);
        setBaselineSnapshot({
          title: nextTitle,
          description: nextDescription,
          knowledge: nextKnowledge,
          knowledgeGroups: nextGroups,
        });
        setStatus('Floppy details saved.');
      } else {
        await onCreate?.(payload);
        setStatus('Floppy created successfully – you can now test it below.');
        resetFormState();
        setIsModalOpen(false);
        setModalMode('create');
        setEditingId('');
      }
    } catch (err) {
      setFormError(err?.message || 'Failed to save floppy.');
    } finally {
      setSaving(false);
    }
  };

  const handleEditClick = useCallback(async (floppy) => {
    if (!floppy) return;
    if (isModalOpen && hasUnsavedChanges && editingId !== floppy.id) {
      const confirmed = await confirmUnsavedChanges({
        content: `Switch floppies without saving your changes?`,
      });
      if (!confirmed) {
        return;
      }
    }
    resetFormState();
    setModalMode('edit');
    setEditingId(floppy.id);
    const nextTitle = floppy.title || '';
    const nextDescription = floppy.description || '';
    const nextKnowledge = floppy.knowledge || '';
    setTitle(nextTitle);
    setDescription(nextDescription);
    setKnowledge(nextKnowledge);
    setInitialKnowledgeBaseline(nextKnowledge);
    setFormError('');
    setUploadStatus('');
    setUploadOutcomes([]);
    const incomingGroups = Array.isArray(floppy.knowledgeGroups) ? floppy.knowledgeGroups : [];
    const syncedGroups = syncGroupsFromServer(incomingGroups);
    setBaselineSnapshot({
      title: nextTitle,
      description: nextDescription,
      knowledge: nextKnowledge,
      knowledgeGroups: syncedGroups,
    });
    setIsModalOpen(true);
  }, [
    confirmUnsavedChanges,
    editingId,
    hasUnsavedChanges,
    isModalOpen,
    resetFormState,
    setBaselineSnapshot,
    syncGroupsFromServer,
  ]);

  const handleDeleteClick = (floppy) => {
    if (!floppy?.id || !onDelete) return;
    setDeleteConfirm({ type: 'floppy', floppy, file: null });
    setFormError('');
  };

  const handleKnowledgeDeleteClick = (file) => {
    if (!file?.id || !onDeleteKnowledgeFile || !editingFloppy) return;
    setUploadStatus('');
    setUploadOutcomes([]);
    setDeleteConfirm({ type: 'file', floppy: editingFloppy, file });
  };

  const handleCancelDelete = () => {
    if (deleteConfirm.type === 'floppy' && deleteFloppyPendingId) return;
    if (deleteConfirm.type === 'file' && deleteFilePendingId) return;
    setDeleteConfirm({ type: null, floppy: null, file: null });
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirm.type) return;
    const targetFloppyId = deleteConfirm.floppy?.id;
    setFormError('');

    if (deleteConfirm.type === 'floppy') {
      if (!targetFloppyId || !onDelete) return;
      setDeleteFloppyPendingId(targetFloppyId);
      try {
        await onDelete(targetFloppyId);
        if (editingId === targetFloppyId) {
          closeModal();
        }
        setStatus('Floppy deleted successfully.');
      } catch (err) {
        setFormError(err?.message || 'Failed to delete floppy.');
      } finally {
        setDeleteFloppyPendingId('');
        setDeleteConfirm({ type: null, floppy: null, file: null });
      }
      return;
    }

    if (deleteConfirm.type === 'file') {
      const fileId = deleteConfirm.file?.id;
      if (!targetFloppyId || !fileId || !onDeleteKnowledgeFile) {
        setDeleteConfirm({ type: null, floppy: null, file: null });
        return;
      }
      setDeleteFilePendingId(fileId);
      try {
        const result = await onDeleteKnowledgeFile({ floppyId: targetFloppyId, fileId });
        setUploadOutcomes([]);
        setUploadStatus('Document removed from floppy.');
        const wasPristineBeforeDelete = !hasUnsavedChanges;
        if (result?.floppy?.id === editingId) {
          const incomingGroups = Array.isArray(result.floppy.knowledgeGroups) ? result.floppy.knowledgeGroups : [];
          const syncedGroups = syncGroupsFromServer(incomingGroups);
          const serverDescription = result.floppy.description || description;
          const serverKnowledge = result.floppy.knowledge || '';
          setDescription(serverDescription);
          const nextKnowledgeValue = knowledge === initialKnowledgeBaseline ? serverKnowledge : knowledge;
          if (knowledge === initialKnowledgeBaseline) {
            setKnowledge(serverKnowledge);
            setInitialKnowledgeBaseline(serverKnowledge);
          }
          if (wasPristineBeforeDelete) {
            setBaselineSnapshot({
              title,
              description: serverDescription,
              knowledge: nextKnowledgeValue,
              knowledgeGroups: syncedGroups,
            });
          }
        }
      } catch (err) {
        setUploadOutcomes([]);
        setUploadStatus(err?.message || 'Failed to remove document.');
      } finally {
        setDeleteFilePendingId('');
        setDeleteConfirm({ type: null, floppy: null, file: null });
      }
    }
  };

  useEffect(() => {
    if (isEditing && editingId && !floppies.some((item) => item.id === editingId)) {
      setEditingId('');
      setTitle('');
      setDescription('');
      setLevel('primary');
      setKnowledge('');
    }
  }, [isEditing, editingId, floppies]);

  useEffect(() => {
    if (!isModalOpen) return;
    if (typeof window === 'undefined') return;

    window.requestAnimationFrame(() => {
      const focusTarget = titleInputRef.current || builderRef.current;
      if (!focusTarget) return;
      try {
        focusTarget.focus({ preventScroll: true });
      } catch (err) {
        focusTarget.focus();
      }
    });
  }, [isModalOpen]);

  useEffect(() => {
    if (!deleteConfirm.type) return;
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      confirmButtonRef.current?.focus();
    });
  }, [deleteConfirm]);

  const handleUploadChange = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }
    if (!onUploadKnowledge) {
      setUploadStatus('Document upload is not available.');
      event.target.value = '';
      return;
    }
    if (!isEditing || !editingId) {
      setUploadStatus('Open a floppy for editing before uploading documents.');
      event.target.value = '';
      return;
    }

    setUploadStatus('');
    setUploadOutcomes([]);
    const wasPristineBeforeUpload = !hasUnsavedChanges;

    try {
      const selectedGroup = knowledgeGroups.find((group) => group.id === uploadGroupId);
      const result = await onUploadKnowledge({
        floppyId: editingId,
        files,
        group: selectedGroup
          ? {
              id: selectedGroup.id,
              name: selectedGroup.name,
              description: selectedGroup.description,
            }
          : null,
      });
      const outcomes = result?.outcomes || [];
      setUploadOutcomes(outcomes);
      const successes = outcomes.filter((item) => item?.chunkCount);
      const failures = outcomes.filter((item) => item?.error);
      if (successes.length && !failures.length) {
        setUploadStatus(`Processed ${successes.length} document${successes.length === 1 ? '' : 's'}.`);
      } else if (successes.length || failures.length) {
        setUploadStatus('Upload completed with messages below.');
      } else {
        setUploadStatus('Upload completed.');
      }
      if (result?.floppy?.id === editingId) {
        const incomingGroups = Array.isArray(result.floppy.knowledgeGroups) ? result.floppy.knowledgeGroups : [];
        const syncedGroups = syncGroupsFromServer(incomingGroups);
        const serverDescription = result.floppy.description || description;
        const serverKnowledge = result.floppy.knowledge || '';
        setDescription(serverDescription);
        const nextKnowledgeValue = knowledge === initialKnowledgeBaseline ? serverKnowledge : knowledge;
        if (knowledge === initialKnowledgeBaseline) {
          setKnowledge(serverKnowledge);
          setInitialKnowledgeBaseline(serverKnowledge);
        }
        if (wasPristineBeforeUpload) {
          setBaselineSnapshot({
            title,
            description: serverDescription,
            knowledge: nextKnowledgeValue,
            knowledgeGroups: syncedGroups,
          });
        }
      }
    } catch (err) {
      setUploadStatus(err?.message || 'Failed to upload documents.');
    } finally {
      event.target.value = '';
    }
  };

  const handleAddKnowledgeGroup = () => {
    setUploadStatus('');
    setUploadOutcomes([]);
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `group-${Date.now()}`;
    const nextGroups = [
      ...knowledgeGroups,
      {
        id: newId,
        name: `Knowledge context ${knowledgeGroups.length + 1}`,
        description: '',
      },
    ];
    setKnowledgeGroups(nextGroups);
    setUploadGroupId(newId);
  };

  const handleKnowledgeGroupChange = (id, key, value) => {
    setUploadStatus('');
    setUploadOutcomes([]);
    setKnowledgeGroups((prev) => prev.map((group) => {
      if (group.id !== id) return group;
      return {
        ...group,
        [key]: value,
      };
    }));
  };

  const handleRemoveKnowledgeGroup = (id) => {
    const hasFiles = knowledgeFiles.some((file) => file.groupId === id);
    if (hasFiles) {
      setUploadStatus('Remove documents from this context before deleting it.');
      return;
    }
    setKnowledgeGroups((prev) => prev.filter((group) => group.id !== id));
    setUploadGroupId((current) => (current === id ? '' : current));
    setUploadStatus('Context removed.');
  };

  const submitLabel = isEditing
    ? (saving ? 'Saving…' : 'Save changes')
    : (creating || saving)
      ? 'Saving…'
      : 'Create floppy';
  const submitDisabled = creating || saving;
  const submitIcon = saving
    ? <LoadingOutlined aria-hidden="true" spin />
    : modalMode === 'edit'
      ? <SaveOutlined aria-hidden="true" />
      : <PlusCircleOutlined aria-hidden="true" />;
  const formId = modalMode === 'edit' ? 'floppy-edit-form' : 'floppy-create-form';
  const isDeleteDialogOpen = Boolean(deleteConfirm.type);
  const deleteDialogBusy = deleteConfirm.type === 'floppy'
    ? deleteFloppyPendingId === deleteConfirm.floppy?.id
    : deleteConfirm.type === 'file'
      ? deleteFilePendingId === deleteConfirm.file?.id
      : false;
  const deleteDialogTitle = deleteConfirm.type === 'file' ? 'Remove document?' : 'Delete floppy?';
  const deleteDialogGroupNameRaw = deleteConfirm.type === 'file'
    ? (knowledgeGroups.find((group) => group.id === (deleteConfirm.file?.groupId || ''))?.name || 'General context')
    : null;
  const deleteDialogGroupLabel = deleteDialogGroupNameRaw
    ? (deleteDialogGroupNameRaw.toLowerCase().includes('context') ? deleteDialogGroupNameRaw : `${deleteDialogGroupNameRaw} context`)
    : null;
  const deleteDialogMessage = deleteConfirm.type === 'file'
    ? `Remove “${deleteConfirm.file?.name || 'Document'}” from the ${deleteDialogGroupLabel || 'context'}? This only deletes the attachment.`
    : `Are you sure you want to delete “${deleteConfirm.floppy?.title || 'Untitled floppy'}”? This action cannot be undone.`;
  const knowledgeFiles = useMemo(() => editingFloppy?.knowledgeFiles || [], [editingFloppy]);
  const disableKnowledgeUpload =
    !onUploadKnowledge
    || uploadingKnowledge
    || deleteFilePendingId
    || deleteFloppyPendingId
    || !isEditing
    || isDeleteDialogOpen;
  const groupedKnowledge = useMemo(() => {
    const groups = knowledgeGroups.map((group) => ({
      ...group,
      files: knowledgeFiles.filter((file) => (file.groupId || '') === group.id),
    }));
    const groupIds = new Set(knowledgeGroups.map((group) => group.id));
    const ungrouped = knowledgeFiles.filter((file) => !groupIds.has(file.groupId || ''));
    return { groups, ungrouped };
  }, [knowledgeGroups, knowledgeFiles]);
  const activeGroupData = uploadGroupId
    ? knowledgeGroups.find((group) => group.id === uploadGroupId) || null
    : null;
  const activeGroupSummary = uploadGroupId
    ? groupedKnowledge.groups.find((group) => group.id === uploadGroupId) || null
    : null;
  const generalDocCount = groupedKnowledge.ungrouped.length;
  const activeGroupDocCount = activeGroupSummary ? activeGroupSummary.files.length : 0;

  useEffect(() => {
    if (uploadGroupId && !knowledgeGroups.some((group) => group.id === uploadGroupId)) {
      setUploadGroupId('');
    }
  }, [uploadGroupId, knowledgeGroups]);

  const libraryGroups = useMemo(() => {
    const allGroups = groupedKnowledge.groups.map((summary) => {
      const data = knowledgeGroups.find((group) => group.id === summary.id);
      return {
        id: summary.id,
        name: data?.name || 'Untitled context',
        description: data?.description || '',
        files: summary.files,
      };
    });
    return [
      {
        id: '',
        name: 'General context',
        description: '',
        files: groupedKnowledge.ungrouped,
      },
      ...allGroups,
    ];
  }, [groupedKnowledge, knowledgeGroups]);
  const totalKnowledgeContexts = libraryGroups.length;
  const totalKnowledgeDocuments = libraryGroups.reduce((total, group) => total + group.files.length, 0);

  return (
    <>
      {contextHolder}
      <div className={styles.contentColumn}>
        <section className={`${styles.card} ${styles.statsCard}`}>
        <div className={styles.metricGrid}>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Total floppies</span>
            <span className={styles.metricValue}>{floppyMetrics.total}</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Attached documents</span>
            <span className={styles.metricValue}>{floppyMetrics.documents}</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Knowledge chunks</span>
            <span className={styles.metricValue}>{floppyMetrics.chunks}</span>
          </div>
          <div className={`${styles.metric} ${styles.metricSecondary}`}>
            <span className={styles.metricLabel}>Last update</span>
            <span className={styles.metricValue}>
              {floppyMetrics.lastUpdated ? formatDate(floppyMetrics.lastUpdated) : '—'}
            </span>
          </div>
        </div>
        </section>

        <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>Floppy test bench</h2>
            <p className={styles.cardSubtitle}>
              {`You have ${totalFloppies} floppy${totalFloppies === 1 ? '' : 's'} ready to test.`}
            </p>
          </div>
          <div className={styles.cardHeaderActions}>
            {error ? <span className={styles.statusError}>{error}</span> : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={openCreateModal}
              disabled={creating || saving}
              aria-label="Create floppy"
              title="Create floppy"
            >
              <PlusCircleOutlined aria-hidden="true" />
            </button>
          </div>
        </div>

        <div aria-live="polite" className={styles.visuallyHidden}>{status}</div>

        {isEditing ? (
          <div className={styles.editingNotice}>
            Editing <strong>{editingFloppy?.title || 'Untitled floppy'}</strong>. Finish your updates below or select a different floppy to switch context.
          </div>
        ) : null}

        {totalFloppies ? (
          <div className={styles.searchRow}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search by title or author"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search floppies"
            />
            {hasActiveFilters ? (
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() => setSearch('')}
                aria-label="Clear search"
                title="Clear search"
              >
                <CloseCircleOutlined aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className={styles.loader}>Loading floppies…</div>
        ) : totalFloppies ? (
          filteredFloppies.length ? (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Created by</th>
                    <th>Created at</th>
                    <th>Last updated</th>
                    <th>Documents</th>
                    <th>Knowledge</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFloppies.map((item) => (
                    <tr
                      key={item.id}
                      className={item.id === editingId ? styles.tableRowActive : undefined}
                      aria-selected={item.id === editingId}
                    >
                      <td>{item.title}</td>
                      <td>{item.createdBy || '—'}</td>
                      <td>
                        <span className={styles.timestamp}>{formatDate(item.createdAt)}</span>
                      </td>
                      <td>
                        <span className={styles.timestamp}>{formatDate(item.updatedAt)}</span>
                      </td>
                      <td>
                        <span className={styles.badge}>{item.knowledgeFiles?.length || 0}</span>
                      </td>
                      <td>
                        <span className={styles.badge}>
                          {item.knowledgeChunkCount || item.knowledgeChunks?.length || 0}
                        </span>
                      </td>
                      <td>
                        <div className={styles.tableActions}>
                                <button
                                  type="button"
                                  className={styles.ghostButton}
                                  onClick={() => handleEditClick(item)}
                                  disabled={
                                    saving
                                    || deleteFloppyPendingId === item.id
                                    || item.id === editingId
                                    || isDeleteDialogOpen
                                  }
                                  aria-label={item.id === editingId ? 'Editing floppy' : `Edit ${item.title || 'floppy'}`}
                                  title={item.id === editingId ? 'Editing floppy' : `Edit ${item.title || 'floppy'}`}
                                >
                                  <EditOutlined aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className={styles.dangerButton}
                                  onClick={() => handleDeleteClick(item)}
                                  disabled={deleteFloppyPendingId === item.id || saving || isDeleteDialogOpen}
                                  aria-label={`Delete ${item.title || 'floppy'}`}
                                  title={`Delete ${item.title || 'floppy'}`}
                                >
              <DeleteOutlined aria-hidden="true" />
            </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyState}>
              No floppies match your search. Try a different keyword or clear the filter to see all floppies.
            </div>
          )
        ) : (
          <div className={styles.emptyState}>
            No floppies yet. Create your first floppy above and it will appear here for testing.
          </div>
        )}
      </section>

      {isModalOpen ? (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label={modalMode === 'edit' ? 'Edit floppy' : 'Create a new floppy'}
        >
          <div className={styles.modalContent} ref={builderRef} tabIndex={-1}>
            <div className={styles.modalHeader}>
              <div>
                <h2 className={styles.modalTitle}>
                  {modalMode === 'edit' ? 'Edit floppy' : 'Create a new floppy'}
                </h2>
                <p className={styles.modalSubtitle}>
                  {modalMode === 'edit'
                    ? `Update the details or knowledge for “${editingFloppy?.title || 'Untitled floppy'}”. Save your changes when you are done.`
                    : 'Configure a guided experience for your learners. Save it here and then run a quick test with the live assistant.'}
                </p>
              </div>
              <div className={styles.modalHeaderButtons}>
                <button
                  type="button"
                  className={styles.modalCloseButton}
                  onClick={() => handleRequestCloseModal()}
                  aria-label="Close builder"
                  title="Close builder"
                >
                  <CloseOutlined aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.modalMain}>
                <form id={formId} onSubmit={handleSubmit} className={styles.builderForm}>
                  <div className={styles.formIntro}>
                    <span
                      className={`${styles.modalBadge} ${isEditing ? styles.modalBadgeEdit : styles.modalBadgeCreate}`}
                    >
                      {isEditing ? 'Editing floppy' : 'New floppy'}
                    </span>
                    <p>
                      {isEditing
                        ? 'Refresh the tone, prompts, or knowledge below. Changes are saved instantly once you hit confirm.'
                        : 'Capture the big idea, who it is for, and provide references so the assistant stays on track.'}
                    </p>
                  </div>

                  <div className={styles.formSection}>
                    <div className={styles.formSectionHeader}>
                      <span className={styles.formSectionIcon}>
                        <FormOutlined aria-hidden="true" />
                      </span>
                      <div>
                        <h3 className={styles.formSectionTitle}>Core details</h3>
                        <p className={styles.formSectionText}>Give the floppy a memorable title so team members can find it quickly.</p>
                      </div>
                    </div>
                    <div className={styles.formSectionGrid}>
                      <label className={styles.formField}>
                        <span className={styles.label}>Floppy title</span>
                        <input
                          className={styles.input}
                          type="text"
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          placeholder="e.g. Algebra warm-up floppy"
                          disabled={creating}
                          ref={titleInputRef}
                        />
                        <span className={styles.inputHint}>Use action-oriented language so learners know what to expect.</span>
                      </label>
                      
                      <label className={`${styles.formField} ${styles.formFieldFull}`}>
                        <span className={styles.label}>Description</span>
                        <textarea
                          className={`${styles.textarea} ${styles.textareaCompact}`}
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                          placeholder="Summarise this floppy for teammates – purpose, audience, or scenario."
                          disabled={creating}
                        />
                        <span className={styles.inputHint}>Keep it short and high-level – detailed instructions live in knowledge contexts.</span>
                      </label>
                    </div>
                  </div>

                  {isEditing && (
                    <>
                      <div className={styles.formSection}>
                        <div className={styles.formSectionHeader}>
                          <span className={styles.formSectionIcon}>
                            <FolderOpenOutlined aria-hidden="true" />
                          </span>
                          <div>
                            <h3 className={styles.formSectionTitle}>Knowledge grouping</h3>
                            <p className={styles.formSectionText}>Cluster related uploads into contexts so the assistant can pull the right evidence at the right time.</p>
                          </div>
                        </div>

                        <div className={styles.uploadGroupPicker}>
                          <span className={styles.uploadGroupLabel}>Contexts</span>
                          <div className={styles.uploadGroupChips}>
                            <button
                              type="button"
                              className={`${styles.uploadGroupChip} ${!uploadGroupId ? styles.uploadGroupChipActive : ''}`}
                              onClick={() => setUploadGroupId('')}
                              disabled={disableKnowledgeUpload && !!uploadGroupId}
                              aria-pressed={!uploadGroupId}
                            >
                              <span>General</span>
                              <span className={styles.uploadGroupChipCount}>{generalDocCount}</span>
                            </button>
                            {knowledgeGroups.map((group) => {
                              const summary = groupedKnowledge.groups.find((item) => item.id === group.id);
                              const count = summary ? summary.files.length : 0;
                              return (
                                <button
                                  key={group.id}
                                  type="button"
                                  className={`${styles.uploadGroupChip} ${uploadGroupId === group.id ? styles.uploadGroupChipActive : ''}`}
                                  onClick={() => setUploadGroupId(group.id)}
                                  disabled={disableKnowledgeUpload && uploadGroupId !== group.id}
                                  aria-pressed={uploadGroupId === group.id}
                                >
                                  <span>{group.name || 'Untitled context'}</span>
                                  <span className={styles.uploadGroupChipCount}>{count}</span>
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              className={styles.uploadGroupAdd}
                              onClick={handleAddKnowledgeGroup}
                              disabled={disableKnowledgeUpload}
                              aria-label="Add context"
                              title="Add context"
                            >
                              <PlusOutlined aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div className={styles.groupList}>
                          {!uploadGroupId ? (
                            <div className={`${styles.groupCard} ${styles.groupCardGeneral}`}>
                              <div className={styles.groupCardHeader}>
                                <span className={styles.groupGeneralTitle}>General context</span>
                                <span className={styles.groupFootnote}>
                                  {generalDocCount} document{generalDocCount === 1 ? '' : 's'} linked
                                </span>
                              </div>
                              <textarea
                                className={styles.groupDescriptionInput}
                                value={knowledge}
                                onChange={(event) => setKnowledge(event.target.value)}
                                placeholder="Use this space for manual notes, prompts, or fallback guidance."
                              />
                              <span className={styles.groupFootnote}>These notes are always available, regardless of document context.</span>
                            </div>
                          ) : null}

                          {uploadGroupId && activeGroupData ? (
                            <div className={styles.groupCard}>
                              <div className={styles.groupCardHeader}>
                                <input
                                  className={styles.groupNameInput}
                                  value={activeGroupData.name}
                                  onChange={(event) => handleKnowledgeGroupChange(activeGroupData.id, 'name', event.target.value)}
                                  placeholder="Context name"
                                />
                                <button
                                  type="button"
                                  className={styles.groupRemoveButton}
                                  onClick={() => handleRemoveKnowledgeGroup(activeGroupData.id)}
                                  disabled={activeGroupDocCount > 0}
                                  aria-label="Remove context"
                                  title={activeGroupDocCount > 0 ? 'Remove documents from this context before deleting it' : 'Remove context'}
                                >
                                  <DeleteOutlined aria-hidden="true" />
                                </button>
                              </div>
                              <textarea
                                className={styles.groupDescriptionInput}
                                value={activeGroupData.description}
                                onChange={(event) => handleKnowledgeGroupChange(activeGroupData.id, 'description', event.target.value)}
                                placeholder="Describe when to use this context, or leave empty."
                              />
                              <span className={styles.groupFootnote}>
                                {activeGroupDocCount ? `${activeGroupDocCount} document${activeGroupDocCount === 1 ? '' : 's'} assigned` : 'No documents assigned yet'}
                              </span>
                            </div>
                          ) : null}

                          {uploadGroupId && !activeGroupData ? (
                            <div className={styles.readonlyBox}>
                              This context is unavailable. Select another or add a new one.
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className={styles.formSection}>
                        <div className={styles.formSectionHeader}>
                          <span className={styles.formSectionIcon}>
                            <UploadOutlined aria-hidden="true" />
                          </span>
                          <div>
                            <h3 className={styles.formSectionTitle}>Knowledge uploads</h3>
                            <p className={styles.formSectionText}>Attach supporting documents and categorise them into contexts.</p>
                          </div>
                        </div>

                        <div className={styles.uploadSection}>
                          <span className={styles.uploadingTargetLabel}>
                            Uploading to {activeGroupData ? (activeGroupData.name || 'Untitled context') : 'General context'}
                          </span>
                          <label
                            className={`${styles.uploadDropzone} ${disableKnowledgeUpload ? styles.uploadDropzoneDisabled : ''}`}
                            aria-disabled={disableKnowledgeUpload}
                          >
                            <input
                              className={styles.uploadInput}
                              type="file"
                              accept=".csv,.pdf,.doc,.docx,.txt"
                              multiple
                              onChange={handleUploadChange}
                              disabled={disableKnowledgeUpload}
                              aria-label="Upload knowledge documents"
                            />
                            <div className={styles.uploadDropzoneIcon}>
                              <UploadOutlined aria-hidden="true" />
                            </div>
                            <div className={styles.uploadDropzoneText}>
                              <span className={styles.uploadDropzoneTitle}>Drag & drop or click to upload</span>
                              <span className={styles.uploadDropzoneHint}>
                                CSV, PDF, DOCX, or TXT — we’ll extract and chunk them automatically.
                              </span>
                            </div>
                            {uploadingKnowledge ? (
                              <span className={styles.uploadDropzoneStatus}>Uploading…</span>
                            ) : null}
                          </label>

                          <div className={styles.uploadGroupPicker}>
                            <span className={styles.uploadGroupLabel}>Assign to</span>
                            <div className={styles.uploadGroupChips}>
                              <button
                                type="button"
                                className={`${styles.uploadGroupChip} ${!uploadGroupId ? styles.uploadGroupChipActive : ''}`}
                                onClick={() => setUploadGroupId('')}
                                disabled={disableKnowledgeUpload && !!uploadGroupId}
                                aria-pressed={!uploadGroupId}
                              >
                                <span>General</span>
                                <span className={styles.uploadGroupChipCount}>{groupedKnowledge.ungrouped.length}</span>
                              </button>
                              {knowledgeGroups.map((group) => (
                                <button
                                  key={group.id}
                                  type="button"
                                  className={`${styles.uploadGroupChip} ${uploadGroupId === group.id ? styles.uploadGroupChipActive : ''}`}
                                  onClick={() => setUploadGroupId(group.id)}
                                  disabled={disableKnowledgeUpload && uploadGroupId !== group.id}
                                  aria-pressed={uploadGroupId === group.id}
                                >
                                  <span>{group.name || 'Untitled context'}</span>
                                  <span className={styles.uploadGroupChipCount}>
                                    {(groupedKnowledge.groups.find((item) => item.id === group.id)?.files.length) || 0}
                                  </span>
                                </button>
                              ))}
                              <button
                                type="button"
                                className={styles.uploadGroupAdd}
                                onClick={handleAddKnowledgeGroup}
                                disabled={disableKnowledgeUpload}
                                aria-label="Add context"
                                title="Add context"
                              >
                                <PlusOutlined aria-hidden="true" />
                              </button>
                            </div>
                          </div>

                          {uploadError ? <span className={styles.statusError}>{uploadError}</span> : null}
                          {uploadStatus ? <span className={styles.statusSuccess}>{uploadStatus}</span> : null}
                          {uploadOutcomes.length ? (
                            <ul className={styles.uploadOutcomeList}>
                              {uploadOutcomes.map((item, index) => (
                                <li key={`${item.fileId || item.name || 'file'}-${index}`}>
                                  {item.error ? (
                                    <span className={styles.uploadOutcomeError}>
                                      {item.name || 'File'} — {item.error}
                                    </span>
                                  ) : item.chunkCount ? (
                                    `${item.name || 'File'} — ${item.chunkCount} chunk${item.chunkCount === 1 ? '' : 's'} indexed`
                                  ) : (
                                    `${item.name || 'File'} — no content detected`
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    </>
                  )}
                  <div className={styles.formFooter}>
                    {isEditing && status ? (
                      <span className={styles.statusSuccess} role="status">{status}</span>
                    ) : null}
                    {hasUnsavedChanges ? (
                      <span className={styles.formFooterNotice}>Unsaved changes</span>
                    ) : null}
                    <button
                      type="submit"
                      className={`${styles.primaryButton} ${styles.saveButton}`}
                      disabled={submitDisabled}
                      aria-label={submitLabel}
                      title={submitLabel}
                    >
                      {submitIcon || <CheckOutlined aria-hidden="true" />}
                      <span>{submitLabel}</span>
                    </button>
                  </div>

                  {formError ? <span className={styles.statusError}>{formError}</span> : null}
                </form>

              </div>

              {modalMode === 'edit' ? (
                <section className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>Knowledge library</h2>
                      <p className={styles.cardSubtitle}>
                        Review every document grouped by context. Uploads live in the sections above.
                      </p>
                    </div>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={onRefresh}
                      disabled={loading || uploadingKnowledge}
                      aria-label={loading ? 'Refreshing floppies' : 'Refresh floppies'}
                      title={loading ? 'Refreshing floppies' : 'Refresh floppies'}
                    >
                      <ReloadOutlined aria-hidden="true" />
                    </button>
                  </div>

                  <div className={styles.attachmentSection}>
                    <div className={styles.attachmentHeader}>
                      <div className={styles.attachmentSummary}>
                        <span className={styles.badge}>{totalKnowledgeContexts} context{totalKnowledgeContexts === 1 ? '' : 's'}</span>
                        <span className={styles.badge}>{totalKnowledgeDocuments} document{totalKnowledgeDocuments === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    {libraryGroups.map((group) => (
                      <div key={group.id || 'general-library'} className={styles.attachmentGroup}>
                        <div className={styles.attachmentGroupHeader}>
                          <h3 className={styles.attachmentTitle}>
                            {(group.name || 'Untitled context')} ({group.files.length})
                          </h3>
                          {group.description ? (
                            <p className={styles.attachmentDescription}>{group.description}</p>
                          ) : null}
                        </div>
                        {group.files.length ? (
                          <ul className={styles.knowledgeList}>
                            {group.files.map((file) => (
                              <li key={file.id} className={styles.knowledgeFile}>
                                <div className={styles.knowledgeFileRow}>
                                  <div className={styles.knowledgeFileInfo}>
                                    <span className={styles.knowledgeFileName}>{file.name}</span>
                                    <span className={styles.knowledgeFileMeta}>
                                      {(file.mimetype || 'unknown type').toLowerCase()} · {formatBytes(file.size)}
                                    </span>
                                  </div>
                                  <div className={styles.knowledgeFileActions}>
                                    <span className={styles.badge}>
                                      {file.chunkCount || 0} chunk{file.chunkCount === 1 ? '' : 's'}
                                    </span>
                                    <button
                                      type="button"
                                      className={styles.iconButton}
                                      onClick={() => handleKnowledgeDeleteClick(file)}
                                      disabled={deleteFilePendingId === file.id || !onDeleteKnowledgeFile}
                                      aria-label={`Remove ${file.name}`}
                                      title={`Remove ${file.name}`}
                                    >
                                      {deleteFilePendingId === file.id ? (
                                        <LoadingOutlined aria-hidden="true" spin />
                                      ) : (
                                        <DeleteOutlined aria-hidden="true" />
                                      )}
                                    </button>
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className={styles.readonlyBox}>No documents in this context yet.</div>
                        )}
                      </div>
                    ))}
                    {libraryGroups.every((group) => !group.files.length) ? (
                      <div className={styles.readonlyBox}>
                        {knowledgeFiles.length
                          ? 'No documents in this context yet. Upload to start building it out.'
                          : 'No documents uploaded for this floppy yet.'}
                      </div>
                    ) : null}
                  </div>
                </section>
                ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
      {isDeleteDialogOpen ? (
        <div
          className={`${styles.modalOverlay} ${styles.modalOverlayCentered}`}
          role="dialog"
          aria-modal="true"
          aria-label={deleteConfirm.type === 'file' ? 'Confirm document removal' : 'Confirm floppy deletion'}
        >
          <div className={`${styles.modalContent} ${styles.confirmContent}`} tabIndex={-1}>
            <div className={styles.confirmBody}>
              <h2 className={styles.modalTitle}>{deleteDialogTitle}</h2>
              <p className={styles.modalSubtitle}>{deleteDialogMessage}</p>
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={handleCancelDelete}
                disabled={deleteDialogBusy}
                aria-label="Cancel delete"
                title="Cancel delete"
              >
                <CloseOutlined aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={handleConfirmDelete}
                disabled={deleteDialogBusy}
                aria-label="Confirm delete"
                title="Confirm delete"
                ref={confirmButtonRef}
              >
                {deleteDialogBusy ? (
                  <LoadingOutlined aria-hidden="true" spin />
                ) : (
                  <DeleteOutlined aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
