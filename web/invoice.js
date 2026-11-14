// web/invoice.js — Invoice viewer for IwacuMall orders
const $ = (sel) => document.querySelector(sel);
const fmt = (amount, currency = 'RWF') => `${currency} ${Number(amount || 0).toLocaleString('en-US')}`;
const esc = (val) => String(val ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(typeof value === 'string' && !value.includes('T') ? value.replace(' ','T')+'Z' : value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});
}

async function loadInvoice() {
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order');
  if (!orderId) {
    $('#invoiceLoading').hidden = true;
    $('#invoiceError').textContent = 'No order specified. Please go to My orders and open an invoice from there.';
    $('#invoiceError').hidden = false;
    return;
  }
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Order not found');
    }
    const { order } = await res.json();
    renderInvoice(order);
  } catch (e) {
    $('#invoiceLoading').hidden = true;
    $('#invoiceError').textContent = e.message;
    $('#invoiceError').hidden = false;
  }
  // Load store config
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.storeName) $('#storeName').textContent = cfg.storeName;
    if (cfg.storeAddress) $('#storeAddress').textContent = cfg.storeAddress;
    if (cfg.storePhone)   $('#storePhone').textContent   = cfg.storePhone;
    if (cfg.storeEmail)   $('#storeEmail').textContent   = cfg.storeEmail;
  } catch {}
}

function renderInvoice(order) {
  $('#invoiceLoading').hidden = true;
  $('#invoiceContent').hidden = false;

  const pdfBtn = $('#downloadPdfBtn');
  if (pdfBtn) {
    pdfBtn.href = `/api/orders/${encodeURIComponent(order.id)}/invoice.pdf`;
  }

  $('#invoiceNumber').textContent = esc(order.invoiceNumber || '—');
  $('#invoiceDate').textContent   = formatDate(order.createdAt);
  $('#customerName').textContent = order.customerName || '—';
  $('#customerEmail').textContent = order.customerEmail || '—';
  $('#customerPhone').textContent = order.phone || '—';
  $('#customerAddress').textContent = [order.address, order.city, 'Rwanda'].filter(Boolean).join(', ') || '—';

  // Payment status pill
  const statusEl = $('#paymentStatusPill');
  statusEl.textContent  = esc((order.paymentStatus || 'PENDING').replace(/_/g,' '));
  statusEl.className    = `status-pill status-${order.paymentStatus || 'PENDING'}`;

  $('#fulfillmentStatusText').textContent = `Fulfillment: ${(order.fulfillmentStatus || order.status || '').replace(/_/g,' ')}`;

  // Items table
  const items = order.items || [];
  const currency = 'RWF';
  $('#itemsBody').innerHTML = items.map(i =>
    `<tr><td style="padding:.35rem 0">${esc(i.productName)}${i.isSecondHand === true ? ' · Pre-owned' : ''}</td><td style="text-align:right">${Number(i.quantity)}</td><td style="text-align:right">${fmt(i.unitPrice,currency)}</td><td style="text-align:right">${fmt(i.unitPrice*i.quantity,currency)}</td></tr>`
  ).join('');

  // Totals
  $('#subtotalCell').textContent = fmt(order.subtotal, currency);
  if (order.deliveryFee > 0) {
    $('#deliveryCell').textContent = fmt(order.deliveryFee, currency);
  } else {
    $('#deliveryRow').style.display = 'none';
  }
  if (order.taxAmount > 0) {
    $('#taxCell').textContent = fmt(order.taxAmount, currency);
  } else {
    $('#taxRow').style.display = 'none';
  }
  $('#totalCell').textContent = fmt(order.total, currency);
  const refundedAmount = Math.max(0, Number(order.refundedAmount || 0));
  if (refundedAmount > 0) {
    $('#refundRow').hidden = false;
    $('#refundCell').textContent = fmt(refundedAmount, currency);
    $('#netAfterRefundRow').hidden = false;
    $('#netAfterRefundCell').textContent = fmt(Math.max(0, Number(order.total || 0) - refundedAmount), currency);
  }

  // Payment method from snapshot
  const snap = order.paymentMethodSnapshot || {};
  $('#paymentMethodLabel').textContent = esc(snap.label || order.paymentMethodLabel || '—');
  const instructionEl = $('#paymentInstructions');
  let instructions = snap.instructions || order.paymentInstructions || '';
  if (snap.accountName)   instructions += `\n\nAccount name: ${snap.accountName}`;
  if (snap.accountNumber) instructions += `\nAccount/number: ${snap.accountNumber}`;
  instructionEl.textContent = instructions || 'Contact the store for payment instructions.';

  // Deadline
  if (order.paymentDeadline && order.paymentStatus === 'PENDING') {
    $('#deadlineText').textContent = formatDate(order.paymentDeadline);
    $('#deadlineBox').hidden = false;
  }

  // Paid notice
  if (order.paymentStatus === 'PAID') {
    $('#paymentBox').style.display = 'none';
    $('#deadlineBox').hidden = true;
    $('#paidNotice').hidden = false;
  }
}

loadInvoice();
document.querySelector('#printInvoice')?.addEventListener('click', () => window.print());
