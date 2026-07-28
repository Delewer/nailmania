const DAY_MS = 24 * 60 * 60 * 1000;
const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export async function cleanupCustomerAuthRecords(db, {
  now = new Date(),
  revokedSessionRetentionDays = 30,
  resetTokenRetentionDays = 7,
} = {}) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.valueOf())) throw new Error('Maintenance timestamp is invalid');
  const current = timestamp.toISOString();
  const revokedCutoff = new Date(timestamp.getTime() - revokedSessionRetentionDays * DAY_MS).toISOString();
  const resetCutoff = new Date(timestamp.getTime() - resetTokenRetentionDays * DAY_MS).toISOString();
  const results = await db.batch([
    db.prepare(`
      DELETE FROM sessions
      WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
    `).bind(current, revokedCutoff),
    db.prepare(`
      DELETE FROM password_reset_tokens
      WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)
    `).bind(resetCutoff, resetCutoff),
  ]);
  return {
    sessionsDeleted: changedRows(results?.[0]),
    resetTokensDeleted: changedRows(results?.[1]),
  };
}
