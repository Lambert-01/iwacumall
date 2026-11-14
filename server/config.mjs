/**
 * server/config.mjs
 * Centralised, validated configuration for IwacuMall.
 * This module must be imported first (before db.mjs or index.mjs).
 * It throws a clear error on startup if required production values are missing.
 */

const isProduction = process.env.NODE_ENV === 'production';
const isTest      = process.env.NODE_ENV === 'test';

function optional(name, defaultValue = '') {
  return process.env[name]?.trim() || defaultValue;
}

function optionalInt(name, defaultValue) {
  const v = process.env[name]?.trim();
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function optionalBool(name, defaultValue = false) {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === 'true'  || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return defaultValue;
}

function looksLikePlaceholder(value) {
  return !value || /(?:REPLACE_|PLACEHOLDER|CHANGE[_ -]?ME|YOUR[_ -]?DOMAIN|YOURDOMAIN|YOUR[_ -]?EMAIL|YOURDOMAIN|YOUR@EMAIL\.COM|YOUR-EMAIL|EXAMPLE\.(?:COM|NET|ORG)|\.EXAMPLE(?:$|[/:])|@EXAMPLE\.)/i.test(String(value));
}

// ─── MongoDB ─────────────────────────────────────────────────────────────────
// MONGODB_URI must be supplied in production. In development/test it may be
// absent – the app will start but all DB operations will fail safely.
const mongoUri = process.env.MONGODB_URI?.trim();
const mongoUriPresent = !!mongoUri
  && !mongoUri.startsWith('REPLACE_')
  && !/USERNAME|PASSWORD|REPLACE_|<[^>]+>|example\.(?:mongodb\.net|com|net|org)/i.test(mongoUri)
  && mongoUri !== 'mongodb://localhost:27017/iwacumall';

if (isProduction && !mongoUriPresent) {
  throw new Error(
    '[config] MONGODB_URI is required in production. ' +
    'Provide your MongoDB Atlas connection string in the MONGODB_URI environment variable.'
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export const config = {
  nodeEnv:      optional('NODE_ENV', 'development'),
  isProduction,
  isTest,

  port:         optionalInt('PORT', 4000),
  host:         optional('HOST', '127.0.0.1'),

  // ── Mongo ───────────────────────────────────────────────────────────────────
  mongoUri:     mongoUri || null,
  mongoUriPresent,
  mongoDbName:  optional('MONGODB_DB_NAME', 'iwacumall'),

  // Encrypts administrator TOTP secrets stored in MongoDB.
  cookieSecret: (function () {
    const s = process.env.COOKIE_SECRET?.trim();
  if (isProduction && (!s || s.length < 32 || looksLikePlaceholder(s))) {
      throw new Error('[config] COOKIE_SECRET must be at least 32 characters in production.');
    }
    return s || 'dev-cookie-secret-not-for-prod';
  })(),

  // Session lifetime (default 7 days)
  sessionTtlSeconds: optionalInt('SESSION_TTL_SECONDS', 60 * 60 * 24 * 7),

  // ── CORS ────────────────────────────────────────────────────────────────────
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Google Sign-In client IDs are public identifiers, not secrets. The server
  // verifies tokens against every configured audience (web and mobile).
  googleClientIds: (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_WEB_CLIENT_ID || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  googleWebClientId: optional('GOOGLE_WEB_CLIENT_ID'),

  // Durable product image storage; uploads stay disabled until all values exist.
  cloudinaryCloudName: optional('CLOUDINARY_CLOUD_NAME'),
  cloudinaryApiKey: optional('CLOUDINARY_API_KEY'),
  cloudinaryApiSecret: optional('CLOUDINARY_API_SECRET'),

  // ── Store meta (public, non-secret) ─────────────────────────────────────────
  storeName:    optional('STORE_NAME', 'IwacuMall'),
  storeAddress: optional('STORE_ADDRESS', '[STORE ADDRESS NOT CONFIGURED]'),
  storePhone:   optional('STORE_PHONE',   '[STORE PHONE NOT CONFIGURED]'),
  storeEmail:   optional('STORE_EMAIL',   ''),
  storeNotificationEmail: optional('STORE_NOTIFICATION_EMAIL'),
  currency:     optional('CURRENCY', 'RWF'),

  // ── Admin provisioning ──────────────────────────────────────────────────────
  adminEmail:    optional('ADMIN_EMAIL'),
  adminPassword: optional('ADMIN_PASSWORD'),
  adminName:     optional('ADMIN_NAME', 'IwacuMall Administrator'),

  appBaseUrl: optional('APP_BASE_URL').replace(/\/+$/, ''),

  // ── Seed ────────────────────────────────────────────────────────────────────
  seedDemoCatalog: !isProduction && optionalBool('SEED_DEMO_CATALOG', !isProduction),

  // ── Invoice / payment ───────────────────────────────────────────────────────
  invoiceExpiryHours: optionalInt('INVOICE_EXPIRY_HOURS', 0), // 0 = not configured
  deliveryFeeFlat:    optionalInt('DELIVERY_FEE_FLAT', -1),   // -1 = not configured
  taxRatePercent:     optionalInt('TAX_RATE_PERCENT', -1),     // -1 = not configured

  // ── Email (optional — order saves even if mail fails) ───────────────────────
  smtpHost:     optional('SMTP_HOST'),
  smtpPort:     optionalInt('SMTP_PORT', 587),
  smtpUser:     optional('SMTP_USER'),
  smtpPass:     optional('SMTP_PASS'),  // read-only; never logged
  smtpFrom:     optional('SMTP_FROM'),

  // ── Email verification ───────────────────────────────────────────────────────
  emailVerificationRequired: optionalBool('EMAIL_VERIFICATION_REQUIRED', isProduction),

  // ── Rate limiting ────────────────────────────────────────────────────────────
  rateLimitWindowMs:   optionalInt('RATE_LIMIT_WINDOW_MS',   15 * 60 * 1000),
  rateLimitMaxLogin:   optionalInt('RATE_LIMIT_MAX_LOGIN',   10),
  rateLimitMaxRegister:optionalInt('RATE_LIMIT_MAX_REGISTER',5),
  rateLimitMaxReset:   optionalInt('RATE_LIMIT_MAX_RESET',   5),
  // Trust proxy hop count for real client IP (e.g. 1 when behind one Nginx)
  trustProxyHops:      optionalInt('TRUST_PROXY_HOPS', 0),
};

if (isProduction) {
  if (!config.adminEmail || !/^\S+@\S+\.\S+$/.test(config.adminEmail) || looksLikePlaceholder(config.adminEmail)) {
    throw new Error('[config] ADMIN_EMAIL must be a valid administrator email in production.');
  }
  if (!config.adminPassword || looksLikePlaceholder(config.adminPassword) || config.adminPassword.length < 14) {
    throw new Error('[config] ADMIN_PASSWORD must be a unique password of at least 14 characters in production.');
  }
  let appUrl;
  try { appUrl = new URL(config.appBaseUrl); } catch {}
  if (!appUrl || appUrl.protocol !== 'https:' || !appUrl.hostname || appUrl.username || appUrl.password ||
      /^(localhost|127\.|0\.0\.0\.0)$/i.test(appUrl.hostname) || looksLikePlaceholder(config.appBaseUrl)) {
    throw new Error('[config] APP_BASE_URL must be the real HTTPS storefront URL in production.');
  }
  if (!config.storeAddress || looksLikePlaceholder(config.storeAddress) || config.storeAddress.includes('NOT CONFIGURED')) {
    throw new Error('[config] STORE_ADDRESS must contain the real customer-facing store address in production.');
  }
  if (!config.storePhone || looksLikePlaceholder(config.storePhone) || config.storePhone.replace(/\D/g, '').length < 8) {
    throw new Error('[config] STORE_PHONE must contain the real customer service number in production.');
  }
  if ((config.storeEmail && looksLikePlaceholder(config.storeEmail)) || (config.storeEmail && !/^\S+@\S+\.\S+$/.test(config.storeEmail))) {
    throw new Error('[config] Set STORE_EMAIL to a valid address or leave it blank.');
  }
  if (!/^\S+@\S+\.\S+$/.test(config.storeNotificationEmail) || looksLikePlaceholder(config.storeNotificationEmail)) {
    throw new Error('[config] STORE_NOTIFICATION_EMAIL must be a real store inbox for order and invoice copies.');
  }
  if (!config.emailVerificationRequired) {
    throw new Error('[config] EMAIL_VERIFICATION_REQUIRED must be true in production.');
  }
  if (config.emailVerificationRequired && (
    !config.smtpHost || looksLikePlaceholder(config.smtpHost) ||
    !config.smtpUser || looksLikePlaceholder(config.smtpUser) ||
    !config.smtpPass || looksLikePlaceholder(config.smtpPass) ||
    !config.smtpFrom || looksLikePlaceholder(config.smtpFrom)
  )) {
    throw new Error('[config] SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are required when email verification is enabled.');
  }
}

export default config;
