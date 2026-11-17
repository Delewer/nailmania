import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialPendingOrderSnapshot,
  nextPendingOrderSnapshot,
} from '../src/admin-order-alerts.js';

const payload = (count, id = '', createdAt = '') => ({
  counts: { pending: count },
  latestPending: id ? { id, createdAt } : null,
});

test('pending order alerts establish a silent baseline and notify on a newer order', () => {
  const baseline = nextPendingOrderSnapshot(
    initialPendingOrderSnapshot,
    payload(2, 'order-2', '2026-11-17T10:00:00.000Z'),
  );
  assert.equal(baseline.shouldNotify, false);

  const arrival = nextPendingOrderSnapshot(
    baseline.snapshot,
    payload(3, 'order-3', '2026-11-17T10:01:00.000Z'),
  );
  assert.equal(arrival.shouldNotify, true);
});

test('pending order alerts ignore refreshes and older rows revealed by confirmation', () => {
  const baseline = nextPendingOrderSnapshot(
    initialPendingOrderSnapshot,
    payload(2, 'newest', '2026-11-17T10:00:00.000Z'),
  );
  const unchanged = nextPendingOrderSnapshot(
    baseline.snapshot,
    payload(2, 'newest', '2026-11-17T10:00:00.000Z'),
  );
  assert.equal(unchanged.shouldNotify, false);

  const olderRevealed = nextPendingOrderSnapshot(
    unchanged.snapshot,
    payload(1, 'older', '2026-11-17T09:00:00.000Z'),
  );
  assert.equal(olderRevealed.shouldNotify, false);
  assert.equal(olderRevealed.snapshot.cursor, baseline.snapshot.cursor);
});

test('pending order alerts detect a new order even when another order was confirmed', () => {
  const baseline = nextPendingOrderSnapshot(
    initialPendingOrderSnapshot,
    payload(2, 'order-2', '2026-11-17T10:00:00.000Z'),
  );
  const replaced = nextPendingOrderSnapshot(
    baseline.snapshot,
    payload(2, 'order-3', '2026-11-17T10:01:00.000Z'),
  );
  assert.equal(replaced.shouldNotify, true);
});
