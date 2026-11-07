const $ = (selector) => document.querySelector(selector);
const fmt = (value) => `RWF ${Number(value || 0).toLocaleString('en-US')}`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token = localStorage.getItem('iwm_token') || '';
const page = document.body.dataset.page;
const statusNext = {PLACED:['CONFIRMED','CANCELLED'],CONFIRMED:['PACKING','CANCELLED'],PACKING:['OUT_FOR_DELIVERY','CANCELLED'],OUT_FOR_DELIVERY:['DELIVERED','CANCELLED'],DELIVERED:[],CANCELLED:[]};
let adminOrders = [];
let adminProducts = [];

function formatDate(value) {
  const source = String(value || '');
  const normalized = source.includes('T') ? source : `${source.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? source : date.toLocaleString('en-GB', {dateStyle:'medium',timeStyle:'short'});
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {...options,headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,...options.headers}});
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

async function loadStats() {
  const {stats} = await api('/admin/stats');
  const metrics = [
    ['Active products',stats.products,'▦'],
    ['Customers',stats.customers,'♙'],
    ['Open orders',stats.openOrders,'▤'],
    ['Delivered value',fmt(stats.revenue),'RWF'],
  ];
  $('#statGrid').innerHTML = metrics.map(([label,value,icon]) => `<div class="stat-card"><span>${esc(icon)} &nbsp; ${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
}

function renderAdminOrders() {
  const query = ($('#orderSearch')?.value || '').trim().toLowerCase();
  const status = $('#orderStatusFilter')?.value || 'all';
  const filtered = adminOrders.filter((order) => {
    const matchesStatus = status === 'all' || order.status === status;
    const searchText = [order.id,order.customer_name,order.phone,order.city,order.address].join(' ').toLowerCase();
    return matchesStatus && (!query || searchText.includes(query));
  });
  const count = $('#sidebarOrderCount');
  if (count) count.textContent = adminOrders.filter((order) => !['DELIVERED','CANCELLED'].includes(order.status)).length || '';
  if (!filtered.length) {
    $('#adminOrders').innerHTML = `<div class="empty-state">${adminOrders.length ? 'No orders match those filters.' : 'No orders yet. New customer orders will appear here.'}</div>`;
    return;
  }
  $('#adminOrders').innerHTML = filtered.map((order) => {
    const transitions = statusNext[order.status] || [];
    const orderItems = (order.items || []).map((item) => `${esc(item.product_name)} × ${Number(item.quantity)}`).join(' · ');
    const nextAction = transitions.length ? `<div class="admin-order-controls"><select class="form-control" data-order-select="${esc(order.id)}" aria-label="Next status for order ${esc(order.id.slice(0,8))}">${transitions.map((next) => `<option value="${next}">${next.replaceAll('_',' ')}</option>`).join('')}</select><button class="action-btn" data-update-status="${esc(order.id)}">Update status</button></div>` : '';
    return `<article class="admin-order-card">
      <div class="admin-order-head">
        <div><div class="admin-order-id">Order #${esc(order.id.slice(0,8).toUpperCase())} <span class="pill ${esc(order.status)}">${esc(order.status.replaceAll('_',' '))}</span></div><div class="admin-order-time">${esc(formatDate(order.created_at))}</div></div>
        <div><div class="admin-order-customer">${esc(order.customer_name)}</div><div class="admin-order-contact"><a href="tel:${esc(order.phone)}">${esc(order.phone)}</a> · ${esc(order.city)}<br>${esc(order.address)}</div></div>
        <div class="admin-order-total">${fmt(order.total)}</div>
      </div>
      <div class="admin-order-bottom"><div class="admin-order-items">${orderItems || 'No order items'}<br><strong>Cash on delivery</strong></div>${nextAction}</div>
    </article>`;
  }).join('');
}

async function loadAdminOrders() {
  const {orders} = await api('/admin/orders');
  adminOrders = orders;
  renderAdminOrders();
}

function renderProducts() {
  const query = ($('#productSearch')?.value || '').trim().toLowerCase();
  const products = adminProducts.filter((product) => `${product.name} ${product.category || ''}`.toLowerCase().includes(query));
  $('#productCount').textContent = `${products.length} ${products.length === 1 ? 'product' : 'products'} shown · Update name, price, or stock below.`;
  if (!products.length) {
    $('#adminProducts').innerHTML = '<div class="empty-state">No products match your search.</div>';
    return;
  }
  $('#adminProducts').innerHTML = products.map((product) => `<div class="admin-product-row" data-product-row="${esc(product.id)}">
    <img class="admin-product-image" src="${esc(product.imageUrl || '/assets/products/fallback.png')}" alt="" loading="lazy" onerror="this.src='/assets/products/fallback.png'">
    <div><input class="form-control admin-product-name-input" data-field="name" aria-label="Name for ${esc(product.name)}" value="${esc(product.name)}"><span class="admin-product-category">${esc(product.category || 'Uncategorized')}${product.active ? '' : ' · Hidden'}</span></div>
    <div><input class="form-control" data-field="price" type="number" min="0" step="1" aria-label="Price for ${esc(product.name)}" value="${Number(product.price)}"><small class="admin-product-price">Price · RWF</small></div>
    <input class="form-control" data-field="stock" type="number" min="0" step="1" aria-label="Stock for ${esc(product.name)}" value="${Number(product.stock)}">
    <div class="admin-product-actions"><button class="action-btn" data-save-product="${esc(product.id)}">Save</button><button class="action-btn danger-btn" data-hide-product="${esc(product.id)}" ${product.active ? '' : 'disabled'}>Hide</button></div>
  </div>`).join('');
}

async function loadProducts() {
  const [{products},{categories}] = await Promise.all([api('/admin/products'),api('/categories')]);
  adminProducts = products;
  const select = $('#adminCategorySelect');
  select.innerHTML = categories.map((category) => `<option value="${esc(category.slug)}">${esc(category.name)}</option>`).join('');
  renderProducts();
}

async function loadCategories() {
  const {categories} = await api('/categories');
  $('#adminCategories').innerHTML = categories.length ? categories.map((category,index) => `<div class="admin-category-item"><span class="admin-category-icon">${categoryIcon(category.slug)}</span><div><strong>${esc(category.name)}</strong><small>${esc(category.slug)} · Store category ${index + 1}</small></div></div>`).join('') : '<div class="empty-state">Add your first category to organize the catalog.</div>';
}

function applyStoreConfig(config) {
  if (!config) return;
  const address = $('#sidebarStoreAddress');
  const phone = $('#sidebarStorePhone');
  const number = String(config.storePhone || '0788651421');
  const digits = number.replace(/\D/g,'');
  const dial = number.startsWith('+') ? `+${digits}` : digits.startsWith('0') ? `+250${digits.slice(1)}` : `+${digits}`;
  if (address) address.textContent = config.storeAddress || 'Downtown Kigali';
  if (phone) { phone.textContent = number; phone.href = `tel:${dial}`; }
}

async function initAdmin() {
  if (!token) { $('#adminLocked').hidden = false; return; }
  try {
    const {user} = await api('/me');
    if (user.role !== 'ADMIN') throw Error('This account is not an administrator.');
    $('#adminGreeting').textContent = user.name.split(' ')[0];
    $('#adminContent').hidden = false;
    const results = await Promise.all([loadStats(),loadAdminOrders(),loadProducts(),loadCategories(),api('/config').catch(() => null)]);
    applyStoreConfig(results[4]);
  } catch (error) {
    $('#adminLocked').hidden = false;
    $('#adminLocked').insertAdjacentHTML('beforeend', errorBox(error));
  }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.id === 'signOutBtn') {
      if (token) await api('/auth/logout',{method:'POST'}).catch(() => {});
      localStorage.removeItem('iwm_token');
      localStorage.removeItem('iwm_user');
      location.href = '/';
      return;
    }
    if (button.dataset.tab) {
      document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active',item === button));
      document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.toggle('active',panel.id === `panel-${button.dataset.tab}`));
      return;
    }
    if (button.id === 'refreshOrders') { await loadAdminOrders(); notify('Orders refreshed'); return; }
    if (button.dataset.updateStatus) {
      const id = button.dataset.updateStatus;
      const select = document.querySelector(`[data-order-select="${id}"]`);
      const status = select.value;
      if (status === 'CANCELLED' && !confirm('Cancel this order and return its items to stock?')) return;
      await api(`/admin/orders/${id}/status`,{method:'PATCH',body:JSON.stringify({status})});
      await Promise.all([loadAdminOrders(),loadStats(),loadProducts()]);
      notify('Order status updated');
      return;
    }
    if (button.dataset.saveProduct) {
      const row = document.querySelector(`[data-product-row="${button.dataset.saveProduct}"]`);
      const payload = Object.fromEntries([...row.querySelectorAll('[data-field]')].map((input) => [input.dataset.field,input.dataset.field === 'name' ? input.value.trim() : Number(input.value)]));
      await api(`/admin/products/${button.dataset.saveProduct}`,{method:'PATCH',body:JSON.stringify(payload)});
      await Promise.all([loadProducts(),loadStats()]);
      notify('Product details saved');
      return;
    }
    if (button.dataset.hideProduct) {
      if (!confirm('Hide this product from shoppers?')) return;
      await api(`/admin/products/${button.dataset.hideProduct}`,{method:'DELETE'});
      await Promise.all([loadProducts(),loadStats()]);
      notify('Product hidden from the storefront');
    }
  } catch (error) { notify(error.message); }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'orderSearch' || event.target.id === 'productSearch') {
    if (event.target.id === 'orderSearch') renderAdminOrders();
    else renderProducts();
  }
});
$('#orderStatusFilter')?.addEventListener('change', renderAdminOrders);

document.addEventListener('submit', async (event) => {
  if (!['createProduct','createCategory'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'createProduct') {
      payload.price = Number(payload.price);
      payload.stock = Number(payload.stock);
      payload.featured = Boolean(payload.featured);
      await api('/admin/products',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadProducts(),loadStats()]);
    } else {
      await api('/admin/categories',{method:'POST',body:JSON.stringify(payload)});
      await Promise.all([loadCategories(),loadProducts()]);
    }
    form.reset();
    notify('Saved successfully');
  } catch (error) { notify(error.message); }
});

if (page === 'orders') {
  // Customer order history keeps the existing standalone page behavior.
  const content = $('#ordersContent');
  if (content) {
    if (!token) content.innerHTML = '<div class="empty-state">Please <a href="/" style="color:#1455d9;font-weight:800">sign in</a> to view your orders.</div>';
    else api('/me/orders').then(({orders}) => {
      content.innerHTML = orders.length ? orders.map((order) => `<article class="order-card"><div class="order-title"><div><h3>Order #${esc(order.id.slice(0,8).toUpperCase())}</h3><div class="order-meta">${esc(formatDate(order.created_at))} · ${esc(order.city)} · ${esc(order.phone)}</div></div><div style="text-align:right"><span class="pill ${esc(order.status)}">${esc(order.status.replaceAll('_',' '))}</span><div style="margin-top:7px;font:800 18px Outfit;color:#1552c4">${fmt(order.total)}</div></div></div><div class="order-products">${order.items.map((item) => `${esc(item.product_name)} × ${Number(item.quantity)} — ${fmt(item.unit_price * item.quantity)}`).join('<br>')}<br><strong>Payment: cash on delivery</strong></div></article>`).join('') : '<div class="empty-state">No orders yet. Start shopping!</div>';
    }).catch((error) => { content.innerHTML = errorBox(error); });
  }
} else if (page === 'admin') initAdmin();
