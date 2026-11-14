/**
 * server/index.mjs — IwacuMall API server (MongoDB edition)
 *
 * Node.js ≥ 22.13.0 required (see package.json engines).
 * Uses the official MongoDB driver (no ORM).
 * Authentication: HttpOnly cookies for browsers + Bearer tokens for mobile.
 */

import http     from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID, createHash }  from 'node:crypto';

import config  from './config.mjs';
import { connectDb, dbPing, closeDb, getClient } from './db/mongo.mjs';
import { seed }  from './db/seed.mjs';
import { users, sessions, categories, products, orders, paymentMethods, storeSettings, adminMfa, auditLog, emailOutbox } from './db/repository.mjs';
import { slugify } from './db/repository.mjs';
import {
  createPasswordHash, verifyPassword, cleanText, validEmail,
} from './security.mjs';
import {
  issueToken, tokenHash, createSession,
  ensureUser, ensureAdmin, getClientIp, rateLimit,
  issueEmailVerificationToken, issuePasswordResetToken,
} from './auth.mjs';
import { generateInvoicePdf } from './pdf/invoice.mjs';
import { generateRobotsTxt, generateSitemapXml } from './seo.mjs';
import { startEmailOutboxWorker } from './outbox.mjs';
import { createTotpSecret, createRecoveryCodes, hashRecoveryCode, encryptSensitiveValue, encryptTotpSecret, decryptTotpSecret, verifyTotp, totpProvisioningUri } from './mfa.mjs';
import { verifyGoogleIdToken } from './google-auth.mjs';
import { uploadProductImage, deleteProductImage, uploadCategoryImage, deleteCategoryImage, cloudinaryUploadEnabled } from './media.mjs';

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT      = config.port;
const HOST      = config.host;
const publicDir = resolve(process.cwd(), 'web');
const mime = {
  '.html':'text/html; charset=utf-8',
  '.css' :'text/css; charset=utf-8',
  '.js'  :'text/javascript; charset=utf-8',
  '.svg' :'image/svg+xml',
  '.png' :'image/png',
  '.ico' :'image/x-icon',
  '.webp':'image/webp',
  '.json':'application/json',
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  const e = new Error(message); e.status = status; throw e;
}
function ensure(condition, code, message) { if (!condition) fail(code, message); }

async function bodyJson(req, maxBytes = 64 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) fail(413, 'Request body too large');
  }
  try { return JSON.parse(raw || '{}'); } catch { fail(400, 'Invalid JSON body'); }
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────
// Double-submit cookie pattern: browser must echo the csrf cookie value
// in the X-CSRF-Token header on state-changing requests.

function csrfToken() { return randomUUID(); }

function verifyCsrf(req) {
  // Bearer tokens are sent explicitly by native clients and are not ambient
  // browser credentials, so CSRF protection applies only to cookie sessions.
  const cookieStr = req.headers.cookie || '';
  const hasSessionCookie = /(?:^|;\s*)iwm_session=/.test(cookieStr);
  if (!hasSessionCookie && (req.headers.authorization || '').startsWith('Bearer ')) return;
  const headerVal = req.headers['x-csrf-token'] || '';
  const match = cookieStr.match(/(?:^|;\s*)iwm_csrf=([^;]+)/);
  const cookieVal = match ? decodeURIComponent(match[1]) : '';
  if (!headerVal || !cookieVal || headerVal !== cookieVal) {
    fail(403, 'CSRF check failed');
  }
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function setSessionCookie(res, token, maxAgeSeconds) {
  const opts = [
    `iwm_session=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(config.isProduction ? ['Secure'] : []),
  ].join('; ');
  res.setHeader('Set-Cookie', [
    opts,
    // CSRF cookie (not HttpOnly so JS can read it)
    `iwm_csrf=${csrfToken()}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Strict${config.isProduction ? '; Secure' : ''}`,
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    'iwm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
    'iwm_csrf=; Max-Age=0; Path=/; SameSite=Strict',
  ]);
}

function getSessionToken(req) {
  // Browser: cookie; Mobile: Bearer header
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)iwm_session=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function withDbTransaction(work) {
  const session = getClient().startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

async function getUser(req) {
  const token = getSessionToken(req);
  if (!token || !/^[a-zA-Z0-9_-]{30,150}$/.test(token)) return null;
  const session = await sessions.findByToken(tokenHash(token));
  if (!session) return null;
  return users.findById(session.userId);
}

async function authUser(req, adminRequired = false) {
  const user = await getUser(req);
  ensureUser(user);
  if (adminRequired) ensureAdmin(user);
  return user;
}

// ─── Product helpers ──────────────────────────────────────────────────────────

async function sanitizeProduct(input, partial = false, existing = null) {
  const fields = {};
  for (const k of ['name', 'description', 'imageUrl', 'imagePublicId']) {
    if (input[k] !== undefined) fields[k] = cleanText(input[k], k === 'description' ? 1200 : 200);
  }
  for (const k of ['price']) {
    if (input[k] !== undefined) {
      const v = Number(input[k]);
      ensure(Number.isSafeInteger(v) && v >= 0 && v <= (k === 'price' ? 100_000_000 : 1_000_000), 400, `Invalid ${k}`);
      fields[k] = v;
    }
  }
  for (const k of ['featured', 'active', 'isSecondHand']) {
    if (input[k] !== undefined) {
      ensure(typeof input[k] === 'boolean', 400, `${k} must be true or false`);
      fields[k] = input[k];
    }
  }
  if (input.variants !== undefined) {
    ensure(Array.isArray(input.variants) && input.variants.length <= 100, 400, 'A product can have up to 100 variants.');
    const ids = new Set();
    const combinations = new Set();
    fields.variants = input.variants.map((rawVariant) => {
      ensure(rawVariant && typeof rawVariant === 'object' && !Array.isArray(rawVariant), 400, 'Each product variant must be an object.');
      const type = cleanText(rawVariant.type, 50);
      const value = cleanText(rawVariant.value, 100);
      ensure(rawVariant.price !== '' && rawVariant.price !== null && rawVariant.price !== undefined, 400, 'Each variant needs a price.');
      const price = Number(rawVariant.price);
      ensure(type.length >= 1 && value.length >= 1, 400, 'Each variant needs an option type and value.');
      ensure(Number.isSafeInteger(price) && price >= 0 && price <= 100_000_000, 400, 'Each variant price must be a whole number from 0 to 100,000,000 RWF.');
      const combination = `${type.toLocaleLowerCase()}\u0000${value.toLocaleLowerCase()}`;
      ensure(!combinations.has(combination), 400, 'Variant type and value combinations must be unique.');
      combinations.add(combination);
      const requestedId = cleanText(rawVariant.id || '', 60);
      const id = /^[a-zA-Z0-9_-]{8,60}$/.test(requestedId) ? requestedId : randomUUID();
      ensure(!ids.has(id), 400, 'Variant IDs must be unique.');
      ids.add(id);
      return { id, type, value, price };
    });
    if (fields.variants.length) fields.price = Math.min(...fields.variants.map(variant => variant.price));
  }
  const validateImage = (rawImage) => {
    ensure(rawImage && typeof rawImage === 'object' && !Array.isArray(rawImage), 400, 'Each product photo must include an image URL.');
    const imageUrl = cleanText(rawImage.url, 1000);
    const imagePublicId = cleanText(rawImage.publicId || '', 200);
    ensure(
      imageUrl.startsWith('/assets/products/') || /^https:\/\//.test(imageUrl),
      400, 'Image must be an HTTPS URL or a local product asset path'
    );
    if (imagePublicId) {
      const imagePath = `/iwacumall/products/${imagePublicId.split('/').pop()}.`;
      const expectedCloudPrefix = `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/`;
      ensure(
        cloudinaryUploadEnabled() && /^iwacumall\/products\/[0-9a-f-]{36}$/i.test(imagePublicId) &&
        imageUrl.startsWith(expectedCloudPrefix) && imageUrl.includes(imagePath),
        400, 'Uploaded image ID must match its Cloudinary product image URL'
      );
    }
    return { url: imageUrl, publicId: imagePublicId };
  };
  if (input.images !== undefined) {
    ensure(Array.isArray(input.images) && input.images.length <= 8, 400, 'A product can have up to 8 photos.');
    fields.images = input.images.map(validateImage);
    const publicIds = fields.images.map(image => image.publicId).filter(Boolean);
    ensure(new Set(publicIds).size === publicIds.length, 400, 'A product gallery cannot contain the same uploaded photo twice.');
    const primary = fields.images[0];
    fields.imageUrl = primary?.url || '';
    fields.imagePublicId = primary?.publicId || '';
  } else if (fields.imageUrl !== undefined || fields.imagePublicId !== undefined) {
    const imageUrl = fields.imageUrl ?? existing?.imageUrl ?? '';
    const imagePublicId = fields.imagePublicId ?? existing?.imagePublicId ?? '';
    const unchangedPrimary = partial && existing && imageUrl === existing.imageUrl && imagePublicId === (existing.imagePublicId || '');
    if (!(unchangedPrimary && Array.isArray(existing.images) && existing.images.length)) {
      fields.images = imageUrl ? [validateImage({ url: imageUrl, publicId: imagePublicId })] : [];
    }
    fields.imageUrl = imageUrl;
    fields.imagePublicId = imagePublicId;
  }
  if (!partial) {
    ensure(fields.name && fields.price !== undefined, 400, 'Name and price are required');
    // New products use the admin's Available toggle instead of stock counts.
    fields.stock = 0;
    fields.trackInventory = false;
    fields.isSecondHand = fields.isSecondHand === true;
  }
  if (input.categorySlug !== undefined) {
    const cat = await categories.findBySlug(slugify(cleanText(input.categorySlug, 80)));
    ensure(cat && cat.active !== false, 400, 'Unknown or archived category');
    fields.categoryId   = cat.id;
    fields.categorySlug = cat.slug;
  }
  return fields;
}

function productImages(product) {
  if (Array.isArray(product?.images)) {
    const gallery = product.images.filter(image => image && typeof image.url === 'string' && image.url)
      .map(image => ({ url: image.url, publicId: typeof image.publicId === 'string' ? image.publicId : '' }));
    if (gallery.length) return gallery;
  }
  return product?.imageUrl ? [{ url: product.imageUrl, publicId: product.imagePublicId || '' }] : [];
}

function customerReturnSummary(order, returnWindowDays) {
  const requests = Array.isArray(order.returnRequests) ? order.returnRequests : [];
  const activeRequest = requests.some(request => ['REQUESTED', 'APPROVED'].includes(request.status));
  const consumed = new Map();
  for (const request of requests) {
    if (request.status === 'REJECTED') continue;
    for (const item of request.items || []) {
      const quantity = request.status === 'RECEIVED' ? Number(item.returnedQuantity || 0) : Number(item.quantity || 0);
      consumed.set(item.productId, (consumed.get(item.productId) || 0) + quantity);
    }
  }
  const remainingItems = (order.items || []).map(item => {
    const orderedQuantity = Number(item.quantity || 0);
    return {
      productId: item.productId,
      productName: item.productName || item.product_name || 'Product',
      orderedQuantity,
      availableQuantity: Math.max(0, orderedQuantity - (consumed.get(item.productId) || 0)),
    };
  }).filter(item => item.availableQuantity > 0);
  const deliveredAt = order.deliveredAt || order.updatedAt || order.createdAt || null;
  const deliveredTime = deliveredAt ? new Date(deliveredAt).getTime() : Number.NaN;
  const configuredWindow = Number.isSafeInteger(order.returnWindowDays)
    ? order.returnWindowDays
    : Number(returnWindowDays);
  const windowDays = Number.isSafeInteger(configuredWindow) ? configuredWindow : 0;
  const deadline = windowDays > 0 && Number.isFinite(deliveredTime)
    ? new Date(deliveredTime + windowDays * 24 * 60 * 60 * 1000)
    : null;
  const safeRequests = requests.map(request => ({
    id: request.id,
    status: request.status,
    reason: request.reason,
    requestedAt: request.requestedAt,
    reviewedAt: request.reviewedAt,
    reviewNote: request.reviewNote || '',
    receivedAt: request.receivedAt,
    items: (request.items || []).map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: Number(item.quantity || 0),
      returnedQuantity: Number(item.returnedQuantity || 0),
      restockedQuantity: Number(item.restockedQuantity || 0),
    })),
  }));
  return {
    returnRequests: safeRequests,
    returnPolicy: {
      windowDays,
      deadline,
      remainingItems,
      canRequest: windowDays > 0 && order.fulfillmentStatus === 'DELIVERED' && order.paymentStatus === 'PAID' &&
        !!deadline && Date.now() <= deadline.getTime() && !activeRequest && remainingItems.length > 0,
    },
  };
}

// ─── Invoice / payment helpers ────────────────────────────────────────────────

function computeDeadline(settings) {
  if (!settings.invoiceExpiryHours || settings.invoiceExpiryHours <= 0) return null;
  return new Date(Date.now() + settings.invoiceExpiryHours * 3600 * 1000);
}

function computeDeliveryFee(settings) {
  return settings.deliveryFeeFlat >= 0 ? settings.deliveryFeeFlat : null; // null = not configured
}

function computeTax(subtotal, settings) {
  if (settings.taxRatePercent < 0) return null; // not configured
  return Math.round(subtotal * settings.taxRatePercent / 100);
}

// ─── API route handler ────────────────────────────────────────────────────────

async function api(req, res, url) {
  const path   = url.pathname;
  const method = req.method;
  const ip     = getClientIp(req);

  // Admin data routes require an administrator session. MFA remains an optional
  // account setting; login still verifies a code when that account enabled it.
  if (!config.isTest && path.startsWith('/api/admin/') && !path.startsWith('/api/admin/mfa/')) {
    await authUser(req, true);
  }

  // ── Health / readiness ─────────────────────────────────────────────────────
  if (path === '/api/health' && method === 'GET') {
    const dbOk = await dbPing();
    return json(res, dbOk ? 200 : 503, {
      ok:       dbOk,
      service:  'iwacumall-api',
      database: dbOk ? 'connected' : 'unavailable',
      env:      config.nodeEnv,
    });
  }

  // ── Store config (public, non-secret) ──────────────────────────────────────
  if (path === '/api/config' && method === 'GET') {
    const methods = await paymentMethods.list(true).catch(() => []);
    const settings = await storeSettings.get();
    const expiryConfigured = settings.invoiceExpiryHours > 0;
    const deliveryConfigured = settings.deliveryFeeFlat >= 0;
    return json(res, 200, {
      ...settings,
      currency:       config.currency,
      googleWebClientId: config.googleWebClientId || null,
      productImageUploadsEnabled: cloudinaryUploadEnabled(),
      paymentMethods: methods.map(m => ({ id: m.id, label: m.label, type: m.type })),
      checkoutEnabled: methods.length > 0 && expiryConfigured && deliveryConfigured,
      checkoutBlockedReason: methods.length === 0
        ? 'No payment methods configured. Admin must add at least one payment method.'
        : !expiryConfigured
          ? 'Admin must set a payment deadline in Store settings.'
          : !deliveryConfigured
            ? 'Admin must set a delivery fee in Store settings.'
            : null,
    });
  }

  // ── Categories ─────────────────────────────────────────────────────────────
  if (path === '/api/categories' && method === 'GET') {
    return json(res, 200, { categories: await categories.list() });
  }

  // ── Products ───────────────────────────────────────────────────────────────
  if (path === '/api/products' && method === 'GET') {
    const categorySlug = cleanText(url.searchParams.get('category') || '', 60);
    const search   = cleanText(url.searchParams.get('search') || '', 100);
    const featured = url.searchParams.get('featured') === '1';
    const condition = ['new', 'preowned'].includes(url.searchParams.get('condition')) ? url.searchParams.get('condition') : 'all';
    const sort = ['featured', 'newest', 'price-asc', 'price-desc'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'featured';
    const limit    = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 80));
    const page     = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const result   = await products.list({ categorySlug: categorySlug || undefined, search: search || undefined, featured, condition, sort, limit, page });
    return json(res, 200, result);
  }

  if (/^\/api\/products\/[a-zA-Z0-9-]+$/.test(path) && method === 'GET') {
    const id  = path.split('/').pop();
    const row = await products.findById(id) || await products.findBySlug(id);
    ensure(row && row.active, 404, 'Product not found');
    return json(res, 200, { product: row });
  }

  // ── Auth: register ─────────────────────────────────────────────────────────
  if (path === '/api/auth/register' && method === 'POST') {
    await rateLimit(ip, 'register', config.rateLimitMaxRegister, config.rateLimitWindowMs);
    const b        = await bodyJson(req);
    const name     = cleanText(b.name, 100);
    const email    = cleanText(b.email, 254).toLowerCase();
    const password = b.password;
    ensure(
      name.length >= 2 && validEmail(email) &&
      typeof password === 'string' && password.length >= 10 && password.length <= 128,
      400, 'Provide name, valid email, and password of 10–128 characters'
    );
    const existing = await users.findByEmail(email);
    ensure(!existing, 409, 'Email already registered');
    const id   = randomUUID();
    const userFields = {
      id, name, email, passwordHash: createPasswordHash(password),
      emailVerified: !config.emailVerificationRequired,
    };
    let user;

    try {
      if (config.emailVerificationRequired) {
        await withDbTransaction(async session => {
          user = await users.create(userFields, session);
          const tokenExpiresAt = new Date(Date.now() + 24 * 3600 * 1000);
          const evToken = await issueEmailVerificationToken(id, tokenExpiresAt, session);
          await emailOutbox.queueAuthEmail({
            userId: id, email, eventType: 'AUTH_EMAIL_VERIFICATION',
            encryptedAuthToken: encryptSensitiveValue(evToken), tokenExpiresAt, session,
          });
        });
      } else {
        user = await users.create(userFields);
      }
    } catch (error) {
      if (error?.code === 11000) fail(409, 'Email already registered');
      throw error;
    }

    const { token, expiresAt } = await createSession(id);
    setSessionCookie(res, token, config.sessionTtlSeconds);
    return json(res, 201, {
      token,
      user:  { id, name, email: user.email, role: 'CUSTOMER', emailVerified: user.emailVerified },
      emailVerificationRequired: config.emailVerificationRequired,
    });
  }

  // ── Auth: login ────────────────────────────────────────────────────────────
  if (path === '/api/auth/login' && method === 'POST') {
    await rateLimit(ip, 'login', config.rateLimitMaxLogin, config.rateLimitWindowMs);
    const b        = await bodyJson(req);
    const email    = cleanText(b.email, 254).toLowerCase();
    const password = b.password;
    ensure(validEmail(email) && typeof password === 'string' && password.length <= 128, 400, 'Invalid credentials');
    const user = await users.findByEmail(email);
    ensure(user && verifyPassword(password, user.passwordHash), 401, 'Invalid email or password');
    if (user.role === 'ADMIN' && user.mfaEnabled) {
      if (!b.totpCode) return json(res, 200, { mfaRequired: true });
      const record = await adminMfa.find(user.id);
      let secret = '';
      try { secret = decryptTotpSecret(record?.secret); } catch {}
      const validTotp = secret && verifyTotp(secret, b.totpCode);
      const validRecoveryCode = !validTotp && await adminMfa.consumeRecoveryCode(user.id, hashRecoveryCode(b.totpCode));
      ensure(validTotp || validRecoveryCode, 401, 'Authenticator or recovery code is invalid');
    }
    const { token } = await createSession(user.id);
    setSessionCookie(res, token, config.sessionTtlSeconds);
    return json(res, 200, {
      ...(req.headers['x-iwacumall-client'] === 'mobile' ? { token } : {}),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified, googleLinked: !!user.googleSub, mfaEnabled: !!user.mfaEnabled },
    });
  }

  // ── Auth: Google ID token (web and native clients) ─────────────────────────
  if (path === '/api/auth/google' && method === 'POST') {
    await rateLimit(ip, 'google-login', config.rateLimitMaxLogin, config.rateLimitWindowMs);
    if (/(?:^|;\s*)iwm_session=/.test(req.headers.cookie || '')) verifyCsrf(req);
    ensure(config.googleClientIds.length > 0, 503, 'Google sign-in is not configured yet.');
    const b = await bodyJson(req);
    ensure(typeof b.idToken === 'string' && b.idToken.length > 20 && b.idToken.length <= 8192, 400, 'Google credential is required.');

    let profile;
    try {
      profile = await verifyGoogleIdToken(b.idToken, config.googleClientIds);
    } catch {
      fail(401, 'Google sign-in could not be verified. Please try again.');
    }

    let user = await users.findByGoogleSub(profile.googleSub);
    if (!user) {
      const existing = await users.findByEmail(profile.email);
      if (existing) {
        ensure(existing.role === 'CUSTOMER', 403, 'Administrator accounts must use administrator sign-in.');
        ensure(existing.emailVerified === true, 409, 'Sign in and verify this email before linking Google to the existing account.');
        ensure(!existing.googleSub || existing.googleSub === profile.googleSub, 409, 'This email is linked to a different Google account.');
        user = await users.linkGoogleIdentity(existing.id, profile.googleSub);
        ensure(user, 409, 'This account was updated during sign-in. Please try again.');
      } else {
        try {
          user = await users.create({
            id: randomUUID(), name: cleanText(profile.name, 100) || profile.email.split('@')[0],
            email: profile.email, emailVerified: true, googleSub: profile.googleSub,
          });
        } catch (error) {
          if (error?.code !== 11000) throw error;
          user = await users.findByGoogleSub(profile.googleSub);
          if (!user) {
            const racedEmail = await users.findByEmail(profile.email);
            if (racedEmail && racedEmail.role === 'CUSTOMER' && racedEmail.emailVerified === true && !racedEmail.googleSub) {
              user = await users.linkGoogleIdentity(racedEmail.id, profile.googleSub);
            }
          }
          ensure(user, 409, 'This account was created during sign-in. Please try again.');
        }
      }
    }
    ensure(user.role === 'CUSTOMER', 403, 'Administrator accounts must use administrator sign-in.');

    const { token } = await createSession(user.id);
    setSessionCookie(res, token, config.sessionTtlSeconds);
    return json(res, 200, {
      ...(req.headers['x-iwacumall-client'] === 'mobile' ? { token } : {}),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: !!user.emailVerified, googleLinked: !!user.googleSub, mfaEnabled: !!user.mfaEnabled },
    });
  }

  // ── Auth: logout ───────────────────────────────────────────────────────────
  if (path === '/api/auth/logout' && method === 'POST') {
    verifyCsrf(req);
    const token = getSessionToken(req);
    if (token) await sessions.deleteByToken(tokenHash(token)).catch(() => {});
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  // ── Auth: verify email ─────────────────────────────────────────────────────
  if (path === '/api/auth/verify-email' && method === 'GET') {
    const rawToken = url.searchParams.get('token') || '';
    ensure(rawToken.length > 10, 400, 'Invalid verification link');
    const user = await users.verifyEmail(tokenHash(rawToken));
    ensure(user, 400, 'Verification link is invalid or has expired');
    // Redirect to home with success notice
    res.writeHead(302, { Location: '/?verified=1' });
    return res.end();
  }

  if (path === '/api/auth/resend-verification' && method === 'POST') {
    await rateLimit(ip, 'verify-resend', config.rateLimitMaxReset, config.rateLimitWindowMs);
    const user = await authUser(req);
    verifyCsrf(req);
    if (!user.emailVerified) {
      await withDbTransaction(async session => {
        const tokenExpiresAt = new Date(Date.now() + 24 * 3600 * 1000);
        const rawToken = await issueEmailVerificationToken(user.id, tokenExpiresAt, session);
        await emailOutbox.queueAuthEmail({
          userId: user.id, email: user.email, eventType: 'AUTH_EMAIL_VERIFICATION',
          encryptedAuthToken: encryptSensitiveValue(rawToken), tokenExpiresAt, session,
        });
      });
    }
    return json(res, 200, { ok: true, message: 'If verification is needed, a fresh link has been sent.' });
  }

  // ── Auth: request password reset ───────────────────────────────────────────
  if (path === '/api/auth/forgot-password' && method === 'POST') {
    await rateLimit(ip, 'forgot', config.rateLimitMaxReset, config.rateLimitWindowMs);
    const { email: rawEmail } = await bodyJson(req);
    const email = cleanText(rawEmail || '', 254).toLowerCase();
    // Always return 200 — do not reveal whether email is registered
    if (validEmail(email)) {
      const user = await users.findByEmail(email);
      if (user) {
        try {
          await withDbTransaction(async session => {
            const tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
            const resetToken = await issuePasswordResetToken(user.id, tokenExpiresAt, session);
            await emailOutbox.queueAuthEmail({
              userId: user.id, email, eventType: 'AUTH_PASSWORD_RESET',
              encryptedAuthToken: encryptSensitiveValue(resetToken), tokenExpiresAt, session,
            });
          });
        } catch (error) {
          console.warn('[auth] Password reset email could not be queued:', error?.code || 'QUEUE_ERROR');
        }
      }
    }
    return json(res, 200, { ok: true, message: 'If that email is registered you will receive a reset link.' });
  }

  // ── Auth: reset password ───────────────────────────────────────────────────
  if (path === '/api/auth/reset-password' && method === 'POST') {
    await rateLimit(ip, 'reset', config.rateLimitMaxReset, config.rateLimitWindowMs);
    const { token: rawToken, password } = await bodyJson(req);
    ensure(typeof rawToken === 'string' && rawToken.length > 10, 400, 'Invalid token');
    ensure(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, 'Password must be 10–128 characters');
    const user = await users.resetPasswordWithToken(tokenHash(rawToken), createPasswordHash(password));
    ensure(user, 400, 'Reset link is invalid or has expired');
    return json(res, 200, { ok: true });
  }

  // ── Auth: change password (authenticated) ─────────────────────────────────
  if (path === '/api/auth/change-password' && method === 'POST') {
    const user = await authUser(req);
    verifyCsrf(req);
    const { currentPassword, newPassword } = await bodyJson(req);
    ensure(typeof currentPassword === 'string' && typeof newPassword === 'string', 400, 'Missing fields');
    ensure(newPassword.length >= 10 && newPassword.length <= 128, 400, 'New password must be 10–128 characters');
    const full = await users.findByEmail(user.email);
    ensure(verifyPassword(currentPassword, full.passwordHash), 401, 'Current password is incorrect');
    await users.setPassword(user.id, createPasswordHash(newPassword));
    await sessions.deleteAllForUser(user.id);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  // ── Auth: delete account ───────────────────────────────────────────────────
  if (path === '/api/auth/delete-account' && method === 'POST') {
    const user = await authUser(req);
    verifyCsrf(req);
    ensure(user.role !== 'ADMIN', 403, 'Admin accounts cannot be self-deleted');
    const { password, idToken } = await bodyJson(req);
    if (user.googleSub) {
      ensure(typeof idToken === 'string' && idToken.length > 20, 400, 'A fresh Google sign-in is required to delete this account.');
      ensure(config.googleClientIds.length > 0, 503, 'Google sign-in is not configured.');
      let profile;
      try { profile = await verifyGoogleIdToken(idToken, config.googleClientIds); }
      catch { fail(401, 'Google account verification failed.'); }
      ensure(profile.googleSub === user.googleSub, 401, 'Sign in with the Google account linked to this profile.');
    } else {
      const full = await users.findByEmail(user.email);
      ensure(verifyPassword(password, full?.passwordHash), 401, 'Password is incorrect');
    }
    await sessions.deleteAllForUser(user.id);
    await users.anonymize(user.id);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  // ── Me ─────────────────────────────────────────────────────────────────────
  if (path === '/api/me' && method === 'GET') {
    const user = await authUser(req);
    return json(res, 200, {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified, googleLinked: !!user.googleSub, mfaEnabled: !!user.mfaEnabled }
    });
  }

  if (path === '/api/me' && method === 'PATCH') {
    const user = await authUser(req);
    verifyCsrf(req);
    const { name: rawName } = await bodyJson(req);
    const name = cleanText(rawName, 100);
    ensure(name.length >= 2, 400, 'Enter a name with at least two characters.');
    await users.updateName(user.id, name);
    return json(res, 200, { user: { id: user.id, name, email: user.email, role: user.role, emailVerified: user.emailVerified, mfaEnabled: !!user.mfaEnabled } });
  }

  if (path === '/api/me/addresses' && method === 'GET') {
    const user = await authUser(req);
    return json(res, 200, { addresses: user.savedAddresses || [] });
  }

  if (path === '/api/me/addresses' && method === 'POST') {
    const user = await authUser(req);
    verifyCsrf(req);
    const body = await bodyJson(req);
    const address = {
      id: randomUUID(),
      label: cleanText(body.label, 40),
      recipientName: cleanText(body.recipientName || user.name, 100),
      phone: cleanText(body.phone, 30),
      city: cleanText(body.city, 90),
      address: cleanText(body.address, 180),
      isDefault: body.isDefault === true,
      createdAt: new Date(),
    };
    ensure(body.isDefault === undefined || typeof body.isDefault === 'boolean', 400, 'isDefault must be true or false.');
    ensure(address.label.length >= 2 && address.recipientName.length >= 2 && address.phone.replace(/\D/g, '').length >= 8 && address.address.length >= 5 && address.city.length >= 2, 400, 'Complete the label, recipient, phone, city and delivery address.');
    const addresses = await users.saveAddress(user.id, address);
    await auditLog.record({ action: 'DELIVERY_ADDRESS_ADDED', userId: user.id, detail: address.label });
    return json(res, 201, { addresses });
  }

  const savedAddressPath = path.match(/^\/api\/me\/addresses\/([a-zA-Z0-9-]+)$/);
  if (savedAddressPath) {
    const user = await authUser(req);
    const addressId = savedAddressPath[1];
    if (method === 'PATCH') {
      verifyCsrf(req);
      const body = await bodyJson(req);
      const existing = (user.savedAddresses || []).find(address => address.id === addressId);
      ensure(existing, 404, 'Saved delivery address not found.');
      ensure(body.isDefault === undefined || typeof body.isDefault === 'boolean', 400, 'isDefault must be true or false.');
      const address = {
        ...existing,
        label: body.label === undefined ? existing.label : cleanText(body.label, 40),
        recipientName: body.recipientName === undefined ? existing.recipientName : cleanText(body.recipientName, 100),
        phone: body.phone === undefined ? existing.phone : cleanText(body.phone, 30),
        city: body.city === undefined ? existing.city : cleanText(body.city, 90),
        address: body.address === undefined ? existing.address : cleanText(body.address, 180),
        isDefault: body.isDefault === undefined ? existing.isDefault === true : body.isDefault,
      };
      ensure(address.label.length >= 2 && address.recipientName.length >= 2 && address.phone.replace(/\D/g, '').length >= 8 && address.address.length >= 5 && address.city.length >= 2, 400, 'Complete the label, recipient, phone, city and delivery address.');
      const addresses = await users.saveAddress(user.id, address);
      return json(res, 200, { addresses });
    }
    if (method === 'DELETE') {
      verifyCsrf(req);
      const result = await users.deleteAddress(user.id, addressId);
      ensure(result.removed, 404, 'Saved delivery address not found.');
      return json(res, 200, { addresses: result.addresses });
    }
  }

  if (path === '/api/me/sessions' && method === 'GET') {
    const user = await authUser(req);
    const currentToken = getSessionToken(req);
    const currentHash = currentToken ? tokenHash(currentToken) : '';
    const entries = await sessions.listForUser(user.id);
    return json(res, 200, { sessions: entries.map(entry => ({ id: entry._id.toHexString(), createdAt: entry.createdAt, expiresAt: entry.expiresAt, isCurrent: entry.tokenHash === currentHash })) });
  }

  if (/^\/api\/me\/sessions\/[a-f0-9]{24}$/.test(path) && method === 'DELETE') {
    const user = await authUser(req);
    verifyCsrf(req);
    const oid = path.split('/').pop();
    const revoked = await sessions.revokeByOid(oid, user.id);
    ensure(revoked.deletedCount === 1, 404, 'Session not found.');
    return json(res, 200, { ok: true });
  }

  if (path === '/api/me/orders' && method === 'GET') {
    const user = await authUser(req);
    const requestedLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Number.NaN;
    const requestedSkip = url.searchParams.has('skip') ? Number(url.searchParams.get('skip')) : Number.NaN;
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 20;
    const skip = Number.isSafeInteger(requestedSkip) ? Math.min(1_000_000, Math.max(0, requestedSkip)) : 0;
    const rows = await orders.findByUserId(user.id, limit + 1, skip);
    const hasMore = rows.length > limit;
    const myOrders = rows.slice(0, limit);
    const settings = await storeSettings.get();
    return json(res, 200, { orders: myOrders.map(order => ({
      ...order,
      ...customerReturnSummary(order, settings.returnWindowDays),
      refunds: (order.refunds || []).map(({ amount, reason, createdAt }) => ({ amount, reason, createdAt })),
    })), hasMore, nextSkip: skip + myOrders.length });
  }

  const customerReturnPath = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/returns$/);
  if (customerReturnPath && method === 'POST') {
    const user = await authUser(req);
    verifyCsrf(req);
    await rateLimit(ip, `return-request:${user.id}`, 5, config.rateLimitWindowMs);
    const settings = await storeSettings.get();
    const body = await bodyJson(req);
    const reason = cleanText(body.reason, 500);
    ensure(reason.length >= 5, 400, 'Enter at least five characters explaining your return request.');
    ensure(Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 50, 400, 'Select at least one item to return.');
    const items = body.items.map(item => ({
      productId: cleanText(item?.productId, 60),
      quantity: Number(item?.quantity),
    }));
    ensure(items.every(item => item.productId && Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100), 400, 'Return quantities must be whole numbers from 1 to 100.');
    const result = await orders.requestReturn({
      orderId: customerReturnPath[1], userId: user.id, items, reason,
      returnWindowDays: Number(settings.returnWindowDays),
    });
    return json(res, 201, result);
  }

  // ── Place order ────────────────────────────────────────────────────────────
  if (path === '/api/orders' && method === 'POST') {
    const user = await authUser(req);
    verifyCsrf(req);

    if (config.emailVerificationRequired) {
      ensure(user.emailVerified, 403, 'Please verify your email address before placing an order.');
    }

    // Validate delivery config
    const settings = await storeSettings.get();
    const deliveryFee = computeDeliveryFee(settings);
    ensure(deliveryFee !== null, 503, 'Delivery fee is not configured. Please contact the store.');

    const expiryConfigured = settings.invoiceExpiryHours > 0;
    ensure(expiryConfigured, 503, 'Payment deadline not configured. Please contact the store.');

    const b = await bodyJson(req);
    const customerName = cleanText(b.customerName || user.name, 100);
    const phone   = cleanText(b.phone,   30);
    const address = cleanText(b.address, 180);
    const city    = cleanText(b.city,    90);
    const note    = cleanText(b.note || '', 500);

    ensure(customerName.length >= 2 && phone.length >= 8 && phone.length <= 20 && address.length >= 5 && city.length >= 2,
      400, 'Complete your name, phone number, city and delivery address');

    // Payment method
    const selectedMethodId = cleanText(b.paymentMethodId || '', 60);
    ensure(selectedMethodId, 400, 'Select a payment method');
    const method = await paymentMethods.findById(selectedMethodId);
    ensure(method && method.enabled, 400, 'Selected payment method is not available');

    // Cart items
    ensure(Array.isArray(b.items) && b.items.length >= 1 && b.items.length <= 50, 400, 'Your cart is empty or too large');
    const merged = new Map();
    for (const item of b.items) {
      const id  = cleanText(item.productId, 60);
      const variantId = cleanText(item.variantId || '', 60);
      const qty = Number(item.quantity);
      ensure(id && Number.isSafeInteger(qty) && qty >= 1 && qty <= 100, 400, 'Invalid cart item');
      const key = `${id}\u0000${variantId}`;
      const current = merged.get(key) || { productId: id, variantId, quantity: 0 };
      current.quantity += qty;
      ensure(current.quantity <= 100, 400, 'Maximum 100 per item');
      merged.set(key, current);
    }
    const productQuantities = new Map();
    for (const item of merged.values()) {
      const total = (productQuantities.get(item.productId) || 0) + item.quantity;
      ensure(total <= 100, 400, 'Maximum 100 per product');
      productQuantities.set(item.productId, total);
    }

    // Every order must carry a client-generated key so network retries cannot
    // reserve stock or create a second invoice.
    const idempotencyKey = cleanText(req.headers['idempotency-key'] || '', 128);
    ensure(/^[A-Za-z0-9._:-]{12,128}$/.test(idempotencyKey), 400, 'A valid Idempotency-Key header is required');
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        customerName, phone, address, city, note,
        selectedMethodId,
        items: Array.from(merged.values()).sort((a,b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`))
      }))
      .digest('hex');

    // Fetch current prices from DB (never trust client-submitted prices)
    const lineItems = [];
    for (const { productId, variantId, quantity } of merged.values()) {
      const p = await products.findById(productId);
      ensure(p && p.active, 400, 'A product in your cart is unavailable');
      const variants = Array.isArray(p.variants) ? p.variants : [];
      let selectedVariant = null;
      if (variants.length) {
        ensure(variantId, 400, `Choose an option for ${p.name} before placing your order.`);
        selectedVariant = variants.find(variant => variant.id === variantId);
        ensure(selectedVariant, 409, `The selected option for ${p.name} is no longer available. Please review your cart.`);
      } else {
        ensure(!variantId, 409, `${p.name} no longer has the selected option. Please review your cart.`);
      }
      const variantLabel = selectedVariant ? `${selectedVariant.type}: ${selectedVariant.value}` : '';
      lineItems.push({
        productId,
        variantId: selectedVariant?.id || '',
        variantType: selectedVariant?.type || '',
        variantValue: selectedVariant?.value || '',
        productName: variantLabel ? `${p.name} · ${variantLabel}` : p.name,
        unitPrice: selectedVariant ? selectedVariant.price : p.price,
        quantity,
        trackInventory: p.trackInventory === true,
        isSecondHand: p.isSecondHand === true,
      });
    }

    const subtotal = lineItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    ensure(Number.isSafeInteger(subtotal) && subtotal <= 1_000_000_000, 400, 'Order value is too large');

    const taxAmount = computeTax(subtotal, settings) || 0;
    const deadline  = computeDeadline(settings);

    // Snapshot the payment instructions so later edits don't change this invoice
    const snapshot = {
      label:        method.label,
      type:         method.type,
      instructions: method.instructions,
      accountName:  method.accountName,
      accountNumber:method.accountNumber,
    };

    const checkout = await orders.createWithStockReservation({
      userId: user.id, customerName, phone, address, city, note,
      items: lineItems,
      paymentMethodId: method.id,
      paymentMethodSnapshot: snapshot,
      deliveryFee,
      taxAmount,
      returnWindowDays: Number(settings.returnWindowDays),
      paymentDeadline: deadline,
      customerEmail: user.email,
      storeNotificationEmail: config.storeNotificationEmail,
      sellerSnapshot: {
        name: settings.storeName || config.storeName,
        address: settings.storeAddress || config.storeAddress,
        phone: settings.storePhone || config.storePhone,
        email: settings.storeEmail || config.storeEmail,
      },
      idempotencyKey,
      requestFingerprint,
    });
    return json(res, checkout.replayed ? 200 : 201, checkout.response);
  }

  // ── Download Invoice PDF (Finding #5) ──────────────────────────────────────
  if (/^\/api\/orders\/[a-zA-Z0-9-]+\/invoice\.pdf$/.test(path) && method === 'GET') {
    const user = await authUser(req);
    const id = path.split('/')[3];
    const order = await orders.findById(id);
    ensure(order && (order.userId === user.id || user.role === 'ADMIN'), 404, 'Order not found');
    const settings = await storeSettings.get();
    const pdfBuffer = await generateInvoicePdf(order, settings);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice-${order.invoiceNumber || order.id}.pdf"`,
      'Cache-Control': 'private, no-cache',
      'Content-Length': pdfBuffer.length,
      'X-Robots-Tag': 'noindex, nofollow',
    });
    return res.end(pdfBuffer);
  }

  // ── Get a single order (customer or admin) ─────────────────────────────────
  if (/^\/api\/orders\/[a-zA-Z0-9-]+$/.test(path) && method === 'GET') {
    const user  = await authUser(req);
    const id    = path.split('/').pop();
    const order = await orders.findById(id);
    ensure(order && (order.userId === user.id || user.role === 'ADMIN'), 404, 'Order not found');
    if (user.role === 'ADMIN') return json(res, 200, { order });
    const settings = await storeSettings.get();
    return json(res, 200, { order: {
      ...order,
      ...customerReturnSummary(order, settings.returnWindowDays),
      refunds: (order.refunds || []).map(({ amount, reason, createdAt }) => ({ amount, reason, createdAt })),
    } });
  }

  // ── Admin: invoice email delivery status and retry ─────────────────────────
  if (path === '/api/admin/email-outbox' && method === 'GET') {
    await authUser(req, true);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    return json(res, 200, { jobs: await emailOutbox.list(limit) });
  }

  const emailAction = path.match(/^\/api\/admin\/email-outbox\/([a-f0-9-]+)\/(retry|resend)$/i);
  if (emailAction && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const action = emailAction[2];
    if (action === 'resend') {
      const body = await bodyJson(req);
      ensure(body.confirm === true, 400, 'Confirm that you want to resend to recipients who already received this email.');
    }
    const result = await emailOutbox.requeue(emailAction[1], { resendAll: action === 'resend' });
    ensure(result.found, 404, 'Email delivery job not found');
    ensure(result.requeued, 409, result.reason || 'Email job could not be queued');
    await auditLog.record({ action: action === 'resend' ? 'EMAIL_RESENT' : 'EMAIL_RETRY_QUEUED', adminId: admin.id, detail: emailAction[1] });
    return json(res, 202, { ok: true, status: 'PENDING' });
  }

  // ── Admin: stats ──────────────────────────────────────────────────────────
  if (path === '/api/admin/stats' && method === 'GET') {
    await authUser(req, true);
    const [productCount, customerCount, orderCount, revenue, openOrders] = await Promise.all([
      products.countActive(),
      users.countCustomers(),
      orders.count(),
      orders.sumRevenue(),
      orders.countOpen(),
    ]);
    return json(res, 200, { stats: { products: productCount, customers: customerCount, orders: orderCount, revenue, openOrders } });
  }

  // ── Admin: orders ─────────────────────────────────────────────────────────
  if (path === '/api/admin/orders' && method === 'GET') {
    await authUser(req, true);
    const status        = url.searchParams.get('status') || '';
    const paymentStatus = url.searchParams.get('paymentStatus') || '';
    const search        = cleanText(url.searchParams.get('search') || '', 100);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Number.NaN;
    const rawSkip = url.searchParams.has('skip') ? Number(url.searchParams.get('skip')) : Number.NaN;
    const limit  = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 10;
    const skip   = Number.isSafeInteger(rawSkip) ? Math.min(1_000_000, Math.max(0, rawSkip)) : 0;
    const filters = {
      status:        status        || undefined,
      paymentStatus: paymentStatus || undefined,
      search:        search        || undefined,
      includeArchived,
    };
    const [result, total, openCount] = await Promise.all([orders.listAdmin({
      limit, skip,
      ...filters,
    }), orders.countAdmin(filters), orders.countOpen()]);
    return json(res, 200, {
      orders: result,
      total,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit) || 1,
      hasMore: skip + result.length < total,
      openCount,
    });
  }

  // Hiding an order from the active admin queue preserves customer history, invoices and audit data.
  const restoreAdminOrder = path.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)\/restore$/);
  if (restoreAdminOrder && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = restoreAdminOrder[1];
    ensure(await orders.findById(orderId), 404, 'Order not found');
    const restored = await orders.restoreAdminArchive({ orderId, adminId: admin.id });
    ensure(restored, 409, 'Order is already in the active order list.');
    return json(res, 200, { ok: true });
  }
  const archiveAdminOrder = path.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)$/);
  if (archiveAdminOrder && method === 'DELETE') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = archiveAdminOrder[1];
    ensure(await orders.findById(orderId), 404, 'Order not found');
    const archived = await orders.archiveForAdmin({ orderId, adminId: admin.id });
    ensure(archived, 409, 'Order is already removed from the active order list.');
    return json(res, 200, { ok: true });
  }

  // ── Admin: confirm payment ─────────────────────────────────────────────────
  if (/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/confirm-payment$/.test(path) && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = path.split('/')[4];
    const { paymentRef, note } = await bodyJson(req);
    ensure(typeof paymentRef === 'string' && paymentRef.trim().length >= 2, 400, 'Payment reference is required');
    const changed = await orders.confirmPayment({ orderId, adminId: admin.id, paymentRef: paymentRef.trim(), note: (note || '').trim() });
    ensure(changed, 409, 'Order is not in PENDING state or was already confirmed');
    return json(res, 200, { ok: true });
  }

  const adminReturnPath = path.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)\/returns\/([a-zA-Z0-9-]+)\/(review|receive)$/);
  if (adminReturnPath && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const body = await bodyJson(req);
    if (adminReturnPath[3] === 'review') {
      const decision = cleanText(body.decision, 20).toUpperCase();
      ensure(['APPROVED', 'REJECTED'].includes(decision), 400, 'Choose approve or reject for this return request.');
      const reviewNote = cleanText(body.reviewNote || '', 300);
      const result = await orders.reviewReturnRequest({
        orderId: adminReturnPath[1], requestId: adminReturnPath[2], adminId: admin.id, decision, reviewNote,
      });
      return json(res, 200, result);
    }
    ensure(Array.isArray(body.items) && body.items.length <= 50, 400, 'Return receipt items are invalid.');
    const receivedItems = body.items.map(item => ({
      productId: cleanText(item?.productId, 60),
      quantityReceived: Number(item?.quantityReceived),
      restockQuantity: Number(item?.restockQuantity),
    }));
    ensure(receivedItems.every(item => item.productId && Number.isSafeInteger(item.quantityReceived) && item.quantityReceived >= 0 && Number.isSafeInteger(item.restockQuantity) && item.restockQuantity >= 0), 400, 'Returned and restock quantities must be non-negative whole numbers.');
    const note = cleanText(body.note || '', 300);
    const result = await orders.receiveReturnRequest({
      orderId: adminReturnPath[1], requestId: adminReturnPath[2], adminId: admin.id, receivedItems, note,
    });
    return json(res, 200, result);
  }

  // A refund entry records a refund already issued through the configured manual payment method.
  if (/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/refund$/.test(path) && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = path.split('/')[4];
    const body = await bodyJson(req);
    const amount = Number(body.amount);
    const reason = cleanText(body.reason, 300);
    const paymentRef = cleanText(body.paymentRef, 100);
    ensure(Number.isSafeInteger(amount) && amount > 0, 400, 'Enter a whole-number refund amount in RWF.');
    ensure(reason.length >= 3, 400, 'Enter a reason for the refund.');
    ensure(paymentRef.length >= 2, 400, 'Enter the reference for the refund you issued.');
    const result = await orders.refundOrder({ orderId, adminId: admin.id, amount, reason, paymentRef });
    return json(res, 201, result);
  }

  // ── Admin: cancel order ────────────────────────────────────────────────────
  if (/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/cancel$/.test(path) && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = path.split('/')[4];
    const { reason } = await bodyJson(req);
    const changed = await orders.cancelOrder({ orderId, adminId: admin.id, reason: reason || '' });
    if (!changed) return json(res, 200, { ok: true, alreadyCancelled: true });
    return json(res, 200, { ok: true });
  }

  // ── Admin: fulfillment status ──────────────────────────────────────────────
  if (/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/fulfillment$/.test(path) && method === 'PATCH') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const orderId = path.split('/')[4];
    const { status } = await bodyJson(req);
    const allowed = ['PLACED','CONFIRMED','PACKING','OUT_FOR_DELIVERY','DELIVERED'];
    ensure(allowed.includes(status), 400, 'Invalid fulfillment status');
    const order = await orders.findById(orderId);
    ensure(order, 404, 'Order not found');
    // Initial order acceptance is independent from payment; packing and delivery require confirmed payment.
    if (status === 'DELIVERED') {
      ensure(order.paymentStatus === 'PAID', 409, 'Cannot mark delivered — payment not confirmed');
    }
    const changed = await orders.updateFulfillment({ orderId, adminId: admin.id, fulfillmentStatus: status });
    ensure(changed, 409, 'Order status could not move forward. Confirm payment before packing or delivery, and choose the next status in the sequence.');
    return json(res, 200, { ok: true, fulfillmentStatus: status });
  }

  // ── Admin: audit log for order ─────────────────────────────────────────────
  if (/^\/api\/admin\/orders\/[a-zA-Z0-9-]+\/audit$/.test(path) && method === 'GET') {
    await authUser(req, true);
    const orderId = path.split('/')[4];
    return json(res, 200, { audit: await auditLog.listForOrder(orderId) });
  }

  // ── Admin: products ────────────────────────────────────────────────────────
  if (path === '/api/admin/uploads/product-image' && method === 'POST') {
    await authUser(req, true);
    verifyCsrf(req);
    ensure(cloudinaryUploadEnabled(), 503, 'Product image uploads need Cloudinary storage configured by the store owner.');
    const { dataUrl } = await bodyJson(req, 12 * 1024 * 1024);
    const image = await uploadProductImage(dataUrl);
    return json(res, 201, { imageUrl: image.secureUrl, publicId: image.publicId });
  }

  if (path === '/api/admin/uploads/category-image' && method === 'POST') {
    await authUser(req, true);
    verifyCsrf(req);
    ensure(cloudinaryUploadEnabled(), 503, 'Category image uploads need Cloudinary storage configured by the store owner.');
    const { dataUrl } = await bodyJson(req, 12 * 1024 * 1024);
    const image = await uploadCategoryImage(dataUrl);
    return json(res, 201, { imageUrl: image.secureUrl, publicId: image.publicId });
  }

  if (path === '/api/admin/products' && method === 'GET') {
    await authUser(req, true);
    const search = cleanText(url.searchParams.get('search') || '', 100);
    const categorySlug = cleanText(url.searchParams.get('category') || '', 60);
    const requestedStatus = url.searchParams.get('status') || 'all';
    const adminStatus = ['listed', 'unavailable', 'deleted'].includes(requestedStatus) ? requestedStatus : 'all';
    const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Number.NaN;
    const rawPage = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : Number.NaN;
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 10;
    const page = Number.isSafeInteger(rawPage) ? Math.max(1, Math.min(1_000_000, rawPage)) : 1;
    const result = await products.list({ limit, page, includeInactive: true, adminStatus, search: search || undefined, categorySlug: categorySlug || undefined });
    return json(res, 200, result);
  }

  if (path === '/api/admin/products' && method === 'POST') {
    await authUser(req, true);
    verifyCsrf(req);
    const fields = await sanitizeProduct(await bodyJson(req));
    for (const image of fields.images || []) {
      if (image.publicId) ensure(await products.countImageReferences(image.publicId) === 0, 409, 'This uploaded image is already assigned to another product.');
    }
    const id   = randomUUID();
    const slug = `${slugify(fields.name)}-${id.slice(0, 6)}`;
    await products.create({
      id, slug, ...fields,
      description: fields.description || '',
      imageUrl:    fields.imageUrl    || '',
      imagePublicId: fields.imagePublicId || '',
      images: fields.images || [],
      featured:    fields.featured    || false,
      active:      true,
      createdAt:   new Date(),
      updatedAt:   new Date(),
    });
    return json(res, 201, { id, slug });
  }

  const restoreAdminProduct = path.match(/^\/api\/admin\/products\/([a-zA-Z0-9-]+)\/restore$/);
  if (restoreAdminProduct && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const id = restoreAdminProduct[1];
    const existing = await products.findById(id);
    ensure(existing, 404, 'Product not found');
    const restored = await products.restore(id);
    ensure(restored.modifiedCount === 1, 409, 'Product is not deleted or has already been restored.');
    await auditLog.record({ action: 'PRODUCT_RESTORED', adminId: admin.id, productId: id, detail: existing.name });
    return json(res, 200, { ok: true });
  }

  if (/^\/api\/admin\/products\/[a-zA-Z0-9-]+$/.test(path)) {
    const admin = await authUser(req, true);
    const id = path.split('/').pop();
    const existing = await products.findById(id);
    ensure(existing, 404, 'Product not found');
    if (method === 'DELETE') {
      verifyCsrf(req);
      const deleted = await products.softDelete(id);
      ensure(deleted.modifiedCount === 1, 409, 'Product is already deleted.');
      await auditLog.record({ action: 'PRODUCT_DELETED', adminId: admin.id, productId: id, detail: existing.name });
      return json(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      verifyCsrf(req);
      const body = await bodyJson(req);
      ensure(body.stock === undefined, 400, 'Product stock is not managed here. Use the availability toggle.');
      ensure(!(existing.deletedAt && body.active !== undefined), 409, 'Restore this product before changing availability.');
      if (typeof body.categorySlug === 'string' && slugify(cleanText(body.categorySlug, 80)) === existing.categorySlug) {
        delete body.categorySlug; // Let an existing product remain in its archived category while other fields are edited.
      }
      if (body.images === undefined && body.imageUrl !== undefined && body.imageUrl !== existing.imageUrl && body.imagePublicId === undefined) {
        body.imagePublicId = '';
      }
      if (body.imagePublicId === '' && body.imageUrl === existing.imageUrl) delete body.imagePublicId;
      const fields = await sanitizeProduct(body, true, existing);
      ensure(Object.keys(fields).length > 0, 400, 'No valid changes');
      const previousImages = productImages(existing);
      const nextImages = fields.images ?? previousImages;
      const previousIds = new Set(previousImages.map(image => image.publicId).filter(Boolean));
      const nextIds = new Set(nextImages.map(image => image.publicId).filter(Boolean));
      for (const publicId of nextIds) {
        if (!previousIds.has(publicId)) ensure(await products.countImageReferences(publicId, id) === 0, 409, 'This uploaded image is already assigned to another product.');
      }
      await products.update(id, fields);
      let imageCleanupFailed = false;
      for (const publicId of previousIds) {
        if (nextIds.has(publicId)) continue;
        try {
          const stillUsed = await products.countImageReferences(publicId, id);
          if (!stillUsed) await deleteProductImage(publicId);
          else imageCleanupFailed = true;
        } catch (error) {
          imageCleanupFailed = true;
          console.warn('[media] Previous product image cleanup failed:', error?.code || 'CLEANUP_ERROR');
        }
      }
      return json(res, 200, { ok: true, imageCleanupFailed });
    }
  }

  // ── Admin: categories ──────────────────────────────────────────────────────
  if (path === '/api/admin/categories' && method === 'GET') {
    await authUser(req, true);
    const items = await categories.list({ includeArchived: true });
    const enriched = await Promise.all(items.map(async category => ({
      ...category,
      productCount: await products.countByCategory(category.id, category.slug),
    })));
    return json(res, 200, { categories: enriched });
  }

  if (path === '/api/admin/categories' && method === 'POST') {
    await authUser(req, true);
    verifyCsrf(req);
    const body = await bodyJson(req);
    const { name: rawName } = body;
    const name = cleanText(rawName, 80);
    const slug = slugify(name);
    ensure(name.length >= 2 && slug, 400, 'Enter a valid category name');
    const existing = await categories.findBySlug(slug);
    ensure(!existing, 409, 'Category already exists');
    const id = randomUUID();
    const description = cleanText(body.description || '', 500);
    const imageUrl = cleanText(body.imageUrl || '', 1000);
    const imagePublicId = cleanText(body.imagePublicId || '', 200);
    if (imageUrl) ensure(/^https:\/\//.test(imageUrl), 400, 'Category image must be an HTTPS URL.');
    if (imagePublicId) {
      const expectedCloudPrefix = `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/`;
      const imagePath = `/iwacumall/categories/${imagePublicId.split('/').pop()}.`;
      ensure(cloudinaryUploadEnabled() && /^iwacumall\/categories\/[0-9a-f-]{36}$/i.test(imagePublicId) && imageUrl.startsWith(expectedCloudPrefix) && imageUrl.includes(imagePath), 400, 'Uploaded image ID must match its Cloudinary category image URL.');
    }
    await categories.create({ id, name, slug, description, imageUrl, imagePublicId });
    return json(res, 201, { id, name, slug, description, imageUrl, imagePublicId });
  }

  const restoreAdminCategory = path.match(/^\/api\/admin\/categories\/([a-zA-Z0-9-]+)\/restore$/);
  if (restoreAdminCategory && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const id = restoreAdminCategory[1];
    const category = await categories.findById(id);
    ensure(category, 404, 'Category not found.');
    ensure(category.active === false, 409, 'Category is already active.');
    const restored = await categories.restore(id);
    ensure(restored.modifiedCount === 1, 409, 'Category could not be restored. Refresh and try again.');
    await auditLog.record({ action: 'CATEGORY_RESTORED', adminId: admin.id, detail: category.slug });
    return json(res, 200, { ok: true });
  }

  const adminCategory = path.match(/^\/api\/admin\/categories\/([a-zA-Z0-9-]+)$/);
  if (adminCategory) {
    const admin = await authUser(req, true);
    const category = await categories.findById(adminCategory[1]);
    ensure(category, 404, 'Category not found.');
    if (method === 'PATCH') {
      verifyCsrf(req);
      ensure(category.active !== false, 409, 'Archived categories cannot be edited.');
      const body = await bodyJson(req);
      const fields = {};
      if (body.name !== undefined) {
        fields.name = cleanText(body.name, 80);
        ensure(fields.name.length >= 2, 400, 'Enter a category name with at least two characters.');
        const duplicate = await categories.findByName(fields.name);
        ensure(!duplicate || duplicate.id === category.id, 409, 'A category with that name already exists.');
      }
      if (body.description !== undefined) fields.description = cleanText(body.description, 500);
      if (body.imageUrl !== undefined || body.imagePublicId !== undefined) {
        fields.imageUrl = cleanText(body.imageUrl || '', 1000);
        fields.imagePublicId = cleanText(body.imagePublicId || '', 200);
        if (fields.imageUrl) ensure(/^https:\/\//.test(fields.imageUrl), 400, 'Category image must be an HTTPS URL.');
        if (fields.imagePublicId) {
          const expectedCloudPrefix = `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/`;
          const imagePath = `/iwacumall/categories/${fields.imagePublicId.split('/').pop()}.`;
          ensure(cloudinaryUploadEnabled() && /^iwacumall\/categories\/[0-9a-f-]{36}$/i.test(fields.imagePublicId) && fields.imageUrl.startsWith(expectedCloudPrefix) && fields.imageUrl.includes(imagePath), 400, 'Uploaded image ID must match its Cloudinary category image URL.');
        }
      }
      ensure(Object.keys(fields).length > 0, 400, 'No valid category changes were provided.');
      const previousImageId = category.imagePublicId || '';
      await categories.update(category.id, fields);
      let imageCleanupFailed = false;
      if (fields.imagePublicId !== undefined && previousImageId && fields.imagePublicId !== previousImageId) {
        try {
          if (!await categories.countImageReferences(previousImageId, category.id)) await deleteCategoryImage(previousImageId);
        } catch (error) {
          imageCleanupFailed = true;
          console.warn('[media] Previous category image cleanup failed:', error?.code || 'CLEANUP_ERROR');
        }
      }
      await auditLog.record({ action: fields.name ? 'CATEGORY_UPDATED' : 'CATEGORY_IMAGE_UPDATED', adminId: admin.id, detail: category.slug });
      return json(res, 200, { ok: true, imageCleanupFailed });
    }
    if (method === 'DELETE') {
      verifyCsrf(req);
      ensure(category.active !== false, 409, 'Category is already archived.');
      const productCount = await products.countActiveByCategory(category.id, category.slug);
      ensure(productCount === 0, 409, 'Move or hide the category’s products before archiving it.');
      await categories.archive(category.id);
      await auditLog.record({ action: 'CATEGORY_ARCHIVED', adminId: admin.id, detail: category.slug });
      return json(res, 200, { ok: true });
    }
  }

  // ── Admin: payment methods ─────────────────────────────────────────────────
  if (path === '/api/admin/mfa/setup' && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    await rateLimit(ip, `mfa-setup:${admin.id}`, 5, 15 * 60 * 1000);
    const { currentCode } = await bodyJson(req);
    if (admin.mfaEnabled) {
      ensure(typeof currentCode === 'string' && currentCode.length > 0, 400, 'Enter your current authenticator or recovery code to replace MFA');
      const activeRecord = await adminMfa.find(admin.id);
      let activeSecret = '';
      try { activeSecret = decryptTotpSecret(activeRecord?.secret); } catch {}
      const validCurrentTotp = activeSecret && verifyTotp(activeSecret, currentCode);
      const validCurrentRecovery = !validCurrentTotp && await adminMfa.consumeRecoveryCode(admin.id, hashRecoveryCode(currentCode));
      ensure(validCurrentTotp || validCurrentRecovery, 401, 'Current authenticator or recovery code is invalid');
    }
    const secret = createTotpSecret();
    const recoveryCodes = createRecoveryCodes();
    await adminMfa.savePending(admin.id, encryptTotpSecret(secret), recoveryCodes.map(hashRecoveryCode));
    return json(res, 200, {
      secret,
      recoveryCodes,
      provisioningUri: totpProvisioningUri(admin.email, secret),
    });
  }

  if (path === '/api/admin/mfa/verify' && method === 'POST') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    await rateLimit(ip, `mfa-verify:${admin.id}`, 5, 15 * 60 * 1000);
    const { code } = await bodyJson(req);
    const record = await adminMfa.find(admin.id);
    let secret = '';
    try { secret = decryptTotpSecret(record?.pendingSecret); } catch {}
    ensure(secret && verifyTotp(secret, code), 400, 'Authenticator code is invalid or setup has expired');
    ensure(await adminMfa.activate(admin.id), 409, 'MFA setup could not be confirmed; start again');
    clearSessionCookie(res);
    return json(res, 200, { ok: true, reauthenticationRequired: true });
  }

  if (path === '/api/admin/settings' && method === 'GET') {
    await authUser(req, true);
    return json(res, 200, { settings: await storeSettings.get() });
  }

  if (path === '/api/admin/settings' && method === 'PATCH') {
    const admin = await authUser(req, true);
    verifyCsrf(req);
    const b = await bodyJson(req);
    const fields = {};
    if (b.storeName !== undefined) {
      fields.storeName = cleanText(b.storeName, 100);
      ensure(fields.storeName.length >= 2, 400, 'Store name must be at least 2 characters');
    }
    if (b.storeAddress !== undefined) {
      fields.storeAddress = cleanText(b.storeAddress, 200);
      ensure(fields.storeAddress.length >= 3, 400, 'Enter the store address');
    }
    if (b.storePhone !== undefined) {
      fields.storePhone = cleanText(b.storePhone, 30);
      ensure(fields.storePhone.replace(/\D/g, '').length >= 8, 400, 'Enter a valid store phone number');
    }
    if (b.storeEmail !== undefined) {
      fields.storeEmail = cleanText(b.storeEmail, 254).toLowerCase();
      ensure(!fields.storeEmail || validEmail(fields.storeEmail), 400, 'Enter a valid store email');
    }
    for (const key of ['deliveryFeeFlat', 'taxRatePercent', 'invoiceExpiryHours']) {
      if (b[key] === undefined) continue;
      const value = Number(b[key]);
      ensure(Number.isSafeInteger(value), 400, `${key} must be a whole number`);
      if (key === 'deliveryFeeFlat') ensure(value >= 0 && value <= 100_000_000, 400, 'Delivery fee must be between 0 and 100,000,000 RWF');
      if (key === 'taxRatePercent') ensure(value >= -1 && value <= 100, 400, 'Tax must be -1 (not configured) or 0–100 percent');
      if (key === 'invoiceExpiryHours') ensure(value >= 1 && value <= 720, 400, 'Payment deadline must be 1–720 hours');
      fields[key] = value;
    }
    if (b.returnWindowDays !== undefined) {
      const value = Number(b.returnWindowDays);
      ensure(Number.isSafeInteger(value) && value >= 0 && value <= 365, 400, 'Return window must be 0–365 days (0 disables customer return requests).');
      fields.returnWindowDays = value;
    }
    ensure(Object.keys(fields).length > 0, 400, 'No valid settings were provided');
    await storeSettings.update(fields);
    await auditLog.record({ action: 'STORE_SETTINGS_UPDATED', adminId: admin.id, detail: Object.keys(fields).join(',') });
    return json(res, 200, { ok: true, settings: await storeSettings.get() });
  }

  if (path === '/api/admin/payment-methods' && method === 'GET') {
    await authUser(req, true);
    return json(res, 200, { paymentMethods: await paymentMethods.list() });
  }

  if (path === '/api/admin/payment-methods' && method === 'POST') {
    await authUser(req, true);
    verifyCsrf(req);
    const b = await bodyJson(req);
    const label        = cleanText(b.label, 100);
    const instructions = cleanText(b.instructions, 2000);
    const type         = cleanText(b.type, 50); // e.g. BANK_TRANSFER, MOBILE_MONEY
    ensure(label.length >= 2 && instructions.length >= 10, 400, 'Label and instructions are required (instructions ≥ 10 chars)');
    ensure(['BANK_TRANSFER','MOBILE_MONEY','OTHER'].includes(type), 400, 'Type must be BANK_TRANSFER, MOBILE_MONEY or OTHER');
    const id = randomUUID();
    await paymentMethods.create({
      id, label, type, instructions,
      accountName:   cleanText(b.accountName   || '', 150),
      accountNumber: cleanText(b.accountNumber || '', 100),
      enabled:       true,
      order:         Date.now(),
    });
    return json(res, 201, { id });
  }

  if (/^\/api\/admin\/payment-methods\/[a-zA-Z0-9-]+$/.test(path)) {
    await authUser(req, true);
    const id = path.split('/').pop();
    const existing = await paymentMethods.findById(id);
    ensure(existing, 404, 'Payment method not found');
    if (method === 'PATCH') {
      verifyCsrf(req);
      const b = await bodyJson(req);
      const fields = {};
      if (b.label        !== undefined) fields.label        = cleanText(b.label, 100);
      if (b.instructions !== undefined) fields.instructions = cleanText(b.instructions, 2000);
      if (b.accountName  !== undefined) fields.accountName  = cleanText(b.accountName, 150);
      if (b.accountNumber!== undefined) fields.accountNumber= cleanText(b.accountNumber, 100);
      if (b.enabled      !== undefined) fields.enabled       = !!b.enabled;
      ensure(Object.keys(fields).length > 0, 400, 'No valid changes');
      if (fields.label !== undefined) ensure(fields.label.length >= 2, 400, 'Label must be at least 2 characters');
      if (fields.instructions !== undefined) ensure(fields.instructions.length >= 10, 400, 'Instructions must be at least 10 characters');
      if (b.enabled !== undefined) {
        ensure(typeof b.enabled === 'boolean', 400, 'enabled must be true or false');
        fields.enabled = b.enabled;
      }
      await paymentMethods.update(id, fields);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      verifyCsrf(req);
      await paymentMethods.delete(id);
      return json(res, 200, { ok: true });
    }
  }

  fail(404, 'API endpoint not found');
}

// ─── Static file server ───────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function sendNotFound(req, res, publicDir) {
  const page = await readFile(resolve(publicDir, '404.html'));
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(page);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'Invalid path' }); }

  if (urlPath.startsWith('/products/')) {
    const slug = urlPath.slice('/products/'.length);
    if (!slug || slug.includes('/')) return sendNotFound(req, res, publicDir);
    const product = await products.findBySlug(slug) || await products.findById(slug);
    if (!product || !product.active) return sendNotFound(req, res, publicDir);
    const baseUrl = config.appBaseUrl || `${config.isProduction ? 'https' : 'http'}://${req.headers.host || 'localhost:4000'}`;
    const canonical = `${baseUrl.replace(/\/+$/, '')}/products/${encodeURIComponent(product.slug || product.id)}`;
    const image = product.imageUrl || '/assets/products/fallback.png';
    const imageUrl = /^https:\/\//i.test(image) ? image : new URL(image, baseUrl).href;
    const description = product.description || `${product.name} is available at IwacuMall in Kigali.`;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      description,
      image: imageUrl,
      sku: product.id,
      category: product.category || product.categorySlug || 'Everyday Essentials',
      brand: { '@type': 'Brand', name: 'IwacuMall' },
      offers: variants.length ? {
        '@type': 'AggregateOffer',
        priceCurrency: config.currency,
        lowPrice: Math.min(...variants.map(variant => Number(variant.price))),
        highPrice: Math.max(...variants.map(variant => Number(variant.price))),
        offerCount: variants.length,
        offers: variants.map(variant => ({
          '@type': 'Offer',
          name: `${variant.type}: ${variant.value}`,
          priceCurrency: config.currency,
          price: variant.price,
          availability: product.trackInventory === true && product.stock <= 0 ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
          itemCondition: product.isSecondHand === true ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
          url: canonical,
        })),
      } : {
        '@type': 'Offer',
        priceCurrency: config.currency,
        price: product.price,
        availability: product.trackInventory === true && product.stock <= 0 ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
        itemCondition: product.isSecondHand === true ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
        url: canonical,
      },
    };
    const template = await readFile(resolve(publicDir, 'product.html'), 'utf8');
    const replacements = {
      __PRODUCT_NAME__: escapeHtml(product.name),
      __PRODUCT_DESCRIPTION__: escapeHtml(description),
      __PRODUCT_CANONICAL__: escapeHtml(canonical),
      __PRODUCT_IMAGE__: escapeHtml(imageUrl),
      __PRODUCT_CATEGORY__: escapeHtml(product.category || product.categorySlug || 'Everyday Essentials'),
      __PRODUCT_CONDITION_BADGE__: product.isSecondHand === true ? 'Pre-owned · previously owned' : '',
      __PRODUCT_PRICE__: Number(product.price || 0).toLocaleString('en-US'),
      __PRODUCT_STOCK_CLASS__: product.trackInventory === true && product.stock <= 0 ? 'stock-out' : 'stock-in',
      __PRODUCT_STOCK__: product.trackInventory === true ? product.stock > 0 ? `In stock (${product.stock} available)` : 'Out of stock' : 'Available',
      __PRODUCT_SCHEMA__: JSON.stringify(schema).replace(/</g, '\\u003c'),
    };
    const html = template.replace(/__PRODUCT_[A-Z_]+__/g, token => replacements[token] ?? '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(html);
  }

  // ── SEO Discovery Routes (Finding #11) ──────────────────────────────────────
  if (urlPath === '/robots.txt') {
    const robots = generateRobotsTxt(req);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(robots);
  }

  if (urlPath === '/sitemap.xml') {
    try {
      const sitemap = await generateSitemapXml(req);
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(sitemap);
    } catch (err) {
      console.warn('[seo] Sitemap generation failed:', err?.message);
    }
  }

  if (urlPath === '/' || urlPath === '/shop')      urlPath = '/index.html';
  if (urlPath === '/admin')                        urlPath = '/admin.html';
  if (urlPath === '/orders')                       urlPath = '/orders.html';
  if (urlPath === '/invoice')                      urlPath = '/invoice.html';
  if (urlPath === '/account')                      urlPath = '/account.html';
  if (urlPath === '/reset-password')               urlPath = '/reset-password.html';
  if (urlPath === '/privacy')                      urlPath = '/privacy.html';
  if (urlPath === '/terms')                        urlPath = '/terms.html';
  if (urlPath === '/delivery-policy')              urlPath = '/delivery-policy.html';
  if (urlPath.startsWith('/categories/'))          urlPath = '/index.html';

  const target = resolve(publicDir, `.${urlPath}`);
  if (target !== publicDir && !target.startsWith(publicDir + sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Not a file');
    const contents = await readFile(target);
    const isHtml = target.endsWith('.html');
    const noIndex = ['/admin', '/admin.html', '/orders', '/orders.html', '/invoice', '/invoice.html', '/reset-password', '/reset-password.html'].includes(url.pathname);
    res.writeHead(200, {
      'Content-Type'          : mime[extname(target)] || 'application/octet-stream',
      'Cache-Control'         : isHtml ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options'       : 'DENY',
      'Referrer-Policy'       : 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      'Permissions-Policy'    : 'camera=(), microphone=(), geolocation=()',
      ...(noIndex ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    res.end(contents);
  } catch {
    // Serve clean 404 page for missing pages
    try {
      const notFoundPage = await readFile(resolve(publicDir, '404.html'));
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(notFoundPage);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export const server = http.createServer(async (req, res) => {
  try {
    const url    = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const origin = req.headers.origin;

    // CORS
    const trustedOrigin = !origin ||
      config.corsOrigins.includes(origin) ||
      new URL(origin).host === req.headers.host;
    if (origin && !trustedOrigin && url.pathname.startsWith('/api')) {
      return json(res, 403, { error: 'Origin not allowed' });
    }
    if (origin && trustedOrigin) {
      res.setHeader('Access-Control-Allow-Origin',  origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    const status = Number(e?.status) || 500;
    if (status === 500) console.error('[server]', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Unexpected server error' : e.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

if (!config.isTest) {
  try {
    await connectDb();
    await seed();
  } catch (err) {
    console.error('[startup] Fatal:', err.message);
    process.exit(1);
  }

  const sweepExpiredInvoices = async () => {
    try {
      const count = await orders.expireOverdueOrders();
      if (count) console.info(`[orders] Expired ${count} overdue invoice(s) and restored reserved stock.`);
    } catch (err) {
      console.warn('[orders] Invoice expiry sweep failed:', err?.message || 'unknown');
    }
  };
  await sweepExpiredInvoices();
  const invoiceExpiryTimer = setInterval(() => { void sweepExpiredInvoices(); }, 60_000);
  invoiceExpiryTimer.unref();
  const emailOutboxTimer = startEmailOutboxWorker();

  server.listen(PORT, HOST, () => {
    console.log(`IwacuMall running on http://${HOST}:${PORT} [${config.nodeEnv}]`);
  });

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`[server] ${signal} — shutting down`);
    clearInterval(invoiceExpiryTimer);
    clearInterval(emailOutboxTimer);
    server.close(async () => { await closeDb(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
