/** API client. Token kept in memory only (not localStorage). Errors carry server code/extra for approval flows. */
let token = '';
export const setToken = (t) => { token = t || ''; };
export const getToken = () => token;
export class ApiError extends Error { constructor(m, status, code, extra) { super(m); this.status = status; this.code = code; this.extra = extra; } }
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  let r;
  try {
    r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) { throw new ApiError('Server connection lost.', 0, 'NETWORK'); }
  if (r.headers.get('content-type')?.includes('text/csv')) return r.text();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token && path !== '/login') onUnauthorized(j.error);
    throw new ApiError(j.error || 'Request failed', r.status, j.code, j.extra);
  }
  return j;
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
export async function download(path, name) {
  const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new ApiError('Export failed', r.status);
  const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
