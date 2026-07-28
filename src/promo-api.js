export class PromoRequestError extends Error {
  constructor(code, message, { status = 0, details, cause } = {}) {
    super(message);
    this.name = "PromoRequestError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export async function validatePromoRequest({ code, items }, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl("/api/promos/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code, items }),
    });
  } catch (cause) {
    throw new PromoRequestError("NETWORK_ERROR", "Could not reach the promo service", { cause });
  }

  const isJson = (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
  let payload = null;
  if (isJson) {
    try { payload = await response.json(); }
    catch (cause) {
      throw new PromoRequestError("INVALID_PROMO_RESPONSE", "The promo service returned invalid JSON", {
        status: response.status,
        cause,
      });
    }
  }
  if (response.ok && payload?.promo) return payload.promo;
  if (payload?.error?.code) {
    throw new PromoRequestError(payload.error.code, payload.error.message || "Promo validation failed", {
      status: response.status,
      details: payload.error.details,
    });
  }
  throw new PromoRequestError(
    response.status >= 500 ? "PROMO_SERVICE_UNAVAILABLE" : "INVALID_PROMO_RESPONSE",
    "The promo service is unavailable",
    { status: response.status },
  );
}
