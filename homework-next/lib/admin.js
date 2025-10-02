const API_BASE = (process.env.NEXT_PUBLIC_CHAMPION_API_BASE || '').replace(/\/$/, '');

async function handleResponse(resp) {
  if (!resp.ok) {
    let message = resp.statusText;
    try {
      const payload = await resp.json();
      message = payload?.error || message;
    } catch (_) {
      message = await resp.text();
    }
    throw new Error(message || 'Request failed');
  }
  return resp.json();
}

function createAuthHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function adminLogin(payload) {
  const resp = await fetch(`${API_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function adminLogout(token) {
  const resp = await fetch(`${API_BASE}/api/admin/logout`, {
    method: 'POST',
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function fetchAdminProfile(token) {
  const resp = await fetch(`${API_BASE}/api/admin/profile`, {
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function fetchFloppies(token) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies`, {
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function createFloppy(token, payload) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies`, {
    method: 'POST',
    headers: createAuthHeaders(token),
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function updateFloppy(token, id, payload) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: createAuthHeaders(token),
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function deleteFloppy(token, id) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function fetchFloppy(token, id) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies/${encodeURIComponent(id)}`, {
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function uploadFloppyKnowledge(token, id, files, group) {
  const formData = new FormData();
  (files || []).forEach((file) => {
    if (file) {
      formData.append('files', file);
    }
  });

  if (group?.id) {
    formData.append('groupId', group.id);
    if (group.name !== undefined) {
      formData.append('groupName', group.name);
    }
    if (group.description !== undefined) {
      formData.append('groupDescription', group.description);
    }
  }

  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const resp = await fetch(`${API_BASE}/api/admin/floppies/${encodeURIComponent(id)}/knowledge/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });
  return handleResponse(resp);
} 

export async function deleteFloppyKnowledgeFile(token, floppyId, fileId) {
  const resp = await fetch(`${API_BASE}/api/admin/floppies/${encodeURIComponent(floppyId)}/knowledge/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function startSandboxSession(token, payload) {
  const resp = await fetch(`${API_BASE}/api/admin/sandbox/session`, {
    method: 'POST',
    headers: createAuthHeaders(token),
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function sendSandboxMessage(token, sessionId, message) {
  const resp = await fetch(`${API_BASE}/api/admin/sandbox/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    headers: createAuthHeaders(token),
    body: JSON.stringify({ message }),
  });
  return handleResponse(resp);
}

export async function fetchSandboxHistory(token, sessionId) {
  const resp = await fetch(`${API_BASE}/api/admin/sandbox/session/${encodeURIComponent(sessionId)}/history`, {
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function fetchSandboxes(token) {
  const resp = await fetch(`${API_BASE}/api/admin/sandboxes`, {
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}

export async function createSandbox(token, payload) {
  const resp = await fetch(`${API_BASE}/api/admin/sandboxes`, {
    method: 'POST',
    headers: createAuthHeaders(token),
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function updateSandbox(token, id, payload) {
  const resp = await fetch(`${API_BASE}/api/admin/sandboxes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: createAuthHeaders(token),
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function deleteSandbox(token, id) {
  const resp = await fetch(`${API_BASE}/api/admin/sandboxes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: createAuthHeaders(token),
  });
  return handleResponse(resp);
}
