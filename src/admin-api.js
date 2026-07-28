const TOKEN_KEY = 'nm_admin_dev_token';

export class AdminApiError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const adminDevToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
export const saveAdminDevToken = (token) => sessionStorage.setItem(TOKEN_KEY, String(token || '').trim());
export const clearAdminDevToken = () => sessionStorage.removeItem(TOKEN_KEY);

export async function adminRequest(path, options = {}) {
  const token = adminDevToken();
  const headers = new Headers(options.headers || {});
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
  const isArrayBuffer = options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body);
  const isNativeBody = typeof options.body === 'string' || isFormData || isBlob || isArrayBuffer;
  headers.set('accept', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined && !isFormData && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined || isNativeBody ? options.body : JSON.stringify(options.body),
  });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json() : null;
  if (!response.ok || payload?.ok === false) {
    throw new AdminApiError(
      payload?.error?.code || 'ADMIN_REQUEST_FAILED',
      payload?.error?.message || `Admin request failed with HTTP ${response.status}`,
      response.status,
      payload?.error?.details,
    );
  }
  return payload;
}

export async function adminDownload(path, fallbackName = 'nailmania-export.csv') {
  const token = adminDevToken();
  const headers = new Headers({ accept: 'text/csv' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(path, { headers, credentials: 'same-origin' });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch {}
    throw new AdminApiError(
      payload?.error?.code || 'ADMIN_EXPORT_FAILED',
      payload?.error?.message || `Admin export failed with HTTP ${response.status}`,
      response.status,
      payload?.error?.details,
    );
  }
  const disposition = response.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
