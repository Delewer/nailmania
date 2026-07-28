export const COURIER_DELIVERY_FEE = 70;
export const FREE_DELIVERY_THRESHOLD = 2200;

export function calculateDeliveryFee(deliveryMethod, itemsSubtotal) {
  if (deliveryMethod !== 'courier') return 0;
  const subtotal = Number(itemsSubtotal);
  return Number.isFinite(subtotal) && subtotal >= FREE_DELIVERY_THRESHOLD
    ? 0
    : COURIER_DELIVERY_FEE;
}
