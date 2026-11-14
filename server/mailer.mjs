/**
 * Email delivery helpers for IwacuMall.
 * SMTP work is performed by the durable outbox worker, never in checkout.
 */

import { createTransport } from 'nodemailer';
import { fileURLToPath } from 'node:url';
import config from './config.mjs';

let _transport = null;
const BRAND_LOGO_PATH = fileURLToPath(new URL('../web/assets/favicon.png', import.meta.url));

export function setMailerTransportForTests(transport) {
  if (!config.isTest) throw new Error('Mailer transport injection is only available in test mode.');
  _transport = transport;
}

export function resetMailerTransportForTests() {
  if (!config.isTest) throw new Error('Mailer transport reset is only available in test mode.');
  _transport = null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeSubject(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160);
}

function formatAmount(value, currency) {
  const amount = Number(value || 0);
  return `${currency} ${Number.isFinite(amount) ? amount.toLocaleString('en-US') : '0'}`;
}

function formatStoreDate(value) {
  if (!value) return 'Not specified';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not specified';
  return date.toLocaleString('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short' });
}

function orderAddress(order) {
  return [order.address, order.city, 'Rwanda'].filter(Boolean).join(', ');
}

function brandEmail({ storeName, title, intro, body, store, invoiceUrl = '' }) {
  const esc = escapeHtml;
  const contact = [store.address, store.phone, store.email].filter(Boolean);
  const contactHtml = contact.map(value => `<div style="margin:3px 0">${esc(value)}</div>`).join('');
  const invoiceLink = invoiceUrl
    ? `<a href="${esc(invoiceUrl)}" style="display:inline-block;background:#1455D9;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">View your order and invoice</a>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#172554"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6fb;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #e5ebf5;border-radius:16px;overflow:hidden"><tr><td style="background:#081f62;padding:22px 28px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td><img src="cid:iwacumall-logo" width="52" height="52" alt="IwacuMall" style="display:block;border:0;border-radius:12px"></td><td style="padding-left:14px;color:#fff"><div style="font-size:22px;font-weight:800">${esc(storeName)}</div><div style="font-size:12px;color:#d9e5ff;margin-top:4px">Your home for everyday shopping</div></td></tr></table></td></tr><tr><td style="padding:30px 28px 12px"><div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#1455D9;font-weight:800">${esc(storeName)}</div><h1 style="font-size:25px;line-height:1.25;margin:8px 0 12px;color:#081f62">${esc(title)}</h1><p style="font-size:15px;line-height:1.7;margin:0;color:#475569">${esc(intro)}</p></td></tr><tr><td style="padding:18px 28px 28px">${body}${invoiceLink ? `<div style="margin:24px 0 8px">${invoiceLink}</div>` : ''}<div style="border-top:1px solid #e7edf6;margin-top:26px;padding-top:20px;color:#475569;font-size:14px;line-height:1.65"><div>With appreciation,</div><strong style="color:#081f62">${esc(storeName)} Customer Care</strong>${contactHtml ? `<div style="margin-top:8px;font-size:12px;color:#64748b">${contactHtml}</div>` : ''}</div></td></tr><tr><td style="background:#f8faff;padding:16px 28px;color:#718096;font-size:11px;line-height:1.6">This email relates to an order placed with ${esc(storeName)}. Please keep your invoice and payment reference for your records.</td></tr></table></td></tr></table></body></html>`;
}

function logoAttachment() {
  return { filename: 'iwacumall-logo.png', path: BRAND_LOGO_PATH, cid: 'iwacumall-logo' };
}

function getTransport() {
  if (_transport) return _transport;
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) return null;
  _transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return _transport;
}

export async function sendMail({ to, subject, text, html, attachments }) {
  const transport = getTransport();
  if (!transport) {
    const masked = String(to || '').replace(/(.{2}).*@/, '$1***@');
    console.warn('[mailer] SMTP not configured — email not sent to', masked);
    return { ok: false, error: 'SMTP not configured' };
  }
  try {
    await transport.sendMail({
      from: config.smtpFrom || config.smtpUser,
      to,
      subject: safeSubject(subject),
      text,
      html: html || undefined,
      attachments: attachments || undefined,
    });
    return { ok: true };
  } catch (error) {
    console.error('[mailer] send failed:', error?.code || 'SMTP_ERROR');
    return { ok: false, error: error?.code || 'SMTP delivery failed' };
  }
}

/** Send the email-verification link to a user. */
export async function sendVerificationEmail(email, token) {
  const link = `${config.appBaseUrl || ''}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const storeName = escapeHtml(config.storeName);
  return sendMail({
    to: email,
    subject: `Verify your ${config.storeName} account`,
    text: `Click the link below to verify your email address:\n\n${link}\n\nThis link expires in 24 hours.`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#081F62"><h2>Welcome to ${storeName}!</h2><p>Click the link below to verify your email address and activate your account:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#1455D9;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Verify email</a></p><p style="font-size:12px;color:#718096">Link expires in 24 hours. If you did not create an account, ignore this email.</p></div>`,
  });
}

/** Send a password-reset link. */
export async function sendPasswordResetEmail(email, token) {
  const link = `${config.appBaseUrl || ''}/reset-password?token=${encodeURIComponent(token)}`;
  const storeName = escapeHtml(config.storeName);
  return sendMail({
    to: email,
    subject: `Reset your ${config.storeName} password`,
    text: `Click the link below to reset your password:\n\n${link}\n\nThis link expires in 1 hour and can only be used once.`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#081F62"><h2>Password reset request</h2><p>Use the link below to reset your ${storeName} password:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#1455D9;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Reset password</a></p><p style="font-size:12px;color:#718096">Link expires in 1 hour and can only be used once. If you did not request this, ignore this email.</p></div>`,
  });
}

/** Send one recipient copy from an invoice outbox event. */
export async function sendOrderInvoiceEmail(order, storeSettings = {}, pdfBuffer, recipient) {
  const store = order.sellerSnapshot || storeSettings;
  const storeName = store.storeName || store.name || config.storeName;
  const storeAddress = store.address || store.storeAddress || config.storeAddress;
  const storePhone = store.phone || store.storePhone || config.storePhone;
  const storeEmail = store.email || store.storeEmail || config.storeEmail;
  const currency = order.currency || config.currency || 'RWF';
  const snapshot = order.paymentMethodSnapshot || {};
  const recipientIsStore = recipient.kind === 'STORE';
  const invoiceUrl = `${(config.appBaseUrl || '').replace(/\/+$/, '')}/invoice?order=${encodeURIComponent(order.id)}`;
  const deadline = formatStoreDate(order.paymentDeadline);
  const createdAt = formatStoreDate(order.createdAt);
  const amount = value => formatAmount(value, currency);
  const items = (order.items || []).map(item => ({
    name: `${String(item.productName || item.productId || 'Item')}${item.isSecondHand === true ? ' · Pre-owned' : ''}`,
    quantity: Number(item.quantity || 1),
    unitPrice: Number(item.unitPrice || 0),
  }));
  const address = orderAddress(order);

  const text = [
    recipientIsStore ? `A new order was received by ${storeName}.` : `Thank you for shopping with ${storeName}, ${order.customerName || 'valued customer'}.`,
    recipientIsStore ? 'A copy of the order invoice is attached for your records.' : 'Your order has been placed. The attached PDF contains your invoice and payment instructions.',
    '',
    `Invoice number: ${order.invoiceNumber || '—'}`,
    `Order date: ${createdAt}`,
    `Customer: ${order.customerName || '—'}`,
    `Customer email: ${order.customerEmail || '—'}`,
    `Phone: ${order.phone || '—'}`,
    `Delivery address: ${address || '—'}`,
    '',
    'ORDER SUMMARY',
    ...items.map(item => `- ${item.name} × ${item.quantity} at ${amount(item.unitPrice)}: ${amount(item.unitPrice * item.quantity)}`),
    '',
    `Subtotal: ${amount(order.subtotal)}`,
    `Delivery fee: ${Number(order.deliveryFee || 0) === 0 ? 'FREE' : amount(order.deliveryFee)}`,
    `Tax / VAT: ${amount(order.taxAmount)}`,
    `Total: ${amount(order.total)}`,
    `Payment status: ${String(order.paymentStatus || 'PENDING').replace(/_/g, ' ')}`,
    `Payment method: ${snapshot.label || 'Manual payment'}`,
    `Payment account name: ${snapshot.accountName || 'See payment instructions'}`,
    `Payment account / number: ${snapshot.accountNumber || 'See payment instructions'}`,
    `Payment instructions: ${snapshot.instructions || 'See attached invoice.'}`,
    `Required payment reference: ${order.invoiceNumber || '—'}`,
    `Payment deadline: ${deadline}`,
    ...(recipientIsStore && order.note ? ['', `Customer delivery note: ${order.note}`] : []),
    '',
    recipientIsStore ? 'IwacuMall Order Desk' : 'With appreciation,',
    recipientIsStore ? storeName : `${storeName} Customer Care`,
    storePhone || '',
    storeEmail || '',
    invoiceUrl ? `View order and invoice: ${invoiceUrl}` : '',
  ].join('\n');

  const esc = escapeHtml;
  const itemRows = items.map(item => `<tr><td style="padding:11px 8px;border-bottom:1px solid #e8edf5;color:#26364f">${esc(item.name)}<div style="margin-top:3px;font-size:12px;color:#718096">${item.quantity} × ${amount(item.unitPrice)}</div></td><td style="padding:11px 8px;border-bottom:1px solid #e8edf5;text-align:right;font-weight:700;white-space:nowrap">${amount(item.unitPrice * item.quantity)}</td></tr>`).join('');
  const addressCard = `<div style="border:1px solid #e5ebf5;border-radius:10px;padding:14px;margin:16px 0"><strong style="color:#081f62">${recipientIsStore ? 'Customer and delivery details' : 'Delivery details'}</strong><div style="margin-top:8px;line-height:1.65;color:#475569">${esc(order.customerName || 'Customer')}<br><a href="mailto:${esc(order.customerEmail || '')}" style="color:#1455D9">${esc(order.customerEmail || 'Email not available')}</a><br>${esc(order.phone || 'Phone not provided')}<br>${esc(address || 'Delivery address not provided')}</div></div>`;
  const totals = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;color:#475569"><tr><td style="padding:5px 0">Subtotal</td><td align="right">${amount(order.subtotal)}</td></tr><tr><td style="padding:5px 0">Delivery</td><td align="right">${Number(order.deliveryFee || 0) === 0 ? 'FREE' : amount(order.deliveryFee)}</td></tr><tr><td style="padding:5px 0">Tax / VAT</td><td align="right">${amount(order.taxAmount)}</td></tr><tr><td colspan="2" style="border-top:1px solid #dce4f0;padding-top:12px"></td></tr><tr><td style="font-weight:800;font-size:17px;color:#081f62">Total due</td><td align="right" style="font-weight:800;font-size:17px;color:#1455D9">${amount(order.total)}</td></tr></table>`;
  const payment = `<div style="background:#fffdf5;border:1px solid #f2d46f;border-radius:10px;padding:16px;margin-top:18px"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#956d00;font-weight:800">${recipientIsStore ? 'Payment details sent to customer' : 'Payment instructions'}</div><h2 style="font-size:16px;margin:7px 0 10px;color:#081f62">${esc(snapshot.label || 'Manual payment')}</h2><div style="white-space:pre-wrap;line-height:1.65;color:#334155">${esc(snapshot.instructions || 'Please contact the store for payment instructions.')}</div><div style="margin-top:12px;line-height:1.75;color:#334155">Account name: <strong>${esc(snapshot.accountName || 'As stated above')}</strong><br>Account / number: <strong>${esc(snapshot.accountNumber || 'As stated above')}</strong><br>Payment reference: <strong>${esc(order.invoiceNumber || '—')}</strong><br>Pay by: <strong>${esc(deadline)}</strong><br>Payment status: <strong>${esc(String(order.paymentStatus || 'PENDING').replace(/_/g, ' '))}</strong></div></div>`;
  const body = `<p style="margin:0 0 16px;color:#475569;line-height:1.65">Invoice <strong style="color:#081f62">${esc(order.invoiceNumber || '—')}</strong><br>Order date: ${esc(createdAt)}</p>${addressCard}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5ebf5;border-radius:10px;overflow:hidden"><thead><tr style="background:#f7f9fd;color:#5d6b82;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px"><th style="padding:10px 8px">Item</th><th style="padding:10px 8px;text-align:right">Amount</th></tr></thead><tbody>${itemRows || '<tr><td colspan="2" style="padding:12px">No item details available</td></tr>'}</tbody></table>${totals}${payment}${recipientIsStore && order.note ? `<div style="margin-top:16px;padding:12px;background:#f8faff;border-radius:8px"><strong>Customer delivery note</strong><div style="white-space:pre-wrap;margin-top:5px">${esc(order.note)}</div></div>` : ''}<p style="font-size:12px;line-height:1.6;color:#64748b;margin-top:18px">The detailed PDF invoice is attached. Keep invoice <strong>${esc(order.invoiceNumber || '—')}</strong> as your payment reference and proof of purchase.</p>`;
  const html = brandEmail({
    storeName,
    title: recipientIsStore ? 'A new order has arrived' : 'Thank you for your order',
    intro: recipientIsStore
      ? `A customer placed an order with ${storeName}. The invoice and customer details are included below.`
      : `Hello ${order.customerName || 'there'}, your order is recorded. Your itemized invoice and the payment guide are ready below.`,
    body,
    store: { address: storeAddress, phone: storePhone, email: storeEmail },
    invoiceUrl,
  });
  return sendMail({
    to: recipient.email,
    subject: recipientIsStore ? `[New order] ${order.invoiceNumber}` : `Order confirmed · ${order.invoiceNumber} | ${storeName}`,
    text,
    html,
    attachments: [{
      filename: `invoice-${String(order.invoiceNumber).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
      contentDisposition: 'attachment',
    }, logoAttachment()],
  });
}

/** Send a durable payment, fulfillment, cancellation, expiry or refund update. */
export async function sendOrderEventEmail(event, recipient) {
  const eventLabels = {
    PAYMENT_CONFIRMED: 'Payment confirmed',
    FULFILLMENT_UPDATED: 'Order fulfillment updated',
    ORDER_CANCELLED: 'Order cancelled',
    ORDER_EXPIRED: 'Invoice expired',
    ORDER_REFUNDED: 'Refund recorded',
    ORDER_RETURN_REQUESTED: 'Return request received',
    ORDER_RETURN_APPROVED: 'Return request approved',
    ORDER_RETURN_REJECTED: 'Return request update',
    ORDER_RETURN_RECEIVED: 'Returned items received',
  };
  const eventLabel = eventLabels[event.eventType] || 'Order update';
  const storeName = String(event.storeName || config.storeName);
  const currency = String(event.currency || config.currency || 'RWF');
  const amount = value => `${currency} ${Number(value || 0).toLocaleString('en-US')}`;
  const orderUrl = `${(config.appBaseUrl || '').replace(/\/+$/, '')}/invoice?order=${encodeURIComponent(event.orderId || '')}`;
  const storeRecipient = recipient.kind === 'STORE';
  const eventStatus = [event.paymentStatus, event.fulfillmentStatus, event.refundStatus, event.returnStatus].filter(Boolean).join(' · ');
  const text = [
    `${eventLabel} for ${event.invoiceNumber || 'your IwacuMall order'}.`,
    `Invoice: ${event.invoiceNumber || '—'}`,
    `Total: ${amount(event.total)}`,
    event.refundedAmount > 0 ? `Refunded to date: ${amount(event.refundedAmount)}` : '',
    `Status: ${eventStatus || 'Updated'}`,
    storeRecipient ? `Customer: ${event.customerName || '—'} · ${event.customerEmail || '—'} · ${event.phone || '—'}` : '',
    storeRecipient && event.detail ? `Details: ${event.detail}` : '',
    orderUrl ? `Order details: ${orderUrl}` : '',
  ].filter(Boolean).join('\n');
  const details = `<div style="border:1px solid #e5ebf5;border-radius:10px;padding:16px;line-height:1.8"><strong>Invoice:</strong> ${escapeHtml(event.invoiceNumber || '—')}<br><strong>Total:</strong> ${amount(event.total)}${event.refundedAmount > 0 ? `<br><strong>Refunded:</strong> ${amount(event.refundedAmount)}` : ''}<br><strong>Status:</strong> ${escapeHtml(eventStatus || 'Updated')}</div>${storeRecipient ? `<div style="margin-top:14px;line-height:1.7"><strong>Customer:</strong> ${escapeHtml(event.customerName)}<br><strong>Email:</strong> ${escapeHtml(event.customerEmail)}<br><strong>Phone:</strong> ${escapeHtml(event.phone)}<br><strong>Delivery:</strong> ${escapeHtml([event.address, event.city, 'Rwanda'].filter(Boolean).join(', '))}${event.detail ? `<br><strong>Details:</strong> ${escapeHtml(event.detail)}` : ''}</div>` : ''}`;
  const html = brandEmail({
    storeName,
    title: eventLabel,
    intro: storeRecipient ? `The order ${event.invoiceNumber || ''} has a new update from the ${storeName} team.` : `Here is the latest update for your order ${event.invoiceNumber || ''}.`,
    body: details,
    store: { address: event.storeAddress || '', phone: event.storePhone || '', email: event.storeEmail || config.storeEmail },
    invoiceUrl: orderUrl,
  });
  return sendMail({
    to: recipient.email,
    subject: `[${storeName}] ${eventLabel} · ${event.invoiceNumber || 'order'}`,
    text,
    html,
    attachments: [logoAttachment()],
  });
}
