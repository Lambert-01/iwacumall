// web/app.js — IwacuMall storefront (cookie-based auth edition)
const $ = (selector) => document.querySelector(selector);
const fmt = (amount) => `RWF ${Number(amount || 0).toLocaleString('en-US')}`;
const esc = (val) => String(val ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Browser sessions stay in HttpOnly cookies. Only the native mobile client
// requests a bearer token; the storefront keeps user display data in sessionStorage.
const state = {
  products: [], categories: [], paymentMethods: [], filter: 'all', query: '',
  productCache: new Map(),
  productPage: 1, productTotal: 0, totalPages: 1, productsLoading: false, productRequestId: 0,
  cart: JSON.parse(sessionStorage.getItem('iwm_cart') || localStorage.getItem('iwm_cart') || '[]'),
  user: JSON.parse(sessionStorage.getItem('iwm_user') || 'null'),
  modal: '',
  quickViewProduct: null,
  quickViewQty: 1,
  quickViewImageIndex: 0,
  quickViewRelated: null,
  quickViewRelatedLoading: false,
  quickViewRequestId: 0,
  googleClientInitialized: '',
  storeConfig: null,
  checkoutInFlight: false,
};

const initialCategory = location.pathname.match(/^\/categories\/([^/]+)$/);
if (initialCategory) {
  try { state.filter = decodeURIComponent(initialCategory[1]); } catch { state.filter = 'all'; }
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin', // send cookies
    headers: {
      'Content-Type': 'application/json',
      // CSRF: read csrf token from cookie and echo in header
      ...(getCSRFToken() ? { 'X-CSRF-Token': getCSRFToken() } : {}),
      ...options.headers,
    },
  });
  let data;
  try { data = await res.json(); } catch { throw Error('The server returned an invalid response'); }
  if (!res.ok) throw Error(data.error || 'Something went wrong');
  return data;
}

function getCSRFToken() {
  const m = document.cookie.match(/(?:^|;\s*)iwm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Cart persists in sessionStorage (not localStorage) — clears when tab closes
function saveCart() {
  sessionStorage.setItem('iwm_cart', JSON.stringify(state.cart));
  sessionStorage.removeItem('iwm_checkout_key');
  sessionStorage.removeItem('iwm_checkout_fingerprint');
  // Clear legacy localStorage cart
  localStorage.removeItem('iwm_cart');
  updateCartBadge();
}
function saveUser(user) {
  state.user = user;
  sessionStorage.setItem('iwm_user', JSON.stringify(user));
  // Clear legacy localStorage tokens
  localStorage.removeItem('iwm_token');
  localStorage.removeItem('iwm_user');
}
function clearUser() {
  state.user = null;
  sessionStorage.removeItem('iwm_user');
  localStorage.removeItem('iwm_token');
  localStorage.removeItem('iwm_user');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3100);
}
function updateCartBadge() {
  const count = state.cart.reduce((s, i) => s + i.quantity, 0);
  $('#cartBadge').textContent = count;
  const d = $('#drawerCartCount');
  if (d) d.textContent = `(${count})`;
}
function categoryIcon(slug) {
  return ({'groceries':'🛒','electronics':'🎧','home-living':'🛋️','fashion':'👟','beauty-care':'🧴','fresh-produce':'🥑'})[slug] || '🎁';
}
function categoryColor(index) { return ['#fdf4dc','#e7f0ff','#faeaf0','#e5f8ee','#f1eaff','#fff1e8'][index % 6]; }
function productCard(p) {
  const productUrl = `/products/${esc(p.slug || p.id)}`;
  return `<article class="product-card"><div class="product-picture"><a href="${productUrl}" aria-label="View ${esc(p.name)}"><img src="${esc(p.imageUrl||'/assets/products/fallback.png')}" alt="${esc(p.name)}" loading="lazy"></a>${p.featured?'<span class="product-tag">✦ Popular pick</span>':''}<button class="quick-view-trigger" data-view-product="${esc(p.id)}" aria-label="Quick view ${esc(p.name)}">Quick view <span aria-hidden="true">↗</span></button></div><div class="product-content"><div class="product-category">${esc(p.category||'Uncategorized')}</div><h3><a href="${productUrl}" style="color:inherit;text-decoration:none;">${esc(p.name)}</a></h3><p class="short-desc">${esc(p.description)}</p><div class="price-row"><div><b>${fmt(p.price)}</b>${p.stock>0?`<div class="stock-hint">${p.stock<6?`Only ${p.stock} left`:'Ready to ship'}</div>`:'<div class="out-stock">Out of stock</div>'}</div><button class="add-btn" data-add="${esc(p.id)}" aria-label="Add ${esc(p.name)} to cart" ${p.stock===0?'disabled':''}>+</button></div></div></article>`;
}
function renderCategories() {
  const cards = state.categories.map((cat, i) => `<button class="category-card" data-category="${esc(cat.slug)}"><div class="category-icon" style="--category-bg:${categoryColor(i)}">${categoryIcon(cat.slug)}</div><strong>${esc(cat.name)}</strong></button>`).join('');
  $('#categoryGrid').innerHTML = cards;
}
function renderChips() {
  const chips = [{slug:'all',name:'All products'}, ...state.categories];
  $('#filterChips').innerHTML = chips.map(c => `<button data-filter="${esc(c.slug)}" class="chip ${state.filter===c.slug?'active':''}">${esc(c.name)}</button>`).join('');
}
function renderProducts() {
  const items = state.products;
  $('#productsGrid').innerHTML = items.length ? items.map(productCard).join('') : '<div class="empty-state">No products match your search. Try another category.</div>';
  $('#resultCount').textContent = `${state.productTotal} product${state.productTotal===1?'':'s'}`;
  const loadMore = $('#loadMoreProducts');
  if (loadMore) {
    loadMore.hidden = state.products.length >= state.productTotal;
    loadMore.disabled = state.productsLoading;
    loadMore.textContent = state.productsLoading ? 'Loading…' : 'Load more products';
  }
  renderChips();
}

async function loadProductsPage(reset = true) {
  if (!reset && state.productsLoading) return;
  if (reset) state.productRequestId++;
  const requestId = state.productRequestId;
  const page = reset ? 1 : state.productPage + 1;
  state.productsLoading = true;
  renderProducts();
  const params = new URLSearchParams({ limit: '100', page: String(page) });
  if (state.filter !== 'all') params.set('category', state.filter);
  if (state.query) params.set('search', state.query);
  try {
    const result = await api(`/products?${params}`);
    if (requestId !== state.productRequestId) return;
    state.products = reset ? result.products : [...state.products, ...result.products];
    state.productPage = result.page;
    state.productTotal = result.total;
    state.totalPages = result.totalPages;
    renderProducts();
  } catch (error) {
    if (requestId !== state.productRequestId) return;
    if (!reset) toast(error.message);
    else throw error;
  } finally {
    if (requestId === state.productRequestId) {
      state.productsLoading = false;
      renderProducts();
    }
  }
}
function cartDetails() {
  return state.cart.map(item => {
    const product = getProduct(item.productId);
    return product ? { ...product, quantity: item.quantity } : null;
  }).filter(Boolean);
}
function cartIssues() {
  return state.cart.filter(item => {
    const product = getProduct(item.productId);
    return !product || product.stock < item.quantity;
  });
}
function renderCart() {
  const items = cartDetails();
  $('#cartItems').innerHTML = state.cart.length
    ? state.cart.map(item => {
        const p = getProduct(item.productId);
        if (!p) return `<div class="cart-item"><div><strong>Unavailable product</strong><small>This item is no longer listed.</small></div><button class="remove-item" data-remove="${esc(item.productId)}">Remove</button></div>`;
        return `<div class="cart-item"><img src="${esc(p.imageUrl||'/assets/products/fallback.png')}" alt=""><div><strong>${esc(p.name)}</strong><small>${fmt(p.price)}</small>${p.stock<item.quantity?'<small class="out-stock">Only '+p.stock+' left. Update quantity.</small>':''}<div class="qty-controls"><button aria-label="Decrease quantity" data-qty="${esc(p.id)}" data-change="-1">−</button><b>${item.quantity}</b><button aria-label="Increase quantity" data-qty="${esc(p.id)}" data-change="1">+</button></div></div><button class="remove-item" data-remove="${esc(p.id)}">Remove</button></div>`;
      }).join('')
    : '<div class="empty-cart"><span>🛍️</span><strong>Your cart is empty</strong>Find something you love and add it here.</div>';
  $('#cartTotal').textContent = fmt(items.reduce((s, p) => s + p.price * p.quantity, 0));
  $('#checkoutBtn').disabled = items.length === 0 || cartIssues().length > 0;
  updateCartBadge();
}
function showCart() { renderCart(); $('#overlay').hidden = false; $('#cartDrawer').classList.add('open'); $('#cartDrawer').setAttribute('aria-hidden','false'); }
function getProduct(id) {
  return state.products.find(item => item.id === id) || state.productCache.get(id) || null;
}
function closeAll() {
  state.modal = '';
  state.quickViewProduct = null;
  state.quickViewRelated = null;
  state.quickViewRelatedLoading = false;
  state.quickViewRequestId++;
  $('#cartDrawer').classList.remove('open');
  $('#cartDrawer').setAttribute('aria-hidden','true');
  $('#overlay').hidden = true;
  $('#modalHolder').innerHTML = '';
}
function modal(content) {
  $('#cartDrawer').classList.remove('open');
  $('#cartDrawer').setAttribute('aria-hidden','true');
  $('#overlay').hidden = false;
  $('#modalHolder').innerHTML = `<div class="modal${state.modal === 'product' ? ' modal-product' : ''}" role="dialog" aria-modal="true">${content}</div>`;
  $('#modalHolder .close-btn')?.focus();
}
function authModal(isRegister = false) {
  state.modal = isRegister ? 'register' : 'login';
  const googleButton = state.storeConfig?.googleWebClientId ? '<div class="google-signin-box"><div id="googleSignInButton"></div></div><div class="auth-divider"><span>or use your email</span></div>' : '';
  modal(`<div class="modal-head"><div><div class="section-label">WELCOME ${isRegister?'TO IWACUMALL':'BACK'}</div><h2>${isRegister?'Create an account':'Sign in to IwacuMall'}</h2></div><button class="close-btn" data-action="close-overlay" aria-label="Close">×</button></div><p>${isRegister?'Join us to place your first order and track your favorites.':'Welcome back! Let\'s get you shopping.'}</p>${googleButton}<form id="authForm">${isRegister?'<div class="field"><label for="authName">Full name</label><input id="authName" name="name" autocomplete="name" required minlength="2"></div>':''}<div class="field"><label for="authEmail">Email address</label><input id="authEmail" type="email" name="email" autocomplete="email" required></div><div class="field"><label for="authPassword">Password</label><input id="authPassword" name="password" type="password" autocomplete="${isRegister?'new-password':'current-password'}" required minlength="${isRegister?'10':'1'}"></div>${!isRegister?'<div class="field" id="totpField" hidden><label for="totpCode">Authenticator or recovery code</label><input id="totpCode" name="totpCode" autocomplete="one-time-code" autocapitalize="characters" maxlength="16"></div>':''}<p class="form-error" id="authError" hidden></p><button class="btn btn-primary full" type="submit">${isRegister?'Create account':'Sign in'} →</button></form>${!isRegister?'<button class="modal-switch" data-action="forgot-password">Forgot your password?</button>':''}<button class="modal-switch" data-action="${isRegister?'switch-login':'switch-register'}">${isRegister?'Already have an account? Sign in':'New here? Create an account'}</button>`);
  if (googleButton) loadGoogleIdentityButton();
}

function loadGoogleIdentityButton() {
  const clientId = state.storeConfig?.googleWebClientId;
  const button = $('#googleSignInButton');
  if (!clientId || !button) return;
  window.iwacuGoogleCredential = async (response) => {
    if (!response?.credential) return toast('Google did not return a sign-in credential.');
    try {
      const result = await api('/auth/google', { method: 'POST', body: JSON.stringify({ idToken: response.credential }) });
      saveUser(result.user);
      closeAll();
      toast(`Welcome ${result.user.name.split(' ')[0]}!`);
    } catch (error) { toast(error.message); }
  };
  const renderButton = () => {
    if (!window.google?.accounts?.id || !$('#googleSignInButton')) return;
    if (state.googleClientInitialized !== clientId) {
      window.google.accounts.id.initialize({ client_id: clientId, callback: (response) => window.iwacuGoogleCredential?.(response) });
      state.googleClientInitialized = clientId;
    }
    const root = $('#googleSignInButton');
    root.replaceChildren();
    window.google.accounts.id.renderButton(root, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(360, Math.max(220, root.parentElement.clientWidth)) });
  };
  if (window.google?.accounts?.id) return renderButton();
  let script = document.querySelector('script[data-google-identity]');
  if (!script) {
    script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = 'true';
    script.onload = renderButton;
    script.onerror = () => { if ($('#googleSignInButton')) $('#googleSignInButton').textContent = 'Google sign-in is temporarily unavailable.'; };
    document.head.append(script);
  } else {
    script.addEventListener('load', renderButton, { once: true });
    setTimeout(renderButton, 500);
  }
}

function quickViewRelatedMarkup(items, loading = false) {
  if (!items.length && !loading) return '';
  const cards = items.map(item => `<button class="quick-view-related-item" data-related-product="${esc(item.id)}" aria-label="Quick view ${esc(item.name)}"><img src="${esc(item.imageUrl||'/assets/products/fallback.png')}" alt="" loading="lazy" onerror="this.src='/assets/products/fallback.png'"><span>${esc(item.name)}</span><b>${fmt(item.price)}</b></button>`).join('');
  const placeholders = loading && !items.length ? '<span class="quick-view-related-skeleton"></span><span class="quick-view-related-skeleton"></span><span class="quick-view-related-skeleton"></span>' : '';
  return `<div class="quick-view-related" id="quickViewRelated"><strong>You may also like</strong><div class="quick-view-related-list" aria-live="polite">${cards || placeholders}</div></div>`;
}

function quickViewImages(product) {
  const gallery = Array.isArray(product?.images)
    ? product.images.filter(image => image && typeof image.url === 'string' && image.url)
    : [];
  return gallery.length ? gallery : [{ url: product?.imageUrl || '/assets/products/fallback.png', publicId: '' }];
}

function renderQuickView(product, loading = false) {
  state.quickViewProduct = product;
  const images = quickViewImages(product);
  state.quickViewImageIndex = Math.min(state.quickViewImageIndex, images.length - 1);
  const selectedImage = images[state.quickViewImageIndex];
  const thumbnails = images.length > 1 ? `<div class="quick-view-thumbnails" role="group" aria-label="Product photos">${images.map((image, index) => `<button class="quick-view-thumbnail ${index === state.quickViewImageIndex ? 'is-active' : ''}" type="button" data-quick-image="${index}" aria-label="View photo ${index + 1} of ${images.length}" aria-pressed="${index === state.quickViewImageIndex}"><img src="${esc(image.url)}" alt="" loading="lazy" onerror="this.src='/assets/products/fallback.png'"></button>`).join('')}</div>` : '';
  const alreadyInCart = state.cart.find((item) => item.productId === product?.id)?.quantity || 0;
  const availableToAdd = Math.max(0, Number(product?.stock || 0) - alreadyInCart);
  const localRelated = state.products.filter(item => item.id !== product?.id && item.active !== false && item.categorySlug === product?.categorySlug).slice(0, 4);
  const related = state.quickViewRelated ?? localRelated;
  const stock = Math.max(0, Number(product?.stock || 0));
  const stockText = stock <= 0 ? 'Currently out of stock' : stock < 6 ? `Only ${stock} left` : 'In stock';
  const relatedMarkup = !loading ? quickViewRelatedMarkup(related, state.quickViewRelatedLoading) : '';
  modal(`<section class="quick-view"><div class="quick-view-image"><span class="quick-view-image-badge">${product?.featured ? '✦ Popular pick' : esc(product?.category || 'IwacuMall pick')}</span><div class="quick-view-image-stage"><img id="quickViewMainImage" src="${esc(selectedImage.url)}" alt="${esc(product?.name||'Product')}" onerror="this.src='/assets/products/fallback.png'"></div>${thumbnails}</div><div class="quick-view-info"><div class="modal-head"><div><div class="section-label">${esc(product?.category||'IWACUMALL PICK')}</div><h2>${esc(product?.name||'Loading product…')}</h2></div><button class="close-btn" data-action="close-overlay" aria-label="Close product details">×</button></div>${loading?'<div class="quick-view-skeleton" aria-label="Loading product details"></div>':`<div class="quick-view-price">${fmt(product.price)}</div><p class="quick-view-description">${esc(product.description||'A quality everyday find, selected for you.')}</p><div class="quick-view-stock ${stock>0?'available':'unavailable'}" role="status" aria-live="polite">${stockText}</div><div class="quick-view-quantity"><span>Quantity</span><div><button data-quick-qty="-1" aria-label="Decrease quantity" ${state.quickViewQty<=1?'disabled':''}>−</button><b id="quickViewQty" aria-live="polite">${state.quickViewQty}</b><button data-quick-qty="1" aria-label="Increase quantity" ${state.quickViewQty>=availableToAdd?'disabled':''}>+</button></div><strong id="quickViewTotal" aria-live="polite">${fmt(Number(product.price)*state.quickViewQty)}</strong></div><button class="btn btn-primary full" data-quick-add ${availableToAdd<=0?'disabled':''}>Add to cart <span>· ${fmt(Number(product.price)*state.quickViewQty)}</span></button><a class="quick-view-details" href="/products/${esc(product.slug||product.id)}">See full product details →</a>${relatedMarkup}`}</div></section>`);
}

async function openProductQuickView(id) {
  state.modal = 'product';
  const requestId = ++state.quickViewRequestId;
  state.quickViewQty = 1;
  state.quickViewImageIndex = 0;
  state.quickViewRelated = null;
  state.quickViewRelatedLoading = false;
  const cardProduct = getProduct(id) || { id, name: 'Loading product…', stock: 0, price: 0 };
  renderQuickView(cardProduct, true);
  try {
    const result = await api(`/products/${encodeURIComponent(id)}`);
    if (state.modal !== 'product' || requestId !== state.quickViewRequestId) return;
    state.quickViewQty = 1;
    cacheProduct(result.product);
    renderQuickView(result.product);
    if (result.product.categorySlug) void loadQuickViewRecommendations(result.product, requestId);
  } catch (error) {
    if (state.modal !== 'product' || requestId !== state.quickViewRequestId) return;
    state.quickViewProduct = null;
    modal(`<div class="modal-head"><h2>Product unavailable</h2><button class="close-btn" data-action="close-overlay" aria-label="Close">×</button></div><p>${esc(error.message)}</p>`);
  }
}

function cacheProduct(product) {
  if (!product?.id) return;
  state.productCache.set(product.id, product);
}

async function loadQuickViewRecommendations(product, requestId) {
  state.quickViewRelatedLoading = true;
  const host = $('#quickViewRelated');
  if (host) host.outerHTML = quickViewRelatedMarkup(
    state.products.filter(item => item.id !== product.id && item.active !== false && item.categorySlug === product.categorySlug).slice(0, 4),
    true,
  );
  else $('.quick-view-info')?.insertAdjacentHTML('beforeend', quickViewRelatedMarkup([], true));
  try {
    const params = new URLSearchParams({ category: product.categorySlug, limit: '5', page: '1' });
    const result = await api(`/products?${params}`);
    if (state.modal !== 'product' || requestId !== state.quickViewRequestId) return;
    state.quickViewRelated = (result.products || []).filter(item => item.id !== product.id && item.active !== false).slice(0, 4);
    state.quickViewRelated.forEach(cacheProduct);
  } catch {
    state.quickViewRelated = state.products.filter(item => item.id !== product.id && item.active !== false && item.categorySlug === product.categorySlug).slice(0, 4);
  } finally {
    if (state.modal === 'product' && requestId === state.quickViewRequestId) {
      state.quickViewRelatedLoading = false;
      const current = $('#quickViewRelated');
      const markup = quickViewRelatedMarkup(state.quickViewRelated || [], false);
      if (current) current.outerHTML = markup;
      else if (markup) $('.quick-view-info')?.insertAdjacentHTML('beforeend', markup);
    }
  }
}

function forgotPasswordModal() {
  state.modal = 'forgot';
  modal(`<div class="modal-head"><div><div class="section-label">ACCOUNT RECOVERY</div><h2>Reset your password</h2></div><button class="close-btn" data-action="close-overlay" aria-label="Close">×</button></div><p>Enter the email on your account. If it is registered, we will send a reset link.</p><form id="forgotForm"><div class="field"><label for="forgotEmail">Email address</label><input id="forgotEmail" type="email" name="email" autocomplete="email" required></div><p class="form-error" id="forgotError" hidden></p><button class="btn btn-primary full" type="submit">Send reset link</button></form><button class="modal-switch" data-action="switch-login">Back to sign in</button>`);
}
function accountModal() {
  if (!state.user) { authModal(); return; }
  modal(`<div class="modal-head"><div><div class="section-label">YOUR ACCOUNT</div><h2>Hi, ${esc(state.user.name.split(' ')[0])} 👋</h2></div><button class="close-btn" data-action="close-overlay">×</button></div><p>Signed in as ${esc(state.user.email)}</p>${state.user.emailVerified===false?'<p class="form-error" style="display:block">Verify your email before placing an order.</p><button class="btn btn-subtle full" data-action="resend-verification">Resend verification email</button>':''}<a class="btn btn-primary full" href="/orders">View my orders →</a><a class="btn btn-subtle full" style="margin-top:8px" href="/account">Manage profile, addresses and sessions</a>${state.user.role==='ADMIN'?'<a class="btn btn-subtle full" style="margin-top:8px" href="/admin">Admin dashboard →</a>':''}<button class="modal-switch" data-action="logout">Sign out</button>`);
}
function checkoutModal() {
  if (!state.user) { toast('Sign in to place an order'); authModal(); return; }
  const items = cartDetails();
  if (!items.length) { showCart(); return; }

  const cfg = state.storeConfig;
  if (cfg && !cfg.checkoutEnabled) {
    modal(`<div class="modal-head"><div><h2>Checkout unavailable</h2></div><button class="close-btn" data-action="close-overlay">×</button></div><p class="form-error" style="display:block">${esc(cfg.checkoutBlockedReason || 'Checkout is not currently configured. Please contact the store.')}</p>`);
    return;
  }

  const subtotal = items.reduce((s, p) => s + p.price * p.quantity, 0);
  const deliveryFee = Number(cfg?.deliveryFeeFlat ?? 0);
  const taxRate = Number(cfg?.taxRatePercent ?? -1);
  const taxAmount = taxRate >= 0 ? Math.round(subtotal * taxRate / 100) : 0;
  const total = subtotal + deliveryFee + taxAmount;
  const methods  = (state.paymentMethods || []);
  const methodOptions = methods.length
    ? methods.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')
    : '<option value="">No payment methods configured</option>';

  state.modal = 'checkout';
  modal(`<div class="modal-head"><div><div class="section-label">ALMOST THERE</div><h2>Checkout</h2></div><button class="close-btn" data-action="close-overlay">×</button></div><p>${items.length} item(s)</p><div class="checkout-totals"><p>Subtotal <strong>${fmt(subtotal)}</strong></p><p>Delivery <strong>${fmt(deliveryFee)}</strong></p>${taxRate>=0?`<p>Tax (${taxRate}%) <strong>${fmt(taxAmount)}</strong></p>`:''}<p class="checkout-total">Total due <strong>${fmt(total)}</strong></p></div><form id="checkoutForm"><div class="field"><label for="customerName">Full name</label><input id="customerName" name="customerName" value="${esc(state.user.name)}" required minlength="2"></div><div class="form-two"><div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" inputmode="tel" placeholder="07xx xxx xxx" minlength="8" required></div><div class="field"><label for="city">City</label><input id="city" name="city" value="Kigali" required minlength="2"></div></div><div class="field"><label for="address">Delivery address</label><input id="address" name="address" placeholder="District, sector, street / landmark" required minlength="5"></div><div class="field"><label for="paymentMethodId">Payment method</label><select id="paymentMethodId" name="paymentMethodId" class="form-control" required>${methodOptions}</select></div><div class="field"><label for="note">Order notes (optional)</label><textarea id="note" name="note" placeholder="Anything we should know?"></textarea></div><p class="form-error" id="checkoutError" hidden></p><button type="submit" class="btn btn-primary full">Place order • ${fmt(total)} →</button></form>`);
}

async function handleAuth(form) {
  const payload = Object.fromEntries(new FormData(form));
  const error = $('#authError');
  try {
    const result = await api(state.modal==='register'?'/auth/register':'/auth/login',{method:'POST',body:JSON.stringify(payload)});
    if (result.mfaRequired) {
      const field = $('#totpField');
      if (field) field.hidden = false;
      error.textContent = 'Enter a six-digit authenticator code or a one-use 16-character recovery code.';
      error.hidden = false;
      $('#totpCode')?.focus();
      return;
    }
    saveUser(result.user);
    if (result.emailVerificationRequired) {
      modal(`<div class="modal-head"><div><div class="section-label">CHECK YOUR EMAIL</div><h2>Verify your address</h2></div><button class="close-btn" data-action="close-overlay" aria-label="Close">×</button></div><p>We sent a verification link to ${esc(result.user.email)}. Verify it before placing an order.</p><button class="btn btn-primary full" data-action="resend-verification">Resend verification email</button>`);
    } else {
      closeAll();
      toast(`Welcome ${result.user.name.split(' ')[0]}!`);
      if (result.user.role === 'ADMIN') toast('Admin access enabled');
    }
  } catch(e) { error.textContent = e.message; error.hidden = false; }
}

async function handleForgotPassword(form) {
  const error = $('#forgotError');
  try {
    const result = await api('/auth/forgot-password', {method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    modal(`<div class="modal-head"><div><div class="section-label">ACCOUNT RECOVERY</div><h2>Check your inbox</h2></div><button class="close-btn" data-action="close-overlay">×</button></div><p>${esc(result.message)}</p><button class="btn btn-primary full" data-action="switch-login">Back to sign in</button>`);
  } catch(e) { error.textContent = e.message; error.hidden = false; }
}

async function handleCheckout(form) {
  if (state.checkoutInFlight) return;
  state.checkoutInFlight = true;
  const error = $('#checkoutError');
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Placing order…';
  }

  // Reconcile cart
  const issues = cartIssues();
  if (state.cart.length === 0 || issues.length > 0) {
    state.checkoutInFlight = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Place order →'; }
    error.textContent = issues.length ? 'Your cart has unavailable items or quantities. Close checkout, remove or update those items, then try again.' : 'Your cart is empty.';
    error.hidden = false;
    return;
  }

  const payload = {
    ...Object.fromEntries(new FormData(form)),
    items: state.cart,
  };
  const fingerprint = JSON.stringify(payload);
  let idempotencyKey = sessionStorage.getItem('iwm_checkout_key');
  if (!idempotencyKey || sessionStorage.getItem('iwm_checkout_fingerprint') !== fingerprint) {
    idempotencyKey = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-checkout`;
    sessionStorage.setItem('iwm_checkout_key', idempotencyKey);
    sessionStorage.setItem('iwm_checkout_fingerprint', fingerprint);
  }
  try {
    const result = await api('/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload)
    });
    state.cart = [];
    saveCart();
    closeAll();
    const o = result.order;
    modal(`<div class="modal-head"><div><div class="section-label">ORDER RECEIVED</div><h2>You're all set! 🎉</h2></div><button class="close-btn" data-action="close-overlay">×</button></div>
      <p>Your invoice number is <b>${esc(o.invoiceNumber)}</b>.</p>
      <p><strong>Total due:</strong> ${fmt(o.total)}</p>
      <p><strong>How to pay:</strong> ${esc(o.paymentMethodLabel)}</p>
      <p style="white-space:pre-wrap;font-size:.9rem">${esc(o.paymentInstructions)}</p>
      ${o.paymentDeadline ? `<p style="color:#856404;background:#fff3cd;padding:.6rem;border-radius:8px;">⏰ Pay by: <strong>${new Date(o.paymentDeadline).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})}</strong></p>` : ''}
      <a class="btn btn-primary full" href="/invoice?order=${encodeURIComponent(o.id)}">Open invoice →</a>
      <a class="btn btn-subtle full" style="margin-top:8px" href="/orders">View all orders</a>`);
  } catch(e) {
    error.textContent = e.message;
    error.hidden = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Place order →';
    }
  } finally {
    state.checkoutInFlight = false;
  }
}

async function logout() {
  try { await api('/auth/logout',{method:'POST'}); } catch {}
  clearUser();
  closeAll();
  toast('Signed out successfully');
}

function addToCart(id, quantity = 1, product = null) {
  const p = product || getProduct(id);
  if (!p) return;
  const item = state.cart.find(x => x.productId === id);
  const requested = Math.max(1, Number(quantity) || 1);
  if (item) {
    if (item.quantity >= p.stock) { toast('No more stock available'); return; }
    item.quantity = Math.min(item.quantity + requested, p.stock);
  } else {
    if (p.stock <= 0) { toast('This item is out of stock'); return; }
    state.cart.push({ productId: id, quantity: Math.min(requested, p.stock) });
  }
  saveCart();
  toast(`${p.name} added to cart`);
}

function setQty(id, change) {
  const item = state.cart.find(i => i.productId === id);
  const p    = getProduct(id);
  if (!item || !p) return;
  item.quantity += change;
  if (item.quantity <= 0) state.cart = state.cart.filter(i => i.productId !== id);
  else if (item.quantity > p.stock) { item.quantity = p.stock; toast('You reached the available stock'); }
  saveCart(); renderCart();
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('button,[data-action]');
  if (!target) return;
  if (target.dataset.add)      { addToCart(target.dataset.add); return; }
  if (target.dataset.viewProduct) { await openProductQuickView(target.dataset.viewProduct); return; }
  if (target.dataset.relatedProduct) { await openProductQuickView(target.dataset.relatedProduct); return; }
  if (target.dataset.quickImage !== undefined) {
    const product = state.quickViewProduct;
    const images = quickViewImages(product);
    const index = Number(target.dataset.quickImage);
    if (!Number.isInteger(index) || !images[index]) return;
    state.quickViewImageIndex = index;
    const mainImage = $('#quickViewMainImage');
    if (mainImage) {
      mainImage.src = images[index].url;
      mainImage.alt = `${product?.name || 'Product'} · photo ${index + 1}`;
    }
    document.querySelectorAll('[data-quick-image]').forEach(button => {
      const selected = Number(button.dataset.quickImage) === index;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    return;
  }
  if (target.dataset.quickQty) {
    const product = state.quickViewProduct;
    if (!product) return;
    const inCart = state.cart.find((item) => item.productId === product.id)?.quantity || 0;
    const maxAdd = Math.max(1, Number(product.stock) - inCart);
    state.quickViewQty = Math.max(1, Math.min(maxAdd, state.quickViewQty + Number(target.dataset.quickQty)));
    $('#quickViewQty').textContent = state.quickViewQty;
    $('#quickViewTotal').textContent = fmt(Number(product.price) * state.quickViewQty);
    const addButton = $('[data-quick-add]');
    if (addButton) addButton.innerHTML = `Add to cart <span>· ${fmt(Number(product.price) * state.quickViewQty)}</span>`;
    const buttons = document.querySelectorAll('[data-quick-qty]');
    if (buttons[0]) buttons[0].disabled = state.quickViewQty <= 1;
    if (buttons[1]) buttons[1].disabled = state.quickViewQty >= maxAdd;
    return;
  }
  if (target.hasAttribute('data-quick-add')) {
    const product = state.quickViewProduct;
    if (!product || product.stock < 1) return;
    addToCart(product.id, state.quickViewQty, product);
    closeAll();
    return;
  }
  if (target.dataset.category || target.dataset.filter) {
    state.filter = target.dataset.category || target.dataset.filter;
    const nextPath = state.filter === 'all' ? '/shop' : `/categories/${encodeURIComponent(state.filter)}`;
    history.pushState({}, '', nextPath);
    await loadProductsPage(true);
    if (target.dataset.category) $('#products').scrollIntoView({behavior:'smooth'});
    return;
  }
  if (target.id === 'loadMoreProducts') { await loadProductsPage(false); return; }
  if (target.dataset.qty)      { setQty(target.dataset.qty, Number(target.dataset.change)); return; }
  if (target.dataset.remove)   { state.cart = state.cart.filter(i => i.productId !== target.dataset.remove); saveCart(); renderCart(); return; }
  switch (target.id || target.dataset.action) {
    case 'focusSearch':    $('#searchInput').focus(); $('#products').scrollIntoView({behavior:'smooth'}); break;
    case 'accountBtn': case 'open-account': accountModal(); break;
    case 'cartBtn':        showCart(); break;
    case 'checkoutBtn':    checkoutModal(); break;
    case 'close-overlay':  closeAll(); break;
    case 'switch-register':authModal(true); break;
    case 'switch-login':   authModal(false); break;
    case 'forgot-password': forgotPasswordModal(); break;
    case 'resend-verification':
      try { await api('/auth/resend-verification',{method:'POST',body:JSON.stringify({})}); toast('If verification is needed, a fresh email has been sent'); }
      catch(error) { toast(error.message); }
      break;
    case 'logout':         await logout(); break;
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'authForm')     { e.preventDefault(); await handleAuth(e.target); }
  if (e.target.id === 'forgotForm')   { e.preventDefault(); await handleForgotPassword(e.target); }
  if (e.target.id === 'checkoutForm') { e.preventDefault(); await handleCheckout(e.target); }
});
$('#overlay').addEventListener('click', closeAll);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void loadProductsPage(true); }, 250);
});
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/categories\/([^/]+)$/);
  state.filter = match ? decodeURIComponent(match[1]) : 'all';
  void loadProductsPage(true);
});
$('#year').textContent = new Date().getFullYear();
updateCartBadge();

function applyStoreConfig(config) {
  if (!config) return;
  state.storeConfig    = config;
  state.googleClientInitialized = '';
  state.paymentMethods = config.paymentMethods || [];
  const address = $('#footerStoreAddress'), phone = $('#footerStorePhone');
  if (address) { address.textContent = config.storeAddress||''; address.href = `https://maps.google.com/?q=${encodeURIComponent(config.storeAddress||'')}`; }
  if (phone) { const v = String(config.storePhone||''); const d = v.replace(/\D/g,''); const dial = v.startsWith('+') ? `+${d}` : d.startsWith('0') ? `+250${d.slice(1)}` : `+${d}`; phone.textContent = v; phone.href = `tel:${dial}`; }
}

(async () => {
  try {
    const [categories, config] = await Promise.all([
      api('/categories'), api('/config').catch(() => null),
    ]);
    state.categories = categories.categories;
    applyStoreConfig(config);
    renderCategories();
    await loadProductsPage(true);
    // Validate and restore session via /me (cookie is sent automatically)
    try {
      const { user } = await api('/me');
      saveUser(user);
    } catch (authErr) {
      if (sessionStorage.getItem('iwm_user')) {
        clearUser();
      }
    }
  } catch (e) {
    $('#productsGrid').innerHTML = `<div class="empty-state">Could not connect to the store API: ${esc(e.message)}</div>`;
    $('#categoryGrid').innerHTML = '<div class="empty-state">Categories are temporarily unavailable.</div>';
    toast('Unable to load products');
  }
})();

if (new URLSearchParams(location.search).get('verified') === '1') {
  history.replaceState(null, '', location.pathname);
  toast('Email verified. You can now place orders.');
}
