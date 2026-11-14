/**
 * server/db/seed.mjs
 * Seeds categories, demo products (dev only), and the initial admin account.
 * Never runs in production unless SEED_DEMO_CATALOG is explicitly set.
 */

import { randomUUID } from 'node:crypto';
import { getDb }      from './mongo.mjs';
import { slugify }    from './repository.mjs';
import { createPasswordHash } from '../security.mjs';
import config from '../config.mjs';

export async function seed() {
  const db = getDb();

  // ── Categories ──────────────────────────────────────────────────────────────
  const categoryDefs = [
    ['Groceries','groceries'],
    ['Electronics','electronics'],
    ['Home & Living','home-living'],
    ['Fashion','fashion'],
    ['Beauty & Care','beauty-care'],
    ['Fresh Produce','fresh-produce'],
  ];
  for (const [name, slug] of categoryDefs) {
    await db.collection('categories').updateOne(
      { slug },
      { $setOnInsert: { id: randomUUID(), name, slug } },
      { upsert: true }
    );
  }

  // ── Demo products (never in production) ─────────────────────────────────────
  if (config.seedDemoCatalog) {
    const sample = [
      ['Wireless Headphones','electronics',28500,18,'Comfortable wireless listening for everyday use.','headphones',true],
      ['Organic Avocados','fresh-produce',4500,35,'Demo bundle of fresh produce for your grocery catalog.','avocados',true],
      ['Ceramic Coffee Mug','home-living',6500,42,'A clean everyday mug in modern stoneware.','mug',true],
      ['Everyday Tote Bag','fashion',12000,25,'Lightweight reusable carry bag with simple style.','tote',true],
      ['Fresh Orange Juice','groceries',3500,60,'Refreshing juice product listing example.','juice',true],
      ['Smart Watch','electronics',42000,12,'Sample smart wearable listing with a modern display.','watch',true],
      ['Natural Body Lotion','beauty-care',8900,23,'Gentle care product listing example.','lotion',false],
      ['Rice 5 kg','groceries',11500,44,'Pantry essential product listing example.','rice',false],
      ['Table Lamp','home-living',32000,16,'Warm ambient lighting for living spaces.','lamp',false],
      ['Canvas Sneakers','fashion',35000,14,'Comfortable daily sneakers product listing.','sneakers',false],
      ['Fresh Bananas','fresh-produce',2800,45,'Sample local fresh produce item.','bananas',false],
      ['Bluetooth Speaker','electronics',24000,16,'Compact portable wireless speaker example.','speaker',false],
    ];
    for (const [name, catSlug, price, stock, description, asset, featured] of sample) {
      const cat = await db.collection('categories').findOne({ slug: catSlug });
      const slug = slugify(name);
      await db.collection('products').updateOne(
        { slug },
        { $setOnInsert: {
          id: randomUUID(), name, slug, description, price, stock,
          categoryId: cat?.id || null, categorySlug: catSlug, category: cat?.name || catSlug,
          imageUrl: `/assets/products/${asset}.png`,
          featured, active: true,
          createdAt: new Date(), updatedAt: new Date(),
        }},
        { upsert: true }
      );
    }
  }

  // ── Initial admin ────────────────────────────────────────────────────────────
  const { adminEmail, adminPassword, adminName } = config;
  const passwordOk = adminPassword
    && !adminPassword.startsWith('REPLACE_')
    && adminPassword.length >= (config.isProduction ? 14 : 12);

  if (adminEmail && passwordOk) {
    const existing = await db.collection('users').findOne({ email: adminEmail.toLowerCase() });
    if (!existing) {
      await db.collection('users').insertOne({
        id:            randomUUID(),
        name:          adminName,
        email:         adminEmail.toLowerCase(),
        passwordHash:  createPasswordHash(adminPassword),
        role:          'ADMIN',
        emailVerified: true,
        emailToken:    null,
        resetToken:    null,
        mfaEnabled:    false,
        createdAt:     new Date(),
      });
      console.log('[seed] Initial admin created:', adminEmail);
    }
  } else if (!config.isTest) {
    console.log('[seed] Admin seed skipped. Configure ADMIN_EMAIL and ADMIN_PASSWORD in .env.');
  }
}
