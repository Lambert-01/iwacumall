// web/dashboard.js — IwacuMall admin dashboard (cookie-based auth edition)
const $ = (selector) => document.querySelector(selector);
const fmt = (value) => `RWF ${Number(value || 0).toLocaleString('en-US')}`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page = document.body.dataset.page;
let adminMfaEnabled = false;

function getCSRFToken() {
  const m = document.cookie.match(/(?:^|;\s*)iwm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function formatDate(value) {
  const source = String(value || '');
  const normalized = source.includes('T') ? source : `${source.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? source : date.toLocaleString('en-GB', {dateStyle:'medium',timeStyle:'short'});
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': getCSRFToken(),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data.error || 'Request failed';
    console.error(`[admin API] ${options.method || 'GET'} ${path} returned HTTP ${response.status}: ${message}`);
    throw Error(message);
  }
  return data;
}

function notify(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => element.classList.remove('show'), 3000);
}
function errorBox(error) { return `<div class="empty-state">${esc(error.message || error)}</div>`; }
function categoryIcon(slug) {
  return ({groceries:'🛒',electronics:'🎧','home-living':'🛋️',fashion:'👟','beauty-care':'🧴','fresh-produce':'🥑'})[slug] || '✦';
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  const {stats} = await api('/admin/stats');
  const metrics = [
    ['Active products', stats.products, '▦'],
    ['Customers',       stats.customers, '♙'],
    ['Open orders',     stats.openOrders, '▤'],
    ['Paid revenue',    fmt(stats.revenue), 'RWF'],
  ];
  $('#statGrid').innerHTML = metrics.map(([label,value,icon]) =>
    `<div class="stat-card"><span>${esc(icon)} &nbsp; ${esc(label)}</span><strong>${esc(value)}</strong></div>`
  ).join('');
}

// ─── Orders ───────────────────────────────────────────────────────────────────

let adminOrders = [];
let adminOrdersHasMore = false;
let adminOrdersLoading = false;
let adminOrdersQueuedPage = null;
let adminOrdersOpenCount = 0;
let adminOrdersPage = 1;
let adminOrdersTotal = 0;
const adminOrdersPageSize = 10;
let adminOrderDetailId = '';

const fulfillmentNext = {
  PLACED:['CONFIRMED'], CONFIRMED:['PACKING'],
  PACKING:['OUT_FOR_DELIVERY'], OUT_FOR_DELIVERY:['DELIVERED'],
  DELIVERED:[], CANCELLED:[],
};

function renderAdminOrderDetail(order) {
  const fStatus = order.fulfillmentStatus || order.status || 'PLACED';
  const pStatus = order.paymentStatus || 'PENDING';
  const refundTotal = Number(order.refundedAmount || 0);
  const refundRemaining = Math.max(0, Number(order.total || 0) - refundTotal);
  const transitions = fulfillmentNext[fStatus] || [];
  const orderItems = (order.items || []).map(item => `${esc(item.productName || item.product_name)} × ${Number(item.quantity)}`).join(' · ');
  const itemCount = (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const snap = order.paymentMethodSnapshot || {};
  const methodLabel = snap.label || order.paymentMethodLabel || 'Unknown';
  const isArchived = Boolean(order.adminArchivedAt);
  const paymentControls = isArchived ? '' : pStatus === 'PENDING' ? `
    <details class="confirm-payment-details">
      <summary>Confirm payment received</summary>
      <form class="confirm-payment-form" data-order-id="${esc(order.id)}">
        <label>Payment reference<input class="form-control" name="paymentRef" placeholder="Reference from the payment proof" required minlength="2"></label>
        <input class="form-control" name="note" placeholder="Optional internal note">
        <button class="action-btn" type="submit">Confirm payment received</button>
      </form>
    </details>` : (pStatus === 'PAID' ? `<div class="order-payment-success">✓ Payment confirmed</div>${refundTotal ? `<div class="order-refund-note">Refunded ${fmt(refundTotal)} · ${esc(order.refundStatus || 'PARTIAL')}</div>` : ''}` : `<div class="order-payment-muted">Payment: ${esc(pStatus)}</div>`);
  const refundControls = !isArchived && pStatus === 'PAID' && refundRemaining > 0
    ? `<button class="action-btn danger-btn" data-refund-order="${esc(order.id)}" data-refund-remaining="${refundRemaining}">Record refund · up to ${fmt(refundRemaining)}</button>` : '';
  const nextAction = isArchived
    ? `<button class="action-btn" data-restore-order="${esc(order.id)}">Restore order</button>`
    : fStatus === 'PLACED'
      ? `<button class="action-btn order-primary-action" data-confirm-order="${esc(order.id)}">✓ Confirm order</button><small class="order-confirm-separation">Payment is confirmed separately.</small>`
      : pStatus !== 'PAID' && fStatus !== 'CANCELLED'
        ? `<div class="order-action-hint">Confirm payment before packing and delivery can continue.</div>`
        : (transitions.length ? `<div class="admin-order-controls"><select class="form-control" data-order-select="${esc(order.id)}" aria-label="Next status">${transitions.map(next => `<option value="${next}">${next.replaceAll('_',' ')}</option>`).join('')}</select><button class="action-btn" data-update-status="${esc(order.id)}">Update status</button></div>` : '');
  const cancelBtn = !isArchived && !['CANCELLED','DELIVERED'].includes(fStatus) && pStatus !== 'PAID'
    ? `<button class="action-btn danger-btn" data-cancel-order="${esc(order.id)}">✕ Cancel order</button>` : '';
  const archiveAction = !isArchived ? `<button class="action-btn danger-btn" data-archive-order="${esc(order.id)}">Delete from order list</button>` : '';
  const returnRequests = (order.returnRequests || []).map(request => {
    const items = (request.items || []).map(item => `<li>${esc(item.productName)} × ${Number(item.quantity)}${request.status === 'RECEIVED' ? ` · received ${Number(item.returnedQuantity || 0)}` : ''}</li>`).join('');
    const review = request.status === 'REQUESTED' ? `<div class="admin-return-actions"><form class="return-review-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}" data-decision="APPROVED"><textarea class="form-control" name="reviewNote" maxlength="300" placeholder="Optional customer-facing note"></textarea><button class="action-btn" type="submit">Approve return</button></form><form class="return-review-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}" data-decision="REJECTED"><textarea class="form-control" name="reviewNote" maxlength="300" placeholder="Explain why you cannot accept this return" required minlength="5"></textarea><button class="action-btn danger-btn" type="submit">Reject return</button></form></div>` : '';
    const receive = request.status === 'APPROVED' ? `<form class="return-receive-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}"><strong>Inspect returned goods</strong>${(request.items || []).map(item => `<div class="return-receive-item"><span>${esc(item.productName)} · approved ${Number(item.quantity)}</span><label>Received<input class="form-control" type="number" data-return-received="${esc(item.productId)}" min="0" max="${Number(item.quantity)}" value="0" required></label></div>`).join('')}<textarea class="form-control" name="note" maxlength="300" placeholder="Inspection note (optional)"></textarea><button class="action-btn" type="submit">Mark inspection complete</button></form>` : '';
    return `<section class="admin-return-request"><strong>Return ${esc(String(request.status || 'REQUESTED').replaceAll('_',' '))}</strong><small>${esc(formatDate(request.requestedAt))} · ${esc(request.reason)}</small><ul>${items}</ul>${request.reviewNote ? `<p>${esc(request.reviewNote)}</p>` : ''}${review}${receive}</section>`;
  }).join('');
  return `<article class="admin-order-card">
    <div class="admin-order-head"><div><div class="admin-order-id">${esc(order.invoiceNumber || order.id.slice(0,8).toUpperCase())}<span class="pill ${esc(fStatus)}">${esc(fStatus.replaceAll('_',' '))}</span><span class="pill payment-pill ${esc(pStatus)}">${esc(pStatus)}</span></div><div class="admin-order-time">${esc(formatDate(order.createdAt || order.created_at))}</div></div><div><div class="admin-order-customer">${esc(order.customerName || order.customer_name)}</div><div class="admin-order-contact"><a href="tel:${esc(order.phone)}">${esc(order.phone)}</a> · ${esc(order.city)}<br>${esc(order.address)}</div></div><div class="admin-order-total">${fmt(order.total)}</div></div>
    <div class="admin-order-detail-grid"><section><h3>Items <span>${itemCount}</span></h3><p class="admin-order-items">${orderItems || 'No items'}</p><p class="admin-order-method">Payment method · <strong>${esc(methodLabel)}</strong></p>${returnRequests ? `<div class="admin-return-list">${returnRequests}</div>` : ''}</section><section class="admin-order-detail-actions">${isArchived ? '<div class="archived-order-note">Hidden from the active queue. Invoice and history are retained.</div>' : paymentControls}${refundControls}${nextAction}${cancelBtn}<a class="action-btn" href="/invoice?order=${esc(order.id)}" target="_blank">🖨 View invoice</a><a class="action-btn" href="/api/orders/${esc(order.id)}/invoice.pdf" target="_blank">📥 Download PDF</a><button class="action-btn" data-view-audit="${esc(order.id)}">📋 Audit log</button>${archiveAction}</section></div>
  </article>`;
}

function renderAdminOrders() {
  const count = $('#sidebarOrderCount');
  if (count) count.textContent = adminOrdersOpenCount || '';
  const first = adminOrdersTotal ? (adminOrdersPage - 1) * adminOrdersPageSize + 1 : 0;
  const last = Math.min(adminOrdersPage * adminOrdersPageSize, adminOrdersTotal);
  const countText = `${first}–${last} of ${adminOrdersTotal} order${adminOrdersTotal === 1 ? '' : 's'}`;
  if ($('#adminOrderCount')) $('#adminOrderCount').textContent = countText;
  if ($('#adminOrdersPageInfo')) $('#adminOrdersPageInfo').textContent = `Page ${adminOrdersPage} of ${Math.ceil(adminOrdersTotal / adminOrdersPageSize) || 1}`;
  if ($('#previousAdminOrders')) $('#previousAdminOrders').disabled = adminOrdersLoading || adminOrdersPage <= 1;
  if ($('#nextAdminOrders')) $('#nextAdminOrders').disabled = adminOrdersLoading || last >= adminOrdersTotal;
  const host = $('#adminOrders');
  if (!adminOrders.length) {
    host.innerHTML = `<div class="empty-state">${adminOrdersTotal ? 'No orders match those filters.' : 'No orders yet.'}</div>`;
  } else {
    host.innerHTML = adminOrders.map(order => {
      const fStatus = order.fulfillmentStatus || order.status || 'PLACED';
      const pStatus = order.paymentStatus || 'PENDING';
      const itemCount = (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const preview = (order.items || []).slice(0, 2).map(item => `${esc(item.productName || item.product_name)} × ${Number(item.quantity)}`).join(' · ');
      return `<article class="admin-order-row"><div class="admin-order-row-main"><div class="admin-order-row-ref"><strong>${esc(order.invoiceNumber || order.id.slice(0,8).toUpperCase())}</strong><small>${esc(formatDate(order.createdAt || order.created_at))}</small></div><div class="admin-order-row-customer"><strong>${esc(order.customerName || order.customer_name)}</strong><small>${esc(order.phone || '')} · ${esc(order.city || '')}</small></div><div class="admin-order-row-status"><span class="pill ${esc(fStatus)}">${esc(fStatus.replaceAll('_',' '))}</span><span class="pill payment-pill ${esc(pStatus)}">${esc(pStatus)}</span></div><div class="admin-order-row-total">${fmt(order.total)}<small>${itemCount} item${itemCount === 1 ? '' : 's'}</small></div><button class="action-btn admin-order-view" type="button" data-view-order="${esc(order.id)}">View details <span aria-hidden="true">↗</span></button></div><p class="admin-order-row-items">${preview || 'No items'}${(order.items || []).length > 2 ? ' · and more' : ''}</p></article>`;
    }).join('');
  }
  const dialog = $('#adminOrderDetailDialog');
  if (dialog?.open && adminOrderDetailId) {
    const selected = adminOrders.find(order => order.id === adminOrderDetailId);
    if (selected) {
      $('#adminOrderDialogTitle').textContent = `Order ${selected.invoiceNumber || selected.id.slice(0,8).toUpperCase()}`;
      $('#adminOrderDetailContent').innerHTML = renderAdminOrderDetail(selected);
    } else {
      dialog.close();
      adminOrderDetailId = '';
    }
  }
}

async function loadAdminOrders(requestedPage = 1) {
  if (adminOrdersLoading) {
    adminOrdersQueuedPage = requestedPage;
    return;
  }
  const page = Math.max(1, Number(requestedPage) || 1);
  const params = new URLSearchParams({ limit:String(adminOrdersPageSize), skip:String((page - 1) * adminOrdersPageSize) });
  const status = $('#orderStatusFilter')?.value || 'all';
  const paymentStatus = $('#orderPaymentFilter')?.value || 'all';
  const includeArchived = $('#orderVisibilityFilter')?.value === 'deleted';
  const search = ($('#orderSearch')?.value || '').trim();
  if (status !== 'all') params.set('status', status);
  if (paymentStatus !== 'all') params.set('paymentStatus', paymentStatus);
  if (includeArchived) params.set('includeArchived', 'true');
  if (search) params.set('search', search);
  adminOrdersLoading = true;
  if ($('#previousAdminOrders')) $('#previousAdminOrders').disabled = true;
  if ($('#nextAdminOrders')) $('#nextAdminOrders').disabled = true;
  try {
    const result = await api(`/admin/orders?${params}`);
    if (page > result.totalPages && result.total > 0) {
      adminOrdersQueuedPage = result.totalPages;
      return;
    }
    adminOrders = result.orders || [];
    adminOrdersPage = result.page || page;
    adminOrdersTotal = Number(result.total || 0);
    adminOrdersHasMore = result.hasMore === true;
    adminOrdersOpenCount = Number(result.openCount || 0);
    renderAdminOrders();
  } finally {
    adminOrdersLoading = false;
    const queuedPage = adminOrdersQueuedPage;
    adminOrdersQueuedPage = null;
    if (queuedPage !== null) {
      void loadAdminOrders(queuedPage).catch(error => notify(error.message));
    } else {
      renderAdminOrders();
    }
  }
}

async function loadEmailOutbox() {
  const container = $('#emailOutboxJobs');
  if (!container) return;
  const { jobs } = await api('/admin/email-outbox');
  container.innerHTML = jobs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Order / event</th><th>Recipient</th><th>Delivery</th><th>Attempts</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${jobs.flatMap(job => (job.recipients || []).map(recipient => {
    const isAuthEmail = job.eventType?.startsWith('AUTH_');
    const authLinkExpired = isAuthEmail && Date.parse(job.tokenExpiresAt) <= Date.now();
    return `<tr><td>${esc(job.eventSnapshot?.invoiceNumber || job.orderId || job.id)}<small>${esc(job.eventType || 'ORDER_INVOICE')}</small></td><td>${esc(recipient.kind)} · ${esc(recipient.email)}</td><td><span class="pill ${esc(recipient.status)}">${esc(recipient.status)}</span>${recipient.lastError ? `<small class="out-stock">${esc(recipient.lastError)}</small>` : ''}</td><td>${Number(recipient.attempts || 0)}</td><td>${esc(formatDate(recipient.sentAt || job.updatedAt || job.createdAt))}</td><td>${recipient.status === 'FAILED' && !authLinkExpired ? `<button class="action-btn" data-retry-email="${esc(job.id)}">Retry failed</button>` : ''}${job.status === 'SENT' && !isAuthEmail ? ` <button class="action-btn" data-resend-email="${esc(job.id)}">Resend</button>` : ''}</td></tr>`;
  })).join('')}</tbody></table></div>` : '<div class="empty-state">No email jobs yet.</div>';
}

// ─── Products ─────────────────────────────────────────────────────────────────

let adminProducts = [];
let adminCategories = [];
let adminProductPage = 1;
let adminProductTotal = 0;
let adminProductTotalPages = 1;
let adminProductRequestId = 0;
let adminCategoryPage = 1;
const adminProductPageSize = 10;
const adminCategoryPageSize = 10;
let productImageUploadsEnabled = false;
let productImageUploadPromise = Promise.resolve();
let categoryImageUploadPromise = Promise.resolve();

function adminImageGallery(product) {
  if (Array.isArray(product?.images)) {
    const gallery = product.images.filter(image => image && typeof image.url === 'string' && image.url)
      .map(image => ({ url: image.url, publicId: typeof image.publicId === 'string' ? image.publicId : '' }));
    if (gallery.length) return gallery;
  }
  return product?.imageUrl ? [{ url: product.imageUrl, publicId: product.imagePublicId || '' }] : [];
}

function renderProducts() {
  const products = adminProducts;
  const count = $('#productCount');
  if (count) count.textContent = `${adminProductTotal} ${adminProductTotal===1?'product':'products'} · page ${adminProductPage} of ${adminProductTotalPages}`;
  if ($('#adminProductsPageInfo')) $('#adminProductsPageInfo').textContent = `Page ${adminProductPage} of ${adminProductTotalPages}`;
  if ($('#previousAdminProducts')) $('#previousAdminProducts').disabled = adminProductPage <= 1;
  if ($('#nextAdminProducts')) $('#nextAdminProducts').disabled = adminProductPage >= adminProductTotalPages;
  if ($('#adminProductsPagination')) $('#adminProductsPagination').hidden = adminProductTotalPages <= 1;
  const tbody = $('#adminProducts');
  if (!products.length) { tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">${adminProductTotal ? 'No products on this page.' : 'No products match these filters.'}</div></td></tr>`; return; }
  tbody.innerHTML = products.map(product => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variantSummary = variants.length
      ? `<small class="admin-table-subtext">${variants.length} option${variants.length === 1 ? '' : 's'} · ${esc(variants.slice(0, 3).map(variant => variant.value).join(', '))}${variants.length > 3 ? '…' : ''}</small>`
      : '';
    const isDeleted = Boolean(product.deletedAt);
    const isAvailable = product.active !== false;
    const available = isDeleted ? '<span class="admin-status-pill is-inactive">Deleted</span>' : `<button type="button" class="admin-availability ${isAvailable ? 'is-available' : 'is-unavailable'}" data-toggle-product="${esc(product.id)}" data-active="${isAvailable ? '1' : '0'}" aria-label="Mark ${esc(product.name)} ${isAvailable ? 'unavailable' : 'available'}" aria-pressed="${isAvailable}">${isAvailable ? 'Available' : 'Unavailable'}</button>`;
    const photo = product.imageUrl ? `<img class="admin-table-photo" src="${esc(product.imageUrl)}" alt="${esc(product.name)}" loading="lazy" onerror="this.src='/assets/products/fallback.png'">` : '<span class="admin-table-photo-placeholder">✦</span>';
    return `<tr>
      <td><strong class="admin-table-primary">${esc(product.name)}</strong>${product.isSecondHand === true ? '<span class="condition-badge admin-condition-badge">Pre-owned</span>' : ''}${variantSummary}</td>
      <td><span class="admin-table-description" title="${esc(product.description||'')}">${esc(product.description||'—')}</span></td>
      <td>${esc(product.category||product.categorySlug||'Uncategorized')}</td>
      <td class="admin-table-price">${fmt(product.price)}</td>
      <td>${photo}</td>
      <td>${available}</td>
      <td class="admin-table-date">${esc(formatDate(product.createdAt||product.created_at))}</td>
      <td><span class="admin-status-pill ${isDeleted || product.active===false?'is-inactive':'is-active'}">${isDeleted?'Deleted':product.active===false?'Unavailable':'Listed'}</span></td>
      <td><div class="admin-table-actions">${isDeleted ? `<button class="action-btn" data-restore-product="${esc(product.id)}">Restore</button>` : `<button class="action-btn" data-edit-product="${esc(product.id)}">Edit</button><button class="action-btn danger-btn" data-hide-product="${esc(product.id)}">Delete</button>`}</div></td>
    </tr>`;
  }).join('');
}

async function loadProducts(requestedPage = adminProductPage) {
  const requestId = ++adminProductRequestId;
  const page = Math.max(1, Number(requestedPage) || 1);
  const params = new URLSearchParams({ limit:String(adminProductPageSize), page:String(page) });
  const search = ($('#productSearch')?.value || '').trim();
  const categorySlug = $('#productCategoryFilter')?.value || 'all';
  const status = $('#productStatusFilter')?.value || 'all';
  if (search) params.set('search', search);
  if (categorySlug !== 'all') params.set('category', categorySlug);
  if (status !== 'all') params.set('status', status);
  const [{products, total, totalPages, page: resultPage}, {categories}] = await Promise.all([api(`/admin/products?${params}`), api('/admin/categories')]);
  if (requestId !== adminProductRequestId) return;
  if (page > totalPages) return loadProducts(totalPages || 1);
  adminProducts = products;
  adminProductPage = resultPage || page;
  adminProductTotal = Number(total || 0);
  adminProductTotalPages = Number(totalPages || 1);
  adminCategories = categories;
  const select = $('#adminCategorySelect');
  if (select) select.innerHTML = categories.filter(c => c.active !== false).map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
  const filter = $('#productCategoryFilter');
  if (filter) {
    filter.innerHTML = `<option value="all">All categories</option>${categories.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}${c.active === false ? ' · deleted' : ''}</option>`).join('')}`;
    filter.value = categorySlug;
  }
  renderProducts();
}

async function uploadProductPhoto(fileList, productId = '') {
  const row = productId ? document.querySelector(`[data-product-row="${CSS.escape(productId)}"]`) : null;
  const status = row?.querySelector('[data-product-image-status]') || $('#productImageUploadStatus');
  const preview = row?.querySelector(`[data-product-preview="${CSS.escape(productId)}"]`) || $('#productImagePreview');
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (files.length > 8) {
    status.textContent = 'Choose up to 8 photos at a time.';
    return;
  }
  if (files.some(file => !['image/png','image/jpeg','image/webp'].includes(file.type))) {
    status.textContent = 'Choose PNG, JPG or WebP photos.';
    return;
  }
  if (files.some(file => file.size > 8 * 1024 * 1024)) {
    status.textContent = 'Each photo must be smaller than 8 MB.';
    return;
  }
  status.textContent = `Uploading ${files.length} ${files.length === 1 ? 'photo' : 'photos'}…`;
  const uploaded = [];
  const errors = [];
  for (const file of files) {
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
      });
      const result = await api('/admin/uploads/product-image', {method:'POST', body:JSON.stringify({dataUrl})});
      uploaded.push({ url: result.imageUrl, publicId: result.publicId });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!uploaded.length) {
    status.textContent = errors[0] || 'No photos were uploaded.';
    return;
  }
  const urlInput = row?.querySelector('[data-field="imageUrl"]') || $('#productImageUrl');
  const publicIdInput = row?.querySelector('[data-field="imagePublicId"]') || $('#productImagePublicId');
  const imagesInput = row?.querySelector('[data-field="images"]') || $('#productImages');
  urlInput.value = uploaded[0].url;
  publicIdInput.value = uploaded[0].publicId;
  imagesInput.value = JSON.stringify(uploaded);
  if (row) row.dataset.pendingImageUrl = uploaded[0].url;
  else $('#productImageUrl').dataset.pendingImageUrl = uploaded[0].url;
  preview.src = uploaded[0].url;
  preview.hidden = false;
  status.textContent = errors.length
    ? `${uploaded.length} photo(s) uploaded; ${errors.length} failed. Saving will use the uploaded photos. ${errors[0]}`
    : `${uploaded.length} ${uploaded.length === 1 ? 'photo' : 'photos'} uploaded and ready to save.`;
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'productImageFile') {
    const input = event.target;
    const upload = uploadProductPhoto(input.files);
    input.value = '';
    input.disabled = true;
    productImageUploadPromise = upload.catch(error => {
      $('#productImageUploadStatus').textContent = error.message;
    }).finally(() => { input.disabled = !productImageUploadsEnabled; });
  }
  if (event.target.matches('[data-product-image-file]')) {
    const id = event.target.dataset.productImageFile;
    const upload = uploadProductPhoto(event.target.files, id);
    event.target.value = '';
    void upload.catch(error => {
      const row = document.querySelector(`[data-product-row="${CSS.escape(id)}"]`);
      if (row) notify(error.message);
    });
  }
});

async function uploadCategoryPhoto(file) {
  const status = $('#categoryImageUploadStatus');
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose an image smaller than 8 MB.');
  status.textContent = 'Uploading photo to Cloudinary…';
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  const result = await api('/admin/uploads/category-image', {method:'POST', body:JSON.stringify({dataUrl})});
  $('#categoryImageUrl').value = result.imageUrl;
  $('#categoryImagePublicId').value = result.publicId;
  const preview = $('#categoryImagePreview');
  preview.src = result.imageUrl;
  preview.hidden = false;
  status.textContent = 'Photo uploaded and ready to save.';
}

function openProductEditor(productId = '') {
  const form = $('#createProduct');
  const dialog = $('#productEditorDialog');
  const product = adminProducts.find(item => item.id === productId);
  form.reset();
  form.elements.namedItem('productId').value = product?.id || '';
  form.elements.namedItem('name').value = product?.name || '';
  form.elements.namedItem('description').value = product?.description || '';
  form.elements.namedItem('price').value = product ? Number(product.price) : '';
  form.elements.namedItem('categorySlug').value = product?.categorySlug || adminCategories.find(category => category.active !== false)?.slug || '';
  form.elements.namedItem('featured').checked = product?.featured === true;
  form.elements.namedItem('isSecondHand').checked = product?.isSecondHand === true;
  renderProductVariantRows(product?.variants || []);
  const gallery = product ? adminImageGallery(product) : [];
  $('#productImageUrl').value = gallery[0]?.url || '';
  $('#productImagePublicId').value = gallery[0]?.publicId || '';
  $('#productImages').value = JSON.stringify(gallery);
  const preview = $('#productImagePreview');
  preview.src = gallery[0]?.url || '';
  preview.hidden = !gallery[0]?.url;
  $('#productImageUploadStatus').textContent = gallery.length ? `${gallery.length} saved photo${gallery.length === 1 ? '' : 's'} · choose files to replace` : '';
  $('#productDialogTitle').textContent = product ? 'Edit product' : 'Add product';
  $('#productDialogDescription').textContent = product ? 'Update the catalog details and product photos.' : 'Add the details shoppers will see in the store.';
  $('#saveProductButton').innerHTML = product ? 'Save changes <span>→</span>' : 'Add to catalog <span>→</span>';
  $('#productImageFile').value = '';
  productImageUploadPromise = Promise.resolve();
  dialog.showModal();
}

function newVariantId() {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : `variant_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function renderProductVariantRows(variants = []) {
  const host = $('#productVariantRows');
  host.innerHTML = (Array.isArray(variants) ? variants : []).map(variant => `
    <div class="product-variant-row" data-product-variant-row data-variant-id="${esc(variant.id || newVariantId())}">
      <label>Option type<input class="form-control" data-variant-type value="${esc(variant.type || '')}" placeholder="Size, flavour, colour…" maxlength="50" required></label>
      <label>Option name<input class="form-control" data-variant-value value="${esc(variant.value || '')}" placeholder="Large, Vanilla, Blue…" maxlength="100" required></label>
      <label>Price (RWF)<input class="form-control" data-variant-price type="number" min="0" max="100000000" step="1" value="${variant.price !== '' && variant.price !== null && Number.isSafeInteger(Number(variant.price)) ? Number(variant.price) : ''}" required></label>
      <button class="product-variant-remove" type="button" data-remove-product-variant aria-label="Remove option">×</button>
    </div>`).join('');
  syncProductVariantRows();
}

function syncProductVariantRows() {
  const rows = [...document.querySelectorAll('[data-product-variant-row]')];
  const variants = rows.map(row => ({
    id: row.dataset.variantId,
    type: row.querySelector('[data-variant-type]').value.trim(),
    value: row.querySelector('[data-variant-value]').value.trim(),
    price: row.querySelector('[data-variant-price]').value === '' ? '' : Number(row.querySelector('[data-variant-price]').value),
  }));
  $('#productVariants').value = JSON.stringify(variants);
  const basePrice = $('#productBasePrice');
  const label = $('#productBasePriceLabel');
  basePrice.readOnly = variants.length > 0;
  label.firstChild.textContent = variants.length ? 'Starting price (RWF)' : 'Price (RWF)';
  const validPrices = variants.map(variant => variant.price).filter(Number.isSafeInteger);
  if (variants.length && validPrices.length === variants.length) basePrice.value = Math.min(...validPrices);
  if (!variants.length) $('#productVariants').value = '[]';
}

$('#addProductVariant')?.addEventListener('click', () => {
  const existing = JSON.parse($('#productVariants').value || '[]');
  existing.push({ id: newVariantId(), type: '', value: '', price: $('#productBasePrice').value });
  renderProductVariantRows(existing);
  document.querySelector('[data-product-variant-row]:last-child [data-variant-type]')?.focus();
});

$('#productVariantRows')?.addEventListener('input', syncProductVariantRows);
$('#productVariantRows')?.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-product-variant]');
  if (!remove) return;
  remove.closest('[data-product-variant-row]')?.remove();
  syncProductVariantRows();
});

function openCategoryEditor(categoryId = '') {
  const form = $('#createCategory');
  const dialog = $('#categoryEditorDialog');
  const category = adminCategories.find(item => item.id === categoryId);
  form.reset();
  form.elements.namedItem('categoryId').value = category?.id || '';
  form.elements.namedItem('name').value = category?.name || '';
  form.elements.namedItem('description').value = category?.description || '';
  $('#categoryImageUrl').value = category?.imageUrl || '';
  $('#categoryImagePublicId').value = category?.imagePublicId || '';
  const preview = $('#categoryImagePreview');
  preview.src = category?.imageUrl || '';
  preview.hidden = !category?.imageUrl;
  $('#categoryImageUploadStatus').textContent = category?.imageUrl ? 'Current category photo · choose a file to replace' : '';
  $('#categoryDialogTitle').textContent = category ? 'Edit category' : 'Add category';
  $('#categoryDialogDescription').textContent = category ? 'Update the category details and storefront image.' : 'Add a name, a short description, and an optional image.';
  $('#saveCategoryButton').innerHTML = category ? 'Save changes <span>→</span>' : 'Add category <span>→</span>';
  $('#categoryImageFile').value = '';
  categoryImageUploadPromise = Promise.resolve();
  dialog.showModal();
}

$('#categoryImageFile')?.addEventListener('change', event => {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  input.disabled = true;
  categoryImageUploadPromise = uploadCategoryPhoto(file).catch(error => {
    $('#categoryImageUploadStatus').textContent = error.message;
  }).finally(() => { input.disabled = !productImageUploadsEnabled; });
});

async function loadCategories() {
  const {categories} = await api('/admin/categories');
  adminCategories = categories;
  renderCategories();
  const select = $('#adminCategorySelect');
  if (select) select.innerHTML = categories.filter(c => c.active !== false).map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
  const productFilter = $('#productCategoryFilter');
  if (productFilter) {
    const selected = productFilter.value || 'all';
    productFilter.innerHTML = `<option value="all">All categories</option>${categories.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}${c.active === false ? ' · deleted' : ''}</option>`).join('')}`;
    productFilter.value = selected;
  }
  if (!categories.some(category => category.active !== false)) {
    const button = $('#saveProductButton');
    if (button) button.disabled = true;
  } else {
    const button = $('#saveProductButton');
    if (button) button.disabled = false;
  }
}

function renderCategories() {
  const query = ($('#categorySearch')?.value || '').trim().toLowerCase();
  const status = $('#categoryStatusFilter')?.value || 'all';
  const filtered = adminCategories.filter(category => {
    const matchesText = `${category.name} ${category.description||''}`.toLowerCase().includes(query);
    const matchesStatus = status === 'all' || (status === 'deleted' ? category.active === false : category.active !== false);
    return matchesText && matchesStatus;
  });
  const pages = Math.ceil(filtered.length / adminCategoryPageSize) || 1;
  adminCategoryPage = Math.min(adminCategoryPage, pages);
  const pageStart = (adminCategoryPage - 1) * adminCategoryPageSize;
  const pageItems = filtered.slice(pageStart, pageStart + adminCategoryPageSize);
  const count = $('#categoryCount');
  if (count) count.textContent = `${filtered.length} ${filtered.length === 1 ? 'category' : 'categories'} · page ${adminCategoryPage} of ${pages}`;
  if ($('#adminCategoriesPageInfo')) $('#adminCategoriesPageInfo').textContent = `Page ${adminCategoryPage} of ${pages}`;
  if ($('#previousAdminCategories')) $('#previousAdminCategories').disabled = adminCategoryPage <= 1;
  if ($('#nextAdminCategories')) $('#nextAdminCategories').disabled = adminCategoryPage >= pages;
  if ($('#adminCategoriesPagination')) $('#adminCategoriesPagination').hidden = pages <= 1;
  const tbody = $('#adminCategories');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">${adminCategories.length ? 'No categories match your search.' : 'Add your first category to organize the catalog.'}</div></td></tr>`;
    return;
  }
  tbody.innerHTML = pageItems.map(category => {
    const image = category.imageUrl ? `<img class="admin-table-photo category-table-photo" src="${esc(category.imageUrl)}" alt="${esc(category.name)}" loading="lazy" onerror="this.src='/assets/products/fallback.png'">` : `<span class="admin-table-photo-placeholder">${categoryIcon(category.slug)}</span>`;
    return `<tr>
      <td>${image}</td>
      <td><strong class="admin-table-primary">${esc(category.name)}</strong><small class="admin-table-subtext">${esc(category.slug)}</small></td>
      <td><span class="admin-table-description" title="${esc(category.description||'')}">${esc(category.description||'—')}</span></td>
      <td><span class="admin-count-pill">${Number(category.productCount||0)}</span></td>
      <td><span class="admin-status-pill ${category.active===false?'is-inactive':'is-active'}">${category.active===false?'Deleted':'Active'}</span></td>
      <td><div class="admin-table-actions">${category.active===false ? `<button class="action-btn" data-restore-category="${esc(category.id)}">Restore</button>` : `<button class="action-btn" data-edit-category="${esc(category.id)}">Edit</button><button class="action-btn danger-btn" data-archive-category="${esc(category.id)}">Delete</button>`}</div></td>
    </tr>`;
  }).join('');
}

// ─── Payment methods ──────────────────────────────────────────────────────────

let paymentMethods = [];

async function loadPaymentMethods() {
  const {paymentMethods: methods} = await api('/admin/payment-methods');
  paymentMethods = methods;
  const container = $('#adminPaymentMethods');
  if (!container) return;
  if (!methods.length) {
    container.innerHTML = '<div class="empty-state">No payment methods configured yet. Add one below.</div>';
    return;
  }
  container.innerHTML = methods.map(m => `
    <div class="admin-payment-method-row" data-pm-id="${esc(m.id)}">
      <div>
        <strong>${esc(m.label)}</strong>
        <span class="admin-product-category">${esc(m.type)} · ${m.enabled?'Enabled':'Disabled'}</span>
        ${(m.accountName||m.accountNumber)?`<p style="font-size:.82rem;color:#53637d;margin:.3rem 0 0">${esc(m.accountName||'')}${m.accountName&&m.accountNumber?' · ':''}${esc(m.accountNumber||'')}</p>`:''}
        <p style="font-size:.82rem;color:#8190aa;margin:.3rem 0 0;white-space:pre-wrap">${esc(m.instructions)}</p>
        <details style="margin-top:.65rem">
          <summary style="cursor:pointer;font-size:.8rem;font-weight:700;color:#1455d9">Edit payment instructions</summary>
          <form class="admin-form edit-payment-method-form" data-payment-id="${esc(m.id)}" style="margin-top:.6rem">
            <label>Label<input name="label" class="form-control" value="${esc(m.label)}" required maxlength="100"></label>
            <label>Account name<input name="accountName" class="form-control" value="${esc(m.accountName||'')}" maxlength="150"></label>
            <label>Account / number<input name="accountNumber" class="form-control" value="${esc(m.accountNumber||'')}" maxlength="100"></label>
            <label>Instructions<textarea name="instructions" class="form-control" required minlength="10" maxlength="2000">${esc(m.instructions)}</textarea></label>
            <button class="action-btn" type="submit">Save method</button>
          </form>
        </details>
      </div>
      <div>
        <button class="action-btn" data-toggle-pm="${esc(m.id)}" data-enabled="${m.enabled?'1':'0'}">${m.enabled?'Disable':'Enable'}</button>
        <button class="action-btn danger-btn" data-delete-pm="${esc(m.id)}">Delete</button>
      </div>
    </div>
  `).join('');
}

async function loadStoreSettings() {
  const {settings} = await api('/admin/settings');
  for (const form of [$('#storeSettingsForm'), $('#storeProfileForm')]) {
    if (!form) continue;
    for (const [key, value] of Object.entries(settings)) {
      const input = form.elements.namedItem(key);
      if (input) input.value = value ?? '';
    }
  }
}

function applyStoreConfig(config) {
  productImageUploadsEnabled = config?.productImageUploadsEnabled === true;
  const uploadInput = $('#productImageFile');
  if (uploadInput) uploadInput.disabled = !productImageUploadsEnabled;
  const categoryUploadInput = $('#categoryImageFile');
  if (categoryUploadInput) categoryUploadInput.disabled = !productImageUploadsEnabled;
  document.querySelectorAll('[data-product-image-file]').forEach(input => { input.disabled = !productImageUploadsEnabled; });
  document.querySelectorAll('[data-trigger-product-image]').forEach(button => { button.disabled = !productImageUploadsEnabled; });
  const uploadNotice = $('#productUploadConfigNotice');
  if (uploadNotice) {
    uploadNotice.hidden = productImageUploadsEnabled;
    uploadNotice.textContent = 'Photo uploads are unavailable until Cloudinary is configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to the server .env, then restart the app.';
  }
  const categoryUploadNotice = $('#categoryUploadConfigNotice');
  if (categoryUploadNotice) {
    categoryUploadNotice.hidden = productImageUploadsEnabled;
    categoryUploadNotice.textContent = 'Category photo uploads are unavailable until Cloudinary is configured. Add the CLOUDINARY settings to the server .env, then restart the app.';
  }
  const uploadStatus = $('#productImageUploadStatus');
  if (uploadStatus && !productImageUploadsEnabled) uploadStatus.textContent = 'Uploads are disabled until durable image storage is configured.';
  if (!config) return;
  const address = $('#sidebarStoreAddress'), phone = $('#sidebarStorePhone');
  const number  = String(config.storePhone || '');
  const digits  = number.replace(/\D/g,'');
  const dial    = number.startsWith('+') ? `+${digits}` : digits.startsWith('0') ? `+250${digits.slice(1)}` : `+${digits}`;
  if (address) address.textContent = config.storeAddress || '';
  if (phone)   { phone.textContent = number; phone.href = `tel:${dial}`; }
}

async function initAdmin() {
  const adminLockedEl   = $('#adminLocked');
  const adminContentEl  = $('#adminContent');
  if (!adminLockedEl || !adminContentEl) return;
  document.body.classList.add('admin-login-mode');
  try {
    const {user} = await api('/me');
    if (user.role !== 'ADMIN') throw Error('Administrator access required');
    adminLockedEl.hidden = true;
    adminMfaEnabled = Boolean(user.mfaEnabled);
    const mfaStatus = $('#adminMfaStatus');
    const mfaButton = $('#rotateMfaSetup');
    if (mfaStatus) mfaStatus.textContent = adminMfaEnabled
      ? 'Authenticator verification is enabled for this account.'
      : 'Authenticator verification is optional and currently off.';
    if (mfaButton) mfaButton.textContent = adminMfaEnabled
      ? 'Replace authenticator and recovery codes'
      : 'Set up authenticator';
    $('#adminGreeting').textContent = user.name.split(' ')[0];
    adminContentEl.hidden = false;
    document.body.classList.remove('admin-login-mode');
    const results = await Promise.all([
      loadStats(), loadAdminOrders(), loadProducts(), loadCategories(),
      loadPaymentMethods(),
      loadStoreSettings(),
      api('/config').catch(() => null),
      loadEmailOutbox(),
    ]);
    applyStoreConfig(results[6]);
  } catch {
    document.body.classList.add('admin-login-mode');
    adminContentEl.hidden = true;
    adminLockedEl.hidden = false;
    const loginError = $('#adminLoginError');
    if (loginError) {
      loginError.textContent = '';
      loginError.hidden = true;
    }
  }
}

async function loginAdmin(form) {
  const error = $('#adminLoginError');
  const mfaField = $('#adminLoginMfaField');
  const mfaInput = form.elements.namedItem('totpCode');
  const submit = form.querySelector('button[type="submit"]');
  const submitMarkup = submit?.innerHTML || '';
  if (submit?.disabled) return;
  if (error) error.hidden = true;
  if (submit) { submit.disabled = true; submit.innerHTML = '<span>Signing in…</span><span aria-hidden="true">…</span>'; }
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.email = String(payload.email || '').trim();
    payload.totpCode = String(payload.totpCode || '').trim().toUpperCase();
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    if (result.mfaRequired) {
      if (mfaField) mfaField.hidden = false;
      if (mfaInput) { mfaInput.required = true; mfaInput.focus(); }
      if (error) {
        error.textContent = 'Enter the authenticator code or an unused recovery code to continue.';
        error.hidden = false;
      }
      return;
    }
    if (result.user?.role !== 'ADMIN') {
      throw new Error('This account does not have administrator access.');
    }
    form.reset();
    if (mfaField) mfaField.hidden = true;
    if (mfaInput) mfaInput.required = false;
    await initAdmin();
  } catch (loginError) {
    if (error) {
      error.textContent = loginError.message || 'Administrator sign-in failed. Please try again.';
      error.hidden = false;
    }
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = submitMarkup; }
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button,a[data-cancel-order]');
  if (!button) return;
  try {
    if (button.hasAttribute('data-open-product-dialog')) { openProductEditor(); return; }
    if (button.hasAttribute('data-open-category-dialog')) { openCategoryEditor(); return; }
    if (button.hasAttribute('data-close-dialog')) { button.closest('dialog')?.close(); return; }
    if (button.dataset.viewOrder) {
      const order = adminOrders.find(item => item.id === button.dataset.viewOrder);
      if (!order) return;
      adminOrderDetailId = order.id;
      $('#adminOrderDialogTitle').textContent = `Order ${order.invoiceNumber || order.id.slice(0,8).toUpperCase()}`;
      $('#adminOrderDetailContent').innerHTML = renderAdminOrderDetail(order);
      $('#adminOrderDetailDialog').showModal();
      return;
    }
    if (button.dataset.editProduct) { openProductEditor(button.dataset.editProduct); return; }
    if (button.dataset.editCategory) { openCategoryEditor(button.dataset.editCategory); return; }
    if (button.id === 'loadMoreCustomerOrders') {
      await loadCustomerOrders(true);
      return;
    }
    if (button.id === 'previousAdminOrders') {
      await loadAdminOrders(adminOrdersPage - 1);
      return;
    }
    if (button.id === 'nextAdminOrders') {
      await loadAdminOrders(adminOrdersPage + 1);
      return;
    }
    if (button.id === 'previousAdminProducts') {
      await loadProducts(adminProductPage - 1);
      return;
    }
    if (button.id === 'nextAdminProducts') {
      await loadProducts(adminProductPage + 1);
      return;
    }
    if (button.id === 'previousAdminCategories') {
      adminCategoryPage = Math.max(1, adminCategoryPage - 1);
      renderCategories();
      return;
    }
    if (button.id === 'nextAdminCategories') {
      adminCategoryPage += 1;
      renderCategories();
      return;
    }
    if (button.dataset.triggerProductImage) {
      document.querySelector(`[data-product-image-file="${CSS.escape(button.dataset.triggerProductImage)}"]`)?.click();
      return;
    }
    if (button.id === 'signOutBtn') {
      await api('/auth/logout',{method:'POST'}).catch(() => {});
      sessionStorage.clear();
      localStorage.removeItem('iwm_token');
      localStorage.removeItem('iwm_user');
      location.href = '/';
      return;
    }
    if (button.id === 'rotateMfaSetup') {
      let currentCode = '';
      if (adminMfaEnabled) {
        currentCode = prompt('Enter a current authenticator code or unused recovery code to replace MFA:') || '';
        if (!currentCode) return;
      }
      const result = await api('/admin/mfa/setup', {method:'POST', body:JSON.stringify(currentCode ? {currentCode:currentCode.trim()} : {})});
      $('#mfaRotationSecret').textContent = result.secret;
      $('#mfaRotationRecoveryCodes').textContent = (result.recoveryCodes || []).join('\n');
      $('#mfaRotationBox').hidden = false;
      button.disabled = true;
      notify('Save the new recovery codes before confirming this change');
      return;
    }
    if (button.dataset.tab) {
      document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el===button));
      document.querySelectorAll('.admin-panel').forEach(el => el.classList.toggle('active', el.id===`panel-${button.dataset.tab}`));
      return;
    }
    if (button.id === 'refreshOrders') { await loadAdminOrders(); notify('Orders refreshed'); return; }
    if (button.id === 'refreshEmail') { await loadEmailOutbox(); notify('Email status refreshed'); return; }
    if (button.dataset.retryEmail) {
      await api(`/admin/email-outbox/${button.dataset.retryEmail}/retry`, {method:'POST', body:JSON.stringify({})});
      await loadEmailOutbox();
      notify('Failed email delivery queued for retry');
      return;
    }
    if (button.dataset.resendEmail) {
      if (!confirm('Resend this email to all recipients, including recipients who already received it?')) return;
      await api(`/admin/email-outbox/${button.dataset.resendEmail}/resend`, {method:'POST', body:JSON.stringify({confirm:true})});
      await loadEmailOutbox();
      notify('Email resend queued');
      return;
    }

    if (button.dataset.confirmOrder) {
      const id = button.dataset.confirmOrder;
      if (!confirm('Accept this order and notify the customer? Payment will remain pending until you confirm it separately.')) return;
      await api(`/admin/orders/${id}/fulfillment`, {method:'PATCH', body:JSON.stringify({status:'CONFIRMED'})});
      await loadAdminOrders();
      notify('Order accepted; payment remains a separate confirmation');
      return;
    }

    if (button.dataset.updateStatus) {
      const id     = button.dataset.updateStatus;
      const select = document.querySelector(`[data-order-select="${id}"]`);
      const status = select.value;
      await api(`/admin/orders/${id}/fulfillment`,{method:'PATCH',body:JSON.stringify({status})});
      await Promise.all([loadAdminOrders(), loadStats()]);
      notify('Fulfillment status updated');
      return;
    }

    if (button.dataset.cancelOrder) {
      if (!confirm('Cancel this unpaid order?')) return;
      const reason = prompt('Reason for cancellation (optional):') || '';
      await api(`/admin/orders/${button.dataset.cancelOrder}/cancel`,{method:'POST',body:JSON.stringify({reason})});
      await Promise.all([loadAdminOrders(), loadStats(), loadProducts()]);
      notify('Order cancelled');
      return;
    }

    if (button.dataset.refundOrder) {
      const remaining = Number(button.dataset.refundRemaining);
      const amountText = prompt(`Enter the refund amount already issued (RWF). Remaining refundable: ${remaining}`, String(remaining));
      if (amountText === null) return;
      const amount = Number(amountText);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > remaining) {
        notify(`Enter a whole number from 1 to ${remaining} RWF`);
        return;
      }
      const paymentRef = prompt('Enter the payment provider reference for this refund:');
      if (paymentRef === null) return;
      const reason = prompt('Reason for this refund:');
      if (reason === null) return;
      if (!confirm(`Record that ${fmt(amount)} has already been refunded? This records the refund and does not send money.`)) return;
      await api(`/admin/orders/${button.dataset.refundOrder}/refund`, {method:'POST', body:JSON.stringify({amount, paymentRef, reason})});
      await Promise.all([loadAdminOrders(), loadStats()]);
      notify('Refund recorded in the order ledger');
      return;
    }

    if (button.dataset.viewAudit) {
      const {audit} = await api(`/admin/orders/${button.dataset.viewAudit}/audit`);
      const lines = audit.map(e => `${formatDate(e.createdAt)} — ${e.action}${e.detail?' | '+e.detail:''}`).join('\n');
      alert(lines || 'No audit entries yet.');
      return;
    }

    if (button.dataset.archiveOrder) {
      if (!confirm('Delete this order from the active admin list? Its invoice, customer history, payment details and audit records will be kept.')) return;
      await api(`/admin/orders/${button.dataset.archiveOrder}`, {method:'DELETE', body:JSON.stringify({})});
      await Promise.all([loadAdminOrders(), loadStats()]);
      notify('Order removed from the active list');
      return;
    }
    if (button.dataset.restoreOrder) {
      await api(`/admin/orders/${button.dataset.restoreOrder}/restore`, {method:'POST', body:JSON.stringify({})});
      await loadAdminOrders();
      notify('Order restored to the active list');
      return;
    }

    if (button.dataset.archiveCategory) {
      if (!confirm('Delete this category from the active catalog? It must have no available products. Historical orders are preserved.')) return;
      await api(`/admin/categories/${button.dataset.archiveCategory}`, {method:'DELETE'});
      await Promise.all([loadCategories(), loadProducts()]);
      notify('Category deleted from the active catalog');
      return;
    }
    if (button.dataset.restoreCategory) {
      await api(`/admin/categories/${button.dataset.restoreCategory}/restore`, {method:'POST', body:JSON.stringify({})});
      await Promise.all([loadCategories(), loadProducts()]);
      notify('Category restored');
      return;
    }
    if (button.dataset.hideProduct) {
      if (!confirm('Delete this product from the active catalog? Existing orders and invoices keep their product details.')) return;
      await api(`/admin/products/${button.dataset.hideProduct}`,{method:'DELETE'});
      await Promise.all([loadProducts(), loadStats()]);
      notify('Product deleted from the active catalog');
      return;
    }
    if (button.dataset.restoreProduct) {
      await api(`/admin/products/${button.dataset.restoreProduct}/restore`, {method:'POST', body:JSON.stringify({})});
      await Promise.all([loadProducts(), loadStats()]);
      notify('Product restored to the catalog');
      return;
    }
    if (button.dataset.toggleProduct) {
      const active = button.dataset.active === '1';
      await api(`/admin/products/${button.dataset.toggleProduct}`, {method:'PATCH', body:JSON.stringify({active:!active})});
      await Promise.all([loadProducts(), loadStats()]);
      notify(active ? 'Product marked unavailable' : 'Product marked available');
      return;
    }

    if (button.dataset.togglePm) {
      const enabled = button.dataset.enabled === '1';
      await api(`/admin/payment-methods/${button.dataset.togglePm}`,{method:'PATCH',body:JSON.stringify({enabled:!enabled})});
      await loadPaymentMethods();
      notify(enabled ? 'Payment method disabled' : 'Payment method enabled');
      return;
    }
    if (button.dataset.deletePm) {
      if (!confirm('Delete this payment method? This cannot be undone.')) return;
      await api(`/admin/payment-methods/${button.dataset.deletePm}`,{method:'DELETE'});
      await loadPaymentMethods();
      notify('Payment method deleted');
      return;
    }
  } catch (error) { notify(error.message); }
});

let orderSearchTimer = null;
let productSearchTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.id === 'orderSearch') {
    clearTimeout(orderSearchTimer);
    orderSearchTimer = setTimeout(() => { void loadAdminOrders(1).catch(error => notify(error.message)); }, 300);
  }
  if (event.target.id === 'productSearch') {
    clearTimeout(productSearchTimer);
    productSearchTimer = setTimeout(() => { void loadProducts(1).catch(error => notify(error.message)); }, 300);
  }
  if (event.target.id === 'categorySearch') { adminCategoryPage = 1; renderCategories(); }
  if (event.target.matches('.admin-product-image-url')) {
    const row = event.target.closest('[data-product-row]');
    const preview = row?.querySelector('[data-product-preview]');
    if (preview) preview.src = event.target.value.trim() || '/assets/products/fallback.png';
    const publicId = row?.querySelector('[data-field="imagePublicId"]') || $('#productImagePublicId');
    const isPendingUpload = row?.dataset.pendingImageUrl && event.target.value.trim() === row.dataset.pendingImageUrl;
    const isCreatePendingUpload = event.target.id === 'productImageUrl' && event.target.dataset.pendingImageUrl && event.target.value.trim() === event.target.dataset.pendingImageUrl;
    if (publicId && !isPendingUpload && !isCreatePendingUpload) publicId.value = '';
    const images = row?.querySelector('[data-field="images"]') || $('#productImages');
    if (images && !isPendingUpload && !isCreatePendingUpload) {
      images.value = JSON.stringify(event.target.value.trim() ? [{ url: event.target.value.trim(), publicId: '' }] : []);
    }
  }
});

$('#orderStatusFilter')?.addEventListener('change', () => { void loadAdminOrders().catch(error => notify(error.message)); });
$('#orderPaymentFilter')?.addEventListener('change', () => { void loadAdminOrders().catch(error => notify(error.message)); });
$('#orderVisibilityFilter')?.addEventListener('change', () => { void loadAdminOrders().catch(error => notify(error.message)); });
$('#productCategoryFilter')?.addEventListener('change', () => { void loadProducts(1).catch(error => notify(error.message)); });
$('#productStatusFilter')?.addEventListener('change', () => { void loadProducts(1).catch(error => notify(error.message)); });
$('#categoryStatusFilter')?.addEventListener('change', () => { adminCategoryPage = 1; renderCategories(); });

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'adminLoginForm') {
    await loginAdmin(form);
    return;
  }
  if (!['createProduct','createCategory','createPaymentMethod','storeSettingsForm','storeProfileForm','verifyMfaRotation'].includes(form.id) && !form.classList.contains('confirm-payment-form') && !form.classList.contains('edit-payment-method-form') && !form.classList.contains('return-review-form') && !form.classList.contains('return-receive-form') && !form.classList.contains('customer-return-form')) return;

  try {
    if (form.id === 'createProduct') await productImageUploadPromise;
    if (form.id === 'createCategory') await categoryImageUploadPromise;
    const payload = Object.fromEntries(new FormData(form));
    if (form.classList.contains('return-review-form')) {
      await api(`/admin/orders/${form.dataset.orderId}/returns/${form.dataset.requestId}/review`, {
        method:'POST', body:JSON.stringify({ decision:form.dataset.decision, reviewNote:payload.reviewNote || '' }),
      });
      await loadAdminOrders();
      notify(form.dataset.decision === 'APPROVED' ? 'Return request approved' : 'Return request rejected');
      return;
    }
    if (form.classList.contains('return-receive-form')) {
      const items = [...form.querySelectorAll('[data-return-received]')].map(input => ({
        productId:input.dataset.returnReceived,
        quantityReceived:Number(input.value),
        restockQuantity:0,
      }));
      await api(`/admin/orders/${form.dataset.orderId}/returns/${form.dataset.requestId}/receive`, {
        method:'POST', body:JSON.stringify({ items, note:payload.note || '' }),
      });
      await Promise.all([loadAdminOrders(), loadProducts(), loadStats()]);
      notify('Return inspection saved');
      return;
    }
    if (form.classList.contains('customer-return-form')) {
      const items = [...form.querySelectorAll('[data-return-customer-qty]')]
        .map(input => ({ productId:input.dataset.returnCustomerQty, quantity:Number(input.value || 0) }))
        .filter(item => item.quantity > 0);
      if (!items.length) throw new Error('Choose a quantity for at least one item.');
      await api(`/orders/${form.dataset.orderId}/returns`, {method:'POST', body:JSON.stringify({items, reason:payload.reason})});
      await loadCustomerOrders();
      notify('Return request sent to the store');
      return;
    }
    if (form.classList.contains('confirm-payment-form')) {
      const orderId = form.dataset.orderId;
      await api(`/admin/orders/${orderId}/confirm-payment`,{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadAdminOrders(), loadStats()]);
      notify('Payment confirmed ✅');
      return;
    }
    if (form.id === 'verifyMfaRotation') {
      await api('/admin/mfa/verify', {method:'POST', body:JSON.stringify(payload)});
      notify('MFA saved. Sign in again with the new authenticator.');
      location.reload();
      return;
    }
    if (form.id === 'storeSettingsForm' || form.id === 'storeProfileForm') {
      if (form.id === 'storeSettingsForm') {
        for (const key of ['deliveryFeeFlat','taxRatePercent','invoiceExpiryHours','returnWindowDays']) payload[key] = Number(payload[key]);
      }
      await api('/admin/settings', {method:'PATCH', body:JSON.stringify(payload)});
      await loadStoreSettings();
      notify(form.id === 'storeProfileForm' ? 'Store profile saved' : 'Checkout rules saved');
      return;
    }
    if (form.classList.contains('edit-payment-method-form')) {
      await api(`/admin/payment-methods/${form.dataset.paymentId}`, {method:'PATCH', body:JSON.stringify(payload)});
      await loadPaymentMethods();
      notify('Payment method updated');
      return;
    }
    if (form.id === 'createProduct') {
      const productId = payload.productId;
      delete payload.productId;
      payload.price    = Number(payload.price);
      payload.featured = !!payload.featured;
      payload.isSecondHand = !!form.elements.namedItem('isSecondHand').checked;
      payload.images = JSON.parse(payload.images || '[]');
      payload.variants = JSON.parse(payload.variants || '[]');
      const result = productId
        ? await api(`/admin/products/${productId}`,{method:'PATCH',body:JSON.stringify(payload)})
        : await api('/admin/products',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadProducts(), loadStats()]);
      $('#productEditorDialog').close();
      $('#productImagePreview').hidden = true;
      $('#productImagePreview').removeAttribute('src');
      $('#productImageUploadStatus').textContent = '';
      $('#productImagePublicId').value = '';
      $('#productImages').value = '[]';
      $('#productImageUrl').value = '';
      $('#productImageUrl').dataset.pendingImageUrl = '';
      notify(result?.imageCleanupFailed ? 'Product saved, but Cloudinary could not remove the old photo.' : productId ? 'Product updated' : 'Product added to the catalog');
      return;
    } else if (form.id === 'createCategory') {
      const categoryId = payload.categoryId;
      delete payload.categoryId;
      const result = categoryId
        ? await api(`/admin/categories/${categoryId}`,{method:'PATCH',body:JSON.stringify(payload)})
        : await api('/admin/categories',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadCategories(), loadProducts()]);
      $('#categoryEditorDialog').close();
      notify(result?.imageCleanupFailed ? 'Category saved, but Cloudinary could not remove the old photo.' : categoryId ? 'Category updated' : 'Category added');
      return;
    } else if (form.id === 'createPaymentMethod') {
      await api('/admin/payment-methods',{method:'POST',body:JSON.stringify(payload)});
      await loadPaymentMethods();
    }
    form.reset();
    notify('Saved successfully');
  } catch (error) { notify(error.message); }
});

// ─── Page init ────────────────────────────────────────────────────────────────

let customerOrders = [];
let customerOrdersSkip = 0;
let customerOrdersHasMore = false;
let customerOrdersLoading = false;

function renderCustomerOrders() {
  const content = $('#ordersContent');
  if (!content) return;
  const pendingCount = customerOrders.filter(order => order.paymentStatus === 'PENDING').length;
  const paidTotal = customerOrders.filter(order => order.paymentStatus === 'PAID')
    .reduce((sum, order) => sum + Math.max(0, Number(order.total || 0) - Number(order.refundedAmount || 0)), 0);
  $('#customerOrderCount').textContent = String(customerOrders.length);
  $('#customerOrderPending').textContent = String(pendingCount);
  $('#customerOrderSpend').textContent = fmt(paidTotal);
  const cards = customerOrders.map(order => {
    const snap = order.paymentMethodSnapshot || {};
    const fulfillment = order.fulfillmentStatus || order.status || 'PLACED';
    const payment = order.paymentStatus || 'PENDING';
    const steps = ['PLACED', 'CONFIRMED', 'PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED'];
    const currentStep = steps.indexOf(fulfillment);
    const progress = fulfillment === 'CANCELLED' ? `<div class="customer-order-cancelled">This order was cancelled${order.cancelReason ? ` · ${esc(order.cancelReason)}` : ''}</div>` : `<ol class="order-progress" aria-label="Order progress">${steps.map((step, index) => `<li class="${index < currentStep ? 'is-complete' : index === currentStep ? 'is-current' : ''}"><span>${index < currentStep ? '✓' : index + 1}</span><small>${step.replaceAll('_', ' ').toLowerCase()}</small></li>`).join('')}</ol>`;
    const items = (order.items || []).map(item => {
      const lineTotal = Number(item.unitPrice ?? item.unit_price ?? item.price ?? 0) * Number(item.quantity || 0);
      const variant = item.variantValue || item.variantLabel || item.variant?.value || '';
      return `<li><div><strong>${esc(item.productName || item.product_name)}</strong>${variant ? `<small>${esc(item.variantType || item.variant?.type || 'Option')}: ${esc(variant)}</small>` : ''}${item.isSecondHand ? '<span class="condition-badge">Pre-owned</span>' : ''}</div><span>${Number(item.quantity)} × ${fmt(item.unitPrice ?? item.unit_price ?? item.price ?? 0)}</span><strong>${fmt(lineTotal)}</strong></li>`;
    }).join('');
    const returnRequests = (order.returnRequests || []).map(request => `<div class="customer-return-status"><strong>Return ${esc(String(request.status || 'REQUESTED').replaceAll('_',' ').toLowerCase())}</strong><small>${esc(formatDate(request.requestedAt))} · ${esc(request.reason)}</small>${request.reviewNote ? `<p>${esc(request.reviewNote)}</p>` : ''}<ul>${(request.items || []).map(item => `<li>${esc(item.productName)} × ${Number(item.quantity)}${request.status === 'RECEIVED' ? ` · received ${Number(item.returnedQuantity || 0)}` : ''}</li>`).join('')}</ul></div>`).join('');
    const returnPolicy = order.returnPolicy || {};
    const returnForm = returnPolicy.canRequest ? `<details class="customer-return-details"><summary>Request a return</summary><p>Submit before ${esc(formatDate(returnPolicy.deadline))}. The store will review your request.</p><form class="customer-return-form" data-order-id="${esc(order.id)}"><label>Reason<textarea class="form-control" name="reason" minlength="5" maxlength="500" required placeholder="Tell us what happened and why you are requesting a return"></textarea></label><div class="customer-return-quantities">${(returnPolicy.remainingItems || []).map(item => `<label>${esc(item.productName)} · up to ${Number(item.availableQuantity)}<input class="form-control" data-return-customer-qty="${esc(item.productId)}" type="number" min="0" max="${Number(item.availableQuantity)}" value="0"></label>`).join('')}</div><button class="btn btn-subtle" type="submit">Send return request</button></form></details>` : '';
    const paymentMessage = payment === 'PENDING'
      ? `<div class="order-payment-guidance"><strong>Payment is awaiting confirmation</strong><span>${fulfillment === 'PLACED' ? 'Use the payment instructions on your invoice. The store will confirm your order after reviewing it.' : 'Your order is accepted. Use the invoice instructions to pay; packing starts after the store confirms receipt.'}</span>${order.paymentDeadline ? `<small>Payment due ${esc(formatDate(order.paymentDeadline))}</small>` : ''}</div>`
      : payment === 'PAID' ? '<div class="order-payment-guidance is-paid"><strong>✓ Payment confirmed</strong><span>Your order is ready to move through fulfillment.</span></div>'
        : `<div class="order-payment-guidance"><strong>Payment ${esc(payment.toLowerCase().replaceAll('_',' '))}</strong></div>`;
    return `<article class="customer-order-card">
      <header class="customer-order-head"><div><span class="order-reference-label">ORDER REFERENCE</span><h3>${esc(order.invoiceNumber || 'Order #' + order.id.slice(0,8).toUpperCase())}</h3><p>${esc(formatDate(order.createdAt||order.created_at))} <span>·</span> ${esc(order.city || 'Kigali')} <span>·</span> ${esc(order.phone || '')}</p></div><div class="customer-order-total"><span>ORDER TOTAL</span><strong>${fmt(order.total)}</strong><div class="customer-order-badges"><span class="customer-status-badge ${esc(fulfillment)}">${esc(fulfillment.replaceAll('_',' '))}</span><span class="customer-status-badge payment ${esc(payment)}">${esc(payment.replaceAll('_',' '))}</span></div></div></header>
      ${progress}
      ${paymentMessage}
      <details class="customer-order-details"><summary>Items and delivery details <span>${(order.items || []).length} item${(order.items || []).length === 1 ? '' : 's'}</span></summary><ul class="customer-order-items">${items || '<li>No item details available.</li>'}</ul><div class="customer-delivery-summary"><strong>Delivery to</strong><span>${esc(order.customerName || order.customer_name || '')} · ${esc(order.phone || '')}</span><span>${esc(order.address || '')}, ${esc(order.city || '')}</span><strong class="order-payment-method">Payment method · ${esc(snap.label || 'Invoice')}</strong>${Number(order.refundedAmount || 0) > 0 ? `<span class="order-refund-note">Refunded ${fmt(order.refundedAmount)} · ${esc(order.refundStatus || 'PARTIALLY_REFUNDED')}</span>` : ''}</div></details>
      ${returnRequests ? `<div class="customer-return-list">${returnRequests}</div>` : ''}${returnForm}
      <footer class="customer-order-actions"><a class="btn btn-primary" href="/invoice?order=${esc(order.id)}">View invoice <span aria-hidden="true">→</span></a><a class="btn btn-subtle" href="/api/orders/${esc(order.id)}/invoice.pdf" target="_blank" rel="noopener">Download PDF ↓</a><a class="customer-order-help" href="tel:+250788651421">Need help?</a></footer>
    </article>`;
  }).join('');
  content.innerHTML = `${cards || (customerOrders.length ? '' : '<div class="empty-state">No orders yet. Start shopping!</div>')}${customerOrdersHasMore ? '<div class="products-load-more"><button id="loadMoreCustomerOrders" class="btn btn-subtle">Load older orders</button></div>' : ''}`;
}

async function loadCustomerOrders(append = false) {
  const content = $('#ordersContent');
  if (!content || customerOrdersLoading) return;
  customerOrdersLoading = true;
  if (!append) {
    customerOrders = [];
    customerOrdersSkip = 0;
    customerOrdersHasMore = false;
    content.innerHTML = '<div class="empty-state">Loading your orders…</div>';
  }
  try {
    if (!append) {
      const { user } = await api('/me');
      if (!user) throw new Error('Not signed in');
      $('#ordersGreeting').textContent = `Hello ${String(user.name || 'there').split(/\s+/)[0]}, follow payment, preparation and delivery from checkout to your door.`;
    }
    const result = await api(`/me/orders?limit=20&skip=${customerOrdersSkip}`);
    const rows = result.orders || [];
    customerOrders = append ? [...customerOrders, ...rows] : rows;
    customerOrdersSkip = Number(result.nextSkip || customerOrdersSkip + rows.length);
    customerOrdersHasMore = result.hasMore === true;
    renderCustomerOrders();
  } catch (error) {
    if (append) renderCustomerOrders();
    else content.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    throw error;
  } finally {
    customerOrdersLoading = false;
  }
}

if (page === 'orders') {
  void loadCustomerOrders().catch(() => {});
} else if (page === 'admin') {
  initAdmin();
}
