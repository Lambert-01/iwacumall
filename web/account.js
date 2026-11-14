const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' });
};
const state = { user: null, googleClientId: null, googleLoaded: false };

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)iwm_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken() ? { 'X-CSRF-Token': csrfToken() } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function status(message, kind = '') {
  const element = $('#accountStatus');
  element.textContent = message;
  element.className = `account-status ${kind}`;
}

async function loadAddresses() {
  const { addresses } = await api('/me/addresses');
  $('#savedAddresses').innerHTML = addresses.length ? addresses.map(address => `
    <article class="saved-address-card">
      <div><strong>${esc(address.label)} ${address.isDefault ? '<span class="default-address-badge">Default</span>' : ''}</strong>
        <p>${esc(address.recipientName)} · ${esc(address.phone)}<br>${esc(address.address)}, ${esc(address.city)}</p></div>
      <div class="saved-address-actions">${address.isDefault ? '' : `<button class="action-btn" data-default-address="${esc(address.id)}">Make default</button>`}<button class="action-btn danger-btn" data-delete-address="${esc(address.id)}">Remove</button></div>
    </article>`).join('') : '<div class="empty-state">No saved addresses yet. Add one below for a faster checkout.</div>';
}

async function loadSessions() {
  const { sessions } = await api('/me/sessions');
  $('#accountSessions').innerHTML = sessions.length ? sessions.map(session => `
    <article class="account-session-row"><div><strong>${session.isCurrent ? 'This device' : 'Signed-in device'}</strong><small>Started ${esc(dateLabel(session.createdAt))} · Expires ${esc(dateLabel(session.expiresAt))}</small></div>
      ${session.isCurrent ? '<span class="session-current">Current session</span>' : `<button class="action-btn danger-btn" data-revoke-session="${esc(session.id)}">Revoke</button>`}</article>`).join('') : '<div class="empty-state">No active sessions found.</div>';
}

function setGoogleReauthButton() {
  const root = $('#googleReauthButton');
  if (!state.googleClientId || !window.google?.accounts?.id || !root) {
    if (root) root.textContent = 'Google sign-in is not configured on this site yet.';
    return;
  }
  window.iwacuDeleteAccountWithGoogle = async response => {
    if (!response?.credential) return status('Google did not return a confirmation token.', 'error');
    try {
      await api('/auth/delete-account', { method:'POST', body:JSON.stringify({ idToken:response.credential }) });
      sessionStorage.removeItem('iwm_user');
      status('Your account was deleted.', 'success');
      setTimeout(() => location.assign('/'), 900);
    } catch (error) { status(error.message, 'error'); }
  };
  window.google.accounts.id.initialize({ client_id:state.googleClientId, callback:response => window.iwacuDeleteAccountWithGoogle?.(response) });
  root.replaceChildren();
  window.google.accounts.id.renderButton(root, { theme:'outline', size:'large', text:'continue_with', shape:'pill' });
}

function loadGoogleIdentityScript() {
  return new Promise(resolve => {
    if (window.google?.accounts?.id) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}

async function handleDeleteAccount(form) {
  const payload = Object.fromEntries(new FormData(form));
  if (payload.confirmation !== 'DELETE') return status('Type DELETE exactly to confirm account removal.', 'error');
  if (!confirm('Delete this IwacuMall account and anonymize its personal profile?')) return;
  if (state.user.googleLinked) {
    $('#googleReauthPanel').hidden = false;
    const loaded = await loadGoogleIdentityScript();
    if (!loaded) return status('Google sign-in could not be loaded. Try again later.', 'error');
    setGoogleReauthButton();
    status('Choose the Google account linked to this profile to finish account removal.');
    return;
  }
  try {
    await api('/auth/delete-account', { method:'POST', body:JSON.stringify({ password:payload.password }) });
    sessionStorage.removeItem('iwm_user');
    status('Your account was deleted.', 'success');
    setTimeout(() => location.assign('/'), 900);
  } catch (error) { status(error.message, 'error'); }
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['profileForm','addressForm','deleteAccountForm','changePasswordForm'].includes(form.id)) return;
  event.preventDefault();
  try {
    if (form.id === 'profileForm') {
      const { user } = await api('/me', { method:'PATCH', body:JSON.stringify({ name:$('#profileName').value.trim() }) });
      state.user = user;
      status('Profile updated.', 'success');
    } else if (form.id === 'addressForm') {
      const payload = Object.fromEntries(new FormData(form));
      payload.isDefault = form.elements.isDefault.checked;
      const result = await api('/me/addresses', { method:'POST', body:JSON.stringify(payload) });
      form.reset();
      form.elements.city.value = 'Kigali';
      await loadAddresses();
      status('Delivery address saved.', 'success');
    } else if (form.id === 'deleteAccountForm') {
      await handleDeleteAccount(form);
    } else {
      await api('/auth/change-password', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      await api('/auth/logout', { method:'POST', body:'{}' }).catch(() => {});
      sessionStorage.removeItem('iwm_user');
      location.assign('/');
    }
  } catch (error) { status(error.message, 'error'); }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.deleteAddress) {
      await api(`/me/addresses/${button.dataset.deleteAddress}`, { method:'DELETE', body:'{}' });
      await loadAddresses();
      status('Delivery address removed.', 'success');
    } else if (button.dataset.defaultAddress) {
      await api(`/me/addresses/${button.dataset.defaultAddress}`, { method:'PATCH', body:JSON.stringify({ isDefault:true }) });
      await loadAddresses();
      status('Default delivery address updated.', 'success');
    } else if (button.dataset.revokeSession) {
      if (!confirm('Revoke this signed-in session? That device will need to sign in again.')) return;
      await api(`/me/sessions/${button.dataset.revokeSession}`, { method:'DELETE', body:'{}' });
      await loadSessions();
      status('Session revoked.', 'success');
    } else if (button.id === 'requestPasswordReset') {
      await api('/auth/forgot-password', { method:'POST', body:JSON.stringify({ email:state.user.email }) });
      status('If that email is registered, a password reset link will arrive shortly.', 'success');
    } else if (button.id === 'logoutAccount') {
      await api('/auth/logout', { method:'POST', body:'{}' });
      sessionStorage.removeItem('iwm_user');
      location.assign('/');
    }
  } catch (error) { status(error.message, 'error'); }
});

async function initialize() {
  try {
    const [me, config] = await Promise.all([api('/me'), api('/config')]);
    state.user = me.user;
    state.googleClientId = config.googleWebClientId;
    $('#profileName').value = state.user.name;
    $('#profileEmail').value = state.user.email;
    if (state.user.googleLinked) {
      $('#passwordTools').innerHTML = '<p>This account uses Google sign-in. You can set a password by requesting a reset email.</p><button id="requestPasswordReset" class="btn btn-subtle">Send password reset link</button>';
      $('#deletePasswordWrap').hidden = true;
      $('#deleteAccountForm').elements.password.required = false;
    } else {
      $('#passwordTools').innerHTML = `<form id="changePasswordForm" class="account-form"><h3>Change password</h3><label>Current password<input class="form-control" name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input class="form-control" name="newPassword" type="password" autocomplete="new-password" minlength="10" required></label><button class="btn btn-subtle" type="submit">Update password</button></form>`;
      $('#deleteAccountForm').elements.password.required = true;
    }
    $('#accountContent').hidden = false;
    await Promise.all([loadAddresses(), loadSessions()]);
    status(`Signed in as ${state.user.email}.`);
  } catch (error) {
    status(`${error.message} Sign in to manage your account.`, 'error');
    $('#accountContent').hidden = true;
  }
}
initialize();
