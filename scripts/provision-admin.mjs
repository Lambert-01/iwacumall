/**
 * Explicitly provision the administrator account from .env.
 * Run with `npm run admin:seed`; this intentionally resets the password for
 * the configured email and revokes its current sessions. Existing MFA stays on.
 */

import { randomUUID } from 'node:crypto';
import config from '../server/config.mjs';
import { connectDb, closeDb, getDb } from '../server/db/mongo.mjs';
import { createPasswordHash, validEmail } from '../server/security.mjs';

const email = String(config.adminEmail || '').trim().toLowerCase();
const password = config.adminPassword;
const minimumLength = config.isProduction ? 14 : 12;

if (!validEmail(email)) {
  console.error('[admin:seed] Set a valid ADMIN_EMAIL in .env.');
  process.exitCode = 1;
} else if (
  typeof password !== 'string' ||
  password.length < minimumLength ||
  password.startsWith('REPLACE_')
) {
  console.error(`[admin:seed] Set a unique ADMIN_PASSWORD of at least ${minimumLength} characters in .env.`);
  process.exitCode = 1;
} else {
  try {
    await connectDb();

    const db = getDb();
    const users = db.collection('users');
    const existing = await users.findOne({ email });
    const now = new Date();

    if (existing) {
      await users.updateOne(
        { _id: existing._id },
        {
          $set: {
            name: config.adminName,
            email,
            passwordHash: createPasswordHash(password),
            role: 'ADMIN',
            emailVerified: true,
            passwordUpdatedAt: now,
            updatedAt: now,
            resetToken: null,
            emailToken: null,
          },
        },
      );
      if (existing.id) {
        await db.collection('sessions').deleteMany({ userId: existing.id });
        await db.collection('authTokens').deleteMany({ userId: existing.id });
      }
      console.log('[admin:seed] Configured administrator updated; prior sessions revoked and MFA state preserved.');
    } else {
      await users.insertOne({
        id: randomUUID(),
        name: config.adminName,
        email,
        passwordHash: createPasswordHash(password),
        role: 'ADMIN',
        emailVerified: true,
        emailToken: null,
        resetToken: null,
        mfaEnabled: false,
        createdAt: now,
      });
      console.log('[admin:seed] Administrator created from .env.');
    }
  } catch (error) {
    const networkCodes = new Set();
    if (typeof error?.code === 'string') networkCodes.add(error.code);
    for (const server of error?.reason?.servers?.values?.() || []) {
      for (const nested of [server.error, server.error?.cause, server.error?.cause?.cause]) {
        if (typeof nested?.code === 'string') networkCodes.add(nested.code);
      }
    }
    const detail = [error?.name || 'DatabaseError', ...networkCodes].join(' ');
    console.error('[admin:seed] Failed to reach or update MongoDB:', detail);
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => {});
  }
}
