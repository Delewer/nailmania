import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D1_TIME_TRAVEL_SAFETY_LAG_MS,
  timeTravelBookmarkTimestamp,
} from '../scripts/d1-release-time.mjs';

test('D1 backup requests a Time Travel bookmark safely behind the local clock', () => {
  const now = new Date('2026-10-20T06:08:29.632Z');
  const bookmark = new Date(timeTravelBookmarkTimestamp(now));

  assert.equal(now.getTime() - bookmark.getTime(), D1_TIME_TRAVEL_SAFETY_LAG_MS);
  assert.equal(bookmark.toISOString(), '2026-10-20T06:07:29.632Z');
});

test('D1 backup timestamp rejects invalid dates', () => {
  assert.throws(() => timeTravelBookmarkTimestamp('not-a-date'), /valid backup timestamp/);
});
