import { catalogRevisionBump } from './catalog-cache.js';

const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 60;

export class CartReservationError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'CartReservationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value, max) => String(value || '').trim().slice(0, max);
const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export function normalizeCartId(value) {
  const cartId = text(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cartId)) {
    throw new CartReservationError('INVALID_CART_ID', 'A valid cart id is required', 400);
  }
  return cartId.toLowerCase();
}

export function normalizeReservationId(value) {
  const reservationId = text(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)) {
    throw new CartReservationError('INVALID_RESERVATION_ID', 'A valid reservation id is required', 400);
  }
  return reservationId.toLowerCase();
}

const reservationTtlMinutes = (env) => {
  const value = Number(env?.RESERVATION_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_MINUTES) {
    throw new CartReservationError(
      'INVALID_RESERVATION_TTL',
      `RESERVATION_TTL_MINUTES must be an integer from 1 to ${MAX_TTL_MINUTES}`,
      503,
    );
  }
  return value;
};

const primarySession = (db) => (
  typeof db.withSession === 'function' ? db.withSession('first-primary') : db
);

function expiredCleanupStatements(db, { productId, now, revision }) {
  const expired = `
    status = 'ACTIVE' AND product_id = ? AND expires_at <= ?
  `;
  return [
    db.prepare(`
      UPDATE inventory
      SET reserved = reserved - COALESCE((
            SELECT SUM(quantity) FROM cart_reservations WHERE ${expired}
          ), 0),
          updated_at = ?, admin_revision = ?
      WHERE product_id = ? AND warehouse_id = 1
        AND EXISTS (SELECT 1 FROM cart_reservations WHERE ${expired})
    `).bind(productId, now, now, revision, productId, productId, now),
    db.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
        balance_on_hand, balance_reserved, reason, created_at
      )
      SELECT 'cart-expire:' || r.id, r.product_id, 1, 'reservation_release', 0,
             -r.quantity, i.on_hand, i.reserved, 'Cart reservation expired', ?
      FROM cart_reservations r
      JOIN inventory i ON i.product_id = r.product_id AND i.warehouse_id = 1
      WHERE r.status = 'ACTIVE' AND r.product_id = ? AND r.expires_at <= ?
      ON CONFLICT(id) DO NOTHING
    `).bind(now, productId, now),
    db.prepare(`
      UPDATE cart_reservations
      SET status = 'EXPIRED', updated_at = ?
      WHERE ${expired}
    `).bind(now, productId, now),
  ];
}

export async function synchronizeCartReservation(db, input, options = {}) {
  const database = primarySession(db);
  const cartId = normalizeCartId(input?.cartId);
  const hasProductKey = input?.productKey !== undefined && input?.productKey !== null;
  const productKey = text(hasProductKey ? input.productKey : input?.productId, 120);
  const quantity = Number(input?.quantity);
  if (!productKey) throw new CartReservationError('INVALID_PRODUCT_ID', 'Product id is required');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    throw new CartReservationError('INVALID_RESERVATION_QUANTITY', 'Quantity must be an integer from 0 to 99');
  }
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const ttlMinutes = reservationTtlMinutes(options.env);
  const expiresAt = new Date(new Date(now).getTime() + ttlMinutes * 60 * 1000).toISOString();
  // Storefront carts contain the stable catalog key. Numeric SKUs are valid
  // catalog keys too, so only treat a numeric value as a database id when the
  // caller explicitly used the legacy productId field.
  const numericProductId = !hasProductKey && /^[1-9]\d*$/.test(productKey) ? Number(productKey) : null;
  const findById = Number.isSafeInteger(numericProductId);
  const product = await database.prepare(`
    SELECT p.id, p.catalog_key, i.on_hand, i.reserved
    FROM products p
    JOIN categories c ON c.id = p.category_id AND c.is_active = 1
    JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    WHERE p.is_active = 1 AND p.deleted_at IS NULL
      AND ${findById ? 'p.id = ?' : 'p.catalog_key = ?'}
    LIMIT 1
  `).bind(findById ? numericProductId : productKey).first();
  if (!product) throw new CartReservationError('PRODUCT_NOT_FOUND', 'Product is unavailable', 404);

  const reservationId = crypto.randomUUID();
  const revision = `cart:${crypto.randomUUID()}`;
  const movementId = `cart-change:${crypto.randomUUID()}`;
  const currentQuantity = `COALESCE((
    SELECT quantity FROM cart_reservations
    WHERE cart_id = ? AND product_id = ? AND status = 'ACTIVE' AND expires_at > ?
  ), 0)`;
  const statements = expiredCleanupStatements(database, { productId: product.id, now, revision });
  statements.push(database.prepare(`
    UPDATE inventory
    SET reserved = reserved + ? - ${currentQuantity},
        updated_at = ?, admin_revision = ?
    WHERE product_id = ? AND warehouse_id = 1
  `).bind(quantity, cartId, product.id, now, now, revision, product.id));
  statements.push(database.prepare(`
    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
      balance_on_hand, balance_reserved, reason, created_at
    )
    SELECT ?, i.product_id, 1,
           CASE WHEN ? - ${currentQuantity} > 0 THEN 'reservation' ELSE 'reservation_release' END,
           0, ? - ${currentQuantity}, i.on_hand, i.reserved,
           CASE WHEN ? > 0 THEN 'Cart reservation updated' ELSE 'Cart reservation cancelled' END, ?
    FROM inventory i
    WHERE i.product_id = ? AND i.warehouse_id = 1
      AND ? <> ${currentQuantity}
  `).bind(
    movementId, quantity, cartId, product.id, now,
    quantity, cartId, product.id, now,
    quantity, now, product.id,
    quantity, cartId, product.id, now,
  ));
  if (quantity > 0) {
    statements.push(database.prepare(`
      INSERT INTO cart_reservations (
        id, cart_id, product_id, quantity, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      ON CONFLICT(cart_id, product_id) DO UPDATE SET
        quantity = excluded.quantity,
        status = 'ACTIVE',
        expires_at = CASE
          WHEN cart_reservations.status = 'ACTIVE' AND cart_reservations.expires_at > excluded.updated_at
            THEN cart_reservations.expires_at
          ELSE excluded.expires_at
        END,
        order_id = NULL,
        updated_at = excluded.updated_at
    `).bind(reservationId, cartId, product.id, quantity, expiresAt, now, now));
  } else {
    statements.push(database.prepare(`
      UPDATE cart_reservations
      SET status = 'CANCELLED', order_id = NULL, updated_at = ?
      WHERE cart_id = ? AND product_id = ? AND status = 'ACTIVE'
    `).bind(now, cartId, product.id));
  }
  statements.push(catalogRevisionBump(database));

  try {
    await database.batch(statements);
  } catch (error) {
    const message = String(error?.message || error);
    if (/converted cart reservation is immutable/i.test(message)) {
      throw new CartReservationError('CART_ALREADY_CONVERTED', 'This cart was already submitted as an order', 409);
    }
    if (/reservation product unavailable/i.test(message)) {
      throw new CartReservationError('PRODUCT_NOT_FOUND', 'Product is unavailable', 409);
    }
    if (/CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/i.test(message)) {
      const inventory = await database.prepare(`
        SELECT MAX(0, on_hand - reserved) AS available
        FROM inventory WHERE product_id = ? AND warehouse_id = 1
      `).bind(product.id).first();
      throw new CartReservationError(
        'INSUFFICIENT_STOCK',
        'The requested quantity is no longer available',
        409,
        { productKey: product.catalog_key, requested: quantity, available: Number(inventory?.available || 0) },
      );
    }
    throw error;
  }

  const row = await database.prepare(`
    SELECT id, quantity, status, expires_at
    FROM cart_reservations WHERE cart_id = ? AND product_id = ?
  `).bind(cartId, product.id).first();
  const inventory = await database.prepare(`
    SELECT on_hand, reserved, MAX(0, on_hand - reserved) AS available
    FROM inventory WHERE product_id = ? AND warehouse_id = 1
  `).bind(product.id).first();
  return {
    id: row?.id || null,
    cartId,
    productId: Number(product.id),
    productKey: product.catalog_key,
    quantity,
    status: quantity > 0 ? 'ACTIVE' : (row?.status || 'CANCELLED'),
    expiresAt: quantity > 0 ? row?.expires_at || expiresAt : null,
    available: Number(inventory?.available || 0),
  };
}

export async function releaseExpiredCartReservations(db, options = {}) {
  const database = primarySession(db);
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const limit = Math.min(250, Math.max(1, Number(options.limit) || 100));
  const cartId = options.cartId ? normalizeCartId(options.cartId) : null;
  const productId = options.productId == null ? null : Number(options.productId);
  const result = await database.prepare(`
    SELECT id, product_id, quantity
    FROM cart_reservations
    WHERE status = 'ACTIVE' AND expires_at <= ?
      AND (? IS NULL OR cart_id = ?)
      AND (? IS NULL OR product_id = ?)
    ORDER BY expires_at, id
    LIMIT ?
  `).bind(now, cartId, cartId, productId, productId, limit).all();
  const rows = result.results || [];
  const summary = { checkedAt: now, selected: rows.length, released: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    const token = crypto.randomUUID();
    const statements = [
      database.prepare(`
        UPDATE inventory
        SET reserved = reserved - ?, updated_at = ?, admin_revision = ?
        WHERE product_id = ? AND warehouse_id = 1
          AND EXISTS (
            SELECT 1 FROM cart_reservations
            WHERE id = ? AND status = 'ACTIVE' AND expires_at <= ?
          )
      `).bind(row.quantity, now, `cart-expire:${token}`, row.product_id, row.id, now),
      database.prepare(`
        INSERT INTO inventory_movements (
          id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
          balance_on_hand, balance_reserved, reason, created_at
        )
        SELECT 'cart-expire:' || r.id, r.product_id, 1, 'reservation_release', 0,
               -r.quantity, i.on_hand, i.reserved, 'Cart reservation expired', ?
        FROM cart_reservations r
        JOIN inventory i ON i.product_id = r.product_id AND i.warehouse_id = 1
        WHERE r.id = ? AND r.status = 'ACTIVE' AND r.expires_at <= ?
        ON CONFLICT(id) DO NOTHING
      `).bind(now, row.id, now),
      database.prepare(`
        UPDATE cart_reservations
        SET status = 'EXPIRED', updated_at = ?
        WHERE id = ? AND status = 'ACTIVE' AND expires_at <= ?
      `).bind(now, row.id, now),
      catalogRevisionBump(
        database,
        `EXISTS (SELECT 1 FROM cart_reservations WHERE id = ? AND status = 'EXPIRED' AND updated_at = ?)`,
        [row.id, now],
      ),
    ];
    try {
      const batch = await database.batch(statements);
      if (changedRows(batch?.[2]) > 0) summary.released += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.errors.push({
        reservationId: row.id,
        code: error?.code || 'RELEASE_FAILED',
        message: error?.message || String(error),
      });
    }
  }
  return summary;
}

export async function releaseExpiredCartReservationsForProduct(db, productId, options = {}) {
  const database = primarySession(db);
  const normalizedProductId = Number(productId);
  if (!Number.isInteger(normalizedProductId) || normalizedProductId < 1) {
    throw new CartReservationError('INVALID_PRODUCT_ID', 'A valid product id is required', 400);
  }
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const expired = await database.prepare(`
    SELECT 1 AS found
    FROM cart_reservations
    WHERE product_id = ? AND status = 'ACTIVE' AND expires_at <= ?
    LIMIT 1
  `).bind(normalizedProductId, now).first();
  if (!expired) return { checkedAt: now, released: 0 };
  const revision = `cart-expire:${crypto.randomUUID()}`;
  const statements = expiredCleanupStatements(database, {
    productId: normalizedProductId,
    now,
    revision,
  });
  statements.push(catalogRevisionBump(
    database,
    `EXISTS (
      SELECT 1 FROM cart_reservations
      WHERE product_id = ? AND status = 'EXPIRED' AND updated_at = ?
    )`,
    [normalizedProductId, now],
  ));
  const results = await database.batch(statements);
  return { checkedAt: now, released: changedRows(results?.[2]) };
}

export async function listActiveCartReservations(db, cartId, options = {}) {
  const database = primarySession(db);
  const normalizedCartId = normalizeCartId(cartId);
  await releaseExpiredCartReservations(database, {
    cartId: normalizedCartId,
    now: options.now,
    limit: 100,
  });
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const result = await database.prepare(`
    SELECT r.id, r.quantity, r.expires_at, p.id AS product_id, p.catalog_key
    FROM cart_reservations r
    JOIN products p ON p.id = r.product_id
    WHERE r.cart_id = ? AND r.status = 'ACTIVE' AND r.expires_at > ?
    ORDER BY r.created_at, r.id
  `).bind(normalizedCartId, now).all();
  return (result.results || []).map((row) => ({
    id: row.id,
    cartId: normalizedCartId,
    productId: Number(row.product_id),
    productKey: row.catalog_key,
    quantity: Number(row.quantity),
    status: 'ACTIVE',
    expiresAt: row.expires_at,
  }));
}

export async function synchronizeCartReservationById(db, reservationId, input, options = {}) {
  const database = primarySession(db);
  const id = normalizeReservationId(reservationId);
  const cartId = normalizeCartId(input?.cartId);
  const reservation = await database.prepare(`
    SELECT r.product_id, r.status, r.expires_at, p.catalog_key
    FROM cart_reservations r
    JOIN products p ON p.id = r.product_id
    WHERE r.id = ? AND r.cart_id = ?
  `).bind(id, cartId).first();
  if (!reservation) {
    throw new CartReservationError('RESERVATION_NOT_FOUND', 'Reservation not found', 404);
  }
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  if (reservation.status !== 'ACTIVE' || reservation.expires_at <= now) {
    if (reservation.status === 'ACTIVE') {
      await releaseExpiredCartReservations(database, { cartId, productId: reservation.product_id, now, limit: 1 });
    }
    throw new CartReservationError('RESERVATION_EXPIRED', 'Reservation is no longer active', 409);
  }
  return synchronizeCartReservation(database, {
    cartId,
    productKey: reservation.catalog_key,
    quantity: input?.quantity,
  }, options);
}
