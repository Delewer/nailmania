# Architecture audit: cart and inventory reservations

## Existing architecture

- Runtime: React 18 + Vite storefront, Cloudflare Pages Functions, Scheduled Worker and Cloudflare D1 (SQLite semantics).
- Catalog source of truth: D1 `products`, `categories`, `inventory` and the effective-price views.
- Inventory model: `inventory.on_hand` is physical stock, `inventory.reserved` is stock unavailable for a physical sale, and `available = on_hand - reserved`.
- Existing staff UI: the protected `/admin/products` area is used by `manager` and `admin` roles. It already supports product search, receipts, write-offs, corrections, movement history, and displays physical/reserved/available quantities.
- Existing order flow: `POST /api/orders` validates an authoritative D1 quote and commits the order, items, inventory changes, promotions and idempotency record in one D1 batch.

## Problem found

The persisted browser cart was not a server-side inventory owner. Stock was protected only when an order was submitted, so a product shown in a customer's cart could still be sold by the physical shop. Keeping a cart for weeks also could not be treated as a valid long-lived reservation.

## Minimal integration path

The existing D1 inventory and `/admin` staff application remain the single system. A separate PostgreSQL service or a second `/staff` inventory database would create two sources of truth, so the implementation is adapted to the deployed Cloudflare architecture:

- add durable, expiring `cart_reservations` linked to the existing product and inventory rows;
- reserve through the API before changing the local cart;
- make all stock readers account for active, non-expired cart reservations;
- convert an active cart reservation to a sale when `POST /api/orders` succeeds;
- use the existing admin inventory workflow for physical sales and stock operations;
- add `/admin/reservations` for both `manager` and `admin`, with 5-second refresh and links from converted reservations to new orders;
- release expired cart reservations in the existing Scheduled Worker and lazily in request paths.

## Resulting invariants

- `inventory.on_hand >= inventory.reserved >= 0` is enforced by the existing D1 constraint inside atomic batches.
- A physical write-off cannot reduce `on_hand` below `reserved`.
- Two carts cannot reserve the same last unit.
- A physical sale and an online reservation cannot both win the same last unit.
- Expired reservations are excluded from public and staff availability even before cleanup changes their status.
- Cart activity does not extend the original 15-minute deadline.
- Successful order submission, not online payment, performs the one-time sale conversion.

Implementation and rollout details are in [docs/CART_RESERVATIONS.md](docs/CART_RESERVATIONS.md).
