/**
 * server/auth.mjs
 * Authentication helpers: token issuance, session creation, rate limiting,
 * email-verification tokens, password-reset tokens.
 * Does NOT handle HTTP — only logic.
 */

import { randomBytes, createHash, createHmac } from 'node:crypto';
import { sessions, users, authTokens } from './db/repository.mjs';
import { getDb } from './db/mongo.mjs';
import config from './config.mjs';

// ─── Token helpers ────────────────────────────────────────────────────────────

export function issueToken() { return randomBytes(32).toString('base64url'); }
export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Issue a session token and persist the session record. */
export async function createSession(userId) {
  const token   = issueToken();
  const hash    = tokenHash(token);
  const expiresAt = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  await sessions.create({ tokenHash: hash, userId, expiresAt });
  return { token, expiresAt };
}

/** Throw an HTTP error if the user is not authenticated or not an admin. */
export function ensureUser(user) {
  if (!user) throw Object.assign(new Error('Please sign in to continue'), { status: 401 });
}
export function ensureAdmin(user) {
  ensureUser(user);
  if (user.role !== 'ADMIN') throw Object.assign(new Error('Administrator access required'), { status: 403 });
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
export function getClientIp(req) {
  if (config.trustProxyHops > 0) {
    const fwd = req.headers['x-forwarded-for'] || '';
    const ips = fwd.split(',').map(s => s.trim()).filter(Boolean);
    // Take the Nth-from-right address (hop count from right)
    const idx = ips.length - config.trustProxyHops;
    if (idx >= 0 && ips[idx]) return ips[idx];
  }
  return req.socket?.remoteAddress || '0.0.0.0';
}

export async function rateLimit(ip, endpoint, maxAttempts, windowMs) {
  if (config.isTest) return; // skip rate limiting during automated test suites
  const now = Date.now();
  const window = Math.max(1000, Number(windowMs) || 60_000);
  const windowNumber = Math.floor(now / window);
  const bucketId = createHmac('sha256', config.cookieSecret)
    .update(`${ip}:${endpoint}:${window}:${windowNumber}`)
    .digest('hex');
  const expiresAt = new Date((windowNumber + 1) * window);
  const buckets = getDb().collection('rateLimitBuckets');
  let entry;
  try {
    entry = await buckets.findOneAndUpdate(
      { bucketId },
      { $inc: { count: 1 }, $setOnInsert: { bucketId, expiresAt, createdAt: new Date(now) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (error) {
    // Concurrent first requests can race to create the same unique bucket.
    if (error?.code !== 11000) throw error;
    entry = await buckets.findOneAndUpdate(
      { bucketId }, { $inc: { count: 1 } }, { returnDocument: 'after' },
    );
  }
  const count = Number(entry?.count || 0);
  if (count > maxAttempts) {
    throw Object.assign(new Error('Too many attempts. Try again later.'), { status: 429 });
  }
}

// ─── Email verification tokens ───────────────────────────────────────────────

export async function issueEmailVerificationToken(userId, expiresAt = new Date(Date.now() + 24 * 3600 * 1000), session = null) {
  const token     = issueToken();
  await users.setEmailToken(userId, tokenHash(token), expiresAt, session);
  return token; // raw token — send this in email
}

export async function issuePasswordResetToken(userId, expiresAt = new Date(Date.now() + 3600 * 1000), session = null) {
  const token     = issueToken();
  await users.setResetToken(userId, tokenHash(token), expiresAt, session);
  return token;
}

