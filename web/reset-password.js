const form = document.querySelector('#resetForm');
const error = document.querySelector('#resetError');
const token = new URLSearchParams(location.search).get('token') || '';

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  const values = Object.fromEntries(new FormData(form));
  if (!token) {
    error.textContent = 'This reset link is missing or invalid. Request a new one from sign in.';
    error.hidden = false;
    return;
  }
  if (values.password !== values.confirmPassword) {
    error.textContent = 'The passwords do not match.';
    error.hidden = false;
    return;
  }
  try {
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: values.password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not reset your password');
    form.hidden = true;
    document.querySelector('#resetSuccess').hidden = false;
    history.replaceState(null, '', '/reset-password');
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  }
});
