/**
 * scripts/migrate-auth-token-indexes.mjs
 *
 * Idempotent migration script to remove dangerous TTL token indexes from the
 * 'users' collection and ensure the safe 'authTokens' collection is established.
 *
 * Background:
 *   TTL indexes on fields inside documents in the 'users' collection caused MongoDB
 *   to delete the ENTIRE user document when an emailToken or resetToken expired.
 *   This script drops those dangerous indexes from 'users' and verifies that
 *   tokens are isolated in the 'authTokens' collection with their own TTL index.
 *
 * Usage:
 *   # Dry-run inspection (default):
 *   node scripts/migrate-auth-token-indexes.mjs
 *
 *   # Apply migration:
 *   node scripts/migrate-auth-token-indexes.mjs --apply
 */

import { MongoClient, ServerApiVersion } from 'mongodb';

const APPLY_CHANGES = process.argv.includes('--apply') || process.argv.includes('--write');
const mongoUri = process.env.MONGODB_URI?.trim();
const dbName   = process.env.MONGODB_DB_NAME || 'iwacumall';

if (!mongoUri) {
  console.error('[migration] Error: MONGODB_URI is not set. Please configure MONGODB_URI in your environment or .env.');
  process.exit(1);
}

console.log(`\n=== IwacuMall: Auth Token Index Safety Migration ===`);
console.log(`Mode    : ${APPLY_CHANGES ? '⚡ APPLY (modifications enabled)' : '🔍 DRY-RUN (read-only inspection)'}`);
console.log(`Database: ${dbName}\n`);

const client = new MongoClient(mongoUri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

try {
  await client.connect();
  const db = client.db(dbName);

  const DANGEROUS_INDEXES = [
    'users_email_token',
    'users_reset_token',
    'users_email_token_expiry',
    'users_reset_token_expiry',
  ];

  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    console.log("ℹ️  Collection 'users' does not exist yet. No legacy indexes to drop.");
  } else {
    const existingIndexes = await db.collection('users').indexes();
    const existingIndexNames = existingIndexes.map(i => i.name);
    console.log(`Current indexes on 'users':\n  ${existingIndexNames.join(', ')}`);

    const indexesToDrop = existingIndexes.filter(i => {
      if (DANGEROUS_INDEXES.includes(i.name)) return true;
      // Also catch any index on users that has expireAfterSeconds
      if (i.expireAfterSeconds !== undefined && i.name !== '_id_') return true;
      return false;
    });

    if (indexesToDrop.length === 0) {
      console.log("✅ No dangerous TTL or legacy token indexes found on 'users'.");
    } else {
      console.log(`\n⚠️  Found ${indexesToDrop.length} dangerous/legacy index(es) on 'users':`);
      for (const idx of indexesToDrop) {
        console.log(`  - ${idx.name} (keys: ${JSON.stringify(idx.key)}, expireAfterSeconds: ${idx.expireAfterSeconds})`);
      }

      if (APPLY_CHANGES) {
        for (const idx of indexesToDrop) {
          console.log(`Dropping index '${idx.name}'...`);
          await db.collection('users').dropIndex(idx.name);
          console.log(`  ✓ Successfully dropped '${idx.name}'`);
        }
      } else {
        console.log("\n[DRY-RUN] To drop these dangerous indexes, re-run with: node scripts/migrate-auth-token-indexes.mjs --apply");
      }
    }
  }

  // Verify authTokens collection indexes
  console.log("\nVerifying 'authTokens' collection indexes...");
  if (APPLY_CHANGES) {
    await db.collection('authTokens').createIndexes([
      { key: { tokenHash: 1 },       name: 'auth_tokens_hash', unique: true },
      { key: { userId: 1, type: 1 }, name: 'auth_tokens_user_type' },
      { key: { expiresAt: 1 },       name: 'auth_tokens_ttl', expireAfterSeconds: 0 },
    ]);
    console.log("✅ 'authTokens' collection indexes verified.");
  } else {
    console.log("[DRY-RUN] 'authTokens' collection indexes will be ensured upon application run.");
  }

  console.log("\nMigration check complete.\n");
} catch (err) {
  console.error('[migration] Failed:', err);
  process.exit(1);
} finally {
  await client.close();
}
