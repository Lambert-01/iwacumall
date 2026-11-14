/**
 * scripts/migrate-sqlite-to-mongo.mjs
 * Dry-run SQLite → MongoDB Atlas migration script.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/migrate-sqlite-to-mongo.mjs
 *   node --env-file-if-exists=.env scripts/migrate-sqlite-to-mongo.mjs --write
 *
 * Rules:
 *  - Default is DRY-RUN: counts records, prints types, never writes.
 *  - Pass --write to actually migrate. Idempotent: uses upsert.
 *  - Never prints personal data (names, emails, addresses, tokens, hashes).
 *  - Refuses to run if MONGODB_URI is missing or looks like production without --force.
 *  - Always back up SQLite BEFORE running --write (instructions below).
 *
 * === BEFORE RUNNING --write ===
 *   1. Stop the application server.
 *   2. Back up the SQLite file:
 *        cp data/iwacumall.sqlite data/iwacumall.sqlite.bak.$(date +%Y%m%d_%H%M%S)
 *   3. Verify the backup:
 *        ls -lh data/iwacumall.sqlite.bak.*
 *   4. Run dry-run first and confirm counts look correct:
 *        node --env-file-if-exists=.env scripts/migrate-sqlite-to-mongo.mjs
 *   5. Run the write pass:
 *        node --env-file-if-exists=.env scripts/migrate-sqlite-to-mongo.mjs --write
 *   6. Verify in MongoDB Atlas that counts match.
 *   7. Start the application and smoke-test.
 *   8. Keep the SQLite backup for at least 30 days.
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve }      from 'node:path';
import { MongoClient, ServerApiVersion } from 'mongodb';

const WRITE_MODE = process.argv.includes('--write');
const FORCE      = process.argv.includes('--force');

const mongoUri  = process.env.MONGODB_URI?.trim();
const dbName    = process.env.MONGODB_DB_NAME || 'iwacumall';
const sqlitePath= resolve(process.cwd(), process.env.DATABASE_PATH || './data/iwacumall.sqlite');

// ── Safety checks ─────────────────────────────────────────────────────────────

if (!mongoUri) {
  console.error('[migrate] Error: MONGODB_URI is not set. Configure it in .env before migrating.');
  process.exit(1);
}

// Never infer safety from database names or usernames. Remote writes require
// the explicit --force flag after a reviewed dry-run and verified backup.
if (!FORCE && WRITE_MODE && !/^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(mongoUri)) {
  console.error('[migrate] Refusing a remote database write without --force. Run a dry-run, verify the target and backup, then add --force deliberately.');
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== IwacuMall SQLite → MongoDB Migration ===`);
console.log(`Mode    : ${WRITE_MODE ? '⚠️  WRITE (will upsert to MongoDB)' : '🔍 DRY-RUN (read-only)'}`);
console.log(`SQLite  : ${sqlitePath}`);
console.log(`MongoDB : [URI REDACTED] database: ${dbName}`);
console.log('');

const sqlite = new DatabaseSync(sqlitePath);

// ── Count and report ──────────────────────────────────────────────────────────

const usersCount      = sqlite.prepare('SELECT COUNT(*) n FROM users').get().n;
const sessionsCount   = sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n;
const categoriesCount = sqlite.prepare('SELECT COUNT(*) n FROM categories').get().n;
const productsCount   = sqlite.prepare('SELECT COUNT(*) n FROM products').get().n;
const ordersCount     = sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n;
const orderItemsCount = sqlite.prepare('SELECT COUNT(*) n FROM order_items').get().n;
const legacyStatusCounts = sqlite.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all();
const cancelledLegacyCount = legacyStatusCounts.reduce((total, row) => {
  const status = String(row.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return total + (['CANCELLED', 'CANCELED'].includes(status) ? row.n : 0);
}, 0);

console.log('SQLite record counts:');
console.log(`  users:        ${usersCount}`);
console.log(`  sessions:     ${sessionsCount}  (will not be migrated — users will re-login)`);
console.log(`  categories:   ${categoriesCount}`);
console.log(`  products:     ${productsCount}`);
console.log(`  orders:       ${ordersCount}`);
console.log(`  order items:  ${orderItemsCount}  (embedded in order documents)`);
console.log(`  cancelled:    ${cancelledLegacyCount}  (will map to CANCELLED / VOID; no stock adjustment)`);
console.log('');

// User roles
const roleBreakdown = sqlite.prepare("SELECT role, COUNT(*) n FROM users GROUP BY role").all();
for (const { role, n } of roleBreakdown) {
  console.log(`  user role ${role}: ${n}`);
}
console.log('');

if (!WRITE_MODE) {
  console.log('✅ Dry-run complete — no data written.');
  console.log('   Run with --write to perform the actual migration.');
  console.log('   Remember to back up SQLite first! See script header for instructions.\n');
  process.exit(0);
}

// ── Write pass ────────────────────────────────────────────────────────────────

console.log('Connecting to MongoDB…');
const client = new MongoClient(mongoUri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});
await client.connect();
const db = client.db(dbName);
console.log('Connected.\n');

let migrated = 0;

// Categories
const categories = sqlite.prepare('SELECT * FROM categories').all();
for (const cat of categories) {
  if (WRITE_MODE) {
    await db.collection('categories').updateOne(
      { id: cat.id },
      { $setOnInsert: { id: cat.id, name: cat.name, slug: cat.slug } },
      { upsert: true }
    );
  }
  migrated++;
}
console.log(`Categories migrated: ${categories.length}`);

// Products (embed category slug)
const products = sqlite.prepare('SELECT p.*, c.slug AS categorySlug FROM products p LEFT JOIN categories c ON c.id = p.category_id').all();
for (const p of products) {
  if (WRITE_MODE) {
    await db.collection('products').updateOne(
      { id: p.id },
      { $setOnInsert: {
        id: p.id, name: p.name, slug: p.slug,
        description: p.description || '',
        price: p.price, stock: p.stock,
        categoryId:   p.category_id || null,
        categorySlug: p.categorySlug || null,
        imageUrl:  p.image_url || '',
        featured:  !!p.featured,
        active:    !!p.active,
        createdAt: new Date(p.created_at || Date.now()),
        updatedAt: new Date(p.updated_at || Date.now()),
      }},
      { upsert: true }
    );
  }
}
console.log(`Products migrated: ${products.length}`);

// Users (never log names/emails/hashes — just count per role)
const usersRows = sqlite.prepare('SELECT * FROM users').all();
let userCount = 0;
for (const u of usersRows) {
  if (WRITE_MODE) {
    await db.collection('users').updateOne(
      { id: u.id },
      { $setOnInsert: {
        id:           u.id,
        name:         u.name,
        email:        u.email,
        passwordHash: u.password_hash,
        role:         u.role,
        emailVerified:true, // existing users are considered verified on import
        emailToken:   null,
        resetToken:   null,
        mfaEnabled:   false,
        createdAt:    new Date(u.created_at || Date.now()),
      }},
      { upsert: true }
    );
  }
  userCount++;
}
console.log(`Users migrated: ${userCount} (by role: ${roleBreakdown.map(r => `${r.role}:${r.n}`).join(', ')})`);

// Orders (embed items + map to new payment/fulfillment schema)
const ordersRows = sqlite.prepare('SELECT * FROM orders').all();
let orderCount = 0;
let cancelledOrderCount = 0;
for (const o of ordersRows) {
  const items = sqlite.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  const oldStatus = String(o.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const isCancelled = ['CANCELLED', 'CANCELED'].includes(oldStatus);
  const fulfillmentStatus = isCancelled
    ? 'CANCELLED'
    : ['PLACED','CONFIRMED','PACKING','OUT_FOR_DELIVERY','DELIVERED'].includes(oldStatus)
      ? oldStatus
      : 'PLACED';
  if (isCancelled) cancelledOrderCount++;
  const paymentStatus = fulfillmentStatus === 'DELIVERED'
    ? 'PAID'
    : fulfillmentStatus === 'CANCELLED' ? 'VOID' : 'PENDING';
  if (WRITE_MODE) {
    await db.collection('orders').updateOne(
      { id: o.id },
      { $setOnInsert: {
        id:               o.id,
        userId:           o.user_id,
        customerName:     o.customer_name,
        phone:            o.phone,
        address:          o.address,
        city:             o.city,
        note:             o.note || '',
        items:            items.map(i => ({
          productId:   i.product_id,
          productName: i.product_name,
          unitPrice:   i.unit_price,
          quantity:    i.quantity,
        })),
        subtotal:         o.subtotal,
        deliveryFee:      o.delivery_fee || 0,
        taxAmount:        0,
        total:            o.total,
        paymentMethodId:  'CASH_ON_DELIVERY_LEGACY',
        paymentMethodSnapshot: {
          label: 'Cash on delivery (legacy)',
          type: 'OTHER',
          instructions: 'Legacy order — cash on delivery.',
        },
        invoiceNumber:    `LEGACY-${o.id.slice(0,8).toUpperCase()}`,
        // Map old status to new split schema
        fulfillmentStatus,
        paymentStatus,
        paymentDeadline:  null,
        createdAt:        new Date(o.created_at || Date.now()),
        updatedAt:        new Date(o.created_at || Date.now()),
      }},
      { upsert: true }
    );
  }
  orderCount++;
}
console.log(`Orders migrated: ${orderCount} (with embedded items)`);
console.log(`Cancelled legacy orders: ${cancelledOrderCount} (mapped to CANCELLED / VOID)`);
console.log('Inventory note: product stock is imported as-is; this script does not adjust stock for old cancelled orders.');
console.log('');
console.log('✅ Migration complete.');
console.log('   Please verify record counts in MongoDB Atlas before switching traffic.');
console.log('   Keep your SQLite backup for at least 30 days.\n');

await client.close();
