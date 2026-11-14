/**
 * tests/api.test.mjs — IwacuMall API tests (MongoDB edition)
 *
 * Tests run against an in-memory MongoDB instance using mongodb-memory-server,
 * or against a test database if MONGODB_TEST_URI is set.
 *
 * NEVER connects to the production database. If MONGODB_URI is set but
 * MONGODB_TEST_URI is not, the tests use a fresh in-memory database to protect
 * production data.
 *
 * Run: npm test
 */

import test   from 'node:test';
import assert from 'node:assert/strict';

// ── Set test environment BEFORE importing any app module ─────────────────────
process.env.NODE_ENV        = 'test';
process.env.ADMIN_EMAIL = "admin@test.invalid";
process.env.ADMIN_PASSWORD = "test-only-admin-password-not-for-production";
process.env.ADMIN_NAME = "Test Admin";
process.env.STORE_NAME = "IwacuMall Test Store";
process.env.INVOICE_EXPIRY_HOURS = '48';
process.env.DELIVERY_FEE_FLAT    = '0';
process.env.TAX_RATE_PERCENT     = '0';
process.env.SEED_DEMO_CATALOG    = 'true';
process.env.GOOGLE_CLIENT_IDS    = '';
process.env.GOOGLE_WEB_CLIENT_ID = '';

// ── MongoDB: use in-memory replica set (supports transactions) or test URI ───
let replSet;

async function startMongo() {
  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'iwacumall_test';
    console.log('[test] Using in-memory MongoDB Replica Set (transactions supported)');
    return;
  } catch (err) {
    if (process.env.MONGODB_TEST_URI) {
      const uri = process.env.MONGODB_TEST_URI;
      if (!uri.includes('test') && !uri.includes('localhost') && !uri.includes('127.0.0.1')) {
        throw new Error(
          '[test] MONGODB_TEST_URI does not appear to be a test database. ' +
          'Include "test" in the URI or use localhost. Refusing to run against production.'
        );
      }
      process.env.MONGODB_URI     = process.env.MONGODB_TEST_URI;
      process.env.MONGODB_DB_NAME = 'iwacumall_test';
      console.log('[test] Using MONGODB_TEST_URI');
      return;
    }
    throw err;
  }
}

await startMongo();

// ── Import app after env is configured ──────────────────────────────────────
const { connectDb, closeDb } = await import('../server/db/mongo.mjs');
await connectDb();
const { default: config } = await import('../server/config.mjs');
config.storeNotificationEmail = 'store@test.example';

const { seed } = await import('../server/db/seed.mjs');
await seed();

const { server } = await import('../server/index.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(path, method = 'GET', data, token, extraHeaders = {}) {
  const checkoutKey = path === '/orders' && method === 'POST'
    ? { 'Idempotency-Key': `test-checkout-${++checkoutKeyCounter}-unique` }
    : {};
  const headers = {
    'Content-Type': 'application/json',
    'X-IwacuMall-Client': 'mobile',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...checkoutKey,
    ...extraHeaders,
  };
  const res = await fetch(base + '/api' + path, {
    method,
    headers,
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  let responseData;
  try { responseData = await res.json(); } catch { responseData = {}; }
  return { status: res.status, data: responseData, headers: res.headers };
}

let checkoutKeyCounter = 0;

// ─── Tests ────────────────────────────────────────────────────────────────────

test('health check returns 200 or 503 with truthful db status', async () => {
  const { status, data } = await api('/health');
  assert.ok(status === 200 || status === 503);
  assert.ok(typeof data.database === 'string');
});

test('public endpoints are accessible without auth', async () => {
  const products   = await api('/products');
  const categories = await api('/categories');
  assert.equal(products.status,   200);
  assert.equal(categories.status, 200);
  assert.ok(Array.isArray(products.data.products));
  assert.ok(products.data.products.length >= 10);
  assert.ok(Array.isArray(categories.data.categories));
  assert.ok(categories.data.categories.length >= 6);
});

test('Google sign-in stays closed until an OAuth client is configured', async () => {
  const result = await api('/auth/google', 'POST', { idToken: 'untrusted-placeholder-token' });
  assert.equal(result.status, 503);
  assert.match(result.data.error, /not configured/i);
});

test('admin endpoints require authentication', async () => {
  const unauth = await api('/admin/orders');
  assert.equal(unauth.status, 401);
});

test('registration validates inputs', async () => {
  const tooShort = await api('/auth/register', 'POST', { name: 'X', email: 'bad', password: '123' });
  assert.equal(tooShort.status, 400);
  const shortPw  = await api('/auth/register', 'POST', { name: 'Bob Test', email: 'bob@test.example', password: 'short' });
  assert.equal(shortPw.status, 400);
});

let customerToken, customerId, orderId, invoiceNumber;
let adminToken, adminId;

test('customer register, login and account flows', async () => {
  const reg = await api('/auth/register', 'POST', {
    name: 'Test Customer', email: 'buyer@test.example', password: 'customerTest123456',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.role, 'CUSTOMER');
  customerToken = reg.data.token;
  customerId    = reg.data.user.id;

  // Cannot register again with same email
  const dup = await api('/auth/register', 'POST', { name: 'Test Customer', email: 'buyer@test.example', password: 'customerTest123456' });
  assert.equal(dup.status, 409);

  // Me endpoint
  const me = await api('/me', 'GET', null, customerToken);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'buyer@test.example');
});

test('admin login', async () => {
  const login = await api('/auth/login', 'POST', {
    email: 'admin@test.example', password: 'VeryStrongTest12345!',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;
  adminId    = login.data.user.id;
});

test('customer cannot access admin endpoints', async () => {
  const forbidden = await api('/admin/stats', 'GET', null, customerToken);
  assert.equal(forbidden.status, 403);
});

test('register does not create admin role', async () => {
  const reg = await api('/auth/register', 'POST', {
    name: 'Evil Admin', email: 'evil@test.example', password: 'evilPassword123!',
    role: 'ADMIN', // attempt injection
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.role, 'CUSTOMER');
});

test('admin creates a payment method', async () => {
  const pm = await api('/admin/payment-methods', 'POST', {
    label: 'MTN Mobile Money',
    type: 'MOBILE_MONEY',
    accountName: '[OWNER: CONFIGURE YOUR NAME]',
    accountNumber: '[OWNER: CONFIGURE YOUR NUMBER]',
    instructions: 'Send payment to the number above. Use your order invoice number as the reference.',
  }, adminToken);
  assert.equal(pm.status, 201);
  // Store the ID for checkout
  process.env._TEST_PM_ID = pm.data.id;
});

test('checkout requires a valid payment method', async () => {
  const products = await api('/products');
  const p = products.data.products.find(x => x.name === 'Wireless Headphones');
  assert.ok(p, 'Demo product must exist');

  // Store for later tests
  process.env._TEST_PRODUCT_ID    = p.id;
  process.env._TEST_PRODUCT_PRICE = String(p.price);
  process.env._TEST_PRODUCT_STOCK = String(p.stock);

  const orderPayload = {
    customerName: 'Test Customer',
    phone: '0788000000',
    city: 'Kigali',
    address: 'Kicukiro, main road',
    items: [{ productId: p.id, quantity: 2 }],
    paymentMethodId: 'nonexistent',
  };
  const badMethod = await api('/orders', 'POST', orderPayload, customerToken);
  assert.equal(badMethod.status, 400);
});

test('place order and verify server-calculated totals', async () => {
  const productId = process.env._TEST_PRODUCT_ID;
  const unitPrice = Number(process.env._TEST_PRODUCT_PRICE);
  const pmId      = process.env._TEST_PM_ID;

  const order = await api('/orders', 'POST', {
    customerName: 'Test Customer',
    phone: '0788000000',
    city: 'Kigali',
    address: 'Kicukiro, main road',
    items: [{ productId, quantity: 2 }],
    paymentMethodId: pmId,
  }, customerToken);
  assert.equal(order.status, 201);

  const o = order.data.order;
  // Subtotal must be server-calculated (price × qty)
  assert.equal(o.subtotal, unitPrice * 2);
  // Delivery fee and tax (both 0 in test env)
  assert.equal(o.deliveryFee, 0);
  assert.equal(o.taxAmount, 0);
  assert.equal(o.total, unitPrice * 2);
  assert.ok(o.invoiceNumber.startsWith('INV-'), 'Invoice number must start with INV-');
  assert.ok(o.paymentInstructions, 'Payment instructions must be present');
  orderId       = o.id;
  invoiceNumber = o.invoiceNumber;
});

test('checkout idempotency returns the original order without reserving stock again', async () => {
  const productId = process.env._TEST_PRODUCT_ID;
  const pmId = process.env._TEST_PM_ID;
  const key = 'same-checkout-request-key-0001';
  const payload = {
    customerName: 'Test Customer', phone: '0788000000', city: 'Kigali',
    address: 'Kicukiro, main road', items: [{ productId, quantity: 1 }], paymentMethodId: pmId,
  };
  const before = await api(`/products/${productId}`);
  const first = await api('/orders', 'POST', payload, customerToken, { 'Idempotency-Key': key });
  const replay = await api('/orders', 'POST', payload, customerToken, { 'Idempotency-Key': key });
  const conflict = await api('/orders', 'POST', { ...payload, note: 'changed' }, customerToken, { 'Idempotency-Key': key });
  const after = await api(`/products/${productId}`);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.order.id, first.data.order.id);
  assert.equal(replay.data.order.invoiceNumber, first.data.order.invoiceNumber);
  assert.equal(conflict.status, 409);
  assert.equal(after.data.product.stock, before.data.product.stock - 1);
});

test('checkout atomically records invoice delivery and PDF endpoint returns a PDF', async () => {
  const { emailOutbox } = await import('../server/db/repository.mjs');
  const jobs = await emailOutbox.list();
  const job = jobs.find(item => item.orderId === orderId);
  assert.ok(job, 'invoice email job should be committed with the order');
  assert.equal(job.status, 'PENDING');
  assert.ok(job.recipients.some(recipient => recipient.kind === 'CUSTOMER'));
  assert.ok(job.recipients.some(recipient => recipient.kind === 'STORE'));
  assert.equal(Object.hasOwn(job, 'pdfBuffer'), false, 'admin outbox view must not expose the stored PDF bytes');

  const response = await fetch(`${base}/api/orders/${orderId}/invoice.pdf`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/pdf/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
});

test('outbox sends both copies with the same invoice PDF and records delivery', async () => {
  const { setMailerTransportForTests, resetMailerTransportForTests } = await import('../server/mailer.mjs');
  const { processEmailOutboxBatch } = await import('../server/outbox.mjs');
  const captured = [];
  setMailerTransportForTests({ sendMail: async message => { captured.push(message); return { messageId: 'local-test' }; } });
  try {
    await processEmailOutboxBatch();
  } finally {
    resetMailerTransportForTests();
  }
  const { emailOutbox } = await import('../server/db/repository.mjs');
  const job = (await emailOutbox.list()).find(item => item.orderId === orderId);
  assert.equal(job.status, 'SENT');
  assert.deepEqual(job.recipients.map(item => item.status), ['SENT', 'SENT']);
  const messages = captured.filter(message => message.subject.includes(invoiceNumber));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(message => message.to).sort(), ['buyer@test.example', 'store@test.example']);
  assert.equal(messages[0].attachments[0].contentType, 'application/pdf');
  assert.deepEqual(messages[0].attachments[0].content, messages[1].attachments[0].content);
});

test('fresh database bootstrap keeps token TTL indexes off the users collection', async () => {
  const { getDb } = await import('../server/db/mongo.mjs');
  const indexes = await getDb().collection('users').listIndexes().toArray();
  assert.equal(indexes.some(index => index.expireAfterSeconds !== undefined), false);
});

test('invoice numbers are unique', async () => {
  const productId = process.env._TEST_PRODUCT_ID;
  const pmId      = process.env._TEST_PM_ID;
  const o2 = await api('/orders', 'POST', {
    customerName: 'Test Customer',
    phone: '0788000000',
    city: 'Kigali',
    address: 'Kicukiro, main road',
    items: [{ productId, quantity: 1 }],
    paymentMethodId: pmId,
  }, customerToken);
  assert.equal(o2.status, 201);
  assert.notEqual(o2.data.order.invoiceNumber, invoiceNumber);
});

test('stock is reduced and customer order is visible', async () => {
  const productId    = process.env._TEST_PRODUCT_ID;
  const originalStock= Number(process.env._TEST_PRODUCT_STOCK);

  const myOrders = await api('/me/orders', 'GET', null, customerToken);
  assert.equal(myOrders.status, 200);
  assert.ok(myOrders.data.orders.length >= 1);

  const updatedProduct = await api(`/products/${productId}`);
  assert.ok(updatedProduct.data.product.stock < originalStock);
});

test('customer cannot view another customer\'s order', async () => {
  // Register a second customer
  const reg2 = await api('/auth/register', 'POST', {
    name: 'Other Customer', email: 'other@test.example', password: 'otherPassword123!',
  });
  const token2 = reg2.data.token;

  const myOrders = await api('/me/orders', 'GET', null, customerToken);
  const firstOrderId = myOrders.data.orders[0]?.id;
  assert.ok(firstOrderId);

  // other customer tries to access
  const stolen = await api(`/orders/${firstOrderId}`, 'GET', null, token2);
  assert.equal(stolen.status, 404);
});

test('admin can view orders and must confirm payment with reference', async () => {
  const adminOrders = await api('/admin/orders', 'GET', null, adminToken);
  assert.equal(adminOrders.status, 200);
  assert.ok(adminOrders.data.orders.length >= 1);

  const targetOrder = adminOrders.data.orders.find(o => o.invoiceNumber === invoiceNumber);

  // Store orderId from server response
  if (targetOrder) {
    // confirm without reference — must fail
    const noRef = await api(`/admin/orders/${targetOrder.id}/confirm-payment`, 'POST',
      { paymentRef: '' }, adminToken);
    assert.equal(noRef.status, 400);

    // confirm with reference — must succeed
    const confirmed = await api(`/admin/orders/${targetOrder.id}/confirm-payment`, 'POST', {
      paymentRef: 'REF123456', note: 'Verified in mobile money dashboard',
    }, adminToken);
    assert.equal(confirmed.status, 200);

    // confirming again must be idempotent (409 or already confirmed)
    const again = await api(`/admin/orders/${targetOrder.id}/confirm-payment`, 'POST', {
      paymentRef: 'REF123456',
    }, adminToken);
    assert.equal(again.status, 409);
  }
});

test('return requests require delivery, can be approved once, and restock only once', async () => {
  const settings = await api('/admin/settings', 'PATCH', { returnWindowDays: 30 }, adminToken);
  assert.equal(settings.status, 200);

  const productId = process.env._TEST_PRODUCT_ID;
  const checkout = await api('/orders', 'POST', {
    customerName: 'Test Customer', phone: '0788000000', city: 'Kigali',
    address: 'Kicukiro, main road', items: [{ productId, quantity: 2 }],
    paymentMethodId: process.env._TEST_PM_ID,
  }, customerToken);
  assert.equal(checkout.status, 201);
  const returnOrderId = checkout.data.order.id;
  const confirmed = await api(`/admin/orders/${returnOrderId}/confirm-payment`, 'POST', {
    paymentRef: 'RETURN-TEST-REF', note: 'Return workflow test payment',
  }, adminToken);
  assert.equal(confirmed.status, 200);

  const premature = await api(`/orders/${returnOrderId}/returns`, 'POST', {
    items: [{ productId, quantity: 1 }], reason: 'One item is damaged',
  }, customerToken);
  assert.equal(premature.status, 409);

  for (const status of ['CONFIRMED', 'PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    const transition = await api(`/admin/orders/${returnOrderId}/fulfillment`, 'PATCH', { status }, adminToken);
    assert.equal(transition.status, 200);
  }

  const snapshot = await api(`/orders/${returnOrderId}`, 'GET', null, customerToken);
  assert.equal(snapshot.data.order.returnWindowDays, 30);
  assert.equal(snapshot.data.order.returnPolicy.canRequest, true);
  const disabledForFuture = await api('/admin/settings', 'PATCH', { returnWindowDays: 0 }, adminToken);
  assert.equal(disabledForFuture.status, 200);

  const request = await api(`/orders/${returnOrderId}/returns`, 'POST', {
    items: [{ productId, quantity: 1 }], reason: 'One item arrived damaged',
  }, customerToken);
  assert.equal(request.status, 201);
  const duplicate = await api(`/orders/${returnOrderId}/returns`, 'POST', {
    items: [{ productId, quantity: 1 }], reason: 'Another request for this order',
  }, customerToken);
  assert.equal(duplicate.status, 409);

  const requestId = request.data.request.id;
  const approved = await api(`/admin/orders/${returnOrderId}/returns/${requestId}/review`, 'POST', {
    decision: 'APPROVED', reviewNote: 'Return approved. Bring the item to the store.',
  }, adminToken);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'APPROVED');

  const before = await api(`/products/${productId}`);
  const received = await api(`/admin/orders/${returnOrderId}/returns/${requestId}/receive`, 'POST', {
    items: [{ productId, quantityReceived: 1, restockQuantity: 1 }], note: 'Inspected and fit for resale',
  }, adminToken);
  assert.equal(received.status, 200);
  assert.equal(received.data.restockedItems.length, 1);
  const after = await api(`/products/${productId}`);
  assert.equal(after.data.product.stock, before.data.product.stock + 1);

  const repeatedReceipt = await api(`/admin/orders/${returnOrderId}/returns/${requestId}/receive`, 'POST', {
    items: [{ productId, quantityReceived: 1, restockQuantity: 1 }],
  }, adminToken);
  assert.equal(repeatedReceipt.status, 409);
  const unchanged = await api(`/products/${productId}`);
  assert.equal(unchanged.data.product.stock, after.data.product.stock);

  const customerOrders = await api('/me/orders?limit=20&skip=0', 'GET', null, customerToken);
  const updated = customerOrders.data.orders.find(item => item.id === returnOrderId);
  assert.equal(updated.returnRequests[0].status, 'RECEIVED');
  assert.equal(Object.hasOwn(updated.returnRequests[0], 'reviewedBy'), false);
  assert.equal(Object.hasOwn(updated.returnRequests[0], 'receivedBy'), false);
  assert.equal(updated.returnPolicy.remainingItems[0].availableQuantity, 1);
  const singleOrder = await api(`/orders/${returnOrderId}`, 'GET', null, customerToken);
  assert.equal(Object.hasOwn(singleOrder.data.order.returnRequests[0], 'reviewedBy'), false);
  assert.equal(Object.hasOwn(singleOrder.data.order.returnRequests[0], 'receivedBy'), false);
});

test('admin cancel restores stock exactly once', async () => {
  const productId     = process.env._TEST_PRODUCT_ID;
  const pmId          = process.env._TEST_PM_ID;

  // Place a fresh order
  const fresh = await api('/orders', 'POST', {
    customerName: 'Test Customer', phone: '0788000000', city: 'Kigali',
    address: 'Kicukiro', items: [{ productId, quantity: 3 }],
    paymentMethodId: pmId,
  }, customerToken);
  assert.equal(fresh.status, 201);

  const before = await api(`/products/${productId}`);
  const stockBefore = before.data.product.stock;

  // Find this order
  const adminOrders = await api('/admin/orders', 'GET', null, adminToken);
  const freshOrder = adminOrders.data.orders.find(o => o.invoiceNumber === fresh.data.order.invoiceNumber);
  assert.ok(freshOrder);

  // Cancel
  const cancel1 = await api(`/admin/orders/${freshOrder.id}/cancel`, 'POST',
    { reason: 'Test cancel' }, adminToken);
  assert.equal(cancel1.status, 200);

  // Stock must be restored
  const after = await api(`/products/${productId}`);
  assert.equal(after.data.product.stock, stockBefore + 3);

  // Cancel again — must be idempotent, stock must NOT double-restore
  const cancel2 = await api(`/admin/orders/${freshOrder.id}/cancel`, 'POST',
    { reason: 'Duplicate' }, adminToken);
  assert.equal(cancel2.status, 200);

  const after2 = await api(`/products/${productId}`);
  assert.equal(after2.data.product.stock, stockBefore + 3); // unchanged
});

test('expired invoice releases reserved stock exactly once', async () => {
  const productId = process.env._TEST_PRODUCT_ID;
  const paymentMethodId = process.env._TEST_PM_ID;
  const before = await api(`/products/${productId}`);
  const placed = await api('/orders', 'POST', {
    customerName: 'Test Customer', phone: '0788000000', city: 'Kigali',
    address: 'Kicukiro', items: [{ productId, quantity: 2 }], paymentMethodId,
  }, customerToken);
  assert.equal(placed.status, 201);

  const { getDb } = await import('../server/db/mongo.mjs');
  const { orders } = await import('../server/db/repository.mjs');
  await getDb().collection('orders').updateOne(
    { id: placed.data.order.id },
    { $set: { paymentDeadline: new Date(Date.now() - 60_000) } },
  );

  assert.equal(await orders.expireOverdueOrders(), 1);
  const expired = await api(`/orders/${placed.data.order.id}`, 'GET', null, customerToken);
  assert.equal(expired.data.order.paymentStatus, 'EXPIRED');
  assert.equal(expired.data.order.fulfillmentStatus, 'CANCELLED');
  const restored = await api(`/products/${productId}`);
  assert.equal(restored.data.product.stock, before.data.product.stock);

  assert.equal(await orders.expireOverdueOrders(), 0);
  const stillRestored = await api(`/products/${productId}`);
  assert.equal(stillRestored.data.product.stock, before.data.product.stock);
});

test('product management: add, patch, delete', async () => {
  const newProduct = await api('/admin/products', 'POST', {
    name: 'Test Widget', description: 'A test product', price: 5000, stock: 10,
    categorySlug: 'groceries',
  }, adminToken);
  assert.equal(newProduct.status, 201);

  const changed = await api(`/admin/products/${newProduct.data.id}/stock`, 'POST', {
    delta: 10, reason: 'Test inventory count correction',
  }, adminToken);
  assert.equal(changed.status, 200);

  const hidden = await api(`/admin/products/${newProduct.data.id}`, 'DELETE', null, adminToken);
  assert.equal(hidden.status, 200);

  // Should not appear in public listing
  const pub = await api(`/products/${newProduct.data.id}`);
  assert.notEqual(pub.status, 200);
});

test('product gallery validates photos, keeps the first as primary, and survives legacy primary-image edits', async () => {
  const photos = [
    { url: 'https://images.example/widget-front.jpg', publicId: '' },
    { url: 'https://images.example/widget-side.jpg', publicId: '' },
  ];
  const created = await api('/admin/products', 'POST', {
    name: 'Gallery Widget', description: 'A product with a photo gallery', price: 6200, stock: 6,
    categorySlug: 'groceries', images: photos,
  }, adminToken);
  assert.equal(created.status, 201);

  let fetched = await api(`/products/${created.data.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.data.product.images, photos);
  assert.equal(fetched.data.product.imageUrl, photos[0].url);

  const reordered = [photos[1], { url: 'https://images.example/widget-detail.jpg', publicId: '' }];
  const changed = await api(`/admin/products/${created.data.id}`, 'PATCH', { images: reordered }, adminToken);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.imageCleanupFailed, false);
  fetched = await api(`/products/${created.data.id}`);
  assert.deepEqual(fetched.data.product.images, reordered);
  assert.equal(fetched.data.product.imageUrl, reordered[0].url);

  const legacyEdit = await api(`/admin/products/${created.data.id}`, 'PATCH', {
    imageUrl: reordered[0].url, price: 6300,
  }, adminToken);
  assert.equal(legacyEdit.status, 200);
  fetched = await api(`/products/${created.data.id}`);
  assert.deepEqual(fetched.data.product.images, reordered);

  const tooMany = await api('/admin/products', 'POST', {
    name: 'Too Many Photos', price: 100, stock: 1, categorySlug: 'groceries',
    images: Array.from({ length: 9 }, (_, index) => ({ url: `https://images.example/${index}.jpg`, publicId: '' })),
  }, adminToken);
  assert.equal(tooMany.status, 400);

  const unownedCloudinaryId = await api('/admin/products', 'POST', {
    name: 'Invalid Uploaded Photo', price: 100, stock: 1, categorySlug: 'groceries',
    images: [{ url: 'https://images.example/not-cloudinary.jpg', publicId: 'iwacumall/products/00000000-0000-4000-8000-000000000000' }],
  }, adminToken);
  assert.equal(unownedCloudinaryId.status, 400);
});

test('password reset flow', async () => {
  // Request reset
  const req = await api('/auth/forgot-password', 'POST', { email: 'buyer@test.example' });
  assert.equal(req.status, 200); // always 200 — no email enumeration

  // Invalid token fails
  const bad = await api('/auth/reset-password', 'POST', { token: 'badtoken', password: 'newPassword9999!' });
  assert.equal(bad.status, 400);
});

test('logout invalidates session', async () => {
  // Create a fresh session to logout
  const login = await api('/auth/login', 'POST', {
    email: 'buyer@test.example', password: 'customerTest123456',
  });
  const tmpToken = login.data.token;

  const logout = await api('/auth/logout', 'POST', null, tmpToken);
  assert.equal(logout.status, 200);

  const after = await api('/me', 'GET', null, tmpToken);
  assert.equal(after.status, 401);
});

test('static site and path traversal', async () => {
  const index    = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.ok((await index.text()).includes('Everything you love'));

  const traverse = await fetch(base + '/%2e%2e/%2e%2e/etc/passwd');
  assert.notEqual(traverse.status, 200);
  assert.equal((await fetch(base + '/robots.txt')).status, 200);
  assert.equal((await fetch(base + '/sitemap.xml')).status, 200);
  assert.equal((await fetch(base + '/products/wireless-headphones')).status, 200);
  assert.equal((await fetch(base + '/this-page-does-not-exist')).status, 404);
});

test('production config accepts real settings and rejects placeholders or a missing Mongo URI', async () => {
  const { spawnSync } = await import('node:child_process');
  const productionEnv = {
    ...process.env,
    NODE_ENV: 'production',
    MONGODB_URI: "mongodb://127.0.0.1:27017/iwacumall-test",
    COOKIE_SECRET: "test-only-cookie-secret-not-for-production-0123456789",
    ADMIN_EMAIL: "admin@test.invalid",
    ADMIN_PASSWORD: "test-only-admin-password-not-for-production",
    APP_BASE_URL: "https://store.test.invalid",
    STORE_ADDRESS: "Test address, Kigali, Rwanda",
    STORE_PHONE: "00000000",
    STORE_EMAIL: "store@test.invalid",
    STORE_NOTIFICATION_EMAIL: "orders@test.invalid",
    EMAIL_VERIFICATION_REQUIRED: "true",
    SMTP_HOST: "smtp.test.invalid",
    SMTP_USER: "test-mail-user@test.invalid",
    SMTP_PASS: "test-only-smtp-password-not-for-production",
    SMTP_FROM: "IwacuMall Test <no-reply@test.invalid>",
  };
  const args = ['--input-type=module', '-e', "import('./server/config.mjs')"];
  const configured = spawnSync(process.execPath, args, { env: productionEnv, encoding: 'utf8' });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);

  const placeholders = {
    ...productionEnv,
    STORE_NOTIFICATION_EMAIL: "REPLACE_WITH_REAL_STORE_EMAIL",
    SMTP_USER: "REPLACE_WITH_SMTP_USERNAME",
    SMTP_FROM: "REPLACE_WITH_SMTP_FROM",
  };
  const rejected = spawnSync(process.execPath, args, { env: placeholders, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'Production config must reject example notification and mailer addresses');
  assert.match(rejected.stderr, /STORE_NOTIFICATION_EMAIL/);

  const missingDatabase = { ...productionEnv };
  delete missingDatabase.MONGODB_URI;
  const missing = spawnSync(process.execPath, args, { env: missingDatabase, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MONGODB_URI is required in production/);
});

// ── Teardown ──────────────────────────────────────────────────────────────────

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  if (replSet) await replSet.stop();
});
