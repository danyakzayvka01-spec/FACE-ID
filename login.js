const form = document.querySelector('#loginForm');
const username = document.querySelector('#adminUsername');
const password = document.querySelector('#adminPassword');
const errorBox = document.querySelector('#loginError');

async function checkSession() {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    const status = await response.json();
    if (status.authenticated) window.location.replace('/');
    if (!status.configured) showError('На сервере ещё не заданы данные администратора. Добавьте ADMIN_USERNAME и ADMIN_PASSWORD в конфигурацию.');
  } catch {
    showError('Сервер недоступен. Попробуйте обновить страницу.');
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('is-hidden');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.classList.add('is-hidden');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить вход');
    window.location.replace('/');
  } catch (error) {
    password.select();
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

checkSession();
