const ENDPOINT = "/api/reservations";

export class ReservationRequestError extends Error {
  constructor(code, message, { status = 0, details, cause } = {}) {
    super(message);
    this.name = "ReservationRequestError";
    this.code = code;
    this.status = status;
    if(details !== undefined) this.details = details;
    if(cause !== undefined) this.cause = cause;
  }
}

async function responsePayload(response) {
  const isJson = (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
  if(!isJson) throw new ReservationRequestError("RESERVATION_API_UNAVAILABLE", "Reservation service is unavailable", {status:response.status});
  try{return await response.json();}
  catch(cause){throw new ReservationRequestError("INVALID_RESERVATION_RESPONSE", "Reservation service returned invalid JSON", {status:response.status,cause});}
}

export async function synchronizeReservation(input, fetchImpl = globalThis.fetch) {
  let response;
  try{
    response = await fetchImpl(ENDPOINT, {
      method:"POST",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      credentials:"same-origin",
      body:JSON.stringify(input),
    });
  }catch(cause){
    throw new ReservationRequestError("NETWORK_ERROR", "Could not reach the reservation service", {cause});
  }
  const payload = await responsePayload(response);
  if(response.ok && payload?.reservation) return payload.reservation;
  if(payload?.error?.code) throw new ReservationRequestError(payload.error.code,payload.error.message||"Reservation failed",{status:response.status,details:payload.error.details});
  throw new ReservationRequestError("INVALID_RESERVATION_RESPONSE","Reservation service returned an invalid response",{status:response.status});
}

export async function loadCartReservations(cartId, fetchImpl = globalThis.fetch) {
  let response;
  try{
    response = await fetchImpl(`${ENDPOINT}?cartId=${encodeURIComponent(cartId)}`, {
      headers:{Accept:"application/json"}, credentials:"same-origin",
    });
  }catch(cause){
    throw new ReservationRequestError("NETWORK_ERROR", "Could not reach the reservation service", {cause});
  }
  const payload = await responsePayload(response);
  if(response.ok && Array.isArray(payload?.reservations)) return payload.reservations;
  if(payload?.error?.code) throw new ReservationRequestError(payload.error.code,payload.error.message||"Reservation lookup failed",{status:response.status,details:payload.error.details});
  throw new ReservationRequestError("INVALID_RESERVATION_RESPONSE","Reservation service returned an invalid response",{status:response.status});
}
