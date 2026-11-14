const $ = selector => document.querySelector(selector);
const fmt = amount => `RWF ${Number(amount || 0).toLocaleString('en-US')}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let currentProduct = null;
let selectedQty = 1;
let selectedVariantId = '';

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 3000);
}

function variants() { return Array.isArray(currentProduct?.variants) ? currentProduct.variants : []; }
function selectedVariant() { return variants().find(variant => variant.id === selectedVariantId) || null; }
function tracksInventory() { return currentProduct?.trackInventory === true; }
function quantityLimit() { return tracksInventory() ? Math.max(0, Math.min(100, Number(currentProduct?.stock || 0))) : 100; }
function cartItems() {
  try { return JSON.parse(sessionStorage.getItem('iwm_cart') || localStorage.getItem('iwm_cart') || '[]'); }
  catch { return []; }
}
function reservedQuantity() {
  return cartItems().filter(item => item.productId === currentProduct?.id).reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function updateVariantDisplay() {
  const variant = selectedVariant();
  const price = variant ? variant.price : currentProduct.price;
  $('#productPrice').textContent = fmt(price);
  document.querySelectorAll('[data-product-variant]').forEach(label => {
    const input = label.querySelector('input');
    const active = input?.value === selectedVariantId;
    label.classList.toggle('is-selected', active);
    if (input) input.checked = active;
  });
  const availableToAdd = Math.max(0, quantityLimit() - reservedQuantity());
  $('#btnPlus').disabled = selectedQty >= availableToAdd;
  $('#btnMinus').disabled = selectedQty <= 1;
  const hasVariants = variants().length > 0;
  $('#addToCartBtn').disabled = availableToAdd < 1;
  $('#addToCartBtn').textContent = hasVariants ? 'Choose options in quick view →' : `Add to cart · ${fmt(Number(price) * selectedQty)} →`;
}

function render() {
  if (!currentProduct) return;
  $('#productLoading').style.display = 'none';
  $('#productContainer').style.display = 'grid';
  document.title = `${currentProduct.name} | IwacuMall`;
  $('#productImage').src = currentProduct.imageUrl || '/assets/products/fallback.png';
  $('#productImage').alt = currentProduct.name;
  $('#productCategory').textContent = currentProduct.category || currentProduct.categorySlug || 'Everyday Essentials';
  $('#productTitle').textContent = currentProduct.name;
  $('#productConditionBadge').hidden = currentProduct.isSecondHand !== true;
  $('#productConditionBadge').textContent = currentProduct.isSecondHand === true ? 'Pre-owned · previously owned' : '';
  $('#productDescription').textContent = currentProduct.description || 'Quality product available at IwacuMall.';
  const allVariants = variants();
  const variantSection = $('#productVariantSection');
  variantSection.hidden = allVariants.length === 0;
  $('#productVariantsHeading').textContent = allVariants.length ? `All available options (${allVariants.length})` : 'Choose your option';
  $('#productVariantList').innerHTML = allVariants.map(variant => `
    <label class="product-detail-variant" data-product-variant>
      <input type="radio" name="productVariant" value="${esc(variant.id)}" aria-label="${esc(variant.type)}: ${esc(variant.value)}">
      <span><small>${esc(variant.type)}</small><strong>${esc(variant.value)}</strong></span>
      <b>${fmt(variant.price)}</b>
    </label>`).join('');
  document.querySelector('.product-qty-row').hidden = allVariants.length > 0;
  const stockBadge = $('#productStockBadge');
  if (!tracksInventory() || currentProduct.stock > 0) {
    stockBadge.textContent = tracksInventory() ? `In stock (${currentProduct.stock} available)` : 'Available';
    stockBadge.className = 'product-detail-stock stock-in';
  } else {
    stockBadge.textContent = 'Out of stock';
    stockBadge.className = 'product-detail-stock stock-out';
  }
  updateVariantDisplay();
}

async function load() {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const slug = pathParts[0] === 'products'
    ? pathParts[1]
    : new URLSearchParams(window.location.search).get('slug');
  if (!slug) {
    $('#productLoading').style.display = 'none';
    $('#productError').style.display = 'block';
    return;
  }
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error('Product not found');
    const data = await response.json();
    currentProduct = data.product;
    selectedVariantId = '';
    render();
  } catch {
    $('#productLoading').style.display = 'none';
    $('#productContainer').style.display = 'none';
    $('#productError').style.display = 'block';
  }
}

$('#productVariantList').addEventListener('change', event => {
  const input = event.target.closest('input[name="productVariant"]');
  if (!input) return;
  selectedVariantId = input.value;
  updateVariantDisplay();
});

$('#btnMinus').addEventListener('click', () => {
  if (selectedQty > 1) selectedQty--;
  $('#qtyText').textContent = selectedQty;
  updateVariantDisplay();
});

$('#btnPlus').addEventListener('click', () => {
  if (!currentProduct) return;
  if (selectedQty < quantityLimit() - reservedQuantity()) {
    selectedQty++;
    $('#qtyText').textContent = selectedQty;
    updateVariantDisplay();
  } else toast('Maximum quantity reached');
});

$('#addToCartBtn').addEventListener('click', () => {
  if (!currentProduct) return;
  if (variants().length) {
    window.location.href = `/?quickView=${encodeURIComponent(currentProduct.id)}#products`;
    return;
  }
  if (tracksInventory() && currentProduct.stock <= 0) return;
  const variant = selectedVariant();
  const allVariants = variants();
  if (allVariants.length && !variant) { toast('Choose an available option first'); return; }
  const cart = cartItems();
  const variantId = variant?.id || '';
  const existingIndex = cart.findIndex(item => item.productId === currentProduct.id && (item.variantId || '') === variantId);
  const otherQuantity = cart.filter(item => item.productId === currentProduct.id && (item.variantId || '') !== variantId)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
  const remaining = Math.max(0, quantityLimit() - otherQuantity);
  if (remaining <= 0) { toast('Maximum quantity reached'); return; }
  if (existingIndex >= 0) cart[existingIndex].quantity = Math.min(Number(cart[existingIndex].quantity || 0) + selectedQty, remaining);
  else cart.push({ productId: currentProduct.id, ...(variant ? { variantId } : {}), quantity: Math.min(selectedQty, remaining) });
  sessionStorage.setItem('iwm_cart', JSON.stringify(cart));
  sessionStorage.removeItem('iwm_checkout_key');
  sessionStorage.removeItem('iwm_checkout_fingerprint');
  const optionLabel = variant ? ` · ${variant.type}: ${variant.value}` : '';
  toast(`${selectedQty} × ${currentProduct.name}${optionLabel} added to cart!`);
  setTimeout(() => { window.location.href = '/#products'; }, 800);
});

load();
