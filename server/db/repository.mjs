/**
 * server/db/repository.mjs
 * Data access helpers (repositories) used by the route handlers.
 * All writes go through here — keeping business logic separate from HTTP concerns.
 */

import { ObjectId } from 'mongodb';
import { getDb, getClient } from './mongo.mjs';
import { randomUUID }       from 'node:crypto';
import config               from '../config.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function col(name) { return getDb().collection(name); }

async function queueOrderEventEmail(db, order, eventType, detail, session, createdAt = new Date()) {
  const recipients = [
    order.customerEmail && { kind: 'CUSTOMER', email: order.customerEmail },
    (order.storeNotificationEmail || config.storeNotificationEmail) && { kind: 'STORE', email: order.storeNotificationEmail || config.storeNotificationEmail },
  ].filter(Boolean).filter((recipient, index, list) => list.findIndex(item => item.email.toLowerCase() === recipient.email.toLowerCase()) === index)
    .map(recipient => ({ ...recipient, status: 'PENDING', attempts: 0, lastError: null }));
  if (!recipients.length) return;
  const seller = order.sellerSnapshot || {};
  const eventSnapshot = {
    orderId: order.id,
    eventType,
    detail: String(detail || '').slice(0, 500),
    invoiceNumber: order.invoiceNumber,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    phone: order.phone,
    address: order.address,
    city: order.city,
    total: Number(order.total || 0),
    refundedAmount: Number(order.refundedAmount || 0),
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    refundStatus: order.refundStatus || '',
    returnStatus: order.returnStatus || '',
    storeName: seller.name || seller.storeName || config.storeName,
    currency: order.currency || config.currency || 'RWF',
  };
  await db.collection('emailOutbox').insertOne({
    id: randomUUID(), orderId: order.id, eventType, eventSnapshot,
    status: 'PENDING', recipients, attempts: 0,
    nextAttemptAt: createdAt, createdAt, updatedAt: createdAt,
  }, { session });
}

/** Generate a human-readable, unique invoice number. e.g. INV-20261107-A3B9 */
function newInvoiceNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g,'').slice(0,6).toUpperCase();
  return `INV-${date}-${suffix}`;
}

export function slugify(value) {
  return String(value).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Auth Tokens (Separated from users to prevent user deletion on token TTL) ──

export const authTokens = {
  async issue({ userId, type, tokenHash, expiresAt, session = null }) {
    const options = session ? { session } : {};
    await col('authTokens').deleteMany({ userId, type }, options);
    return col('authTokens').insertOne({
      userId,
      type,
      tokenHash,
      expiresAt: new Date(expiresAt),
      createdAt: new Date(),
    }, options);
  },
  async consume({ tokenHash, type }) {
    return col('authTokens').findOneAndDelete({
      tokenHash,
      type,
      expiresAt: { $gt: new Date() },
    });
  },
  async findValid({ tokenHash, type }) {
    return col('authTokens').findOne({
      tokenHash,
      type,
      expiresAt: { $gt: new Date() },
    });
  },
  async revokeAllForUser(userId) {
    return col('authTokens').deleteMany({ userId });
  },
};

// ─── Durable order email outbox ──────────────────────────────────────────────

export const emailOutbox = {
  async list(limit = 100) {
    return col('emailOutbox').find({}, { projection: { _id: 0, pdfBuffer: 0, encryptedAuthToken: 0 } })
      .sort({ createdAt: -1 }).limit(Math.min(200, Math.max(1, limit))).toArray();
  },
  async queueAuthEmail({ userId, email, eventType, encryptedAuthToken, tokenExpiresAt, session = null }) {
    if (!['AUTH_EMAIL_VERIFICATION', 'AUTH_PASSWORD_RESET'].includes(eventType)) {
      throw new Error('Unsupported authentication email type');
    }
    const now = new Date();
    const options = session ? { session } : {};
    await col('emailOutbox').updateMany({
      userId, eventType, status: { $in: ['PENDING', 'RETRY', 'FAILED'] },
      encryptedAuthToken: { $exists: true },
    }, {
      $set: { status: 'CANCELLED', cancelledAt: now, updatedAt: now },
      $unset: { encryptedAuthToken: '' },
    }, options);
    return col('emailOutbox').insertOne({
      id: randomUUID(), userId, eventType, encryptedAuthToken, tokenExpiresAt,
      status: 'PENDING',
      recipients: [{ kind: 'USER', email: email.toLowerCase(), status: 'PENDING', attempts: 0, lastError: null }],
      attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    }, options);
  },
  async requeue(id, { resendAll = false } = {}) {
    const job = await col('emailOutbox').findOne({ id });
    if (!job) return { found: false };
    if (job.status === 'SENDING') return { found: true, requeued: false, reason: 'Email is being processed.' };
    if (job.eventType?.startsWith('AUTH_') && job.tokenExpiresAt <= new Date()) {
      return { found: true, requeued: false, reason: 'This sign-in link has expired. The customer must request a fresh email.' };
    }
    if (job.eventType?.startsWith('AUTH_') && resendAll) {
      return { found: true, requeued: false, reason: 'Authentication links cannot be resent after delivery. The customer must request a fresh link.' };
    }
    if (resendAll && job.status !== 'SENT') {
      return { found: true, requeued: false, reason: 'Only a fully sent email can be resent.' };
    }
    if (!resendAll && !['FAILED', 'RETRY'].includes(job.status)) {
      return { found: true, requeued: false, reason: 'This email job is not awaiting a retry.' };
    }
    const recipients = (job.recipients || []).map(recipient => {
      if (resendAll || recipient.status === 'FAILED') {
        return { ...recipient, status: 'PENDING', attempts: 0, lastError: null };
      }
      return recipient;
    });
    if (!recipients.some(recipient => recipient.status === 'PENDING')) {
      return { found: true, requeued: false, reason: 'There are no failed recipients to retry.' };
    }
    const result = await col('emailOutbox').updateOne({ id, status: job.status }, {
      $set: { recipients, status: 'PENDING', nextAttemptAt: new Date(), updatedAt: new Date() },
      $unset: { leaseUntil: '', leaseToken: '', lastError: '' },
    });
    if (result.modifiedCount !== 1) {
      return { found: true, requeued: false, reason: 'Email state changed while the action was being processed. Refresh and try again.' };
    }
    return { found: true, requeued: true };
  },
};

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = {
  async findByEmail(email) {
    return col('users').findOne({ email: email.toLowerCase() });
  },
  async findById(id) {
    return col('users').findOne({ id });
  },
  async findByGoogleSub(googleSub) {
    return col('users').findOne({ googleSub });
  },
  async create({ id, name, email, passwordHash = null, role = 'CUSTOMER', emailVerified = false, googleSub = null }, session = null) {
    const doc = {
      id,
      name,
      email: email.toLowerCase(),
      passwordHash,
      ...(googleSub ? { googleSub } : {}),
      role,
      emailVerified,
      emailToken:     null,
      resetToken:     null,
      mfaEnabled:     false,
      createdAt:      new Date(),
    };
    await col('users').insertOne(doc, session ? { session } : {});
    return doc;
  },
  async linkGoogleIdentity(id, googleSub) {
    const result = await col('users').updateOne(
      { id, $or: [{ googleSub: { $exists: false } }, { googleSub: null }, { googleSub }] },
      { $set: { googleSub, emailVerified: true, updatedAt: new Date() } },
    );
    return result.matchedCount === 1 ? this.findById(id) : null;
  },
  async setEmailToken(userId, token, expiresAt, session = null) {
    return authTokens.issue({ userId, type: 'EMAIL_VERIFICATION', tokenHash: token, expiresAt, session });
  },
  async verifyEmail(token) {
    const tokenDoc = await authTokens.consume({ tokenHash: token, type: 'EMAIL_VERIFICATION' });
    let userId = tokenDoc?.userId;
    if (!userId) {
      // Legacy fallback
      const legacyUser = await col('users').findOne({
        'emailToken.token': token,
        'emailToken.expiresAt': { $gt: new Date() },
      });
      if (legacyUser) userId = legacyUser.id;
    }
    if (!userId) return null;
    return col('users').findOneAndUpdate(
      { id: userId },
      { $set: { emailVerified: true, emailToken: null } },
      { returnDocument: 'after' },
    );
  },
  async setResetToken(userId, token, expiresAt, session = null) {
    return authTokens.issue({ userId, type: 'PASSWORD_RESET', tokenHash: token, expiresAt, session });
  },
  async resetPasswordWithToken(token, passwordHash) {
    const tokenDoc = await authTokens.consume({ tokenHash: token, type: 'PASSWORD_RESET' });
    let userId = tokenDoc?.userId;
    if (!userId) {
      // Legacy fallback
      const legacyUser = await col('users').findOne({
        'resetToken.token': token,
        'resetToken.expiresAt': { $gt: new Date() },
      });
      if (legacyUser) userId = legacyUser.id;
    }
    if (!userId) return null;

    const changedUser = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { passwordHash, resetToken: null, passwordUpdatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (changedUser) {
      await col('sessions').deleteMany({ userId: changedUser.id });
      await authTokens.revokeAllForUser(changedUser.id);
    }
    return changedUser;
  },
  async setPassword(userId, passwordHash) {
    return col('users').updateOne({ id: userId }, { $set: { passwordHash } });
  },
  async updateName(userId, name) {
    return col('users').updateOne({ id: userId }, { $set: { name, updatedAt: new Date() } });
  },
  async saveAddress(userId, address) {
    const user = await col('users').findOne({ id: userId }, { projection: { savedAddresses: 1 } });
    const addresses = Array.isArray(user?.savedAddresses) ? user.savedAddresses : [];
    const index = addresses.findIndex(item => item.id === address.id);
    const isDefault = address.isDefault || (addresses.length === 0 && index < 0);
    const updated = addresses.map(item => ({ ...item, ...(isDefault ? { isDefault: false } : {}) }));
    const normalized = { ...address, isDefault };
    if (index < 0) updated.push(normalized);
    else updated[index] = normalized;
    await col('users').updateOne({ id: userId }, { $set: { savedAddresses: updated, updatedAt: new Date() } });
    return updated;
  },
  async deleteAddress(userId, addressId) {
    const user = await col('users').findOne({ id: userId }, { projection: { savedAddresses: 1 } });
    const addresses = Array.isArray(user?.savedAddresses) ? user.savedAddresses : [];
    const removed = addresses.find(item => item.id === addressId);
    const remaining = addresses.filter(item => item.id !== addressId);
    if (removed?.isDefault && remaining.length) remaining[0].isDefault = true;
    await col('users').updateOne({ id: userId }, { $set: { savedAddresses: remaining, updatedAt: new Date() } });
    return { removed: !!removed, addresses: remaining };
  },
  async anonymize(userId) {
    // Replace PII with anonymised values; retain id/role/timestamps for legal
    const anon = `deleted-${userId.slice(0,8)}@removed.invalid`;
    return col('users').updateOne({ id: userId }, {
      $set: {
        name:          '[deleted]',
        email:         anon,
        passwordHash:  'deleted',
        emailVerified: false,
        emailToken:    null,
        resetToken:    null,
        deletedAt:     new Date(),
      },
      $unset: { googleSub: '', savedAddresses: '' },
    });
  },
  /** Count of active customers — used by admin stats. */
  async countCustomers() {
    return col('users').countDocuments({ role: 'CUSTOMER', deletedAt: { $exists: false } });
  },
};

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessions = {
  async create({ tokenHash, userId, expiresAt }) {
    return col('sessions').insertOne({ tokenHash, userId, expiresAt: new Date(expiresAt * 1000), createdAt: new Date() });
  },
  async findByToken(tokenHash) {
    return col('sessions').findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  },
  async deleteByToken(tokenHash) {
    return col('sessions').deleteOne({ tokenHash });
  },
  async deleteAllForUser(userId) {
    return col('sessions').deleteMany({ userId });
  },
  async listForUser(userId) {
    return col('sessions').find({ userId, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 }).toArray();
  },
  /** Revoke a specific session by its _id (not tokenHash — for user self-service). */
  async revokeByOid(oid, userId) {
    return col('sessions').deleteOne({ _id: new ObjectId(oid), userId });
  },
};

// ─── Categories ──────────────────────────────────────────────────────────────

export const categories = {
  async list({ includeArchived = false } = {}) {
    return col('categories').find(includeArchived ? {} : { active: { $ne: false } }).sort({ name: 1 }).toArray();
  },
  async findById(id) {
    return col('categories').findOne({ id });
  },
  async findBySlug(slug) {
    return col('categories').findOne({ slug });
  },
  async findByName(name) {
    return col('categories').findOne({ name });
  },
  async create({ id, name, slug, description = '', imageUrl = '', imagePublicId = '' }) {
    return col('categories').insertOne({ id, name, slug, description, imageUrl, imagePublicId, active: true, createdAt: new Date() });
  },
  async update(id, fields) {
    return col('categories').updateOne({ id, active: { $ne: false } }, { $set: { ...fields, updatedAt: new Date() } });
  },
  async countImageReferences(publicId, exceptId = '') {
    const query = { imagePublicId: publicId };
    if (exceptId) query.id = { $ne: exceptId };
    return col('categories').countDocuments(query);
  },
  async archive(id) {
    return col('categories').updateOne({ id, active: { $ne: false } }, { $set: { active: false, archivedAt: new Date() } });
  },
  async restore(id) {
    return col('categories').updateOne({ id, active: false }, { $set: { active: true, updatedAt: new Date() }, $unset: { archivedAt: '' } });
  },
};

// ─── Products ────────────────────────────────────────────────────────────────

export const products = {
  async list({ categorySlug, search, featured, limit = 80, page = 1, skip = null, includeInactive = false } = {}) {
    const query = {};
    if (!includeInactive) query.active = true;
    if (categorySlug && categorySlug !== 'all') query.categorySlug = categorySlug;
    if (featured) query.featured = true;
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ name: re }, { description: re }];
    }

    const effectiveLimit = Math.min(200, Math.max(1, Number(limit) || 80));
    const effectiveSkip = skip !== null ? Math.max(0, Number(skip)) : Math.max(0, (Number(page) - 1) * effectiveLimit);

    const [items, total, allCategories] = await Promise.all([
      col('products').find(query)
        .sort({ featured: -1, createdAt: -1 })
        .skip(effectiveSkip)
        .limit(effectiveLimit)
        .project({ _id: 0, passwordHash: 0 })
        .toArray(),
      col('products').countDocuments(query),
      col('categories').find().toArray(),
    ]);

    const catMap = Object.fromEntries(allCategories.map(c => [c.slug, c.name]));
    const enriched = items.map(p => ({
      ...p,
      category: catMap[p.categorySlug] || p.category || (p.categorySlug ? p.categorySlug.replace(/-/g, ' ') : 'Uncategorized'),
    }));

    return {
      products: enriched,
      total,
      page: Math.floor(effectiveSkip / effectiveLimit) + 1,
      limit: effectiveLimit,
      totalPages: Math.ceil(total / effectiveLimit) || 1,
    };
  },
  async findById(id) {
    const p = await col('products').findOne({ id }, { projection: { _id: 0 } });
    if (!p) return null;
    if (!p.category && p.categorySlug) {
      const cat = await col('categories').findOne({ slug: p.categorySlug });
      p.category = cat?.name || p.categorySlug.replace(/-/g, ' ');
    }
    return p;
  },
  async findBySlug(slug) {
    const p = await col('products').findOne({ slug }, { projection: { _id: 0 } });
    if (!p) return null;
    if (!p.category && p.categorySlug) {
      const cat = await col('categories').findOne({ slug: p.categorySlug });
      p.category = cat?.name || p.categorySlug.replace(/-/g, ' ');
    }
    return p;
  },
  async create(doc) {
    return col('products').insertOne(doc);
  },
  async update(id, fields) {
    return col('products').updateOne({ id }, { $set: { ...fields, updatedAt: new Date() } });
  },
  async countImageReferences(publicId, exceptProductId = '') {
    const query = { $or: [{ imagePublicId: publicId }, { 'images.publicId': publicId }] };
    if (exceptProductId) query.id = { $ne: exceptProductId };
    return col('products').countDocuments(query);
  },
  async countActiveByCategory(categoryId, categorySlug) {
    return col('products').countDocuments({ active: true, $or: [{ categoryId }, { categorySlug }] });
  },
  async countByCategory(categoryId, categorySlug) {
    return col('products').countDocuments({ $or: [{ categoryId }, { categorySlug }] });
  },
  async adjustStock({ productId, adminId, delta, reason }) {
    const db = getDb();
    const session = getClient().startSession();
    let adjustment;
    try {
      await session.withTransaction(async () => {
        const product = await db.collection('products').findOne({ id: productId }, { session });
        if (!product) throw Object.assign(new Error('Product not found.'), { status: 404 });
        const previousStock = Number(product.stock) || 0;
        const nextStock = previousStock + delta;
        if (!Number.isSafeInteger(nextStock) || nextStock < 0 || nextStock > 1_000_000) {
          throw Object.assign(new Error('This adjustment would put stock outside the allowed range.'), { status: 400 });
        }
        const now = new Date();
        const changed = await db.collection('products').updateOne(
          { id: productId, stock: previousStock },
          { $set: { stock: nextStock, updatedAt: now } },
          { session },
        );
        if (changed.modifiedCount !== 1) throw Object.assign(new Error('Stock changed during this adjustment. Refresh and try again.'), { status: 409 });
        adjustment = { id: randomUUID(), productId, productName: product.name, adminId, delta, previousStock, newStock: nextStock, reason, createdAt: now };
        await db.collection('inventoryAdjustments').insertOne(adjustment, { session });
        await db.collection('auditLog').insertOne({ action: 'INVENTORY_ADJUSTED', productId, adminId, detail: `${previousStock} → ${nextStock}; ${reason}`, createdAt: now }, { session });
      });
    } finally {
      await session.endSession();
    }
    return adjustment;
  },
  async listAdjustments(productId, limit = 50) {
    return col('inventoryAdjustments').find({ productId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).limit(Math.min(100, Math.max(1, limit))).toArray();
  },
  async softDelete(id) {
    return col('products').updateOne({ id, deletedAt: { $exists: false } }, { $set: { active: false, deletedAt: new Date(), updatedAt: new Date() } });
  },
  async restore(id) {
    return col('products').updateOne({ id, deletedAt: { $exists: true } }, { $set: { active: true, updatedAt: new Date() }, $unset: { deletedAt: '' } });
  },
  async countActive() {
    return col('products').countDocuments({ active: true });
  },
};

// ─── Orders ──────────────────────────────────────────────────────────────────

export const orders = {
  /**
   * Create an order using a MongoDB transaction (requires replica set / Atlas).
   * Falls back to a sequential write if the driver is connected to standalone Mongo.
   */
  async createWithStockReservation({
    userId, customerName, phone, address, city, note,
    items, paymentMethodId, paymentMethodSnapshot, deliveryFee, taxAmount,
    returnWindowDays = 0,
    paymentDeadline, customerEmail, storeNotificationEmail, sellerSnapshot,
    idempotencyKey, requestFingerprint,
  }) {
    const db     = getDb();
    const client = getClient();
    const session = client.startSession();
    let outcome;
    try {
      outcome = await session.withTransaction(async () => {
        if (idempotencyKey) {
          const existing = await db.collection('idempotencyKeys').findOne(
            { userId, key: idempotencyKey }, { session }
          );
          if (existing) {
            if (existing.requestFingerprint !== requestFingerprint) {
              throw Object.assign(new Error('Idempotency key already used with different checkout details'), { status: 409 });
            }
            return { replayed: true, response: existing.response };
          }
        }

        // 1. Verify product availability. New products use the admin's
        // Available toggle; inventory reservation remains opt-in for any
        // explicitly tracked legacy product.
        const reservedLines = new Set();
        for (const item of items) {
          const product = await db.collection('products').findOne(
            { id: item.productId, active: true }, { session }
          );
          if (!product) throw Object.assign(new Error('A product in your cart is unavailable'), { status: 409 });
          if (item.trackInventory === true && product.trackInventory === true) {
            const result = await db.collection('products').findOneAndUpdate(
              { id: item.productId, active: true, stock: { $gte: item.quantity } },
              { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } },
              { session, returnDocument: 'after' }
            );
            if (!result) throw Object.assign(new Error(`Not enough stock for ${product.name || 'this product'}`), { status: 409 });
            reservedLines.add(`${item.productId}\u0000${item.variantId || ''}`);
          }
        }

        // 2. Calculate totals
        const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
        const total    = subtotal + (deliveryFee || 0) + (taxAmount || 0);

        // 3. Build order document
        const orderId       = randomUUID();
        const invoiceNumber = newInvoiceNumber();
        const createdAt = new Date();

        const orderDoc = {
          id:               orderId,
          userId,
          customerName,
          customerEmail:    customerEmail || '',
          phone,
          address,
          city,
          note:             note || '',
          items:            items.map(i => ({
            productId:   i.productId,
            variantId:   i.variantId || '',
            variantType: i.variantType || '',
            variantValue:i.variantValue || '',
            productName: i.productName,
            unitPrice:   i.unitPrice,
            quantity:    i.quantity,
            isSecondHand: i.isSecondHand === true,
            stockReserved: reservedLines.has(`${i.productId}\u0000${i.variantId || ''}`),
          })),
          subtotal,
          deliveryFee:      deliveryFee || 0,
          taxAmount:        taxAmount   || 0,
          total,
          paymentMethodId,
          paymentMethodSnapshot, // immutable snapshot of instructions at order time
          sellerSnapshot: sellerSnapshot || {},
          currency: config.currency,
          invoiceNumber,
          paymentStatus:    'PENDING',
          fulfillmentStatus:'PLACED',
          paymentDeadline:  paymentDeadline || null,
          returnWindowDays: Number.isSafeInteger(returnWindowDays) ? returnWindowDays : 0,
          paymentRef:       null,
          paymentConfirmedAt: null,
          paymentConfirmedBy: null,
          createdAt,
          updatedAt:        createdAt,
        };
        await db.collection('orders').insertOne(orderDoc, { session });

        const response = {
          order: {
            id: orderId,
            invoiceNumber,
            subtotal,
            deliveryFee: deliveryFee || 0,
            taxAmount: taxAmount || 0,
            total,
            paymentDeadline: paymentDeadline || null,
            paymentStatus: 'PENDING',
            paymentMethodLabel: paymentMethodSnapshot?.label || '',
            paymentInstructions: paymentMethodSnapshot?.instructions || '',
            paymentMethodSnapshot,
          },
        };

        if (idempotencyKey) {
          await db.collection('idempotencyKeys').insertOne({
            userId,
            key: idempotencyKey,
            requestFingerprint,
            response,
            orderId,
            createdAt,
          }, { session });
        }

        const recipients = [
          customerEmail && { kind: 'CUSTOMER', email: customerEmail },
          storeNotificationEmail && { kind: 'STORE', email: storeNotificationEmail },
        ].filter(Boolean).map(recipient => ({ ...recipient, status: 'PENDING', attempts: 0, lastError: null }));
        if (recipients.length) {
          await db.collection('emailOutbox').insertOne({
            id: randomUUID(),
            orderId,
            eventType: 'ORDER_INVOICE',
            status: 'PENDING',
            recipients,
            attempts: 0,
            nextAttemptAt: createdAt,
            createdAt,
            updatedAt: createdAt,
          }, { session });
        }

        return { replayed: false, order: orderDoc, response };
      });
    } catch (error) {
      // Two simultaneous requests can both read no idempotency row before one
      // commits. The unique index makes the loser re-read the winner's result.
      if (idempotencyKey && error?.code === 11000) {
        const existing = await col('idempotencyKeys').findOne({ userId, key: idempotencyKey });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw Object.assign(new Error('Idempotency key already used with different checkout details'), { status: 409 });
          }
          return { replayed: true, response: existing.response };
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return outcome;
  },

  async findById(id) {
    return col('orders').findOne({ id }, { projection: { _id: 0 } });
  },
  async findByUserId(userId, limit = 50, skip = 0) {
    return col('orders').find({ userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
  },
  async listAdmin({ limit = 100, skip = 0, status, paymentStatus, search, includeArchived = false } = {}) {
    const query = { adminArchivedAt: includeArchived ? { $exists: true } : { $exists: false } };
    if (status)        query.fulfillmentStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ id: re }, { customerName: re }, { phone: re }, { city: re }, { invoiceNumber: re }];
    }
    return col('orders').find(query, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
  },
  async countOpen() {
    return col('orders').countDocuments({
      adminArchivedAt: { $exists: false },
      fulfillmentStatus: { $nin: ['DELIVERED', 'CANCELLED'] }
    });
  },
  async archiveForAdmin({ orderId, adminId }) {
    const now = new Date();
    const result = await col('orders').updateOne(
      { id: orderId, adminArchivedAt: { $exists: false } },
      { $set: { adminArchivedAt: now, adminArchivedBy: adminId, updatedAt: now } },
    );
    if (result.modifiedCount === 1) {
      await col('auditLog').insertOne({ action: 'ORDER_ARCHIVED', orderId, adminId, detail: 'Removed from active admin order list; order history retained.', createdAt: now });
    }
    return result.modifiedCount === 1;
  },
  async restoreAdminArchive({ orderId, adminId }) {
    const now = new Date();
    const result = await col('orders').updateOne(
      { id: orderId, adminArchivedAt: { $exists: true } },
      { $unset: { adminArchivedAt: '', adminArchivedBy: '' }, $set: { updatedAt: now } },
    );
    if (result.modifiedCount === 1) {
      await col('auditLog').insertOne({ action: 'ORDER_RESTORED', orderId, adminId, detail: 'Restored to active admin order list.', createdAt: now });
    }
    return result.modifiedCount === 1;
  },
  async sumRevenue() {
    const agg = await col('orders').aggregate([
      { $match: { fulfillmentStatus: 'DELIVERED', paymentStatus: 'PAID' } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$total', { $ifNull: ['$refundedAmount', 0] }] } } } },
    ]).toArray();
    return agg[0]?.total || 0;
  },
  async count() {
    return col('orders').countDocuments();
  },

  /**
   * Admin confirms payment — idempotent.
   * Returns false if payment was already confirmed.
   */
  async confirmPayment({ orderId, adminId, paymentRef, note }) {
    const db = getDb();
    const session = getClient().startSession();
    let changed = false;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const result = await db.collection('orders').updateOne(
          { id: orderId, paymentStatus: 'PENDING' },
          { $set: {
            paymentStatus: 'PAID', paymentRef, paymentNote: note || '',
            paymentConfirmedAt: now, paymentConfirmedBy: adminId, updatedAt: now,
          } },
          { session },
        );
        if (!result.modifiedCount) return;
        await db.collection('auditLog').insertOne({
          action: 'PAYMENT_CONFIRMED', orderId, adminId,
          detail: `ref:${paymentRef}${note ? `; ${note}` : ''}`, createdAt: now,
        }, { session });
        const updatedOrder = await db.collection('orders').findOne({ id: orderId }, { session });
        await queueOrderEventEmail(db, updatedOrder, 'PAYMENT_CONFIRMED', `ref:${paymentRef}${note ? `; ${note}` : ''}`, session, now);
        changed = true;
      });
    } finally {
      await session.endSession();
    }
    return changed;
  },

  /** Record a refund that the store has already issued through its manual payment provider. */
  async refundOrder({ orderId, adminId, amount, reason, paymentRef }) {
    const db = getDb();
    const session = getClient().startSession();
    let outcome = null;
    try {
      await session.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId }, { session });
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (order.paymentStatus !== 'PAID') throw Object.assign(new Error('Only paid orders can be refunded.'), { status: 409 });
        const refundedBefore = Number(order.refundedAmount || 0);
        const remaining = Math.max(0, Number(order.total) - refundedBefore);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > remaining) {
          throw Object.assign(new Error(`Refund must be between 1 and ${remaining} RWF.`), { status: 400 });
        }
        const now = new Date();
        const refundedAmount = refundedBefore + amount;
        const refundStatus = refundedAmount >= Number(order.total) ? 'FULLY_REFUNDED' : 'PARTIALLY_REFUNDED';
        const refund = { id: randomUUID(), amount, reason, paymentRef, adminId, createdAt: now };
        const previousAmountFilter = refundedBefore === 0
          ? { $or: [{ refundedAmount: 0 }, { refundedAmount: { $exists: false } }] }
          : { refundedAmount: refundedBefore };
        const updated = await db.collection('orders').updateOne(
          { id: orderId, paymentStatus: 'PAID', ...previousAmountFilter },
          { $set: { refundedAmount, refundStatus, updatedAt: now }, $push: { refunds: refund } },
          { session },
        );
        if (!updated.modifiedCount) throw Object.assign(new Error('Refund state changed. Refresh the order and try again.'), { status: 409 });
        await db.collection('auditLog').insertOne({
          action: 'ORDER_REFUNDED', orderId, adminId,
          detail: `${amount} RWF; ${paymentRef}; ${reason}`,
          createdAt: now,
        }, { session });
        const updatedOrder = await db.collection('orders').findOne({ id: orderId }, { session });
        await queueOrderEventEmail(db, updatedOrder, 'ORDER_REFUNDED', `${amount} RWF; ${paymentRef}; ${reason}`, session, now);
        outcome = { refund, refundedAmount, remaining: Number(order.total) - refundedAmount, refundStatus };
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw Object.assign(new Error('This refund reference has already been recorded.'), { status: 409 });
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return outcome;
  },

  async requestReturn({ orderId, userId, items, reason, returnWindowDays }) {
    const db = getDb();
    const session = getClient().startSession();
    let outcome = null;
    try {
      await session.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId, userId }, { session });
        if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
        if (order.paymentStatus !== 'PAID' || order.fulfillmentStatus !== 'DELIVERED') {
          throw Object.assign(new Error('Only delivered, paid orders can be returned.'), { status: 409 });
        }
        const deliveredAt = order.deliveredAt || order.updatedAt || order.createdAt;
        const allowedDays = Number.isSafeInteger(order.returnWindowDays) ? order.returnWindowDays : returnWindowDays;
        const deadline = new Date(new Date(deliveredAt).getTime() + allowedDays * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (!allowedDays || !Number.isFinite(deadline.getTime()) || now > deadline) {
          throw Object.assign(new Error('The return request period for this order has ended.'), { status: 409 });
        }
        const previousRequests = order.returnRequests || [];
        if (previousRequests.some(request => ['REQUESTED', 'APPROVED'].includes(request.status))) {
          throw Object.assign(new Error('This order already has a return request awaiting completion.'), { status: 409 });
        }
        const purchased = new Map((order.items || []).map(line => [line.productId, {
          productName: line.productName || line.product_name || 'Product',
          quantity: Number(line.quantity || 0),
        }]));
        const alreadyReturned = new Map();
        for (const request of previousRequests) {
          if (request.status === 'REJECTED') continue;
          for (const line of request.items || []) {
            const accounted = request.status === 'RECEIVED' ? Number(line.returnedQuantity || 0) : Number(line.quantity || 0);
            alreadyReturned.set(line.productId, (alreadyReturned.get(line.productId) || 0) + accounted);
          }
        }
        const requestedItems = [];
        const selected = new Set();
        for (const item of items || []) {
          const purchase = purchased.get(item.productId);
          if (!purchase) throw Object.assign(new Error('A selected item is not part of this order.'), { status: 400 });
          if (selected.has(item.productId)) throw Object.assign(new Error('Select each product only once.'), { status: 400 });
          selected.add(item.productId);
          const remaining = purchase.quantity - (alreadyReturned.get(item.productId) || 0);
          if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > remaining) {
            throw Object.assign(new Error(`Return quantity for ${purchase.productName} exceeds the quantity available.`), { status: 400 });
          }
          requestedItems.push({
            productId: item.productId, productName: purchase.productName, quantity: item.quantity,
            returnedQuantity: 0, restockedQuantity: 0,
          });
        }
        if (!requestedItems.length) throw Object.assign(new Error('Select at least one item to return.'), { status: 400 });
        const request = {
          id: randomUUID(), status: 'REQUESTED', items: requestedItems,
          reason: String(reason || '').slice(0, 500), requestedAt: now, deadline,
        };
        const updated = await db.collection('orders').updateOne(
          {
            id: orderId, userId, paymentStatus: 'PAID', fulfillmentStatus: 'DELIVERED',
            $nor: [{ returnRequests: { $elemMatch: { status: { $in: ['REQUESTED', 'APPROVED'] } } } }],
          },
          { $push: { returnRequests: request }, $set: { returnStatus: 'REQUESTED', updatedAt: now } },
          { session },
        );
        if (updated.modifiedCount !== 1) throw Object.assign(new Error('The order changed. Refresh your orders and try again.'), { status: 409 });
        const updatedOrder = await db.collection('orders').findOne({ id: orderId }, { session });
        await db.collection('auditLog').insertOne({
          action: 'RETURN_REQUESTED', orderId, userId, detail: `${request.id}; ${requestedItems.map(item => `${item.quantity} × ${item.productName}`).join(', ')}; ${request.reason}`,
          createdAt: now,
        }, { session });
        await queueOrderEventEmail(db, updatedOrder, 'ORDER_RETURN_REQUESTED', `${request.id}; ${request.reason}`, session, now);
        outcome = { request };
      });
    } finally {
      await session.endSession();
    }
    return outcome;
  },

  async reviewReturnRequest({ orderId, requestId, adminId, decision, reviewNote }) {
    const db = getDb();
    const session = getClient().startSession();
    let outcome = null;
    try {
      await session.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId }, { session });
        if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
        const request = (order.returnRequests || []).find(item => item.id === requestId);
        if (!request) throw Object.assign(new Error('Return request not found.'), { status: 404 });
        if (request.status !== 'REQUESTED') throw Object.assign(new Error('This return request has already been reviewed.'), { status: 409 });
        const now = new Date();
        const changed = await db.collection('orders').updateOne(
          { id: orderId, returnRequests: { $elemMatch: { id: requestId, status: 'REQUESTED' } } },
          { $set: {
            'returnRequests.$.status': decision,
            'returnRequests.$.reviewNote': String(reviewNote || '').slice(0, 300),
            'returnRequests.$.reviewedAt': now,
            'returnRequests.$.reviewedBy': adminId,
            returnStatus: decision,
            updatedAt: now,
          } },
          { session },
        );
        if (!changed.modifiedCount) throw Object.assign(new Error('The return request changed. Refresh and try again.'), { status: 409 });
        const updatedOrder = await db.collection('orders').findOne({ id: orderId }, { session });
        await db.collection('auditLog').insertOne({
          action: decision === 'APPROVED' ? 'RETURN_APPROVED' : 'RETURN_REJECTED', orderId, adminId,
          detail: `${requestId}${reviewNote ? `; ${reviewNote}` : ''}`, createdAt: now,
        }, { session });
        await queueOrderEventEmail(db, updatedOrder, decision === 'APPROVED' ? 'ORDER_RETURN_APPROVED' : 'ORDER_RETURN_REJECTED', `${requestId}; ${reviewNote || decision}`, session, now);
        outcome = { ok: true, status: decision };
      });
    } finally {
      await session.endSession();
    }
    return outcome;
  },

  async receiveReturnRequest({ orderId, requestId, adminId, receivedItems, note }) {
    const db = getDb();
    const session = getClient().startSession();
    let outcome = null;
    try {
      await session.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId }, { session });
        if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
        const request = (order.returnRequests || []).find(item => item.id === requestId);
        if (!request) throw Object.assign(new Error('Return request not found.'), { status: 404 });
        if (request.status !== 'APPROVED') throw Object.assign(new Error('Only approved returns can be marked received.'), { status: 409 });
        const requestedIds = new Set((request.items || []).map(item => item.productId));
        const receivedByProduct = new Map();
        for (const item of receivedItems || []) {
          if (!requestedIds.has(item.productId)) throw Object.assign(new Error('A received item is not part of this return request.'), { status: 400 });
          if (receivedByProduct.has(item.productId)) throw Object.assign(new Error('Each returned product can only be listed once.'), { status: 400 });
          receivedByProduct.set(item.productId, item);
        }
        const processedItems = [];
        for (const requested of request.items || []) {
          const receipt = receivedByProduct.get(requested.productId) || { quantityReceived: 0, restockQuantity: 0 };
          if (!Number.isSafeInteger(receipt.quantityReceived) || receipt.quantityReceived < 0 || receipt.quantityReceived > requested.quantity ||
              !Number.isSafeInteger(receipt.restockQuantity) || receipt.restockQuantity < 0 || receipt.restockQuantity > receipt.quantityReceived) {
            throw Object.assign(new Error(`Received/restock quantities for ${requested.productName} exceed the approved request.`), { status: 400 });
          }
          if (receipt.quantityReceived > 0) processedItems.push({
            productId: requested.productId, productName: requested.productName,
            returnedQuantity: receipt.quantityReceived, restockedQuantity: receipt.restockQuantity,
          });
        }
        if (receivedByProduct.size > (request.items || []).length || !processedItems.length) {
          throw Object.assign(new Error('Record at least one item received from this return.'), { status: 400 });
        }
        const now = new Date();
        const restocked = [];
        for (const item of processedItems.filter(item => item.restockedQuantity > 0)) {
          const product = await db.collection('products').findOne({ id: item.productId }, { session });
          if (!product) throw Object.assign(new Error(`Product ${item.productName} no longer exists in inventory.`), { status: 409 });
          const previousStock = Number(product.stock) || 0;
          const newStock = previousStock + item.restockedQuantity;
          if (!Number.isSafeInteger(newStock) || newStock > 1_000_000) throw Object.assign(new Error(`Restocking ${item.productName} would exceed the inventory limit.`), { status: 400 });
          const changed = await db.collection('products').updateOne(
            { id: item.productId, stock: previousStock },
            { $set: { stock: newStock, updatedAt: now } },
            { session },
          );
          if (changed.modifiedCount !== 1) throw Object.assign(new Error('Inventory changed during return processing. Refresh and try again.'), { status: 409 });
          const adjustment = {
            id: randomUUID(), productId: item.productId, productName: item.productName, adminId,
            delta: item.restockedQuantity, previousStock, newStock,
            reason: `Return ${order.invoiceNumber || order.id}: ${requestId}${note ? `; ${note}` : ''}`,
            createdAt: now,
          };
          await db.collection('inventoryAdjustments').insertOne(adjustment, { session });
          await db.collection('auditLog').insertOne({
            action: 'INVENTORY_RESTOCKED_FROM_RETURN', orderId, productId: item.productId, adminId,
            detail: `${item.restockedQuantity}; return:${requestId}; ${previousStock} → ${newStock}`, createdAt: now,
          }, { session });
          restocked.push(adjustment);
        }
        const updated = await db.collection('orders').updateOne(
          { id: orderId, returnRequests: { $elemMatch: { id: requestId, status: 'APPROVED' } } },
          { $set: {
            'returnRequests.$.status': 'RECEIVED',
            'returnRequests.$.items': (request.items || []).map(item => {
              const processed = processedItems.find(receipt => receipt.productId === item.productId);
              return { ...item, returnedQuantity: processed?.returnedQuantity || 0, restockedQuantity: processed?.restockedQuantity || 0 };
            }),
            'returnRequests.$.receivedAt': now,
            'returnRequests.$.receivedBy': adminId,
            'returnRequests.$.receiptNote': String(note || '').slice(0, 300),
            returnStatus: 'RECEIVED',
            updatedAt: now,
          } },
          { session },
        );
        if (!updated.modifiedCount) throw Object.assign(new Error('The return request changed. Refresh and try again.'), { status: 409 });
        const updatedOrder = await db.collection('orders').findOne({ id: orderId }, { session });
        await db.collection('auditLog').insertOne({
          action: 'RETURN_RECEIVED', orderId, adminId,
          detail: `${requestId}; received:${processedItems.map(item => `${item.returnedQuantity} ${item.productName}`).join(', ')}; restocked:${restocked.map(item => `${item.delta} ${item.productName}`).join(', ') || 'none'}`,
          createdAt: now,
        }, { session });
        await queueOrderEventEmail(db, updatedOrder, 'ORDER_RETURN_RECEIVED', `${requestId}; ${note || 'Returned goods received and inspected.'}`, session, now);
        outcome = { ok: true, status: 'RECEIVED', restockedItems: restocked };
      });
    } finally {
      await session.endSession();
    }
    return outcome;
  },

  /**
   * Admin cancels an unpaid order — restores stock exactly once.
   */
  async cancelOrder({ orderId, adminId, reason }) {
    const db     = getDb();
    const client = getClient();
    const sess   = client.startSession();
    let changed  = false;
    try {
      await sess.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId }, { session: sess });
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (order.paymentStatus === 'PAID') throw Object.assign(
          new Error('Cannot cancel a paid order. Refund it instead.'), { status: 409 }
        );
        if (order.fulfillmentStatus === 'CANCELLED') { changed = false; return; }

        // Restore stock
        for (const line of order.items.filter(item => item.stockReserved !== false)) {
          await db.collection('products').updateOne(
            { id: line.productId },
            { $inc: { stock: line.quantity }, $set: { updatedAt: new Date() } },
            { session: sess }
          );
        }
        await db.collection('orders').updateOne({ id: orderId }, {
          $set: {
            fulfillmentStatus: 'CANCELLED',
            paymentStatus:     order.paymentStatus === 'PENDING' ? 'VOID' : order.paymentStatus,
            cancelReason:      reason || '',
            cancelledBy:       adminId,
            cancelledAt:       new Date(),
            updatedAt:         new Date(),
          }
        }, { session: sess });
        await db.collection('auditLog').insertOne({
          action: 'ORDER_CANCELLED', orderId, adminId, detail: reason || '', createdAt: new Date(),
        }, { session: sess });
        await queueOrderEventEmail(db, {
          ...order,
          fulfillmentStatus: 'CANCELLED',
          paymentStatus: order.paymentStatus === 'PENDING' ? 'VOID' : order.paymentStatus,
        }, 'ORDER_CANCELLED', reason || '', sess);
        changed = true;
      });
    } finally {
      await sess.endSession();
    }
    return changed;
  },

  /** Enforce forward-only fulfillment and write its audit event atomically. */
  async updateFulfillment({ orderId, adminId, fulfillmentStatus }) {
    const transitions = {
      PLACED: ['CONFIRMED'],
      CONFIRMED: ['PACKING'],
      PACKING: ['OUT_FOR_DELIVERY'],
      OUT_FOR_DELIVERY: ['DELIVERED'],
      DELIVERED: [],
      CANCELLED: [],
    };
    const db = getDb();
    const session = getClient().startSession();
    let changed = false;
    try {
      await session.withTransaction(async () => {
        const order = await db.collection('orders').findOne({ id: orderId }, { session });
        const isInitialOrderConfirmation = order?.fulfillmentStatus === 'PLACED' && fulfillmentStatus === 'CONFIRMED';
        if (!order || (!isInitialOrderConfirmation && order.paymentStatus !== 'PAID') || order.refundStatus === 'FULLY_REFUNDED' || !transitions[order.fulfillmentStatus]?.includes(fulfillmentStatus)) return;
        const now = new Date();
        const result = await db.collection('orders').updateOne(
          { id: orderId, fulfillmentStatus: order.fulfillmentStatus },
          { $set: {
            fulfillmentStatus,
            ...(fulfillmentStatus === 'DELIVERED' ? { deliveredAt: now } : {}),
            updatedAt: now,
          } },
          { session },
        );
        if (!result.modifiedCount) return;
        await db.collection('auditLog').insertOne({
          action: 'FULFILLMENT_UPDATED', orderId, adminId, detail: fulfillmentStatus, createdAt: now,
        }, { session });
        await queueOrderEventEmail(db, { ...order, fulfillmentStatus }, 'FULFILLMENT_UPDATED', fulfillmentStatus, session, now);
        changed = true;
      });
    } finally {
      await session.endSession();
    }
    return changed;
  },

  /** Mark expired unpaid orders EXPIRED and restore stock. Called by expiry job. */
  async expireOverdueOrders() {
    const db     = getDb();
    const client = getClient();
    const now    = new Date();

    // Find candidates
    const expired = await col('orders').find({
      paymentStatus: 'PENDING',
      paymentDeadline: { $lt: now },
      fulfillmentStatus: { $nin: ['CANCELLED', 'DELIVERED'] },
    }).toArray();

    let count = 0;
    for (const order of expired) {
      const sess = client.startSession();
      let didExpire = false;
      try {
        await sess.withTransaction(async () => {
          didExpire = false;
          const expiredAt = new Date();
          const r = await db.collection('orders').updateOne(
            {
              id: order.id,
              paymentStatus: 'PENDING',
              paymentDeadline: { $lt: expiredAt },
              fulfillmentStatus: { $nin: ['CANCELLED', 'DELIVERED'] },
            },
            { $set: { paymentStatus: 'EXPIRED', fulfillmentStatus: 'CANCELLED', updatedAt: expiredAt } },
            { session: sess }
          );
          if (r.modifiedCount === 1) {
            for (const line of order.items.filter(item => item.stockReserved !== false)) {
              await db.collection('products').updateOne(
                { id: line.productId },
                { $inc: { stock: line.quantity }, $set: { updatedAt: expiredAt } },
                { session: sess }
              );
            }
            await db.collection('auditLog').insertOne({
              action: 'ORDER_EXPIRED', orderId: order.id,
              detail: 'Invoice payment deadline elapsed', createdAt: expiredAt,
            }, { session: sess });
            await queueOrderEventEmail(db, {
              ...order,
              paymentStatus: 'EXPIRED',
              fulfillmentStatus: 'CANCELLED',
            }, 'ORDER_EXPIRED', 'Invoice payment deadline elapsed', sess, expiredAt);
            didExpire = true;
          }
        });
        if (didExpire) count++;
      } finally {
        await sess.endSession();
      }
    }
    return count;
  },
};

// ─── Payment Methods (admin-configured) ─────────────────────────────────────

export const paymentMethods = {
  async list(enabledOnly = false) {
    const query = enabledOnly ? { enabled: true } : {};
    return col('paymentMethods').find(query).sort({ order: 1 }).project({ _id: 0 }).toArray();
  },
  async findById(id) {
    return col('paymentMethods').findOne({ id }, { projection: { _id: 0 } });
  },
  async create(doc) {
    return col('paymentMethods').insertOne(doc);
  },
  async update(id, fields) {
    return col('paymentMethods').updateOne({ id }, { $set: fields });
  },
  async delete(id) {
    return col('paymentMethods').deleteOne({ id });
  },
};

// ─── Store settings ──────────────────────────────────────────────────────────

export const storeSettings = {
  async get() {
    const saved = await col('storeSettings').findOne(
      { id: 'store' },
      { projection: { _id: 0, id: 0, updatedAt: 0 } },
    );
    return {
      storeName: config.storeName,
      storeAddress: config.storeAddress,
      storePhone: config.storePhone,
      storeEmail: config.storeEmail,
      deliveryFeeFlat: config.deliveryFeeFlat,
      taxRatePercent: config.taxRatePercent,
      invoiceExpiryHours: config.invoiceExpiryHours,
      returnWindowDays: 0,
      ...saved,
    };
  },
  async update(fields) {
    return col('storeSettings').updateOne(
      { id: 'store' },
      { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { id: 'store' } },
      { upsert: true },
    );
  },
};

export const adminMfa = {
  async find(userId) {
    return col('adminTotpSecrets').findOne({ userId }, { projection: { _id: 0 } });
  },
  async savePending(userId, encryptedSecret, recoveryCodeHashes) {
    return col('adminTotpSecrets').updateOne(
      { userId },
      { $set: { pendingSecret: encryptedSecret, pendingRecoveryCodeHashes: recoveryCodeHashes, updatedAt: new Date() }, $setOnInsert: { userId } },
      { upsert: true },
    );
  },
  async activate(userId) {
    const db = getDb();
    const session = getClient().startSession();
    let activated = false;
    try {
      await session.withTransaction(async () => {
        activated = false;
        const result = await db.collection('adminTotpSecrets').updateOne(
          { userId, pendingSecret: { $exists: true } },
          [
            { $set: { secret: '$pendingSecret', recoveryCodeHashes: '$pendingRecoveryCodeHashes', updatedAt: new Date() } },
            { $unset: ['pendingSecret', 'pendingRecoveryCodeHashes'] },
          ],
          { session },
        );
        if (!result.modifiedCount) return;
        const userResult = await db.collection('users').updateOne(
          { id: userId, role: 'ADMIN' }, { $set: { mfaEnabled: true } }, { session },
        );
        if (!userResult.matchedCount) throw new Error('Administrator account is missing during MFA activation');
        // Force every existing administrator session to authenticate with MFA.
        await db.collection('sessions').deleteMany({ userId }, { session });
        activated = true;
      });
    } finally {
      await session.endSession();
    }
    return activated;
  },
  async consumeRecoveryCode(userId, codeHash) {
    const result = await col('adminTotpSecrets').updateOne(
      { userId, recoveryCodeHashes: codeHash },
      { $pull: { recoveryCodeHashes: codeHash }, $set: { updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },
};

// ─── Audit Log ───────────────────────────────────────────────────────────────

export const auditLog = {
  async record({ action, orderId, adminId, userId, productId, detail }) {
    return col('auditLog').insertOne({
      action,
      orderId:   orderId || null,
      adminId:   adminId || null,
      userId:    userId || null,
      productId: productId || null,
      detail:    detail  || null,
      createdAt: new Date(),
    });
  },
  async listForOrder(orderId) {
    return col('auditLog').find({ orderId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).toArray();
  },
};
