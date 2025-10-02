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

export async function login(payload) {
  const resp = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}

export async function register(payload) {
  const resp = await fetch(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(resp);
}
