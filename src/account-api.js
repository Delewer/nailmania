export class AccountApiError extends Error {
  constructor(code, message, { status = 0, requestId = "", details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AccountApiError";
    this.code = code || "ACCOUNT_API_ERROR";
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

const contentType = (response) => String(response?.headers?.get?.("content-type") || "").toLowerCase();

export async function accountApiRequest(path, {
  method = "GET",
  body,
  signal,
  fetchImpl = globalThis.fetch,
  onUnauthorized,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new AccountApiError("ACCOUNT_API_UNAVAILABLE", "Account API is unavailable");
  }

  let response;
  try {
    response = await fetchImpl(path, {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new AccountApiError(
      "ACCOUNT_API_UNAVAILABLE",
      "Account API is unavailable",
      { cause },
    );
  }

  const headerRequestId = String(response?.headers?.get?.("x-request-id") || "").trim();
  let payload = null;
  if (contentType(response).includes("application/json")) {
    try { payload = await response.json(); }
    catch { /* Converted to a stable invalid-response error below. */ }
  }
  const apiError = payload?.error && typeof payload.error === "object" ? payload.error : null;
  const requestId = String(apiError?.requestId || headerRequestId || "").trim();

  if (!response?.ok || payload?.ok !== true) {
    const error = new AccountApiError(
      apiError?.code || (response?.status === 401 ? "AUTH_REQUIRED" : "ACCOUNT_API_INVALID_RESPONSE"),
      apiError?.message || (response?.status ? `Account API returned ${response.status}` : "Invalid account API response"),
      {
        status: Number(response?.status || 0),
        requestId,
        details: apiError?.details,
      },
    );
    if (error.status === 401 && typeof onUnauthorized === "function") onUnauthorized(error);
    throw error;
  }

  return payload;
}

export const accountEndpoints = Object.freeze({
  session: "/api/auth/session",
  login: "/api/auth/login",
  register: "/api/auth/register",
  logout: "/api/auth/logout",
  forgotPassword: "/api/auth/forgot-password",
  resetPassword: "/api/auth/reset-password",
  profile: "/api/me",
  addresses: "/api/me/addresses",
  orders: "/api/me/orders",
});

export const addressEndpoint = (id) => `${accountEndpoints.addresses}/${encodeURIComponent(id)}`;
export const orderEndpoint = (id) => `${accountEndpoints.orders}/${encodeURIComponent(id)}`;
