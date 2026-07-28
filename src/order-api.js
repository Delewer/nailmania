export const ORDER_ENDPOINT = "/api/orders";

export class OrderRequestError extends Error {
  constructor(code, message, { status = 0, details, cause } = {}) {
    super(message);
    this.name = "OrderRequestError";
    this.code = code;
    this.status = status;
    if(details !== undefined) this.details = details;
    if(cause !== undefined) this.cause = cause;
  }
}

const unavailableStatus = (status) => status === 404 || status === 502 || status === 503 || status === 504;

export async function submitOrderRequest(orderRequest, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(ORDER_ENDPOINT, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Accept":"application/json",
        ...(orderRequest?.idempotencyKey ? {"Idempotency-Key":orderRequest.idempotencyKey} : {}),
      },
      body:JSON.stringify(orderRequest),
    });
  }catch(cause){
    throw new OrderRequestError("NETWORK_ERROR", "Could not reach the order service", { cause });
  }

  const isJson = (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
  let payload = null;
  if(isJson){
    try{ payload = await response.json(); }
    catch(cause){
      throw new OrderRequestError("INVALID_ORDER_RESPONSE", "The order service returned invalid JSON", {
        status:response.status,
        cause,
      });
    }
  }

  if(response.ok && payload?.order) return payload.order;

  if(!response.ok && payload?.error?.code){
    throw new OrderRequestError(payload.error.code, payload.error.message || "Order request failed", {
      status:response.status,
      details:payload.error.details,
    });
  }

  const code = unavailableStatus(response.status) || !isJson
    ? "ORDER_API_UNAVAILABLE"
    : "INVALID_ORDER_RESPONSE";
  throw new OrderRequestError(code, "The order service is unavailable", { status:response.status });
}
