const $ = selector => document.querySelector(selector);
let currentProduct = null;
let selectedQty = 1;

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 3000);
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
  $('#productPrice').textContent = `RWF ${Number(currentProduct.price || 0).toLocaleString('en-US')}`;
  $('#productDescription').textContent = currentProduct.description || 'Quality product available at IwacuMall.';
  const stockBadge = $('#productStockBadge');
  if (currentProduct.stock > 0) {
    stockBadge.textContent = `In stock (${currentProduct.stock} available)`;
    stockBadge.className = 'product-detail-stock stock-in';
    $('#addToCartBtn').disabled = false;
  } else {
    stockBadge.textContent = 'Out of stock';
    stockBadge.className = 'product-detail-stock stock-out';
    $('#addToCartBtn').disabled = true;
  }
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
    render();
  } catch {
    $('#productLoading').style.display = 'none';
    $('#productContainer').style.display = 'none';
    $('#productError').style.display = 'block';
  }
}

$('#btnMinus').addEventListener('click', () => {
  if (selectedQty > 1) {
    selectedQty--;
    $('#qtyText').textContent = selectedQty;
  }
});

$('#btnPlus').addEventListener('click', () => {
  if (!currentProduct) return;
  if (selectedQty < currentProduct.stock) {
    selectedQty++;
    $('#qtyText').textContent = selectedQty;
  } else toast('Maximum available stock reached');
});

$('#addToCartBtn').addEventListener('click', () => {
  if (!currentProduct || currentProduct.stock <= 0) return;
  let cart = [];
  try {
    cart = JSON.parse(sessionStorage.getItem('iwm_cart') || localStorage.getItem('iwm_cart') || '[]');
  } catch {}
  const existingIndex = cart.findIndex(item => item.productId === currentProduct.id);
  if (existingIndex >= 0) {
    cart[existingIndex].quantity = Math.min(cart[existingIndex].quantity + selectedQty, currentProduct.stock);
  } else cart.push({ productId: currentProduct.id, quantity: selectedQty });
  sessionStorage.setItem('iwm_cart', JSON.stringify(cart));
  sessionStorage.removeItem('iwm_checkout_key');
  sessionStorage.removeItem('iwm_checkout_fingerprint');
  toast(`${selectedQty} × ${currentProduct.name} added to cart!`);
  setTimeout(() => { window.location.href = '/#products'; }, 800);
});

load();
