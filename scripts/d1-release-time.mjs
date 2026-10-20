export const D1_TIME_TRAVEL_SAFETY_LAG_MS = 60_000;

export function timeTravelBookmarkTimestamp(value = new Date()) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('A valid backup timestamp is required');
  return new Date(timestamp - D1_TIME_TRAVEL_SAFETY_LAG_MS).toISOString();
}
