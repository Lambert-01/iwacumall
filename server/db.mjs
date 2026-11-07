import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPasswordHash } from './security.mjs';

const dbPath = resolve(process.cwd(), process.env.DATABASE_PATH || './data/iwacumall.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN ('CUSTOMER','ADMIN')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL CHECK(price >= 0),
  stock INTEGER NOT NULL CHECK(stock >= 0), category_id TEXT REFERENCES categories(id),
  image_url TEXT NOT NULL DEFAULT '', featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
  city TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL, payment_method TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY',
  status TEXT NOT NULL DEFAULT 'PLACED' CHECK(status IN ('PLACED','CONFIRMED','PACKING','OUT_FOR_DELIVERY','DELIVERED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id), product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0)
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`);

export const slugify = (value) => String(value).toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function seed() {
  const categories = [
    ['Groceries','groceries'], ['Electronics','electronics'], ['Home & Living','home-living'],
    ['Fashion','fashion'], ['Beauty & Care','beauty-care'], ['Fresh Produce','fresh-produce'],
  ];
  for (const [name,slug] of categories) {
    db.prepare('INSERT OR IGNORE INTO categories (id,name,slug) VALUES (?,?,?)').run(randomUUID(),name,slug);
  }
  // DEMONSTRATION CONTENT ONLY: prices, descriptions and imagery must be replaced by the owner.
  const sample = [
    ['Wireless Headphones','electronics',28500,18,'Comfortable wireless listening for everyday use.','headphones',1],
    ['Organic Avocados','fresh-produce',4500,35,'Demo bundle of fresh produce for your grocery catalog.','avocados',1],
    ['Ceramic Coffee Mug','home-living',6500,42,'A clean everyday mug in modern stoneware.','mug',1],
    ['Everyday Tote Bag','fashion',12000,25,'Lightweight reusable carry bag with simple style.','tote',1],
    ['Fresh Orange Juice','groceries',3500,60,'Refreshing juice product listing example.','juice',1],
    ['Smart Watch','electronics',42000,12,'Sample smart wearable listing with a modern display.','watch',1],
    ['Natural Body Lotion','beauty-care',8900,23,'Gentle care product listing example.','lotion',0],
    ['Rice 5 kg','groceries',11500,44,'Pantry essential product listing example.','rice',0],
    ['Table Lamp','home-living',32000,16,'Warm ambient lighting for living spaces.','lamp',0],
    ['Canvas Sneakers','fashion',35000,14,'Comfortable daily sneakers product listing.','sneakers',0],
    ['Fresh Bananas','fresh-produce',2800,45,'Sample local fresh produce item.','bananas',0],
    ['Bluetooth Speaker','electronics',24000,16,'Compact portable wireless speaker example.','speaker',0],
  ];
  if (process.env.SEED_DEMO_CATALOG !== 'false') for (const [name,category,price,stock,description,asset,featured] of sample) {
    const categoryId = db.prepare('SELECT id FROM categories WHERE slug=?').get(category)?.id;
    db.prepare(`INSERT OR IGNORE INTO products(id,name,slug,description,price,stock,category_id,image_url,featured)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(),name,slugify(name),description,price,stock,categoryId,`/assets/products/${asset}.png`,featured);
  }
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (adminEmail && password && password !== 'REPLACE_WITH_A_STRONG_UNIQUE_PASSWORD' && password.length >= 12) {
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail);
    if (!existing) {
      db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)')
        .run(randomUUID(),process.env.ADMIN_NAME||'IwacuMall Administrator',adminEmail,createPasswordHash(password),'ADMIN');
      console.log('Initial admin seeded:',adminEmail);
    }
  } else {
    console.log('Admin seed skipped. Configure ADMIN_EMAIL and a strong ADMIN_PASSWORD in .env.');
  }
}
