/** Durable order email worker with atomic leases and bounded retries. */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db/mongo.mjs';
import { authTokens, orders } from './db/repository.mjs';
import { generateInvoicePdf } from './pdf/invoice.mjs';
import { decryptSensitiveValue } from './mfa.mjs';
import { sendOrderEventEmail, sendOrderInvoiceEmail, sendPasswordResetEmail, sendVerificationEmail } from './mailer.mjs';

const MAX_ATTEMPTS = 8;
const LEASE_MS = 120_000;
const BATCH_SIZE = 10;

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value.value === 'function') return Buffer.from(value.value(true));
  if (value?.buffer && Number.isInteger(value.position)) return Buffer.from(value.buffer.subarray(0, value.position));
  return null;
}

function retryDelay(attempts) {
  return Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)));
}

async function claimNextJob() {
  const now = new Date();
  const leaseToken = randomUUID();
  const job = await getDb().collection('emailOutbox').findOneAndUpdate(
    {
      $or: [
        { status: { $in: ['PENDING', 'RETRY'] }, nextAttemptAt: { $lte: now } },
        { status: 'SENDING', leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'SENDING', leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
  );
  return job ? { ...job, leaseToken } : null;
}

async function purgeExpiredAuthTokens() {
  const now = new Date();
  const outbox = getDb().collection('emailOutbox');
  await outbox.updateMany({
    eventType: { $in: ['AUTH_EMAIL_VERIFICATION', 'AUTH_PASSWORD_RESET'] },
    status: { $in: ['PENDING', 'RETRY'] },
    tokenExpiresAt: { $lte: now },
    encryptedAuthToken: { $exists: true },
  }, {
    $set: {
      status: 'EXPIRED', expiredAt: now, updatedAt: now,
      'recipients.$[].status': 'FAILED',
      'recipients.$[].lastError': 'The sign-in link expired before the email could be delivered.',
    },
    $unset: { encryptedAuthToken: '' },
  });
  await outbox.updateMany({
    eventType: { $in: ['AUTH_EMAIL_VERIFICATION', 'AUTH_PASSWORD_RESET'] },
    status: { $in: ['SENT', 'FAILED', 'EXPIRED', 'CANCELLED'] },
    tokenExpiresAt: { $lte: now },
    encryptedAuthToken: { $exists: true },
  }, {
    $unset: { encryptedAuthToken: '' },
    $set: { authTokenPurgedAt: now, updatedAt: now },
  });
}

async function setRecipientResult(job, recipient, status, error = null) {
  const attempts = Number(recipient.attempts || 0) + 1;
  const recipientStatus = status === 'SENT' ? 'SENT' : attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  const fields = {
    [`recipients.$[r].status`]: recipientStatus,
    [`recipients.$[r].attempts`]: attempts,
    [`recipients.$[r].lastError`]: error ? String(error).slice(0, 300) : null,
  };
  if (recipientStatus === 'SENT') fields['recipients.$[r].sentAt'] = new Date();
  await getDb().collection('emailOutbox').updateOne(
    { id: job.id, status: 'SENDING', leaseToken: job.leaseToken },
    { $set: fields },
    { arrayFilters: [{ 'r.kind': recipient.kind }] },
  );
}

async function processJob(job) {
  const db = getDb();
  const isInvoice = job.eventType === 'ORDER_INVOICE';
  const isAuthEmail = ['AUTH_EMAIL_VERIFICATION', 'AUTH_PASSWORD_RESET'].includes(job.eventType);
  const order = isInvoice ? await orders.findById(job.orderId) : null;
  if (isInvoice && !order) throw new Error('Order snapshot not found');
  if (!isInvoice && !isAuthEmail && !job.eventSnapshot) throw new Error('Order event snapshot not found');

  let authToken = null;
  if (isAuthEmail) {
    if (!job.encryptedAuthToken || !job.tokenExpiresAt) throw new Error('Authentication email token is unavailable');
    if (new Date(job.tokenExpiresAt).getTime() <= Date.now()) {
      const now = new Date();
      await db.collection('emailOutbox').updateOne({ id: job.id, status: 'SENDING', leaseToken: job.leaseToken }, {
        $set: {
          status: 'EXPIRED', expiredAt: now, updatedAt: now,
          'recipients.$[].status': 'FAILED',
          'recipients.$[].lastError': 'The sign-in link expired before the email could be delivered.',
        },
        $unset: { leaseToken: '', leaseUntil: '', encryptedAuthToken: '' },
      });
      return;
    }
    authToken = decryptSensitiveValue(job.encryptedAuthToken);
    const tokenType = job.eventType === 'AUTH_EMAIL_VERIFICATION' ? 'EMAIL_VERIFICATION' : 'PASSWORD_RESET';
    const tokenHash = createHash('sha256').update(authToken).digest('hex');
    const activeToken = await authTokens.findValid({ tokenHash, type: tokenType });
    if (!activeToken) {
      const now = new Date();
      await db.collection('emailOutbox').updateOne({ id: job.id, status: 'SENDING', leaseToken: job.leaseToken }, {
        $set: {
          status: 'CANCELLED', cancelledAt: now, updatedAt: now,
          'recipients.$[].status': 'FAILED',
          'recipients.$[].lastError': 'The account link is no longer valid; request a fresh email.',
        },
        $unset: { leaseToken: '', leaseUntil: '', encryptedAuthToken: '' },
      });
      return;
    }
  }

  let pdfBuffer = isInvoice ? asBuffer(job.pdfBuffer) : null;
  if (isInvoice && !pdfBuffer) {
    const seller = order.sellerSnapshot || {};
    pdfBuffer = await generateInvoicePdf(order, {
      storeName: seller.name,
      storeAddress: seller.address,
      storePhone: seller.phone,
      storeEmail: seller.email,
    });
    await db.collection('emailOutbox').updateOne(
      { id: job.id, status: 'SENDING', leaseToken: job.leaseToken },
      { $set: { pdfBuffer, pdfSavedAt: new Date(), updatedAt: new Date() } },
    );
  }

  for (const recipient of (job.recipients || []).filter(item => item.status === 'PENDING')) {
    const result = isInvoice
      ? await sendOrderInvoiceEmail(order, order.sellerSnapshot || {}, pdfBuffer, recipient)
      : isAuthEmail
        ? job.eventType === 'AUTH_EMAIL_VERIFICATION'
          ? await sendVerificationEmail(recipient.email, authToken)
          : await sendPasswordResetEmail(recipient.email, authToken)
        : await sendOrderEventEmail({ ...job.eventSnapshot, orderId: job.orderId }, recipient);
    await setRecipientResult(job, recipient, result.ok ? 'SENT' : 'FAILED', result.error);
  }

  const fresh = await db.collection('emailOutbox').findOne({ id: job.id, leaseToken: job.leaseToken });
  if (!fresh) return;
  const allSent = (fresh.recipients || []).length > 0 && fresh.recipients.every(item => item.status === 'SENT');
  const hasPending = fresh.recipients.some(item => item.status === 'PENDING');
  const finishedAt = new Date();
  if (allSent) {
    await db.collection('emailOutbox').updateOne({ id: job.id, leaseToken: job.leaseToken }, {
      $set: { status: 'SENT', sentAt: finishedAt, updatedAt: finishedAt },
      $unset: { leaseToken: '', leaseUntil: '', lastError: '', encryptedAuthToken: '' },
    });
    return;
  }

  const status = hasPending && job.attempts < MAX_ATTEMPTS ? 'RETRY' : 'FAILED';
  if (!hasPending || status === 'FAILED') {
    await db.collection('emailOutbox').updateOne(
      { id: job.id, leaseToken: job.leaseToken },
      { $set: { 'recipients.$[r].status': 'FAILED' }, $unset: { 'recipients.$[r].lastError': '' } },
      { arrayFilters: [{ 'r.status': 'PENDING' }] },
    );
  }
  await db.collection('emailOutbox').updateOne({ id: job.id, leaseToken: job.leaseToken }, {
    $set: {
      status,
      nextAttemptAt: new Date(finishedAt.getTime() + retryDelay(job.attempts)),
      updatedAt: finishedAt,
      ...(status === 'FAILED' ? { failedAt: finishedAt } : {}),
    },
    $unset: { leaseToken: '', leaseUntil: '' },
  });
}

let batchRunning = false;

export async function processEmailOutboxBatch() {
  if (batchRunning) return 0;
  batchRunning = true;
  let processed = 0;
  try {
    await purgeExpiredAuthTokens();
    for (let i = 0; i < BATCH_SIZE; i++) {
      const job = await claimNextJob();
      if (!job) break;
      try {
        await processJob(job);
      } catch (error) {
        const finishedAt = new Date();
        const status = job.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'RETRY';
        await getDb().collection('emailOutbox').updateOne({ id: job.id, status: 'SENDING', leaseToken: job.leaseToken }, {
          $set: {
            status,
            lastError: String(error?.message || 'Email job processing failed').slice(0, 300),
            nextAttemptAt: new Date(finishedAt.getTime() + retryDelay(job.attempts)),
            updatedAt: finishedAt,
            ...(status === 'FAILED' ? { failedAt: finishedAt } : {}),
          },
          $unset: { leaseToken: '', leaseUntil: '' },
        });
        console.error('[outbox] Email job failed:', error?.code || 'PROCESSING_ERROR');
      }
      processed++;
    }
    return processed;
  } finally {
    batchRunning = false;
  }
}

export function startEmailOutboxWorker(intervalMs = 5_000) {
  const timer = setInterval(() => {
    void processEmailOutboxBatch().catch(error => console.error('[outbox] Poll failed:', error?.code || 'DATABASE_ERROR'));
  }, intervalMs);
  timer.unref();
  void processEmailOutboxBatch().catch(error => console.error('[outbox] Initial poll failed:', error?.code || 'DATABASE_ERROR'));
  return timer;
}
