fetch('/api/config', { credentials: 'same-origin' })
  .then((response) => response.ok ? response.json() : null)
  .then((config) => {
    if (!config) return;
    document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = config.storeName || 'IwacuMall'; });
    document.querySelectorAll('[data-store-address]').forEach((el) => { el.textContent = config.storeAddress || '[Store address to be confirmed]'; });
    document.querySelectorAll('[data-store-phone]').forEach((el) => {
      el.textContent = config.storePhone || '[Store phone to be confirmed]';
      const digits = String(config.storePhone || '').replace(/\D/g, '');
      if (digits.length >= 8) el.href = `tel:${String(config.storePhone).startsWith('+') ? '+' : '+250'}${String(config.storePhone).startsWith('+') ? digits : digits.replace(/^0/, '')}`;
    });
    document.querySelectorAll('[data-store-email]').forEach((el) => {
      if (!config.storeEmail) { el.textContent = '[Store email to be added]'; return; }
      el.textContent = config.storeEmail;
      el.href = `mailto:${config.storeEmail}`;
    });
    document.querySelectorAll('[data-delivery-fee]').forEach((el) => {
      const fee = Number(config.deliveryFeeFlat);
      el.textContent = Number.isFinite(fee) && fee >= 0 ? `RWF ${fee.toLocaleString('en-US')}` : '[Owner must set delivery pricing]';
    });
    document.querySelectorAll('[data-payment-deadline]').forEach((el) => {
      const hours = Number(config.invoiceExpiryHours);
      el.textContent = Number.isFinite(hours) && hours > 0 ? `${hours} hours` : '[Owner must set a payment deadline]';
    });
  })
  .catch(() => {});
