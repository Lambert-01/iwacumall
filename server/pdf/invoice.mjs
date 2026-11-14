/**
 * server/pdf/invoice.mjs
 * Generates an official, printable IwacuMall PDF invoice from persisted order snapshots.
 */

import PDFDocument from 'pdfkit';

/**
 * Format currency in RWF
 */
function formatMoney(amount, currency = 'RWF') {
  return `${currency} ${Number(amount || 0).toLocaleString('en-US')}`;
}

function formatDate(date) {
  if (!date) return '—';
  try {
    const d = new Date(date);
    return d.toLocaleString('en-GB', {
      timeZone: 'Africa/Kigali',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return String(date);
  }
}

/**
 * Generates invoice PDF buffer.
 * @param {Object} order - Full order object with snapshot and items
 * @param {Object} storeConfig - Store metadata (name, address, phone, email)
 * @returns {Promise<Buffer>}
 */
export function generateInvoicePdf(order, storeConfig = {}) {
  return new Promise((resolve, reject) => {
    try {
      const seller = order.sellerSnapshot || {};
      const storeName = seller.name || seller.storeName || storeConfig.storeName || 'IwacuMall';
      const storeAddress = seller.address || seller.storeAddress || storeConfig.storeAddress || 'Downtown Kigali, Rwanda';
      const storePhone = seller.phone || seller.storePhone || storeConfig.storePhone || '+250788651421';
      const storeEmail = seller.email || seller.storeEmail || storeConfig.storeEmail || '';
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true,
        info: {
          Title: `Invoice ${order.invoiceNumber || order.id}`,
          Author: storeName,
          Subject: 'Order Invoice & Payment Instructions',
          CreationDate: order.createdAt ? new Date(order.createdAt) : new Date(),
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      const primaryBlue = '#1455D9';
      const darkNavy    = '#081F62';
      const textGray    = '#4A5568';
      const lightBg     = '#F6F8FC';
      const goldAccent  = '#EDA900';

      // ─── Header ─────────────────────────────────────────────────────────────
      doc.rect(40, 40, 515, 65).fill(lightBg);

      doc.fillColor(darkNavy).fontSize(22).font('Helvetica-Bold')
        .text(storeName, 55, 52, { width: 250, ellipsis: true });

      doc.fillColor(primaryBlue).fontSize(10).font('Helvetica-Bold')
        .text('ORDER INVOICE & PAYMENT INSTRUCTIONS', 55, 80);

      // Store contact info (right side of header)
      doc.fillColor(textGray).fontSize(8.5).font('Helvetica')
        .text(storeAddress, 330, 50, { align: 'right', width: 210, ellipsis: true })
        .text(`Phone: ${storePhone}`, 330, 64, { align: 'right', width: 210, ellipsis: true })
        .text(storeEmail ? `Email: ${storeEmail}` : '', 330, 78, { align: 'right', width: 210, ellipsis: true });

      doc.moveDown(2);

      // ─── Metadata block ──────────────────────────────────────────────────────
      const startY = 120;
      doc.rect(40, startY, 250, 85).strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.rect(295, startY, 260, 85).strokeColor('#E2E8F0').lineWidth(1).stroke();

      // Left box: Customer Details
      doc.fillColor(darkNavy).fontSize(10).font('Helvetica-Bold').text('BILLED TO:', 50, startY + 10);
      doc.fillColor('#1A202C').fontSize(9).font('Helvetica')
        .text(order.customerName || 'Customer', 50, startY + 26)
        .text(`Phone: ${order.phone || '—'}`, 50, startY + 39)
        .text(`Address: ${order.address || '—'}, ${order.city || 'Kigali'}`, 50, startY + 52, { width: 230 });

      // Right box: Invoice Details
      doc.fillColor(darkNavy).fontSize(10).font('Helvetica-Bold').text('INVOICE DETAILS:', 305, startY + 10);
      doc.fillColor('#1A202C').fontSize(9).font('Helvetica')
        .text(`Invoice Number:`, 305, startY + 26)
        .font('Helvetica-Bold').text(order.invoiceNumber || '—', 410, startY + 26)
        .font('Helvetica').text(`Order Date:`, 305, startY + 39)
        .text(formatDate(order.createdAt), 410, startY + 39)
        .text(`Payment Status:`, 305, startY + 52)
        .fillColor(order.paymentStatus === 'PAID' ? '#22543D' : '#975A16').font('Helvetica-Bold')
        .text((order.paymentStatus || 'PENDING').replace(/_/g, ' '), 410, startY + 52);

      if (order.paymentDeadline && order.paymentStatus === 'PENDING') {
        doc.fillColor('#C53030').fontSize(8).font('Helvetica-Bold')
          .text(`Pay Before: ${formatDate(order.paymentDeadline)}`, 305, startY + 68);
      }

      // ─── Items Table ─────────────────────────────────────────────────────────
      const drawItemsHeader = y => {
        doc.rect(40, y, 515, 22).fill(darkNavy);
        doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold')
          .text('ITEM DESCRIPTION', 50, y + 6)
          .text('QTY', 340, y + 6, { width: 40, align: 'center' })
          .text('UNIT PRICE', 390, y + 6, { width: 75, align: 'right' })
          .text('AMOUNT', 475, y + 6, { width: 70, align: 'right' });
      };
      let tableY = 225;
      drawItemsHeader(tableY);

      tableY += 24;
      const items = order.items || [];
      let isAlt = false;

      for (const item of items) {
        const productName = String(item.productName || item.productId || 'Item');
        doc.font('Helvetica').fontSize(8.5);
        const rowHeight = Math.max(20, Math.ceil(doc.heightOfString(productName, { width: 280 })) + 8);
        if (tableY + rowHeight > 725) {
          doc.addPage();
          tableY = 50;
          drawItemsHeader(tableY);
          tableY += 22;
        }

        if (isAlt) {
          doc.rect(40, tableY, 515, rowHeight).fill('#F7FAFC');
        }

        doc.fillColor('#2D3748').fontSize(8.5).font('Helvetica')
          .text(productName, 50, tableY + 4, { width: 280, height: rowHeight - 6 })
          .text(String(item.quantity || 1), 340, tableY + 5, { width: 40, align: 'center' })
          .text(formatMoney(item.unitPrice), 390, tableY + 5, { width: 75, align: 'right' })
          .font('Helvetica-Bold')
          .text(formatMoney((item.unitPrice || 0) * (item.quantity || 1)), 475, tableY + 5, { width: 70, align: 'right' });

        tableY += rowHeight;
        isAlt = !isAlt;
      }

      if (tableY + 90 > 730) {
        doc.addPage();
        tableY = 55;
      }
      doc.moveTo(40, tableY).lineTo(555, tableY).strokeColor('#CBD5E0').lineWidth(0.5).stroke();
      tableY += 10;

      // ─── Totals ──────────────────────────────────────────────────────────────
      const totalBlockY = tableY;
      const subtotal = order.subtotal || 0;
      const deliveryFee = order.deliveryFee || 0;
      const taxAmount = order.taxAmount || 0;
      const total = order.total || (subtotal + deliveryFee + taxAmount);

      doc.fillColor('#4A5568').fontSize(9).font('Helvetica')
        .text('Subtotal:', 380, totalBlockY, { width: 85, align: 'right' })
        .font('Helvetica-Bold').text(formatMoney(subtotal), 475, totalBlockY, { width: 70, align: 'right' });

      doc.font('Helvetica').text('Delivery Fee:', 380, totalBlockY + 15, { width: 85, align: 'right' })
        .font('Helvetica-Bold').text(deliveryFee > 0 ? formatMoney(deliveryFee) : 'FREE', 475, totalBlockY + 15, { width: 70, align: 'right' });

      if (taxAmount > 0) {
        doc.font('Helvetica').text('Tax / VAT:', 380, totalBlockY + 30, { width: 85, align: 'right' })
          .font('Helvetica-Bold').text(formatMoney(taxAmount), 475, totalBlockY + 30, { width: 70, align: 'right' });
      }

      const grandTotalY = totalBlockY + (taxAmount > 0 ? 45 : 30);
      doc.rect(370, grandTotalY, 185, 24).fill(lightBg);
      doc.fillColor(primaryBlue).fontSize(10).font('Helvetica-Bold')
        .text('TOTAL DUE:', 380, grandTotalY + 6)
        .text(formatMoney(total), 465, grandTotalY + 6, { width: 80, align: 'right' });

      const refundedAmount = Math.max(0, Number(order.refundedAmount || 0));
      if (refundedAmount > 0) {
        doc.fillColor('#7B341E').fontSize(8.5).font('Helvetica')
          .text('Refunded to date:', 380, grandTotalY + 31, { width: 85, align: 'right' })
          .text(formatMoney(refundedAmount), 475, grandTotalY + 31, { width: 70, align: 'right' });
        doc.fillColor('#1A365D').font('Helvetica-Bold')
          .text('NET AFTER REFUNDS:', 355, grandTotalY + 46, { width: 110, align: 'right' })
          .text(formatMoney(Math.max(0, total - refundedAmount)), 475, grandTotalY + 46, { width: 70, align: 'right' });
      }

      tableY = grandTotalY + (refundedAmount > 0 ? 65 : 35);

      // Keep payment instructions inside the page and suppress them for paid,
      // expired, void or cancelled invoices.
      const snapshot = order.paymentMethodSnapshot || {};
      const methodLabel = snapshot.label || order.paymentMethodLabel || 'Manual Payment';
      const payable = order.paymentStatus === 'PENDING';
      let instText = payable
        ? (snapshot.instructions || order.paymentInstructions || 'Please make payment using the invoice number as reference.')
        : order.paymentStatus === 'PAID' ? 'Payment has been confirmed. No further payment is due.'
          : 'This invoice is no longer payable. Contact the store if you need help.';
      if (payable && snapshot.accountName) instText += `\nAccount Name: ${snapshot.accountName}`;
      if (payable && snapshot.accountNumber) instText += `\nAccount / Merchant Number: ${snapshot.accountNumber}`;
      if (payable) instText += `\nRequired Reference: ${order.invoiceNumber}`;
      doc.font('Helvetica').fontSize(8.5);
      const instructionHeight = Math.ceil(doc.heightOfString(instText, { width: 495, lineGap: 3 }));
      const boxHeight = Math.max(84, instructionHeight + 42);

      if (tableY + boxHeight > 730) {
        doc.addPage();
        tableY = 55;
      }

      const instructionsY = tableY;
      doc.rect(40, instructionsY, 515, boxHeight).fillAndStroke('#FFFDF5', goldAccent);

      doc.fillColor(darkNavy).fontSize(10).font('Helvetica-Bold')
        .text(payable ? `PAYMENT INSTRUCTIONS (${methodLabel.toUpperCase()})` : 'INVOICE STATUS', 50, instructionsY + 10, { width: 495, ellipsis: true });

      doc.fillColor('#2D3748').fontSize(8.5).font('Helvetica')
        .text(instText, 50, instructionsY + 28, { width: 495, height: boxHeight - 36, lineGap: 3 });

      // Put a matching footer on every page, including pages added by long
      // product names or payment instructions.
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page);
        doc.fontSize(7.5).fillColor('#718096').font('Helvetica')
          .text(`${storeName} — ${storeAddress}. Tel: ${storePhone}. Invoice ${order.invoiceNumber}. Page ${page - pages.start + 1} of ${pages.count}.`, 40, 780, { align: 'center', width: 515, ellipsis: true });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
