# Nail Mania statistics contract

## Period and recognition rules

All reporting endpoints require canonical UTC instants (`YYYY-MM-DDTHH:mm:ss.sssZ`) and use the half-open interval `[from, to)`. Offsets such as `+03:00`, date-only values and reversed bounds are rejected instead of being silently converted.

The operational `orderFlow` uses `orders.created_at` and reports orders received in the selected period, their current status, ordered value, active value and cancelled value. A sale is recognized separately at `orders.completed_at` only while the current status is `completed` or `returned`. Pending, confirmed, processing, ready, shipped and cancelled orders never contribute a sale. A refund is recognized independently at immutable `order_returns.created_at`; therefore a refund made today for an older sale decreases today's revenue.

Money remains in whole Moldovan lei, matching the order schema. The dashboard formulas are:

- `grossMerchandise = Σ(items_subtotal + catalog_discount)` for recognized sales (equivalently, list-price merchandise);
- `catalogDiscount = Σ(catalog_discount)`;
- `promoDiscount = Σ(promo_discount)`;
- `saleRevenue = Σ(total_amount) = merchandise after catalog discount - promo discount + delivery`;
- `refundAmount = Σ(order_returns.items_amount - order_returns.promo_refund_amount)` for refund events in the period;
- `netRevenue = saleRevenue - refundAmount`;
- `averageCheck = netRevenue / recognized sale order count` (zero when there are no recognized sales);
- product/category/brand `netUnits = sold_quantity recognized in period - immutable returned quantity recognized in period`;
- merchandise `netRevenue = sold unit_price - allocated promo discount - actual refund`; delivery is intentionally not allocated to a product/category/brand;
- `COGS = Σ(cost_price_snapshot × sold units) - Σ(cost_price_snapshot × returned units)`;
- `grossProfit = merchandise net revenue - COGS`. It is `null` if any contributing sale/refund quantity has no purchase-cost snapshot;
- `currentInventoryCost = Σ(products.cost_price × inventory.on_hand)`. Units with no current purchase price are reported separately and never treated as zero-cost stock.
- `inventory.costCoveragePercent` is the share of current on-hand units that have a purchase cost. The UI shows `—` when no on-hand unit has a known cost.

The daily report keeps received orders and ordered value separate from completed sales, refunds and net revenue. A confirmed order therefore appears in the operational columns immediately, but does not inflate revenue before completion.

Migration `0010_statistics_and_analytics.sql` adds immutable category ID/name and purchase-cost snapshots to `order_items`. Existing lines receive only a best-effort backfill from the catalogue state at migration time. Every new order stores the catalogue values at checkout; later product/category edits cannot change historical report dimensions.

## Administrative endpoints

All endpoints require an active D1 `admin` after Cloudflare Access (or the local admin token) and return `Cache-Control: no-store`. The operational `manager` role cannot access statistics or exports.

- `GET /api/admin/statistics?from=...&to=...` returns summary, daily ledger, product/category/brand reports, inventory value and paginated product filters (`q`, `category`, `brand`, `stock=low|out|no_sales`, `limit`, `offset`).
- `GET /api/admin/statistics/events?from=...&to=...` returns optional Analytics Engine funnel metrics. It returns `configured:false` when read credentials are intentionally absent.
- `GET /api/admin/statistics/export?report=sales|products|inventory|movements&from=...&to=...` exports UTF-8 CSV with a BOM. Every cell is quoted; quotes are doubled; text beginning with `=`, `+`, `-` or `@` (including after whitespace) receives an apostrophe to prevent Excel/LibreOffice formula execution. Numeric negatives remain numeric.

The `sales` CSV is a ledger: sale rows are timestamped by completion and refund rows by the immutable return timestamp. Its `net_revenue_lei` column adds up to the summary net revenue. Inventory and movement exports honor the same product filters; `no_sales` means no recognized sold quantity in the requested period.

## Analytics Engine event schema

Preview and production use different `PRODUCT_ANALYTICS` datasets. Local Pages development deliberately has no remote Analytics Engine binding.

Ordered fields (Analytics Engine accepts ordered arrays):

| Position | Blob | Meaning |
|---|---|---|
| `blob1` | event | `product_view`, `add_to_cart`, `search`, `checkout_started`, `order_created` |
| `blob2` | product key | Server-verified catalogue key, or empty |
| `blob3` | category ID | Server-verified catalogue category, or empty |
| `blob4` | brand | Server-verified catalogue brand, or empty |
| `blob5` | language | `ro` or `ru` |
| `blob6` | source | Strict source enum |

| Position | Double | Meaning |
|---|---|---|
| `double1` | count | Always `1` |
| `double2` | quantity/items | Added quantity or checkout/order item count |
| `double3` | value | Server catalogue add value or checkout/order value in lei |
| `double4` | result count | Search result count; the query is never sent |
| `double5` | query length | Length only; raw search text is never accepted |

Exactly one index is written: a 64-byte hex HMAC of a random anonymous browser UUID and UTC day. The raw UUID, IP, user agent, name, email, phone, address, order number and search text are never stored. The index stays below Cloudflare's 96-byte limit and rotates daily.

`POST /api/events` is JSON-only, limited to 4096 bytes, same-origin, rate-limited and accepts only the four browser events. `order_created` is in the dataset schema but is forbidden on the public endpoint; the order service emits it with server-calculated item count/value only after its D1 batch commits. Analytics failure never rolls back a valid order.

The reader calls only Cloudflare's official SQL endpoint with a fixed query template and a validated dataset/date range. Counts and sums are weighted by `_sample_interval`, as required for sampled Analytics Engine rows. References: [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), [sampling and limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/).

The event panel shows views, cart additions, searches, checkout starts, created orders, created-order value, checkout-to-order conversion and view-to-order conversion. These conversion rates are event ratios, not unique-user conversion; the anonymous daily HMAC is deliberately not exposed as customer identity.

## External configuration (no values in Git)

- `ANALYTICS_INDEX_SECRET`: separate secret of at least 16 characters for the anonymous HMAC. The writer accepts `RATE_LIMIT_SECRET` only as a compatibility fallback, but production readiness deliberately requires the separate value.
- `CLOUDFLARE_ACCOUNT_ID`: non-secret account identifier used only by the optional admin reader.
- `ANALYTICS_READ_TOKEN`: secret Cloudflare API token limited to `Account Analytics: Read`.

The committed `PRODUCT_ANALYTICS_DATASET` variable must match the environment's `PRODUCT_ANALYTICS` binding. `scripts/verify-release-config.mjs` checks this isolation and prints only a reader-readiness boolean, never a secret value.
