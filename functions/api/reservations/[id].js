import { requireCustomerMutation } from '../../_lib/customer-auth.js';
import {
  CartReservationError,
  synchronizeCartReservationById,
} from '../../_lib/cart-reservations.js';
import { apiError, handleApiError, json, readBoundedJson, requireDatabase } from '../../_lib/http.js';

const MAX_RESERVATION_JSON_BYTES = 8 * 1024;

async function changeReservation(context, quantityOverride) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_RESERVATION_JSON_BYTES,
      requireObject: true,
    });
    const reservation = await synchronizeCartReservationById(
      requireDatabase(context.env),
      decodeURIComponent(String(context.params.id || '')),
      { ...body, quantity: quantityOverride ?? body.quantity },
      { env: context.env },
    );
    return json({ ok: true, reservation }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof CartReservationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}

export const onRequestPatch = (context) => changeReservation(context);
export const onRequestDelete = (context) => changeReservation(context, 0);
