import { requireCustomerMutation } from '../../_lib/customer-auth.js';
import { apiError, handleApiError } from '../../_lib/http.js';

const disabled = (context) => {
  try {
    requireCustomerMutation(context.request, context.env);
    return apiError(
      'CART_RESERVATIONS_DISABLED',
      'Cart items are reserved only after the order is placed',
      410,
    );
  } catch (error) {
    return handleApiError(error);
  }
};

export const onRequestPatch = disabled;
export const onRequestDelete = disabled;
