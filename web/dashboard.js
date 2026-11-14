// web/dashboard.js — IwacuMall admin dashboard (cookie-based auth edition)
const $ = (selector) => document.querySelector(selector);
const fmt = (value) => `RWF ${Number(value || 0).toLocaleString('en-US')}`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page = document.body.dataset.page;

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
  if (!response.ok) throw Error(data.error || 'Request failed');
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
let adminOrdersSkip = 0;
let adminOrdersHasMore = false;
let adminOrdersLoading = false;
let adminOrdersReloadQueued = false;
let adminOrdersOpenCount = 0;

const fulfillmentNext = {
  PLACED:['CONFIRMED','CANCELLED'], CONFIRMED:['PACKING','CANCELLED'],
  PACKING:['OUT_FOR_DELIVERY','CANCELLED'], OUT_FOR_DELIVERY:['DELIVERED','CANCELLED'],
  DELIVERED:[], CANCELLED:[],
};

function renderAdminOrders() {
  const query  = ($('#orderSearch')?.value || '').trim().toLowerCase();
  const status = $('#orderStatusFilter')?.value || 'all';
  const pStatus= $('#orderPaymentFilter')?.value || 'all';
  const filtered = adminOrders.filter((order) => {
    const matchF = status  === 'all' || order.fulfillmentStatus === status;
    const matchP = pStatus === 'all' || order.paymentStatus    === pStatus;
    const searchText = [order.id,order.customerName||order.customer_name,order.phone,order.city,order.invoiceNumber].join(' ').toLowerCase();
    return matchF && matchP && (!query || searchText.includes(query));
  });
  const count = $('#sidebarOrderCount');
  if (count) count.textContent = adminOrdersOpenCount || '';
  if (!filtered.length) {
    $('#adminOrders').innerHTML = `<div class="empty-state">${adminOrders.length ? 'No orders match those filters.' : 'No orders yet.'}</div>`;
    return;
  }
  $('#adminOrders').innerHTML = filtered.map((order) => {
    const fStatus = order.fulfillmentStatus || order.status || 'PLACED';
    const pStatus = order.paymentStatus || 'PENDING';
    const refundTotal = Number(order.refundedAmount || 0);
    const refundRemaining = Math.max(0, Number(order.total || 0) - refundTotal);
    const transitions = fulfillmentNext[fStatus] || [];
    const orderItems  = (order.items || []).map(item => `${esc(item.productName||item.product_name)} × ${Number(item.quantity)}`).join(' · ');
    const snap = order.paymentMethodSnapshot || {};
    const methodLabel = snap.label || order.paymentMethodLabel || 'Unknown';

    // Payment confirmation controls (only for PENDING payment)
    const paymentControls = pStatus === 'PENDING' ? `
      <details class="confirm-payment-details">
        <summary>Confirm payment received</summary>
        <form class="confirm-payment-form" data-order-id="${esc(order.id)}">
          <input class="form-control" name="paymentRef" placeholder="Payment reference / note (required)" required minlength="2">
          <input class="form-control" name="note" placeholder="Optional internal note">
          <button class="action-btn" type="submit">✔ Mark as paid</button>
        </form>
      </details>` : (pStatus === 'PAID' ? `<div style="color:#155724;font-size:.85rem">✅ Payment confirmed</div>${refundTotal ? `<div style="color:#815b00;font-size:.82rem">Refunded ${fmt(refundTotal)} · ${esc(order.refundStatus || 'PARTIAL')}</div>` : ''}` : `<div style="color:#721c24;font-size:.85rem">Payment: ${esc(pStatus)}</div>`);
    const refundControls = pStatus === 'PAID' && refundRemaining > 0
      ? `<button class="action-btn danger-btn" data-refund-order="${esc(order.id)}" data-refund-remaining="${refundRemaining}" style="margin-top:.5rem">Record refund · up to ${fmt(refundRemaining)}</button>` : '';

    // Fulfillment update controls
    const nextAction = pStatus !== 'PAID' && fStatus !== 'CANCELLED'
      ? `<div class="admin-order-controls" style="opacity:.5" title="Confirm payment first"><select class="form-control" disabled><option>Update fulfillment (payment required first)</option></select></div>`
      : (transitions.length ? `<div class="admin-order-controls"><select class="form-control" data-order-select="${esc(order.id)}" aria-label="Next status">${transitions.map(next=>`<option value="${next}">${next.replaceAll('_',' ')}</option>`).join('')}</select><button class="action-btn" data-update-status="${esc(order.id)}">Update</button></div>` : '');

    // Cancel button (only for unpaid)
    const cancelBtn = !['CANCELLED','DELIVERED'].includes(fStatus) && pStatus !== 'PAID'
      ? `<button class="action-btn danger-btn" data-cancel-order="${esc(order.id)}" style="margin-top:.5rem">✕ Cancel order</button>` : '';

    const returnRequests = (order.returnRequests || []).map(request => {
      const items = (request.items || []).map(item => `<li>${esc(item.productName)} × ${Number(item.quantity)}${request.status === 'RECEIVED' ? ` · received ${Number(item.returnedQuantity || 0)} · restocked ${Number(item.restockedQuantity || 0)}` : ''}</li>`).join('');
      const review = request.status === 'REQUESTED' ? `<div class="admin-return-actions"><form class="return-review-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}" data-decision="APPROVED"><textarea class="form-control" name="reviewNote" maxlength="300" placeholder="Optional customer-facing note"></textarea><button class="action-btn" type="submit">Approve return</button></form><form class="return-review-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}" data-decision="REJECTED"><textarea class="form-control" name="reviewNote" maxlength="300" placeholder="Explain why you cannot accept this return" required minlength="5"></textarea><button class="action-btn danger-btn" type="submit">Reject return</button></form></div>` : '';
      const receive = request.status === 'APPROVED' ? `<form class="return-receive-form" data-order-id="${esc(order.id)}" data-request-id="${esc(request.id)}"><strong>Inspect returned goods</strong>${(request.items || []).map(item => `<div class="return-receive-item"><span>${esc(item.productName)} · approved ${Number(item.quantity)}</span><label>Received<input class="form-control" type="number" data-return-received="${esc(item.productId)}" min="0" max="${Number(item.quantity)}" value="0" required></label><label>Restockable<input class="form-control" type="number" data-return-restock="${esc(item.productId)}" min="0" max="${Number(item.quantity)}" value="0" required></label></div>`).join('')}<textarea class="form-control" name="note" maxlength="300" placeholder="Inspection note (optional)"></textarea><button class="action-btn" type="submit">Mark received and restock</button></form>` : '';
      return `<section class="admin-return-request"><strong>Return ${esc(String(request.status || 'REQUESTED').replaceAll('_',' '))}</strong><small>${esc(formatDate(request.requestedAt))} · ${esc(request.reason)}</small><ul>${items}</ul>${request.reviewNote ? `<p>${esc(request.reviewNote)}</p>` : ''}${review}${receive}</section>`;
    }).join('');

    return `<article class="admin-order-card">
      <div class="admin-order-head">
        <div>
          <div class="admin-order-id">
            ${esc(order.invoiceNumber || order.id.slice(0,8).toUpperCase())}
            <span class="pill ${esc(fStatus)}">${esc(fStatus.replaceAll('_',' '))}</span>
            <span class="pill payment-pill ${esc(pStatus)}" style="font-size:.7rem">${esc(pStatus)}</span>
          </div>
          <div class="admin-order-time">${esc(formatDate(order.createdAt || order.created_at))}</div>
        </div>
        <div>
          <div class="admin-order-customer">${esc(order.customerName||order.customer_name)}</div>
          <div class="admin-order-contact"><a href="tel:${esc(order.phone)}">${esc(order.phone)}</a> · ${esc(order.city)}<br>${esc(order.address)}</div>
        </div>
        <div class="admin-order-total">${fmt(order.total)}</div>
      </div>
      <div class="admin-order-bottom">
        <div class="admin-order-items">
          ${orderItems || 'No items'}
          <br><strong>Method: ${esc(methodLabel)}</strong>
          ${returnRequests ? `<div class="admin-return-list">${returnRequests}</div>` : ''}
        </div>
        <div>
          ${paymentControls}
          ${refundControls}
          ${nextAction}
          ${cancelBtn}
          <a class="action-btn" href="/invoice?order=${esc(order.id)}" target="_blank" style="margin-top:.4rem;display:inline-block">🖨 View invoice</a>
          <a class="action-btn" href="/api/orders/${esc(order.id)}/invoice.pdf" target="_blank" style="margin-top:.4rem;display:inline-block">📥 Download PDF</a>
          <button class="action-btn" data-view-audit="${esc(order.id)}" style="margin-top:.4rem">📋 Audit log</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function loadAdminOrders() {
  return loadAdminOrdersPage(false);
}

async function loadAdminOrdersPage(append) {
  if (adminOrdersLoading) {
    if (!append) adminOrdersReloadQueued = true;
    return;
  }
  const limit = 100;
  if (!append) {
    adminOrdersSkip = 0;
    adminOrders = [];
  }
  const params = new URLSearchParams({ limit:String(limit), skip:String(adminOrdersSkip) });
  const status = $('#orderStatusFilter')?.value || 'all';
  const paymentStatus = $('#orderPaymentFilter')?.value || 'all';
  const search = ($('#orderSearch')?.value || '').trim();
  if (status !== 'all') params.set('status', status);
  if (paymentStatus !== 'all') params.set('paymentStatus', paymentStatus);
  if (search) params.set('search', search);
  const button = $('#loadMoreAdminOrders');
  adminOrdersLoading = true;
  if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  try {
    const result = await api(`/admin/orders?${params}`);
    const rows = result.orders || [];
    adminOrders = append ? [...adminOrders, ...rows] : rows;
    adminOrdersSkip += rows.length;
    adminOrdersHasMore = result.hasMore === true;
    adminOrdersOpenCount = Number(result.openCount || 0);
    renderAdminOrders();
  } finally {
    adminOrdersLoading = false;
    if (button) {
      button.hidden = !adminOrdersHasMore;
      button.disabled = false;
      button.textContent = 'Load more orders';
    }
    if (adminOrdersReloadQueued) {
      adminOrdersReloadQueued = false;
      void loadAdminOrdersPage(false).catch(error => notify(error.message));
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

function adminImageGallery(product) {
  if (Array.isArray(product?.images)) {
    const gallery = product.images.filter(image => image && typeof image.url === 'string' && image.url)
      .map(image => ({ url: image.url, publicId: typeof image.publicId === 'string' ? image.publicId : '' }));
    if (gallery.length) return gallery;
  }
  return product?.imageUrl ? [{ url: product.imageUrl, publicId: product.imagePublicId || '' }] : [];
}

function renderProducts() {
  const query    = ($('#productSearch')?.value || '').trim().toLowerCase();
  const stockFilter = $('#inventoryStockFilter')?.value || 'all';
  const products = adminProducts.filter(p => {
    const matchesText = `${p.name} ${p.category||p.categorySlug||''}`.toLowerCase().includes(query);
    const stock = Number(p.stock || 0);
    const matchesStock = stockFilter === 'low' ? stock > 0 && stock <= 5 : stockFilter === 'out' ? stock === 0 : true;
    return matchesText && matchesStock;
  });
  $('#productCount').textContent = `${products.length} ${products.length===1?'product':'products'} shown`;
  if (!products.length) { $('#adminProducts').innerHTML = '<div class="empty-state">No products match your search.</div>'; return; }
  $('#adminProducts').innerHTML = products.map(product => {
    const currentCategory = adminCategories.find(c => c.slug === product.categorySlug);
    const categoryOptions = adminCategories.filter(c => c.active !== false).map(c => `<option value="${esc(c.slug)}" ${c.slug === product.categorySlug ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const archivedOption = currentCategory?.active === false ? `<option value="${esc(currentCategory.slug)}" selected>${esc(currentCategory.name)} · archived</option>` : '';
    const gallery = adminImageGallery(product);
    return `<div class="admin-product-row" data-product-row="${esc(product.id)}">
      <div class="admin-product-photo-edit"><img class="admin-product-image" data-product-preview="${esc(product.id)}" src="${esc(product.imageUrl||'/assets/products/fallback.png')}" alt="" loading="lazy" onerror="this.src='/assets/products/fallback.png'"><button class="action-btn" type="button" data-trigger-product-image="${esc(product.id)}">Photos</button><small data-product-image-status>${gallery.length > 1 ? `${gallery.length} photos` : ''}</small><input type="file" accept="image/png,image/jpeg,image/webp" data-product-image-file="${esc(product.id)}" multiple hidden></div>
      <div class="admin-product-edit-fields"><input class="form-control admin-product-name-input" data-field="name" aria-label="Name for ${esc(product.name)}" value="${esc(product.name)}"><select class="form-control admin-product-category-select" data-field="categorySlug" aria-label="Category for ${esc(product.name)}">${archivedOption}${categoryOptions}</select><input class="form-control admin-product-image-url" data-field="imageUrl" aria-label="Primary photo URL for ${esc(product.name)}" value="${esc(product.imageUrl||'')}" placeholder="Primary image URL"><input type="hidden" data-field="imagePublicId" value="${esc(product.imagePublicId||'')}"><input type="hidden" data-field="images" value="${esc(JSON.stringify(gallery))}"><span class="admin-product-category">${product.active?'Visible in store':'Hidden from store'}</span></div>
      <div><input class="form-control" data-field="price" type="number" min="0" step="1" aria-label="Price" value="${Number(product.price)}"><small class="admin-product-price">Price · RWF</small></div>
      <div class="admin-stock-adjust"><strong class="${Number(product.stock)<=5?'stock-warning':''}">${Number(product.stock)} in stock</strong><div><input class="form-control" data-stock-delta type="number" step="1" value="1" aria-label="Stock adjustment amount"><button class="action-btn" data-adjust-stock="${esc(product.id)}">Adjust</button></div></div>
      <div class="admin-product-actions"><button class="action-btn" data-save-product="${esc(product.id)}">Save</button><button class="action-btn" data-stock-history="${esc(product.id)}">History</button><button class="action-btn danger-btn" data-hide-product="${esc(product.id)}" ${product.active?'':'disabled'}>Hide</button></div>
    </div>`;
  }).join('');
}

async function loadProducts() {
  const [{products},{categories}] = await Promise.all([api('/admin/products'), api('/admin/categories')]);
  adminProducts = products;
  adminCategories = categories;
  const select = $('#adminCategorySelect');
  if (select) select.innerHTML = categories.filter(c => c.active !== false).map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
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
    const upload = uploadProductPhoto(event.target.files);
    event.target.value = '';
    void upload.catch(error => {
      $('#productImageUploadStatus').textContent = error.message;
    });
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

async function loadCategories() {
  const {categories} = await api('/admin/categories');
  adminCategories = categories;
  $('#adminCategories').innerHTML = categories.length
    ? categories.map((c,i) => `<div class="admin-category-item ${c.active===false?'archived':''}"><span class="admin-category-icon">${categoryIcon(c.slug)}</span><div><input class="form-control admin-category-name" data-category-name="${esc(c.id)}" value="${esc(c.name)}" aria-label="Category name ${esc(c.name)}" ${c.active===false?'disabled':''}><small>${esc(c.slug)} · ${c.active===false?'Archived':'Store category '+(i+1)}</small></div>${c.active===false?'<span class="admin-product-category">Archived</span>':`<button class="action-btn" data-save-category="${esc(c.id)}">Save</button><button class="action-btn danger-btn" data-archive-category="${esc(c.id)}">Archive</button>`}</div>`).join('')
    : '<div class="empty-state">Add your first category to organize the catalog.</div>';
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
  const form = $('#storeSettingsForm');
  if (!form) return;
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value ?? '';
  }
}

function applyStoreConfig(config) {
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
  const mfaSetupEl = $('#adminMfaSetup');
  if (!adminLockedEl || !adminContentEl) return;
  try {
    const {user} = await api('/me');
    if (user.role !== 'ADMIN') throw Error('Administrator access required');
    adminLockedEl.hidden = true;
    if (!user.mfaEnabled) {
      adminContentEl.hidden = true;
      if (mfaSetupEl) mfaSetupEl.hidden = false;
      return;
    }
    $('#adminGreeting').textContent = user.name.split(' ')[0];
    adminContentEl.hidden = false;
    const results = await Promise.all([
      loadStats(), loadAdminOrders(), loadProducts(), loadCategories(),
      loadPaymentMethods(),
      loadStoreSettings(),
      api('/config').catch(() => null),
      loadEmailOutbox(),
    ]);
    applyStoreConfig(results[6]);
  } catch (error) {
    adminLockedEl.hidden = false;
    adminLockedEl.insertAdjacentHTML('beforeend', errorBox(error));
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button,a[data-cancel-order]');
  if (!button) return;
  try {
    if (button.id === 'loadMoreCustomerOrders') {
      await loadCustomerOrders(true);
      return;
    }
    if (button.id === 'loadMoreAdminOrders') {
      await loadAdminOrdersPage(true);
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
    if (button.id === 'beginMfaSetup') {
      const result = await api('/admin/mfa/setup', {method:'POST', body:JSON.stringify({})});
      $('#mfaSecret').textContent = result.secret;
      $('#mfaRecoveryCodes').textContent = (result.recoveryCodes || []).join('\n');
      $('#mfaSecretBox').hidden = false;
      button.disabled = true;
      notify('Add the secret to your authenticator app');
      return;
    }
    if (button.id === 'rotateMfaSetup') {
      const currentCode = prompt('Enter a current authenticator code or unused recovery code to replace MFA:');
      if (!currentCode) return;
      const result = await api('/admin/mfa/setup', {method:'POST', body:JSON.stringify({currentCode:currentCode.trim()})});
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
      if (!confirm('Cancel this order and return items to stock?')) return;
      const reason = prompt('Reason for cancellation (optional):') || '';
      await api(`/admin/orders/${button.dataset.cancelOrder}/cancel`,{method:'POST',body:JSON.stringify({reason})});
      await Promise.all([loadAdminOrders(), loadStats(), loadProducts()]);
      notify('Order cancelled and stock restored');
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
      if (!confirm(`Record that ${fmt(amount)} has already been refunded? This records the refund and does not send money or change inventory.`)) return;
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

    if (button.dataset.saveProduct) {
      const row = document.querySelector(`[data-product-row="${button.dataset.saveProduct}"]`);
      const payload = Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input =>
        [input.dataset.field, ['name','categorySlug','imageUrl','imagePublicId','images'].includes(input.dataset.field) ? input.value.trim() : Number(input.value)]));
      payload.images = JSON.parse(payload.images || '[]');
      const result = await api(`/admin/products/${button.dataset.saveProduct}`,{method:'PATCH',body:JSON.stringify(payload)});
      await Promise.all([loadProducts(), loadStats()]);
      notify(result.imageCleanupFailed ? 'Product saved, but Cloudinary could not remove the old photo.' : 'Product saved');
      return;
    }
    if (button.dataset.adjustStock) {
      const row = document.querySelector(`[data-product-row="${button.dataset.adjustStock}"]`);
      const delta = Number(row.querySelector('[data-stock-delta]').value);
      const reason = prompt('Why are you changing this stock count? (e.g. received shipment, damaged item, stock count correction)');
      if (reason === null) return;
      await api(`/admin/products/${button.dataset.adjustStock}/stock`, {method:'POST', body:JSON.stringify({delta,reason})});
      await Promise.all([loadProducts(), loadStats()]);
      notify('Inventory adjustment saved');
      return;
    }
    if (button.dataset.stockHistory) {
      const {adjustments} = await api(`/admin/products/${button.dataset.stockHistory}/inventory-adjustments`);
      const text = adjustments.map(entry => `${formatDate(entry.createdAt)} · ${entry.delta>0?'+':''}${entry.delta} (${entry.previousStock} → ${entry.newStock}) · ${entry.reason}`).join('\n');
      alert(text || 'No stock adjustments recorded for this product.');
      return;
    }
    if (button.dataset.saveCategory) {
      const input = document.querySelector(`[data-category-name="${button.dataset.saveCategory}"]`);
      await api(`/admin/categories/${button.dataset.saveCategory}`, {method:'PATCH', body:JSON.stringify({name:input.value.trim()})});
      await Promise.all([loadCategories(), loadProducts()]);
      notify('Category updated');
      return;
    }
    if (button.dataset.archiveCategory) {
      if (!confirm('Archive this category? It must have no active products.')) return;
      await api(`/admin/categories/${button.dataset.archiveCategory}`, {method:'DELETE'});
      await Promise.all([loadCategories(), loadProducts()]);
      notify('Category archived');
      return;
    }
    if (button.dataset.hideProduct) {
      if (!confirm('Hide this product from shoppers?')) return;
      await api(`/admin/products/${button.dataset.hideProduct}`,{method:'DELETE'});
      await Promise.all([loadProducts(), loadStats()]);
      notify('Product hidden');
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
document.addEventListener('input', (event) => {
  if (event.target.id === 'orderSearch') {
    clearTimeout(orderSearchTimer);
    orderSearchTimer = setTimeout(() => { void loadAdminOrders().catch(error => notify(error.message)); }, 300);
  }
  if (event.target.id === 'productSearch' || event.target.id === 'inventoryStockFilter') renderProducts();
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
$('#inventoryStockFilter')?.addEventListener('change', renderProducts);

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!['createProduct','createCategory','createPaymentMethod','storeSettingsForm','verifyMfaSetup','verifyMfaRotation'].includes(form.id) && !form.classList.contains('confirm-payment-form') && !form.classList.contains('edit-payment-method-form') && !form.classList.contains('return-review-form') && !form.classList.contains('return-receive-form') && !form.classList.contains('customer-return-form')) return;
  const payload = Object.fromEntries(new FormData(form));

  try {
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
        restockQuantity:Number(form.querySelector(`[data-return-restock="${CSS.escape(input.dataset.returnReceived)}"]`)?.value || 0),
      }));
      await api(`/admin/orders/${form.dataset.orderId}/returns/${form.dataset.requestId}/receive`, {
        method:'POST', body:JSON.stringify({ items, note:payload.note || '' }),
      });
      await Promise.all([loadAdminOrders(), loadProducts(), loadStats()]);
      notify('Returned goods recorded; eligible items were restocked');
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
    if (form.id === 'verifyMfaSetup' || form.id === 'verifyMfaRotation') {
      await api('/admin/mfa/verify', {method:'POST', body:JSON.stringify(payload)});
      notify('MFA saved. Sign in again with the new authenticator.');
      location.reload();
      return;
    }
    if (form.id === 'storeSettingsForm') {
      for (const key of ['deliveryFeeFlat','taxRatePercent','invoiceExpiryHours','returnWindowDays']) payload[key] = Number(payload[key]);
      await api('/admin/settings', {method:'PATCH', body:JSON.stringify(payload)});
      await loadStoreSettings();
      notify('Store settings saved');
      return;
    }
    if (form.classList.contains('edit-payment-method-form')) {
      await api(`/admin/payment-methods/${form.dataset.paymentId}`, {method:'PATCH', body:JSON.stringify(payload)});
      await loadPaymentMethods();
      notify('Payment method updated');
      return;
    }
    if (form.id === 'createProduct') {
      payload.price    = Number(payload.price);
      payload.stock    = Number(payload.stock);
      payload.featured = !!payload.featured;
      payload.images = JSON.parse(payload.images || '[]');
      await api('/admin/products',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadProducts(), loadStats()]);
    } else if (form.id === 'createCategory') {
      await api('/admin/categories',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadCategories(), loadProducts()]);
    } else if (form.id === 'createPaymentMethod') {
      await api('/admin/payment-methods',{method:'POST',body:JSON.stringify(payload)});
      await loadPaymentMethods();
    }
    form.reset();
    if (form.id === 'createProduct') {
      $('#productImagePreview').hidden = true;
      $('#productImagePreview').removeAttribute('src');
      $('#productImageUploadStatus').textContent = '';
      $('#productImagePublicId').value = '';
      $('#productImages').value = '[]';
      $('#productImageUrl').dataset.pendingImageUrl = '';
    }
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
  const cards = customerOrders.map(order => {
    const snap = order.paymentMethodSnapshot || {};
    const returnRequests = (order.returnRequests || []).map(request => `<div class="customer-return-status"><strong>Return ${esc(String(request.status || 'REQUESTED').replaceAll('_',' ').toLowerCase())}</strong><small>${esc(formatDate(request.requestedAt))} · ${esc(request.reason)}</small>${request.reviewNote ? `<p>${esc(request.reviewNote)}</p>` : ''}<ul>${(request.items || []).map(item => `<li>${esc(item.productName)} × ${Number(item.quantity)}${request.status === 'RECEIVED' ? ` · received ${Number(item.returnedQuantity || 0)} · restocked ${Number(item.restockedQuantity || 0)}` : ''}</li>`).join('')}</ul></div>`).join('');
    const returnPolicy = order.returnPolicy || {};
    const returnForm = returnPolicy.canRequest ? `<details class="customer-return-details"><summary>Request a return</summary><p>Submit before ${esc(formatDate(returnPolicy.deadline))}. The store will review your request.</p><form class="customer-return-form" data-order-id="${esc(order.id)}"><label>Reason<textarea class="form-control" name="reason" minlength="5" maxlength="500" required placeholder="Tell us what happened and why you are requesting a return"></textarea></label><div class="customer-return-quantities">${(returnPolicy.remainingItems || []).map(item => `<label>${esc(item.productName)} · up to ${Number(item.availableQuantity)}<input class="form-control" data-return-customer-qty="${esc(item.productId)}" type="number" min="0" max="${Number(item.availableQuantity)}" value="0"></label>`).join('')}</div><button class="btn btn-subtle" type="submit">Send return request</button></form></details>` : '';
    return `<article class="order-card">
      <div class="order-title"><div><h3>${esc(order.invoiceNumber || 'Order #' + order.id.slice(0,8).toUpperCase())}</h3><div class="order-meta">${esc(formatDate(order.createdAt||order.created_at))} · ${esc(order.city)} · ${esc(order.phone)}</div></div>
        <div style="text-align:right"><span class="pill ${esc(order.fulfillmentStatus||order.status)}">${esc((order.fulfillmentStatus||order.status||'').replaceAll('_',' '))}</span><span class="pill" style="background:#fff3cd;color:#856404;margin-left:4px">${esc(order.paymentStatus||'PENDING')}</span><div style="margin-top:7px;font:800 18px Outfit;color:#1552c4">${fmt(order.total)}</div></div></div>
      <div class="order-products">${(order.items||[]).map(item => `${esc(item.productName||item.product_name)} × ${Number(item.quantity)} — ${fmt((item.unitPrice||item.unit_price)*item.quantity)}`).join('<br>')}<br><strong>Payment: ${esc(snap.label||'Invoice')}</strong>
        ${order.paymentStatus==='PENDING'&&order.paymentDeadline?`<br><span style="color:#856404;font-size:.85rem">⏰ Pay by: ${esc(formatDate(order.paymentDeadline))}</span>`:''}
        ${Number(order.refundedAmount||0)>0?`<br><strong>Refunded to date: ${fmt(order.refundedAmount)} · ${esc(order.refundStatus||'PARTIALLY_REFUNDED')}</strong>`:''}
        ${order.paymentStatus==='PAID'?'<br>✅ Payment confirmed':''}</div>
      ${returnRequests ? `<div class="customer-return-list">${returnRequests}</div>` : ''}${returnForm}
      <a class="btn btn-subtle" href="/invoice?order=${esc(order.id)}" style="margin-top:.5rem;display:inline-block">View invoice →</a>
      <a class="btn btn-subtle" href="/api/orders/${esc(order.id)}/invoice.pdf" target="_blank" style="margin-top:.5rem;margin-left:6px;display:inline-block">Download PDF ↓</a>
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
