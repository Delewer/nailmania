import { requireCustomerMutation } from '../_lib/customer-auth.js';
import {
  CartReservationError,
  listActiveCartReservations,
  synchronizeCartReservation,
} from '../_lib/cart-reservations.js';
import { apiError, handleApiError, json, readBoundedJson, requireDatabase } from '../_lib/http.js';

const MAX_RESERVATION_JSON_BYTES = 8 * 1024;

export async function onRequestGet(context) {
  try {
    const db = requireDatabase(context.env);
    const cartId = new URL(context.request.url).searchParams.get('cartId');
    const reservations = await listActiveCartReservations(db, cartId, { env: context.env });
    return json({ ok: true, reservations }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof CartReservationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_RESERVATION_JSON_BYTES,
      requireObject: true,
    });
    const reservation = await synchronizeCartReservation(requireDatabase(context.env), body, {
      env: context.env,
    });
    return json({ ok: true, reservation }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof CartReservationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
