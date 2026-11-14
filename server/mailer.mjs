/**
 * Email delivery helpers for IwacuMall.
 * SMTP work is performed by the durable outbox worker, never in checkout.
 */

import { createTransport } from 'nodemailer';
import config from './config.mjs';

let _transport = null;

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
  const currency = order.currency || config.currency || 'RWF';
  const snapshot = order.paymentMethodSnapshot || {};
  const recipientIsStore = recipient.kind === 'STORE';
  const amount = value => `${currency} ${Number(value || 0).toLocaleString('en-US')}`;
  const invoiceUrl = `${(config.appBaseUrl || '').replace(/\/+$/, '')}/invoice?order=${encodeURIComponent(order.id)}`;
  const deadline = order.paymentDeadline
    ? new Date(order.paymentDeadline).toLocaleString('en-GB', { timeZone: 'Africa/Kigali' })
    : 'Not specified';
  const items = (order.items || []).map(item => ({
    name: `${String(item.productName || item.productId || 'Item')}${item.isSecondHand === true ? ' · Pre-owned' : ''}`,
    quantity: Number(item.quantity || 1),
    unitPrice: Number(item.unitPrice || 0),
  }));

  const text = [
    recipientIsStore ? `New IwacuMall order ${order.invoiceNumber}` : `Thank you for your order with ${storeName}.`,
    `Invoice: ${order.invoiceNumber}`,
    `Customer: ${order.customerName} (${order.customerEmail || ''})`,
    `Phone: ${order.phone || '—'}`,
    `Delivery address: ${order.address || '—'}, ${order.city || '—'}`,
    '',
    'Items:',
    ...items.map(item => `- ${item.name} × ${item.quantity}: ${amount(item.unitPrice * item.quantity)}`),
    '',
    `Subtotal: ${amount(order.subtotal)}`,
    `Delivery: ${amount(order.deliveryFee)}`,
    `Tax: ${amount(order.taxAmount)}`,
    `Total due: ${amount(order.total)}`,
    `Payment method: ${snapshot.label || 'Manual payment'}`,
    `Account name: ${snapshot.accountName || 'See payment instructions'}`,
    `Account / number: ${snapshot.accountNumber || 'See payment instructions'}`,
    `Payment instructions: ${snapshot.instructions || 'See attached invoice.'}`,
    `Required payment reference: ${order.invoiceNumber}`,
    `Payment deadline: ${deadline}`,
    `Invoice: ${invoiceUrl}`,
  ].join('\n');

  const esc = escapeHtml;
  const itemRows = items.map(item => `<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(item.name)} × ${item.quantity}</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${amount(item.unitPrice * item.quantity)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172554"><h2 style="color:#1455D9">${esc(storeName)}</h2><h3>${recipientIsStore ? 'New order received' : 'Your order invoice'}</h3><p>Invoice <strong>${esc(order.invoiceNumber)}</strong></p><p>Customer: ${esc(order.customerName)} · ${esc(order.phone)}<br>Delivery: ${esc(order.address)}, ${esc(order.city)}</p><table style="width:100%;border-collapse:collapse">${itemRows}</table><p>Subtotal: ${amount(order.subtotal)}<br>Delivery: ${amount(order.deliveryFee)}<br>Tax: ${amount(order.taxAmount)}<br><strong>Total due: ${amount(order.total)}</strong></p><div style="background:#FFFDF5;border:1px solid #FFC400;border-radius:8px;padding:14px"><strong>How to pay — ${esc(snapshot.label || 'Manual payment')}</strong><p style="white-space:pre-wrap">${esc(snapshot.instructions || 'See attached invoice.')}</p><p>Account name: ${esc(snapshot.accountName || 'See instructions')}<br>Account / number: ${esc(snapshot.accountNumber || 'See instructions')}<br>Reference: <strong>${esc(order.invoiceNumber)}</strong><br>Deadline: ${esc(deadline)}</p></div><p><a href="${esc(invoiceUrl)}">View invoice online</a></p><p style="color:#64748b;font-size:12px">The official PDF invoice is attached.</p></div>`;
  return sendMail({
    to: recipient.email,
    subject: recipientIsStore ? `[New Order] ${order.invoiceNumber}` : `Your ${storeName} invoice ${order.invoiceNumber}`,
    text,
    html,
    attachments: [{
      filename: `invoice-${String(order.invoiceNumber).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
      contentDisposition: 'attachment',
    }],
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
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172554"><h2 style="color:#1455D9">${escapeHtml(storeName)}</h2><h3>${escapeHtml(eventLabel)}</h3><p>Invoice <strong>${escapeHtml(event.invoiceNumber || '—')}</strong></p><p>Total: <strong>${amount(event.total)}</strong>${event.refundedAmount > 0 ? `<br>Refunded to date: ${amount(event.refundedAmount)}` : ''}<br>Status: ${escapeHtml(eventStatus || 'Updated')}</p>${storeRecipient ? `<p>Customer: ${escapeHtml(event.customerName)} · ${escapeHtml(event.customerEmail)} · ${escapeHtml(event.phone)}<br>${escapeHtml(event.address)}, ${escapeHtml(event.city)}${event.detail ? `<br>Details: ${escapeHtml(event.detail)}` : ''}</p>` : ''}<p><a href="${escapeHtml(orderUrl)}">View order details</a></p></div>`;
  return sendMail({
    to: recipient.email,
    subject: `[${storeName}] ${eventLabel} · ${event.invoiceNumber || 'order'}`,
    text,
    html,
  });
}
