/**
 * server/db/mongo.mjs
 * MongoDB Atlas connection and collection/index bootstrap.
 *
 * Usage:
 *   import { getDb, getClient, closeDb } from './db/mongo.mjs';
 *
 * The module exports a lazy singleton. Call connectDb() once at startup;
 * all subsequent calls to getDb() return the cached database handle.
 */

import { MongoClient, ServerApiVersion } from 'mongodb';
import config from '../config.mjs';

let _client = null;
let _db     = null;

/** Connect to Atlas (or local Mongo) and set up indexes. */
export async function connectDb() {
  if (_db) return _db;

  if (!config.mongoUri) {
    throw new Error(
      '[mongo] MONGODB_URI is not configured. ' +
      'Provide a valid MongoDB Atlas connection string to start the application.'
    );
  }

  _client = new MongoClient(config.mongoUri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    // Keep connections alive across serverless cold-starts / idle periods
    minPoolSize: 1,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
  });

  await _client.connect();
  _db = _client.db(config.mongoDbName);

  // Ping to confirm connectivity
  await _db.command({ ping: 1 });
  console.log(`[mongo] Connected to database: ${config.mongoDbName}`);

  await ensureIndexes(_db);
  return _db;
}

/** Return the cached database, or throw if not yet connected. */
export function getDb() {
  if (!_db) throw new Error('[mongo] Database not connected. Call connectDb() first.');
  return _db;
}

/** Return the raw client (for transactions). */
export function getClient() {
  if (!_client) throw new Error('[mongo] Client not available. Call connectDb() first.');
  return _client;
}

/** Gracefully close the connection. */
export async function closeDb() {
  if (_client) { await _client.close(); _client = null; _db = null; }
}

/** Health check — returns true if the db is reachable, false otherwise. */
export async function dbPing() {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

// ─── Index bootstrap ─────────────────────────────────────────────────────────

async function ensureIndexes(db) {
  // 1. users: Safely remove legacy and dangerous TTL indexes on the users collection.
  // CRITICAL SAFETY FIX: Never have TTL indexes on 'users' collection because MongoDB TTL deletes
  // the entire document (user account) when the token date expires.
  const usersCollectionExists = (await db.listCollections({ name: 'users' }).toArray()).length > 0;
  if (usersCollectionExists) {
    const legacyNames = new Set([
      'users_email_token', 'users_reset_token',
      'users_email_token_expiry', 'users_reset_token_expiry',
    ]);
    // Remove every TTL index from users, including custom names installed by
    // older deployments. A TTL index on this collection deletes whole users.
    const indexes = await db.collection('users').listIndexes().toArray();
    for (const index of indexes) {
      if (index.name === '_id_' || (!legacyNames.has(index.name) && index.expireAfterSeconds === undefined)) continue;
      try {
        await db.collection('users').dropIndex(index.name);
      } catch (error) {
        if (error?.code !== 27 && error?.codeName !== 'IndexNotFound') throw error;
      }
    }
  }

  // Safe unique & performance indexes for users (NO TTL INDEXES)
  await db.collection('users').createIndexes([
    { key: { email: 1 },      name: 'users_email_unique', unique: true },
    { key: { googleSub: 1 },  name: 'users_google_sub_unique', unique: true, sparse: true },
    { key: { role: 1 },       name: 'users_role' },
    { key: { createdAt: -1 }, name: 'users_created_at' },
  ]);

  // 2. authTokens: Separate collection for verification & password reset tokens with TTL.
  // Expired tokens are purged from this collection without touching the user account.
  await db.collection('authTokens').createIndexes([
    { key: { tokenHash: 1 },      name: 'auth_tokens_hash', unique: true },
    { key: { userId: 1, type: 1 },name: 'auth_tokens_user_type' },
    { key: { expiresAt: 1 },      name: 'auth_tokens_ttl', expireAfterSeconds: 0 },
  ]);

  await db.collection('rateLimitBuckets').createIndexes([
    { key: { bucketId: 1 }, name: 'rate_limit_bucket_unique', unique: true },
    { key: { expiresAt: 1 }, name: 'rate_limit_bucket_ttl', expireAfterSeconds: 0 },
  ]);

  // 3. sessions: TTL expires the session document when expiresAt passes.
  await db.collection('sessions').createIndexes([
    { key: { tokenHash: 1 }, name: 'sessions_token_hash', unique: true },
    { key: { userId:    1 }, name: 'sessions_user' },
    { key: { expiresAt: 1 }, name: 'sessions_expires', expireAfterSeconds: 0 },
  ]);

  // 4. products
  await db.collection('products').createIndexes([
    { key: { slug:       1 }, name: 'products_slug', unique: true },
    { key: { categoryId: 1 }, name: 'products_category' },
    { key: { categorySlug: 1},name: 'products_category_slug' },
    { key: { active: 1, featured: -1, createdAt: -1 }, name: 'products_active_featured' },
  ]);

  // 5. categories
  await db.collection('categories').createIndexes([
    { key: { slug: 1 }, name: 'categories_slug', unique: true },
    { key: { name: 1 }, name: 'categories_name', unique: true },
  ]);

  await db.collection('inventoryAdjustments').createIndexes([
    { key: { productId: 1, createdAt: -1 }, name: 'inventory_adjustments_product_date' },
    { key: { adminId: 1, createdAt: -1 }, name: 'inventory_adjustments_admin_date' },
  ]);

  // 6. orders
  await db.collection('orders').createIndexes([
    { key: { userId:        1, createdAt: -1 }, name: 'orders_user' },
    { key: { invoiceNumber: 1 },                name: 'orders_invoice', unique: true },
    { key: { status:        1 },                name: 'orders_status' },
    { key: { fulfillmentStatus: 1 },            name: 'orders_fulfillment_status' },
    { key: { paymentStatus: 1 },                name: 'orders_payment_status' },
    { key: { createdAt:    -1 },                name: 'orders_created_at' },
    { key: { paymentDeadline: 1 },              name: 'orders_payment_deadline', sparse: true },
    { key: { 'refunds.paymentRef': 1 },          name: 'orders_refund_reference_unique', unique: true, sparse: true },
  ]);

  // 7. idempotencyKeys: Durable checkout idempotency
  await db.collection('idempotencyKeys').createIndexes([
    { key: { userId: 1, key: 1 }, name: 'idempotency_user_key', unique: true },
  ]);
  try {
    await db.collection('idempotencyKeys').dropIndex('idempotency_ttl');
  } catch (error) {
    if (error?.code !== 27 && error?.codeName !== 'IndexNotFound' && error?.code !== 26 && error?.codeName !== 'NamespaceNotFound') throw error;
  }

  // 8. payment_methods (admin-configured)
  await db.collection('paymentMethods').createIndexes([
    { key: { enabled: 1 }, name: 'payment_methods_enabled' },
    { key: { order:   1 }, name: 'payment_methods_order' },
  ]);

  // 9. storeSettings: Singleton store configuration
  await db.collection('storeSettings').createIndexes([
    { key: { id: 1 }, name: 'store_settings_singleton', unique: true },
  ]);

  // 10. auditLog
  await db.collection('auditLog').createIndexes([
    { key: { orderId:    1, createdAt: -1 }, name: 'audit_order' },
    { key: { adminId:    1, createdAt: -1 }, name: 'audit_admin' },
    { key: { createdAt: -1 },               name: 'audit_created' },
  ]);

  // 11. admin_totp (MFA)
  await db.collection('adminTotpSecrets').createIndexes([
    { key: { userId: 1 }, name: 'totp_user', unique: true },
  ]);

  // 12. emailOutbox: Durable transactional email jobs
  const outboxExists = (await db.listCollections({ name: 'emailOutbox' }).toArray()).length > 0;
  if (outboxExists) {
    const previousDedupIndex = (await db.collection('emailOutbox').listIndexes().toArray())
      .find(index => index.name === 'outbox_dedup');
    if (previousDedupIndex) {
      await db.collection('emailOutbox').dropIndex('outbox_dedup');
    }
  }
  await db.collection('emailOutbox').createIndexes([
    { key: { status: 1, nextAttemptAt: 1 }, name: 'outbox_poll' },
    { key: { id: 1 },                       name: 'outbox_id_unique', unique: true, sparse: true },
    { key: { createdAt: -1 },               name: 'outbox_created' },
  ]);

  console.log('[mongo] Indexes verified.');
}
