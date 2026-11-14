// web/app.js — IwacuMall storefront (cookie-based auth edition)
const $ = (selector) => document.querySelector(selector);
const fmt = (amount) => `RWF ${Number(amount || 0).toLocaleString('en-US')}`;
const esc = (val) => String(val ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Browser sessions stay in HttpOnly cookies. Only the native mobile client
// requests a bearer token; the storefront keeps user display data in sessionStorage.
const state = {
  products: [], categories: [], paymentMethods: [], filter: 'all', query: '', condition: 'all', sort: 'featured',
  productCache: new Map(),
  productPage: 1, productTotal: 0, totalPages: 1, productsLoading: false, productRequestId: 0,
  cart: JSON.parse(sessionStorage.getItem('iwm_cart') || localStorage.getItem('iwm_cart') || '[]'),
  user: JSON.parse(sessionStorage.getItem('iwm_user') || 'null'),
  modal: '',
  quickViewProduct: null,
  quickViewVariantId: '',
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
function productVariants(product) { return Array.isArray(product?.variants) ? product.variants : []; }
function variantFor(product, variantId) { return productVariants(product).find(variant => variant.id === variantId) || null; }
function variantLabel(variant) { return variant ? `${variant.type}: ${variant.value}` : ''; }
function tracksInventory(product) { return product?.trackInventory === true; }
function productOrderLimit(product) {
  return tracksInventory(product) ? Math.max(0, Math.min(100, Number(product?.stock || 0))) : 100;
}
function productCanBeOrdered(product) {
  return !!product && product.active !== false && (!tracksInventory(product) || Number(product.stock || 0) > 0);
}
function cartQuantityForProduct(productId) {
  return state.cart.filter(item => item.productId === productId).reduce((total, item) => total + Number(item.quantity || 0), 0);
}
function categoryColor(index) { return ['#fdf4dc','#e7f0ff','#faeaf0','#e5f8ee','#f1eaff','#fff1e8'][index % 6]; }
function productCard(p) {
  const productUrl = `/products/${esc(p.slug || p.id)}`;
  const variants = productVariants(p);
  const canOrder = productCanBeOrdered(p);
  const optionButton = variants.length
    ? `<button class="add-btn product-options-btn" data-view-product="${esc(p.id)}" aria-label="Choose options for ${esc(p.name)}" ${canOrder?'':'disabled'}>↗</button>`
    : `<button class="add-btn" data-add="${esc(p.id)}" aria-label="Add ${esc(p.name)} to cart" ${canOrder?'':'disabled'}>+</button>`;
  const availability = canOrder ? (tracksInventory(p) ? p.stock < 6 ? `Only ${p.stock} left` : 'Ready to ship' : 'Available') : 'Unavailable';
  return `<article class="product-card"><div class="product-picture"><a href="${productUrl}" aria-label="View ${esc(p.name)}"><img src="${esc(p.imageUrl||'/assets/products/fallback.png')}" alt="${esc(p.name)}" loading="lazy"></a>${p.featured?'<span class="product-tag">✦ Popular pick</span>':''}<button class="quick-view-trigger" data-view-product="${esc(p.id)}" aria-label="Quick view ${esc(p.name)}">Quick view <span aria-hidden="true">↗</span></button></div><div class="product-content"><div class="product-category">${esc(p.category||'Uncategorized')}</div>${p.isSecondHand === true ? '<span class="condition-badge">Pre-owned</span>' : ''}<h3><a href="${productUrl}" style="color:inherit;text-decoration:none;">${esc(p.name)}</a></h3><p class="short-desc">${esc(p.description)}</p><div class="price-row"><div><b>${variants.length ? 'From ' : ''}${fmt(p.price)}</b>${variants.length ? `<div class="stock-hint">${variants.length} options</div>` : canOrder?`<div class="stock-hint">${availability}</div>`:'<div class="out-stock">Unavailable</div>'}</div>${optionButton}</div></div></article>`;
}
function renderCategories() {
  const cards = state.categories.map((cat, i) => `<button class="category-card" data-category="${esc(cat.slug)}"><div class="category-icon" style="--category-bg:${categoryColor(i)}">${cat.imageUrl?`<img src="${esc(cat.imageUrl)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${categoryIcon(cat.slug)}'))">`:categoryIcon(cat.slug)}</div><strong>${esc(cat.name)}</strong></button>`).join('');
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
  const pager = $('#productsPagination');
  const previous = $('#previousProducts'), next = $('#nextProducts');
  if (pager) pager.hidden = state.totalPages <= 1;
  if (previous) previous.disabled = state.productsLoading || state.productPage <= 1;
  if (next) next.disabled = state.productsLoading || state.productPage >= state.totalPages;
  const pageInfo = $('#productsPageInfo');
  if (pageInfo) pageInfo.textContent = state.productsLoading ? 'Loading products…' : `Page ${state.productPage} of ${state.totalPages}`;
  renderChips();
}

async function loadProductsPage(requestedPage = 1) {
  state.productRequestId++;
  const requestId = state.productRequestId;
  const page = Math.max(1, Math.min(state.totalPages || 1, Number(requestedPage) || 1));
  state.productsLoading = true;
  renderProducts();
  const params = new URLSearchParams({ limit: '12', page: String(page), sort: state.sort });
  if (state.filter !== 'all') params.set('category', state.filter);
  if (state.query) params.set('search', state.query);
  if (state.condition !== 'all') params.set('condition', state.condition);
  try {
    const result = await api(`/products?${params}`);
    if (requestId !== state.productRequestId) return;
    state.products = result.products;
    state.productPage = result.page;
    state.productTotal = result.total;
    state.totalPages = result.totalPages;
    renderProducts();
  } catch (error) {
    if (requestId !== state.productRequestId) return;
    toast(error.message);
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
    if (!product) return null;
    const variant = variantFor(product, item.variantId);
    return { ...product, price: variant ? variant.price : product.price, selectedVariant: variant, quantity: item.quantity };
  }).filter(Boolean);
}
function cartIssues() {
  const invalidVariant = state.cart.filter(item => {
    const product = getProduct(item.productId);
    if (!product) return true;
    const variants = productVariants(product);
    return product.active === false || (variants.length ? !variantFor(product, item.variantId) : !!item.variantId);
  });
  const totals = new Map();
  for (const item of state.cart) totals.set(item.productId, (totals.get(item.productId) || 0) + Number(item.quantity || 0));
  const stockIssues = [...totals].filter(([productId, quantity]) => {
    const product = getProduct(productId);
    return !product || !productCanBeOrdered(product) || quantity > productOrderLimit(product);
  });
  return [...invalidVariant, ...stockIssues.map(([productId]) => ({ productId }))];
}
function renderCart() {
  const items = cartDetails();
  $('#cartItems').innerHTML = state.cart.length
    ? state.cart.map(item => {
        const p = getProduct(item.productId);
        const variant = variantFor(p, item.variantId);
        const variantId = item.variantId || '';
        const price = variant ? variant.price : p?.price;
        if (!p) return `<div class="cart-item"><div><strong>Unavailable product</strong><small>This item is no longer listed.</small></div><button class="remove-item" data-remove="${esc(item.productId)}" data-remove-variant="${esc(variantId)}">Remove</button></div>`;
        const label = variantLabel(variant);
        const productQty = cartQuantityForProduct(p.id);
        return `<div class="cart-item"><img src="${esc(p.imageUrl||'/assets/products/fallback.png')}" alt=""><div><strong>${esc(p.name)}</strong>${p.isSecondHand === true ? '<small class="condition-badge cart-condition-badge">Pre-owned</small>' : ''}${label?`<small class="cart-variant-label">${esc(label)}</small>`:''}<small>${fmt(price)}</small>${tracksInventory(p)&&p.stock<productQty?'<small class="out-stock">Only '+p.stock+' left across all options.</small>':''}<div class="qty-controls"><button aria-label="Decrease quantity" data-qty="${esc(p.id)}" data-variant-id="${esc(variantId)}" data-change="-1">−</button><b>${item.quantity}</b><button aria-label="Increase quantity" data-qty="${esc(p.id)}" data-variant-id="${esc(variantId)}" data-change="1">+</button></div></div><button class="remove-item" data-remove="${esc(p.id)}" data-remove-variant="${esc(variantId)}">Remove</button></div>`;
      }).join('')
    : '<div class="empty-cart"><span>🛍️</span><strong>Your cart is empty</strong>Find something you love and add it here.</div>';
  $('#cartTotal').textContent = fmt(items.reduce((s, p) => s + p.price * p.quantity, 0));
  $('#checkoutBtn').disabled = items.length === 0 || cartIssues().length > 0;
  updateCartBadge();
}
function showCart() { renderCart(); $('#overlay').hidden = false; $('#cartDrawer').classList.add('open'); $('#cartDrawer').setAttribute('aria-hidden','false'); }
function getProduct(id) {
  return state.productCache.get(id) || state.products.find(item => item.id === id) || null;
}
function closeAll() {
  state.modal = '';
  state.quickViewProduct = null;
  state.quickViewVariantId = '';
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
function syncGoogleSignInOption() {
  if (!['login', 'register'].includes(state.modal)) return;
  const form = $('#authForm');
  if (!form) return;
  let area = $('#googleSignInArea');
  if (!area) {
    form.insertAdjacentHTML('beforebegin', '<div class="google-signin-box" id="googleSignInArea"><div id="googleSignInButton"></div></div><div class="auth-divider" id="googleAuthDivider"><span>or use your email</span></div>');
    area = $('#googleSignInArea');
  }
  const button = $('#googleSignInButton');
  if (!state.storeConfig?.googleWebClientId) {
    if (button) {
      button.textContent = state.storeConfig ? 'Google sign-in is not configured for this store.' : 'Loading Google sign-in…';
      button.classList.add('google-signin-status');
    }
    return;
  }
  loadGoogleIdentityButton();
}
function authModal(isRegister = false) {
  state.modal = isRegister ? 'register' : 'login';
  modal(`<div class="modal-head"><div><div class="section-label">WELCOME ${isRegister?'TO IWACUMALL':'BACK'}</div><h2>${isRegister?'Create an account':'Sign in to IwacuMall'}</h2></div><button class="close-btn" data-action="close-overlay" aria-label="Close">×</button></div><p>${isRegister?'Join us to place your first order and track your favorites.':'Welcome back! Let\'s get you shopping.'}</p><form id="authForm">${isRegister?'<div class="field"><label for="authName">Full name</label><input id="authName" name="name" autocomplete="name" required minlength="2"></div>':''}<div class="field"><label for="authEmail">Email address</label><input id="authEmail" type="email" name="email" autocomplete="email" required></div><div class="field"><label for="authPassword">Password</label><input id="authPassword" name="password" type="password" autocomplete="${isRegister?'new-password':'current-password'}" required minlength="${isRegister?'10':'1'}"></div>${!isRegister?'<div class="field" id="totpField" hidden><label for="totpCode">Authenticator or recovery code</label><input id="totpCode" name="totpCode" autocomplete="one-time-code" autocapitalize="characters" maxlength="16"></div>':''}<p class="form-error" id="authError" hidden></p><button class="btn btn-primary full" type="submit">${isRegister?'Create account':'Sign in'} →</button></form>${!isRegister?'<button class="modal-switch" data-action="forgot-password">Forgot your password?</button>':''}<button class="modal-switch" data-action="${isRegister?'switch-login':'switch-register'}">${isRegister?'Already have an account? Sign in':'New here? Create an account'}</button>`);
  syncGoogleSignInOption();
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
    root.classList.remove('google-signin-status');
    root.replaceChildren();
    window.google.accounts.id.renderButton(root, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(360, Math.max(220, root.parentElement.clientWidth)) });
  };
  if (window.google?.accounts?.id) return renderButton();
  const renderWhenReady = (attempt = 0) => {
    if (window.google?.accounts?.id) return renderButton();
    if (attempt >= 20) {
      const root = $('#googleSignInButton');
      if (root) {
        root.textContent = 'Google sign-in could not load. Check your connection and OAuth setup.';
        root.classList.add('google-signin-status');
      }
      return;
    }
    setTimeout(() => renderWhenReady(attempt + 1), 250);
  };
  let script = document.querySelector('script[data-google-identity]');
  if (!script) {
    script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = 'true';
    script.onload = () => renderWhenReady();
    script.onerror = () => {
      const root = $('#googleSignInButton');
      if (root) {
        root.textContent = 'Google sign-in could not load. Check your connection and OAuth setup.';
        root.classList.add('google-signin-status');
      }
    };
    document.head.append(script);
  } else {
    renderWhenReady();
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
  const variants = productVariants(product);
  if (variants.length && !variants.some(variant => variant.id === state.quickViewVariantId)) state.quickViewVariantId = '';
  if (!variants.length) state.quickViewVariantId = '';
  const selectedVariant = variantFor(product, state.quickViewVariantId);
  const unitPrice = selectedVariant ? selectedVariant.price : Number(product?.price || 0);
  const variantMarkup = variants.length ? `<section class="quick-view-variants" aria-labelledby="quickViewVariantsHeading"><div class="quick-view-variants-heading"><strong id="quickViewVariantsHeading">Choose an option</strong><span>All ${variants.length} options</span></div><div class="quick-view-variant-list" role="group" aria-label="All ${variants.length} product options">${variants.map(variant => `<button type="button" class="quick-view-variant ${variant.id === selectedVariant?.id ? 'is-selected' : ''}" data-quick-variant="${esc(variant.id)}" aria-pressed="${variant.id === selectedVariant?.id}"><span><small>${esc(variant.type)}</small><strong>${esc(variant.value)}</strong></span><b>${fmt(variant.price)}</b></button>`).join('')}</div><small class="quick-view-variant-note">Choose the exact option you want. Its price will be used in your cart.</small></section>` : '';
  const images = quickViewImages(product);
  state.quickViewImageIndex = Math.min(state.quickViewImageIndex, images.length - 1);
  const selectedImage = images[state.quickViewImageIndex];
  const thumbnails = images.length > 1 ? `<div class="quick-view-thumbnails" role="group" aria-label="Product photos">${images.map((image, index) => `<button class="quick-view-thumbnail ${index === state.quickViewImageIndex ? 'is-active' : ''}" type="button" data-quick-image="${index}" aria-label="View photo ${index + 1} of ${images.length}" aria-pressed="${index === state.quickViewImageIndex}"><img src="${esc(image.url)}" alt="" loading="lazy" onerror="this.src='/assets/products/fallback.png'"></button>`).join('')}</div>` : '';
  const availableToAdd = Math.max(0, productOrderLimit(product) - cartQuantityForProduct(product?.id));
  const localRelated = state.products.filter(item => item.id !== product?.id && item.active !== false && item.categorySlug === product?.categorySlug).slice(0, 4);
  const related = state.quickViewRelated ?? localRelated;
  const stock = Math.max(0, Number(product?.stock || 0));
  const canOrder = productCanBeOrdered(product);
  const stockText = !canOrder ? 'Currently unavailable' : tracksInventory(product) ? stock < 6 ? `Only ${stock} left` : 'In stock' : 'Available';
  const relatedMarkup = !loading ? quickViewRelatedMarkup(related, state.quickViewRelatedLoading) : '';
  modal(`<section class="quick-view"><div class="quick-view-image"><span class="quick-view-image-badge">${product?.featured ? '✦ Popular pick' : esc(product?.category || 'IwacuMall pick')}</span><div class="quick-view-image-stage"><img id="quickViewMainImage" src="${esc(selectedImage.url)}" alt="${esc(product?.name||'Product')}" onerror="this.src='/assets/products/fallback.png'"></div>${thumbnails}</div><div class="quick-view-info"><div class="modal-head"><div><div class="section-label">${esc(product?.category||'IWACUMALL PICK')}</div><h2>${esc(product?.name||'Loading product…')}</h2>${product?.isSecondHand === true ? '<span class="condition-badge quick-view-condition">Pre-owned · previously owned</span>' : ''}</div><button class="close-btn" data-action="close-overlay" aria-label="Close product details">×</button></div>${loading?'<div class="quick-view-skeleton" aria-label="Loading product details"></div>':`<div class="quick-view-price">${fmt(unitPrice)}</div><p class="quick-view-description">${esc(product.description||'A quality everyday find, selected for you.')}</p>${variantMarkup}<div class="quick-view-stock ${canOrder?'available':'unavailable'}" role="status" aria-live="polite">${stockText}</div><div class="quick-view-quantity"><span>Quantity</span><div><button data-quick-qty="-1" aria-label="Decrease quantity" ${state.quickViewQty<=1?'disabled':''}>−</button><b id="quickViewQty" aria-live="polite">${state.quickViewQty}</b><button data-quick-qty="1" aria-label="Increase quantity" ${state.quickViewQty>=availableToAdd?'disabled':''}>+</button></div><strong id="quickViewTotal" aria-live="polite">${fmt(unitPrice*state.quickViewQty)}</strong></div><button class="btn btn-primary full" data-quick-add ${(availableToAdd<=0 || (variants.length>0 && !selectedVariant))?'disabled':''}>${variants.length>0&&!selectedVariant?'Choose an option first':'Add to cart'} <span>· ${fmt(unitPrice*state.quickViewQty)}</span></button><a class="quick-view-details" href="/products/${esc(product.slug||product.id)}">See full product details →</a>${relatedMarkup}`}</div></section>`);
}

async function openProductQuickView(id) {
  state.modal = 'product';
  const requestId = ++state.quickViewRequestId;
  state.quickViewQty = 1;
  state.quickViewVariantId = '';
  state.quickViewImageIndex = 0;
  state.quickViewRelated = null;
  state.quickViewRelatedLoading = false;
  const cardProduct = getProduct(id) || { id, name: 'Loading product…', stock: 0, price: 0 };
  renderQuickView(cardProduct, true);
  try {
    const result = await api(`/products/${encodeURIComponent(id)}`);
    if (state.modal !== 'product' || requestId !== state.quickViewRequestId) return;
    state.quickViewQty = 1;
    state.quickViewVariantId = '';
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

function addToCart(id, quantity = 1, product = null, variantId = '') {
  const p = product || getProduct(id);
  if (!p) return;
  const variants = productVariants(p);
  const variant = variantFor(p, variantId);
  if (variants.length && !variant) { toast('Choose an available option first'); return; }
  if (!variants.length && variantId) { toast('This option is no longer available'); return; }
  if (!productCanBeOrdered(p)) { toast('This product is unavailable'); return; }
  const item = state.cart.find(x => x.productId === id && (x.variantId || '') === (variant?.id || ''));
  const requested = Math.max(1, Number(quantity) || 1);
  const otherQuantity = cartQuantityForProduct(id) - Number(item?.quantity || 0);
  const remaining = Math.max(0, productOrderLimit(p) - otherQuantity);
  if (item) {
    if (item.quantity >= remaining) { toast('Maximum quantity reached for this product'); return; }
    item.quantity = Math.min(item.quantity + requested, remaining);
  } else {
    if (remaining <= 0) { toast('Maximum quantity reached for this product'); return; }
    state.cart.push({ productId: id, ...(variant ? { variantId: variant.id } : {}), quantity: Math.min(requested, remaining) });
  }
  saveCart();
  toast(`${p.name}${variant ? ` · ${variant.type}: ${variant.value}` : ''} added to cart`);
}

function setQty(id, change, variantId = '') {
  const item = state.cart.find(i => i.productId === id && (i.variantId || '') === variantId);
  const p    = getProduct(id);
  if (!item || !p) return;
  const otherQuantity = cartQuantityForProduct(id) - Number(item.quantity || 0);
  item.quantity += change;
  if (item.quantity <= 0) state.cart = state.cart.filter(i => !(i.productId === id && (i.variantId || '') === variantId));
  else if (item.quantity > productOrderLimit(p) - otherQuantity) { item.quantity = Math.max(0, productOrderLimit(p) - otherQuantity); toast('You reached the maximum quantity'); }
  saveCart(); renderCart();
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('button,[data-action]');
  if (!target) return;
  if (target.dataset.add)      { addToCart(target.dataset.add); return; }
  if (target.dataset.viewProduct) { await openProductQuickView(target.dataset.viewProduct); return; }
  if (target.dataset.relatedProduct) { await openProductQuickView(target.dataset.relatedProduct); return; }
  if (target.dataset.quickVariant) {
    const product = state.quickViewProduct;
    if (!product || !variantFor(product, target.dataset.quickVariant)) return;
    state.quickViewVariantId = target.dataset.quickVariant;
    renderQuickView(product);
    return;
  }
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
    const maxAdd = Math.max(1, productOrderLimit(product) - cartQuantityForProduct(product.id));
    state.quickViewQty = Math.max(1, Math.min(maxAdd, state.quickViewQty + Number(target.dataset.quickQty)));
    const selectedVariant = variantFor(product, state.quickViewVariantId);
    const unitPrice = selectedVariant ? selectedVariant.price : Number(product.price);
    $('#quickViewQty').textContent = state.quickViewQty;
    $('#quickViewTotal').textContent = fmt(unitPrice * state.quickViewQty);
    const addButton = $('[data-quick-add]');
    if (addButton) {
      const needsVariant = productVariants(product).length > 0 && !selectedVariant;
      addButton.disabled = !productCanBeOrdered(product) || state.quickViewQty > maxAdd || needsVariant;
      addButton.innerHTML = `${needsVariant ? 'Choose an option first' : 'Add to cart'} <span>· ${fmt(unitPrice * state.quickViewQty)}</span>`;
    }
    const buttons = document.querySelectorAll('[data-quick-qty]');
    if (buttons[0]) buttons[0].disabled = state.quickViewQty <= 1;
    if (buttons[1]) buttons[1].disabled = state.quickViewQty >= maxAdd;
    return;
  }
  if (target.hasAttribute('data-quick-add')) {
    const product = state.quickViewProduct;
    if (!product || !productCanBeOrdered(product) || (productVariants(product).length > 0 && !variantFor(product, state.quickViewVariantId))) return;
    addToCart(product.id, state.quickViewQty, product, state.quickViewVariantId);
    closeAll();
    return;
  }
  if (target.dataset.category || target.dataset.filter) {
    state.filter = target.dataset.category || target.dataset.filter;
    const nextPath = state.filter === 'all' ? '/shop' : `/categories/${encodeURIComponent(state.filter)}`;
    history.pushState({}, '', nextPath);
    await loadProductsPage(1);
    if (target.dataset.category) $('#products').scrollIntoView({behavior:'smooth'});
    return;
  }
  if (target.id === 'previousProducts') { await loadProductsPage(state.productPage - 1); return; }
  if (target.id === 'nextProducts') { await loadProductsPage(state.productPage + 1); return; }
  if (target.dataset.qty)      { setQty(target.dataset.qty, Number(target.dataset.change), target.dataset.variantId || ''); return; }
  if (target.dataset.remove)   { const variantId = target.dataset.removeVariant || ''; state.cart = state.cart.filter(i => !(i.productId === target.dataset.remove && (i.variantId || '') === variantId)); saveCart(); renderCart(); return; }
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
  searchTimer = setTimeout(() => { void loadProductsPage(1); }, 250);
});
$('#conditionFilter')?.addEventListener('change', event => {
  state.condition = event.target.value;
  void loadProductsPage(1);
});
$('#sortFilter')?.addEventListener('change', event => {
  state.sort = event.target.value;
  void loadProductsPage(1);
});
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/categories\/([^/]+)$/);
  state.filter = match ? decodeURIComponent(match[1]) : 'all';
  void loadProductsPage(1);
});
$('#year').textContent = new Date().getFullYear();
updateCartBadge();

function applyStoreConfig(config) {
  state.storeConfig    = config && typeof config === 'object' ? config : {};
  state.googleClientInitialized = '';
  state.paymentMethods = state.storeConfig.paymentMethods || [];
  syncGoogleSignInOption();
  if (!config) return;
  const address = $('#footerStoreAddress'), phone = $('#footerStorePhone');
  if (address) { address.textContent = state.storeConfig.storeAddress||''; address.href = `https://maps.google.com/?q=${encodeURIComponent(state.storeConfig.storeAddress||'')}`; }
  if (phone) { const v = String(state.storeConfig.storePhone||''); const d = v.replace(/\D/g,''); const dial = v.startsWith('+') ? `+${d}` : d.startsWith('0') ? `+250${d.slice(1)}` : `+${d}`; phone.textContent = v; phone.href = `tel:${dial}`; }
}

(async () => {
  try {
    const [categories, config] = await Promise.all([
      api('/categories'), api('/config').catch(() => null),
    ]);
    state.categories = categories.categories;
    applyStoreConfig(config);
    renderCategories();
    await loadProductsPage(1);
    const requestedQuickView = new URLSearchParams(location.search).get('quickView');
    if (requestedQuickView) void openProductQuickView(requestedQuickView);
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
