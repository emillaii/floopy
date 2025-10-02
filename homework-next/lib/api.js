const API_BASE = (process.env.NEXT_PUBLIC_CHAMPION_API_BASE || '').replace(/\/$/, '');

async function handleResponse(resp) {
  if (!resp.ok) {
    let errorMessage = resp.statusText;
    try {
      const payload = await resp.json();
      errorMessage = payload?.error || errorMessage;
    } catch (_) {
      errorMessage = await resp.text();
    }
    throw new Error(errorMessage || 'Request failed');
  }
  return resp.json();
}

export async function startHomeworkSession(payload) {
  const resp = await fetch(`${API_BASE}/api/homework/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function sendHomeworkMessage(sessionId, message) {
  const resp = await fetch(`${API_BASE}/api/homework/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return handleResponse(resp);
}

export async function fetchHomeworkSessions() {
  const resp = await fetch(`${API_BASE}/api/sessions`);
  return handleResponse(resp);
}

export async function fetchHomeworkMessages(sessionId) {
  const resp = await fetch(`${API_BASE}/api/homework/session/${encodeURIComponent(sessionId)}/messages`);
  return handleResponse(resp);
}

export async function updateHomeworkSession(sessionId, payload) {
  const resp = await fetch(`${API_BASE}/api/homework/session/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function closeSession(sessionId) {
  const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  return handleResponse(resp);
}
