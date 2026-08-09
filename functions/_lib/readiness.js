import { customerEmailDeliveryConfigured } from './customer-email.js';

const present = (value) => typeof value === 'string'
  ? value.trim().length > 0
  : value !== null && value !== undefined;

const httpsUrl = (value) => {
  try { return new URL(String(value || '')).protocol === 'https:'; }
  catch { return false; }
};

const productionR2PublicUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && !url.hostname.toLocaleLowerCase('en-US').endsWith('.r2.dev');
  } catch {
    return false;
  }
};

const validCloudflareAccountId = (value) => /^[a-f0-9]{32}$/i.test(String(value || '').trim());
const validAnalyticsDataset = (value) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(value || '').trim());
const distinctSecondaryTelegramChat = (env) => {
  const primary = String(env?.TELEGRAM_CHAT_ID || '').trim();
  const secondary = String(env?.TELEGRAM_SECONDARY_CHAT_ID || '').trim();
  return Boolean(primary && secondary && primary !== secondary);
};
const r2ManagementCredentialsAbsent = (env) => [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
].every((name) => !present(env?.[name]));

export async function productionReadiness(env, db) {
  let database = false;
  let notificationJournal = false;
  try {
    const row = await db.prepare('SELECT 1 AS healthy').first();
    database = Number(row?.healthy) === 1;
    const notificationRow = await db.prepare('SELECT COUNT(*) AS count FROM notification_attempts').first();
    notificationJournal = Number(notificationRow?.count) >= 0;
  } catch {
    notificationJournal = false;
  }
  const checks = {
    database,
    notificationJournal,
    accessTeamDomain: present(env?.CF_ACCESS_TEAM_DOMAIN),
    accessAudience: present(env?.CF_ACCESS_AUD),
    authFingerprintSalt: String(env?.AUTH_FINGERPRINT_SALT || '').trim().length >= 16,
    rateLimitSecret: String(env?.RATE_LIMIT_SECRET || '').trim().length >= 16,
    turnstileSecret: present(env?.TURNSTILE_SECRET_KEY),
    telegramBotToken: present(env?.TELEGRAM_BOT_TOKEN),
    telegramChatId: present(env?.TELEGRAM_CHAT_ID),
    telegramSecondaryChatId: distinctSecondaryTelegramChat(env),
    customerEmailDelivery: customerEmailDeliveryConfigured(env),
    customerPasswordResetUrl: httpsUrl(env?.CUSTOMER_PASSWORD_RESET_URL),
    productImagesBinding: present(env?.PRODUCT_IMAGES),
    r2PublicBaseUrl: productionR2PublicUrl(env?.R2_PUBLIC_BASE_URL),
    r2ManagementCredentialsAbsent: r2ManagementCredentialsAbsent(env),
    productAnalyticsBinding: typeof env?.PRODUCT_ANALYTICS?.writeDataPoint === 'function',
    analyticsIndexSecret: String(env?.ANALYTICS_INDEX_SECRET || '').trim().length >= 16,
    cloudflareAccountId: validCloudflareAccountId(env?.CLOUDFLARE_ACCOUNT_ID),
    analyticsReadToken: present(env?.ANALYTICS_READ_TOKEN),
    productAnalyticsDataset: validAnalyticsDataset(env?.PRODUCT_ANALYTICS_DATASET),
  };
  return { ready: Object.values(checks).every(Boolean), checks };
}
