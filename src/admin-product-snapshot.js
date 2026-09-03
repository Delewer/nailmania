import { adminRequest } from './admin-api.js';

let snapshotPromise;

const newestFirst = (items) => [...items].sort((left, right) => (
  String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || Number(right.id) - Number(left.id)
));

export function loadAdminProductSnapshot({ refresh = false } = {}) {
  if (refresh || !snapshotPromise) {
    snapshotPromise = adminRequest('/api/admin/products?snapshot=1')
      .then((payload) => newestFirst(payload.items || []))
      .catch((error) => {
        snapshotPromise = undefined;
        throw error;
      });
  }
  return snapshotPromise;
}

export function mergeAdminProductSnapshot(product) {
  if (!snapshotPromise || !product) return;
  snapshotPromise = snapshotPromise.then((items) => newestFirst([
    product,
    ...items.filter((item) => item.id !== product.id),
  ]));
}
