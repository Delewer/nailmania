import { clampLikeTerm, likeContainsPattern } from './search-pattern.js';

export class StatisticsError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'StatisticsError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const FINAL_ORDER_STATUSES = Object.freeze(['completed', 'returned']);

const STOCK_FILTERS = new Set(['', 'all', 'low', 'out', 'no_sales']);
const MOVEMENT_TYPES = new Set([
  '', 'opening_balance', 'receipt', 'reservation', 'reservation_release',
  'sale', 'return', 'write_off', 'adjustment',
]);
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const boundedText = (value, max) => String(value ?? '').trim().slice(0, max);
const number = (value) => Number(value || 0);
const nullableNumber = (value) => value == null ? null : Number(value);
const integer = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

function canonicalUtc(value, field) {
  const raw = boundedText(value, 40);
  if (!CANONICAL_UTC.test(raw)) {
    throw new StatisticsError(
      'INVALID_STATISTICS_PERIOD',
      `${field} must be a canonical UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)`,
      400,
      { field },
    );
  }
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== raw) {
    throw new StatisticsError('INVALID_STATISTICS_PERIOD', `${field} is not a valid UTC instant`, 400, { field });
  }
  return raw;
}

export function parseStatisticsQuery(input) {
  const source = input instanceof URLSearchParams ? input : new URLSearchParams(input || '');
  const from = canonicalUtc(source.get('from'), 'from');
  const to = canonicalUtc(source.get('to'), 'to');
  if (to <= from) {
    throw new StatisticsError('INVALID_STATISTICS_PERIOD', 'to must be later than from', 400, { from, to });
  }
  const stock = boundedText(source.get('stock'), 30).toLowerCase();
  if (!STOCK_FILTERS.has(stock)) {
    throw new StatisticsError('INVALID_STOCK_FILTER', 'Unknown stock report filter', 400, { stock });
  }
  const movementType = boundedText(source.get('type'), 40).toLowerCase();
  if (!MOVEMENT_TYPES.has(movementType)) {
    throw new StatisticsError('INVALID_MOVEMENT_TYPE', 'Unknown inventory movement type', 400, { type: movementType });
  }
  return {
    from,
    to,
    q: clampLikeTerm(source.get('q'), { escape: true }),
    category: boundedText(source.get('category'), 100),
    brand: boundedText(source.get('brand'), 180),
    stock: stock === 'all' ? '' : stock,
    movementType,
    order: boundedText(source.get('order'), 120),
    limit: integer(source.get('limit'), 100, 1, 250),
    offset: integer(source.get('offset'), 0, 0, 1_000_000_000),
  };
}

function productWhere(filters, aliases = {}) {
  const p = aliases.product || 'p';
  const i = aliases.inventory || 'i';
  const sale = aliases.sale || 's';
  const conditions = [];
  const bindings = [];
  if (filters.q) {
    const pattern = likeContainsPattern(filters.q, { escape: true });
    conditions.push(`(${p}.catalog_key LIKE ? ESCAPE '\\' OR ${p}.sku LIKE ? ESCAPE '\\' OR ${p}.name_ro LIKE ? ESCAPE '\\' OR ${p}.name_ru LIKE ? ESCAPE '\\' OR ${p}.brand LIKE ? ESCAPE '\\')`);
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.category) { conditions.push(`${p}.category_id = ?`); bindings.push(filters.category); }
  if (filters.brand) { conditions.push(`${p}.brand = ?`); bindings.push(filters.brand); }
  const available = `(COALESCE(${i}.on_hand, 0) - COALESCE(${i}.reserved, 0))`;
  if (filters.stock === 'out') conditions.push(`${available} <= 0`);
  if (filters.stock === 'low') conditions.push(`${available} > 0 AND ${available} <= ${p}.low_stock_threshold`);
  if (filters.stock === 'no_sales') conditions.push(`COALESCE(${sale}.sold_units, 0) = 0`);
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', bindings };
}

function mapCostMetrics({ saleCogs, refundCogs, saleUnknown, refundUnknown, merchandiseNet }) {
  const cogs = number(saleCogs) - number(refundCogs);
  const unknownCostUnits = number(saleUnknown) + number(refundUnknown);
  return {
    cogs,
    unknownCostUnits,
    grossProfit: unknownCostUnits === 0 ? number(merchandiseNet) - cogs : null,
  };
}

async function loadSummary(db, range) {
  const [orderFlow, sales, refunds, costs, inventory] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS received_orders,
             COALESCE(SUM(total_amount), 0) AS received_value,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'confirmed', 'processing', 'ready', 'shipped') THEN 1 ELSE 0 END), 0) AS active_orders,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'confirmed', 'processing', 'ready', 'shipped') THEN total_amount ELSE 0 END), 0) AS active_value,
             COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
             COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_orders,
             COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_orders,
             COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_orders,
             COALESCE(SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END), 0) AS shipped_orders,
             COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_orders,
             COALESCE(SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END), 0) AS returned_orders,
             COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders,
             COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_amount ELSE 0 END), 0) AS cancelled_value
      FROM orders
      WHERE created_at >= ? AND created_at < ?
    `).bind(range.from, range.to).first(),
    db.prepare(`
      SELECT COUNT(*) AS orders_count,
             SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned_orders,
             COALESCE(SUM(items_subtotal + catalog_discount), 0) AS gross_merchandise,
             COALESCE(SUM(items_subtotal), 0) AS merchandise_after_catalog,
             COALESCE(SUM(catalog_discount), 0) AS catalog_discount,
             COALESCE(SUM(promo_discount), 0) AS promo_discount,
             COALESCE(SUM(delivery_fee), 0) AS delivery_revenue,
             COALESCE(SUM(total_amount), 0) AS sale_revenue
      FROM orders
      WHERE status IN ('completed', 'returned')
        AND completed_at >= ? AND completed_at < ?
    `).bind(range.from, range.to).first(),
    db.prepare(`
      SELECT COUNT(*) AS return_count,
             COUNT(DISTINCT r.order_id) AS returned_order_count,
             COALESCE(SUM(r.items_amount), 0) AS returned_merchandise,
             COALESCE(SUM(r.promo_refund_amount), 0) AS promo_discount_reversed,
             COALESCE(SUM(r.items_amount - r.promo_refund_amount), 0) AS refund_amount,
             COALESCE(SUM((SELECT SUM(ri.quantity) FROM order_return_items ri WHERE ri.return_id = r.id)), 0) AS returned_units
      FROM order_returns r
      JOIN orders o ON o.id = r.order_id AND o.status IN ('completed', 'returned')
      WHERE r.created_at >= ? AND r.created_at < ?
    `).bind(range.from, range.to).first(),
    db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN oi.cost_price_snapshot IS NOT NULL THEN oi.cost_price_snapshot * oi.sold_quantity ELSE 0 END), 0) AS sale_cogs,
        COALESCE(SUM(CASE WHEN oi.cost_price_snapshot IS NULL THEN oi.sold_quantity ELSE 0 END), 0) AS sale_unknown,
        COALESCE((
          SELECT SUM(CASE WHEN oi2.cost_price_snapshot IS NOT NULL THEN oi2.cost_price_snapshot * ri.quantity ELSE 0 END)
          FROM order_return_items ri
          JOIN order_returns r ON r.id = ri.return_id
          JOIN orders ro ON ro.id = r.order_id AND ro.status IN ('completed', 'returned')
          JOIN order_items oi2 ON oi2.id = ri.order_item_id
          WHERE r.created_at >= ? AND r.created_at < ?
        ), 0) AS refund_cogs,
        COALESCE((
          SELECT SUM(CASE WHEN oi2.cost_price_snapshot IS NULL THEN ri.quantity ELSE 0 END)
          FROM order_return_items ri
          JOIN order_returns r ON r.id = ri.return_id
          JOIN orders ro ON ro.id = r.order_id AND ro.status IN ('completed', 'returned')
          JOIN order_items oi2 ON oi2.id = ri.order_item_id
          WHERE r.created_at >= ? AND r.created_at < ?
        ), 0) AS refund_unknown
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed', 'returned')
        AND o.completed_at >= ? AND o.completed_at < ?
    `).bind(range.from, range.to, range.from, range.to, range.from, range.to).first(),
    db.prepare(`
      SELECT COUNT(*) AS product_count,
             COALESCE(SUM(CASE WHEN p.is_active = 1 AND p.deleted_at IS NULL AND (i.on_hand - i.reserved) <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
             COALESCE(SUM(CASE WHEN p.is_active = 1 AND p.deleted_at IS NULL AND (i.on_hand - i.reserved) > 0 AND (i.on_hand - i.reserved) <= p.low_stock_threshold THEN 1 ELSE 0 END), 0) AS low_stock,
             COALESCE(SUM(i.on_hand), 0) AS on_hand,
             COALESCE(SUM(i.reserved), 0) AS reserved,
             COALESCE(SUM(i.on_hand - i.reserved), 0) AS available,
             COALESCE(SUM(CASE WHEN p.cost_price IS NOT NULL THEN p.cost_price * i.on_hand ELSE 0 END), 0) AS inventory_cost,
             COALESCE(SUM(CASE WHEN p.cost_price IS NULL THEN i.on_hand ELSE 0 END), 0) AS unknown_cost_units
      FROM products p
      JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    `).first(),
  ]);

  const orders = number(sales?.orders_count);
  const refundAmount = number(refunds?.refund_amount);
  const saleRevenue = number(sales?.sale_revenue);
  const merchandiseNet = number(sales?.merchandise_after_catalog) - number(sales?.promo_discount) - refundAmount;
  const netRevenue = saleRevenue - refundAmount;
  const inventoryOnHand = number(inventory?.on_hand);
  const inventoryUnknownCostUnits = number(inventory?.unknown_cost_units);
  const inventoryKnownCostUnits = Math.max(0, inventoryOnHand - inventoryUnknownCostUnits);
  const costMetrics = mapCostMetrics({
    saleCogs: costs?.sale_cogs,
    refundCogs: costs?.refund_cogs,
    saleUnknown: costs?.sale_unknown,
    refundUnknown: costs?.refund_unknown,
    merchandiseNet,
  });
  return {
    orderFlow: {
      received: number(orderFlow?.received_orders),
      receivedValue: number(orderFlow?.received_value),
      active: number(orderFlow?.active_orders),
      activeValue: number(orderFlow?.active_value),
      pending: number(orderFlow?.pending_orders),
      confirmed: number(orderFlow?.confirmed_orders),
      processing: number(orderFlow?.processing_orders),
      ready: number(orderFlow?.ready_orders),
      shipped: number(orderFlow?.shipped_orders),
      completed: number(orderFlow?.completed_orders),
      returned: number(orderFlow?.returned_orders),
      cancelled: number(orderFlow?.cancelled_orders),
      cancelledValue: number(orderFlow?.cancelled_value),
    },
    orders,
    returnedOrders: number(sales?.returned_orders),
    grossMerchandise: number(sales?.gross_merchandise),
    merchandiseAfterCatalog: number(sales?.merchandise_after_catalog),
    catalogDiscount: number(sales?.catalog_discount),
    promoDiscount: number(sales?.promo_discount),
    totalDiscount: number(sales?.catalog_discount) + number(sales?.promo_discount),
    deliveryRevenue: number(sales?.delivery_revenue),
    saleRevenue,
    returnCount: number(refunds?.return_count),
    returnedOrderCount: number(refunds?.returned_order_count),
    returnedUnits: number(refunds?.returned_units),
    returnedMerchandise: number(refunds?.returned_merchandise),
    promoDiscountReversed: number(refunds?.promo_discount_reversed),
    refundAmount,
    merchandiseNetRevenue: merchandiseNet,
    netRevenue,
    averageCheck: orders ? Math.round((netRevenue / orders) * 100) / 100 : 0,
    ...costMetrics,
    inventory: {
      products: number(inventory?.product_count),
      outOfStock: number(inventory?.out_of_stock),
      lowStock: number(inventory?.low_stock),
      onHand: inventoryOnHand,
      reserved: number(inventory?.reserved),
      available: number(inventory?.available),
      currentCost: number(inventory?.inventory_cost),
      knownCostUnits: inventoryKnownCostUnits,
      unknownCostUnits: inventoryUnknownCostUnits,
      costCoveragePercent: inventoryOnHand
        ? Math.round((inventoryKnownCostUnits / inventoryOnHand) * 10_000) / 100
        : 100,
    },
  };
}

async function loadDaily(db, range) {
  const result = await db.prepare(`
    WITH events AS (
      SELECT substr(created_at, 1, 10) AS day,
             COUNT(*) AS received_orders,
             SUM(total_amount) AS received_value,
             0 AS completed_orders,
             0 AS sale_revenue,
             0 AS refund_amount
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY substr(created_at, 1, 10)
      UNION ALL
      SELECT substr(completed_at, 1, 10) AS day,
             0 AS received_orders,
             0 AS received_value,
             COUNT(*) AS completed_orders,
             SUM(total_amount) AS sale_revenue,
             0 AS refund_amount
      FROM orders
      WHERE status IN ('completed', 'returned')
        AND completed_at >= ? AND completed_at < ?
      GROUP BY substr(completed_at, 1, 10)
      UNION ALL
      SELECT substr(r.created_at, 1, 10) AS day,
             0 AS received_orders,
             0 AS received_value,
             0 AS completed_orders,
             0 AS sale_revenue,
             SUM(r.items_amount - r.promo_refund_amount) AS refund_amount
      FROM order_returns r
      JOIN orders o ON o.id = r.order_id AND o.status IN ('completed', 'returned')
      WHERE r.created_at >= ? AND r.created_at < ?
      GROUP BY substr(r.created_at, 1, 10)
    )
    SELECT day, SUM(received_orders) AS received_orders,
           SUM(received_value) AS received_value,
           SUM(completed_orders) AS completed_orders,
           SUM(sale_revenue) AS sale_revenue,
           SUM(refund_amount) AS refund_amount,
           SUM(sale_revenue) - SUM(refund_amount) AS net_revenue
    FROM events GROUP BY day ORDER BY day
  `).bind(range.from, range.to, range.from, range.to, range.from, range.to).all();
  return (result.results || []).map((row) => ({
    day: row.day,
    receivedOrders: number(row.received_orders),
    receivedValue: number(row.received_value),
    orders: number(row.completed_orders),
    saleRevenue: number(row.sale_revenue),
    refundAmount: number(row.refund_amount),
    netRevenue: number(row.net_revenue),
  }));
}

const PRODUCT_FACTS = `
  WITH sale AS (
    SELECT oi.product_id,
           SUM(oi.sold_quantity) AS sold_units,
           SUM(oi.list_price * oi.sold_quantity) AS gross_merchandise,
           SUM((oi.list_price - oi.unit_price) * oi.sold_quantity) AS catalog_discount,
           SUM(oi.promo_discount_allocation) AS promo_discount,
           SUM(oi.unit_price * oi.sold_quantity - oi.promo_discount_allocation) AS sale_merchandise,
           SUM(CASE WHEN oi.cost_price_snapshot IS NOT NULL THEN oi.cost_price_snapshot * oi.sold_quantity ELSE 0 END) AS sale_cogs,
           SUM(CASE WHEN oi.cost_price_snapshot IS NULL THEN oi.sold_quantity ELSE 0 END) AS sale_unknown
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('completed', 'returned') AND o.completed_at >= ? AND o.completed_at < ?
    GROUP BY oi.product_id
  ), refund AS (
    SELECT ri.product_id,
           SUM(ri.quantity) AS returned_units,
           SUM(ri.line_amount - ri.promo_refund_amount) AS refund_amount,
           SUM(CASE WHEN oi.cost_price_snapshot IS NOT NULL THEN oi.cost_price_snapshot * ri.quantity ELSE 0 END) AS refund_cogs,
           SUM(CASE WHEN oi.cost_price_snapshot IS NULL THEN ri.quantity ELSE 0 END) AS refund_unknown
    FROM order_return_items ri
    JOIN order_returns r ON r.id = ri.return_id
    JOIN orders o ON o.id = r.order_id AND o.status IN ('completed', 'returned')
    JOIN order_items oi ON oi.id = ri.order_item_id
    WHERE r.created_at >= ? AND r.created_at < ?
    GROUP BY ri.product_id
  )
`;

function mapProduct(row) {
  const saleMerchandise = number(row.sale_merchandise);
  const refundAmount = number(row.refund_amount);
  const merchandiseNet = saleMerchandise - refundAmount;
  const onHand = number(row.on_hand);
  const reserved = number(row.reserved);
  return {
    id: row.id,
    key: row.catalog_key,
    sku: row.sku,
    name: row.name_ro,
    nameRu: row.name_ru,
    categoryId: row.category_id,
    categoryName: row.category_name_ro,
    brand: row.brand,
    active: Boolean(row.is_active) && !row.deleted_at,
    soldUnits: number(row.sold_units),
    returnedUnits: number(row.returned_units),
    netUnits: number(row.sold_units) - number(row.returned_units),
    grossMerchandise: number(row.gross_merchandise),
    catalogDiscount: number(row.catalog_discount),
    promoDiscount: number(row.promo_discount),
    saleMerchandise,
    refundAmount,
    netRevenue: merchandiseNet,
    ...mapCostMetrics({
      saleCogs: row.sale_cogs,
      refundCogs: row.refund_cogs,
      saleUnknown: row.sale_unknown,
      refundUnknown: row.refund_unknown,
      merchandiseNet,
    }),
    onHand,
    reserved,
    available: onHand - reserved,
    lowStockThreshold: number(row.low_stock_threshold),
    costPrice: nullableNumber(row.cost_price),
    currentInventoryCost: row.cost_price == null ? null : number(row.cost_price) * onHand,
  };
}

export async function loadProductReport(db, filters, { paginate = true } = {}) {
  const where = productWhere(filters);
  const select = `
    SELECT p.id, p.catalog_key, p.sku, p.name_ro, p.name_ru, p.category_id,
           c.name_ro AS category_name_ro, p.brand, p.is_active, p.deleted_at,
           p.low_stock_threshold, p.cost_price,
           COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved,
           COALESCE(s.sold_units, 0) AS sold_units,
           COALESCE(s.gross_merchandise, 0) AS gross_merchandise,
           COALESCE(s.catalog_discount, 0) AS catalog_discount,
           COALESCE(s.promo_discount, 0) AS promo_discount,
           COALESCE(s.sale_merchandise, 0) AS sale_merchandise,
           COALESCE(s.sale_cogs, 0) AS sale_cogs,
           COALESCE(s.sale_unknown, 0) AS sale_unknown,
           COALESCE(r.returned_units, 0) AS returned_units,
           COALESCE(r.refund_amount, 0) AS refund_amount,
           COALESCE(r.refund_cogs, 0) AS refund_cogs,
           COALESCE(r.refund_unknown, 0) AS refund_unknown
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    LEFT JOIN sale s ON s.product_id = p.id
    LEFT JOIN refund r ON r.product_id = p.id
    ${where.sql}
  `;
  const baseBindings = [filters.from, filters.to, filters.from, filters.to, ...where.bindings];
  if (!paginate) {
    const result = await db.prepare(`${PRODUCT_FACTS}${select}
      ORDER BY (COALESCE(s.sale_merchandise, 0) - COALESCE(r.refund_amount, 0)) DESC,
               p.name_ro COLLATE NOCASE, p.id
    `).bind(...baseBindings).all();
    return { items: (result.results || []).map(mapProduct), total: (result.results || []).length };
  }
  const [result, count] = await Promise.all([
    db.prepare(`${PRODUCT_FACTS}${select}
      ORDER BY (COALESCE(s.sale_merchandise, 0) - COALESCE(r.refund_amount, 0)) DESC,
               p.name_ro COLLATE NOCASE, p.id
      LIMIT ? OFFSET ?
    `).bind(...baseBindings, filters.limit, filters.offset).all(),
    db.prepare(`${PRODUCT_FACTS}
      SELECT COUNT(*) AS count
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
      LEFT JOIN sale s ON s.product_id = p.id
      LEFT JOIN refund r ON r.product_id = p.id
      ${where.sql}
    `).bind(...baseBindings).first(),
  ]);
  return {
    items: (result.results || []).map(mapProduct),
    total: number(count?.count),
  };
}

function dimensionSql(kind) {
  const category = kind === 'category';
  const saleKey = category ? `COALESCE(NULLIF(oi.category_id_snapshot, ''), 'unknown')` : `COALESCE(NULLIF(oi.brand, ''), 'Fără brand')`;
  const currentKey = category ? 'p.category_id' : `COALESCE(NULLIF(p.brand, ''), 'Fără brand')`;
  const nameColumns = category
    ? `MAX(NULLIF(oi.category_name_ro_snapshot, '')) AS name_ro, MAX(NULLIF(oi.category_name_ru_snapshot, '')) AS name_ru,`
    : `NULL AS name_ro, NULL AS name_ru,`;
  const currentKeys = category ? 'SELECT id AS dimension_key FROM categories' : `SELECT DISTINCT COALESCE(NULLIF(brand, ''), 'Fără brand') AS dimension_key FROM products`;
  const categoryJoin = category ? 'LEFT JOIN categories c ON c.id = k.dimension_key' : '';
  const labelRo = category ? `COALESCE(s.name_ro, r.name_ro, c.name_ro, k.dimension_key)` : 'k.dimension_key';
  const labelRu = category ? `COALESCE(NULLIF(s.name_ru, ''), NULLIF(r.name_ru, ''), NULLIF(c.name_ru, ''), ${labelRo})` : 'k.dimension_key';
  return `
    WITH sale AS (
      SELECT ${saleKey} AS dimension_key, ${nameColumns}
             SUM(oi.sold_quantity) AS sold_units,
             SUM(oi.list_price * oi.sold_quantity) AS gross_merchandise,
             SUM((oi.list_price - oi.unit_price) * oi.sold_quantity) AS catalog_discount,
             SUM(oi.promo_discount_allocation) AS promo_discount,
             SUM(oi.unit_price * oi.sold_quantity - oi.promo_discount_allocation) AS sale_merchandise,
             SUM(CASE WHEN oi.cost_price_snapshot IS NOT NULL THEN oi.cost_price_snapshot * oi.sold_quantity ELSE 0 END) AS sale_cogs,
             SUM(CASE WHEN oi.cost_price_snapshot IS NULL THEN oi.sold_quantity ELSE 0 END) AS sale_unknown
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed', 'returned') AND o.completed_at >= ? AND o.completed_at < ?
      GROUP BY ${saleKey}
    ), refund AS (
      SELECT ${saleKey} AS dimension_key, ${nameColumns}
             SUM(ri.quantity) AS returned_units,
             SUM(ri.line_amount - ri.promo_refund_amount) AS refund_amount,
             SUM(CASE WHEN oi.cost_price_snapshot IS NOT NULL THEN oi.cost_price_snapshot * ri.quantity ELSE 0 END) AS refund_cogs,
             SUM(CASE WHEN oi.cost_price_snapshot IS NULL THEN ri.quantity ELSE 0 END) AS refund_unknown
      FROM order_return_items ri
      JOIN order_returns returns_record ON returns_record.id = ri.return_id
      JOIN orders o ON o.id = returns_record.order_id AND o.status IN ('completed', 'returned')
      JOIN order_items oi ON oi.id = ri.order_item_id
      WHERE returns_record.created_at >= ? AND returns_record.created_at < ?
      GROUP BY ${saleKey}
    ), inventory_facts AS (
      SELECT ${currentKey} AS dimension_key,
             SUM(i.on_hand) AS on_hand, SUM(i.reserved) AS reserved,
             SUM(CASE WHEN p.cost_price IS NOT NULL THEN p.cost_price * i.on_hand ELSE 0 END) AS inventory_cost,
             SUM(CASE WHEN p.cost_price IS NULL THEN i.on_hand ELSE 0 END) AS inventory_unknown
      FROM products p JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
      GROUP BY ${currentKey}
    ), keys AS (
      SELECT dimension_key FROM sale UNION SELECT dimension_key FROM refund
      UNION SELECT dimension_key FROM inventory_facts UNION ${currentKeys}
    )
    SELECT k.dimension_key, ${labelRo} AS name_ro, ${labelRu} AS name_ru,
           COALESCE(s.sold_units, 0) AS sold_units,
           COALESCE(r.returned_units, 0) AS returned_units,
           COALESCE(s.gross_merchandise, 0) AS gross_merchandise,
           COALESCE(s.catalog_discount, 0) AS catalog_discount,
           COALESCE(s.promo_discount, 0) AS promo_discount,
           COALESCE(s.sale_merchandise, 0) AS sale_merchandise,
           COALESCE(r.refund_amount, 0) AS refund_amount,
           COALESCE(s.sale_cogs, 0) AS sale_cogs,
           COALESCE(r.refund_cogs, 0) AS refund_cogs,
           COALESCE(s.sale_unknown, 0) AS sale_unknown,
           COALESCE(r.refund_unknown, 0) AS refund_unknown,
           COALESCE(inv.on_hand, 0) AS on_hand,
           COALESCE(inv.reserved, 0) AS reserved,
           COALESCE(inv.inventory_cost, 0) AS inventory_cost,
           COALESCE(inv.inventory_unknown, 0) AS inventory_unknown
    FROM keys k LEFT JOIN sale s ON s.dimension_key = k.dimension_key
    LEFT JOIN refund r ON r.dimension_key = k.dimension_key
    LEFT JOIN inventory_facts inv ON inv.dimension_key = k.dimension_key
    ${categoryJoin}
    ORDER BY (COALESCE(s.sale_merchandise, 0) - COALESCE(r.refund_amount, 0)) DESC,
             name_ro COLLATE NOCASE
  `;
}

async function loadDimensionReport(db, range, kind) {
  const result = await db.prepare(dimensionSql(kind)).bind(range.from, range.to, range.from, range.to).all();
  return (result.results || []).map((row) => {
    const merchandiseNet = number(row.sale_merchandise) - number(row.refund_amount);
    const onHand = number(row.on_hand);
    const reserved = number(row.reserved);
    return {
      id: row.dimension_key,
      name: row.name_ro,
      nameRu: row.name_ru,
      soldUnits: number(row.sold_units),
      returnedUnits: number(row.returned_units),
      netUnits: number(row.sold_units) - number(row.returned_units),
      grossMerchandise: number(row.gross_merchandise),
      catalogDiscount: number(row.catalog_discount),
      promoDiscount: number(row.promo_discount),
      refundAmount: number(row.refund_amount),
      netRevenue: merchandiseNet,
      ...mapCostMetrics({
        saleCogs: row.sale_cogs,
        refundCogs: row.refund_cogs,
        saleUnknown: row.sale_unknown,
        refundUnknown: row.refund_unknown,
        merchandiseNet,
      }),
      onHand,
      reserved,
      available: onHand - reserved,
      currentInventoryCost: number(row.inventory_cost),
      inventoryUnknownCostUnits: number(row.inventory_unknown),
    };
  });
}

export async function loadStatistics(db, filters) {
  const [summary, daily, products, categories, brands] = await Promise.all([
    loadSummary(db, filters),
    loadDaily(db, filters),
    loadProductReport(db, filters),
    loadDimensionReport(db, filters, 'category'),
    loadDimensionReport(db, filters, 'brand'),
  ]);
  return {
    period: { from: filters.from, to: filters.to, timezone: 'UTC', semantics: '[from,to)' },
    filters: {
      q: filters.q,
      category: filters.category,
      brand: filters.brand,
      stock: filters.stock,
    },
    summary,
    daily,
    products: products.items,
    productPagination: { limit: filters.limit, offset: filters.offset, total: products.total },
    categories,
    brands,
  };
}

function protectSpreadsheetText(value) {
  const text = String(value ?? '').replaceAll('\0', '');
  return typeof value === 'string' && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function encodeCsv(headers, rows) {
  const quote = (value) => `"${protectSpreadsheetText(value).replaceAll('"', '""')}"`;
  return `\uFEFF${[headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

async function loadSalesLedger(db, filters) {
  const result = await db.prepare(`
    SELECT o.completed_at AS event_at, 'sale' AS event_type, o.id AS event_id,
           o.order_no, o.status,
           o.items_subtotal + o.catalog_discount AS gross_merchandise,
           o.catalog_discount, o.promo_discount, o.delivery_fee,
           0 AS refund_amount, o.total_amount AS net_revenue
    FROM orders o
    WHERE o.status IN ('completed', 'returned')
      AND o.completed_at >= ? AND o.completed_at < ?
    UNION ALL
    SELECT r.created_at AS event_at, 'refund' AS event_type, r.id AS event_id,
           o.order_no, o.status, 0 AS gross_merchandise,
           0 AS catalog_discount, 0 AS promo_discount, 0 AS delivery_fee,
           r.items_amount - r.promo_refund_amount AS refund_amount,
           -(r.items_amount - r.promo_refund_amount) AS net_revenue
    FROM order_returns r
    JOIN orders o ON o.id = r.order_id AND o.status IN ('completed', 'returned')
    WHERE r.created_at >= ? AND r.created_at < ?
    ORDER BY event_at, event_type, event_id
  `).bind(filters.from, filters.to, filters.from, filters.to).all();
  return result.results || [];
}

async function loadCurrentInventory(db, filters) {
  const where = productWhere({ ...filters, stock: filters.stock === 'no_sales' ? '' : filters.stock }, { sale: 'unused' });
  const noSales = filters.stock === 'no_sales'
    ? `NOT EXISTS (
        SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = p.id AND oi.sold_quantity > 0
          AND o.status IN ('completed', 'returned')
          AND o.completed_at >= ? AND o.completed_at < ?
      )`
    : '';
  const inventoryWhere = where.sql
    ? `${where.sql}${noSales ? ` AND ${noSales}` : ''}`
    : (noSales ? `WHERE ${noSales}` : '');
  const result = await db.prepare(`
    SELECT p.id, p.catalog_key, p.sku, p.name_ro, p.name_ru, p.category_id,
           c.name_ro AS category_name, p.brand, p.is_active, p.deleted_at,
           p.low_stock_threshold, p.cost_price,
           COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved
    FROM products p JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    ${inventoryWhere}
    ORDER BY p.name_ro COLLATE NOCASE, p.id
  `).bind(...where.bindings, ...(noSales ? [filters.from, filters.to] : [])).all();
  return result.results || [];
}

async function loadInventoryMovements(db, filters) {
  const conditions = ['m.created_at >= ?', 'm.created_at < ?'];
  const bindings = [filters.from, filters.to];
  if (filters.movementType) { conditions.push('m.movement_type = ?'); bindings.push(filters.movementType); }
  if (filters.order) { conditions.push('(m.order_id = ? OR o.order_no = ?)'); bindings.push(filters.order, filters.order); }
  if (filters.category) { conditions.push('p.category_id = ?'); bindings.push(filters.category); }
  if (filters.brand) { conditions.push('p.brand = ?'); bindings.push(filters.brand); }
  if (filters.q) {
    const pattern = likeContainsPattern(filters.q, { escape: true });
    conditions.push(`(p.catalog_key LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.name_ro LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR m.reason LIKE ? ESCAPE '\\' OR o.order_no LIKE ? ESCAPE '\\')`);
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  const result = await db.prepare(`
    SELECT m.created_at, m.id, m.movement_type, p.catalog_key, p.sku,
           p.name_ro, p.category_id, p.brand, w.name AS warehouse,
           m.delta_on_hand, m.delta_reserved, m.balance_on_hand, m.balance_reserved,
           o.order_no, m.reason, u.email AS actor_email
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN orders o ON o.id = m.order_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at, m.id
  `).bind(...bindings).all();
  return result.results || [];
}

export const CSV_REPORTS = Object.freeze(['sales', 'products', 'inventory', 'movements']);

export async function buildCsvReport(db, filters, report) {
  if (!CSV_REPORTS.includes(report)) {
    throw new StatisticsError('INVALID_CSV_REPORT', 'Unknown CSV report', 400, { report });
  }
  if (report === 'sales') {
    const rows = await loadSalesLedger(db, filters);
    return encodeCsv(
      ['event_at_utc', 'event_type', 'event_id', 'order_no', 'order_status', 'gross_merchandise_lei', 'catalog_discount_lei', 'promo_discount_lei', 'delivery_lei', 'refund_lei', 'net_revenue_lei'],
      rows.map((row) => [row.event_at, row.event_type, row.event_id, row.order_no, row.status, row.gross_merchandise, row.catalog_discount, row.promo_discount, row.delivery_fee, row.refund_amount, row.net_revenue]),
    );
  }
  if (report === 'products') {
    const productReport = await loadProductReport(db, filters, { paginate: false });
    return encodeCsv(
      ['product_id', 'catalog_key', 'sku', 'name_ro', 'category_id', 'category_ro', 'brand', 'sold_units', 'returned_units', 'net_units', 'gross_merchandise_lei', 'catalog_discount_lei', 'promo_discount_lei', 'refund_lei', 'net_revenue_lei', 'cogs_lei', 'gross_profit_lei', 'unknown_cost_units', 'on_hand', 'reserved', 'available', 'purchase_cost_lei', 'current_inventory_cost_lei'],
      productReport.items.map((row) => [row.id, row.key, row.sku, row.name, row.categoryId, row.categoryName, row.brand, row.soldUnits, row.returnedUnits, row.netUnits, row.grossMerchandise, row.catalogDiscount, row.promoDiscount, row.refundAmount, row.netRevenue, row.cogs, row.grossProfit ?? '', row.unknownCostUnits, row.onHand, row.reserved, row.available, row.costPrice ?? '', row.currentInventoryCost ?? '']),
    );
  }
  if (report === 'inventory') {
    const rows = await loadCurrentInventory(db, filters);
    return encodeCsv(
      ['product_id', 'catalog_key', 'sku', 'name_ro', 'name_ru', 'category_id', 'category_ro', 'brand', 'active', 'on_hand', 'reserved', 'available', 'low_stock_threshold', 'purchase_cost_lei', 'current_inventory_cost_lei'],
      rows.map((row) => {
        const onHand = number(row.on_hand);
        const reserved = number(row.reserved);
        return [row.id, row.catalog_key, row.sku, row.name_ro, row.name_ru, row.category_id, row.category_name, row.brand, Boolean(row.is_active) && !row.deleted_at ? 1 : 0, onHand, reserved, onHand - reserved, row.low_stock_threshold, row.cost_price ?? '', row.cost_price == null ? '' : number(row.cost_price) * onHand];
      }),
    );
  }
  const rows = await loadInventoryMovements(db, filters);
  return encodeCsv(
    ['created_at_utc', 'movement_id', 'type', 'catalog_key', 'sku', 'product_name_ro', 'category_id', 'brand', 'warehouse', 'delta_on_hand', 'delta_reserved', 'balance_on_hand', 'balance_reserved', 'order_no', 'reason', 'actor_email'],
    rows.map((row) => [row.created_at, row.id, row.movement_type, row.catalog_key, row.sku, row.name_ro, row.category_id, row.brand, row.warehouse, row.delta_on_hand, row.delta_reserved, row.balance_on_hand, row.balance_reserved, row.order_no || '', row.reason, row.actor_email || '']),
  );
}
