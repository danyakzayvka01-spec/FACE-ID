import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from './storage.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data');
const port = Number(process.env.PORT || 4173);
const host = String(process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'));
const maxPhotoBytes = 4 * 1024 * 1024;
const auth = {
  username: String(process.env.ADMIN_USERNAME || '').trim(),
  password: String(process.env.ADMIN_PASSWORD || ''),
  sessionSecret: String(process.env.ADMIN_SESSION_SECRET || randomBytes(32).toString('base64url')),
  secureCookie: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true'
};
const telegram = {
  token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  chatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
  topicId: String(process.env.TELEGRAM_TOPIC_ID || '').trim()
};
const staticFiles = new Set(['index.html', 'login.html', 'capture.html', 'styles.css', 'admin-client.js', 'login.js', 'capture.js']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const storage = await createStorage(dataRoot);

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    ...extra
  };
}

function json(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders }));
  response.end(JSON.stringify(payload));
}

const loginAttempts = new Map();
const sessionTtlMs = 12 * 60 * 60 * 1000;

function cookieName() { return auth.secureCookie ? '__Host-cameralink_session' : 'cameralink_session'; }
function authConfigured() { return auth.username.length >= 3 && auth.password.length >= 10; }
function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([name]) => name));
}

function isAuthenticated(request) {
  const value = parseCookies(request)[cookieName()] || '';
  const separator = value.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac('sha256', auth.sessionSecret).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: Date.now() + sessionTtlMs,
    nonce: randomBytes(16).toString('base64url')
  })).toString('base64url');
  const signature = createHmac('sha256', auth.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function sessionCookie(id) {
  return `${cookieName()}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict${auth.secureCookie ? '; Secure' : ''}`;
}

function clearSessionCookie() {
  return `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${auth.secureCookie ? '; Secure' : ''}`;
}

function credentialsMatch(username, password) {
  if (!authConfigured()) return false;
  const expectedUsername = createHmac('sha256', auth.sessionSecret).update(auth.username).digest();
  const actualUsername = createHmac('sha256', auth.sessionSecret).update(String(username || '').trim()).digest();
  const expectedPassword = createHmac('sha256', auth.sessionSecret).update(auth.password).digest();
  const actualPassword = createHmac('sha256', auth.sessionSecret).update(String(password || '')).digest();
  return timingSafeEqual(expectedUsername, actualUsername) && timingSafeEqual(expectedPassword, actualPassword);
}

function clientIp(request) {
  if (auth.trustProxy) return String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
  return request.socket.remoteAddress || 'unknown';
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function redirect(response, location) {
  response.writeHead(302, securityHeaders({ Location: location, 'Cache-Control': 'no-store' }));
  response.end();
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const raw = await readBody(request, 64 * 1024);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const error = new Error('Некорректные данные');
    error.status = 400;
    throw error;
  }
}

function telegramConfigured() { return Boolean(telegram.token && telegram.chatId); }
function isExpired(link) { return Date.now() > new Date(link.expiresAt).getTime(); }
function effectiveStatus(link) {
  if (link.status === 'revoked' || link.status === 'captured') return link.status;
  return isExpired(link) ? 'expired' : link.status;
}

function adminRecord(link) {
  return {
    token: link.token,
    recipient: link.recipient,
    note: link.note,
    group: link.group,
    expires: link.expires,
    expiresAt: link.expiresAt,
    createdAt: link.createdAt,
    openedAt: link.openedAt || null,
    capturedAt: link.capturedAt || null,
    status: effectiveStatus(link),
    hasPhoto: Boolean(link.photoFilename),
    photoUrl: link.photoFilename ? `/api/links/${link.token}/photo` : null,
    telegramStatus: link.telegram?.status || 'not_configured'
  };
}

function expiryDate(value) {
  const hours = { '24h': 24, '3d': 72, '7d': 168 }[value] || 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function validToken(value) { return /^[a-f0-9]{32}$/.test(value || ''); }

const productionMissing = [];
if (process.env.NODE_ENV === 'production') {
  if (!auth.username) productionMissing.push('ADMIN_USERNAME');
  if (!auth.password) productionMissing.push('ADMIN_PASSWORD');
  if (String(process.env.ADMIN_SESSION_SECRET || '').length < 32) productionMissing.push('ADMIN_SESSION_SECRET');
  if (!telegram.token) productionMissing.push('TELEGRAM_BOT_TOKEN');
  if (!telegram.chatId) productionMissing.push('TELEGRAM_CHAT_ID');
  if (!process.env.DATABASE_URL) productionMissing.push('DATABASE_URL');
  if (!process.env.BLOB_READ_WRITE_TOKEN) productionMissing.push('BLOB_READ_WRITE_TOKEN');
}

async function telegramRequest(method, body = {}) {
  const isMultipart = body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${telegram.token}/${method}`, {
    method: 'POST',
    headers: isMultipart ? undefined : { 'Content-Type': 'application/json' },
    body: isMultipart ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram API: HTTP ${response.status}`);
  return payload.result;
}

let telegramCheckCache = { checkedAt: 0, value: null };
async function checkTelegramConnection() {
  if (!telegramConfigured()) return { configured: false, connected: false };
  if (telegramCheckCache.value && Date.now() - telegramCheckCache.checkedAt < 30000) return telegramCheckCache.value;
  try {
    const [bot, chat] = await Promise.all([
      telegramRequest('getMe'),
      telegramRequest('getChat', { chat_id: telegram.chatId })
    ]);
    telegramCheckCache = {
      checkedAt: Date.now(),
      value: {
        configured: true,
        connected: true,
        botUsername: bot.username || null,
        chatTitle: chat.title || chat.username || chat.first_name || 'Telegram'
      }
    };
  } catch (error) {
    telegramCheckCache = {
      checkedAt: Date.now(),
      value: { configured: true, connected: false, error: String(error.message || 'Ошибка подключения').slice(0, 180) }
    };
  }
  return telegramCheckCache.value;
}

function telegramCaption(link) {
  const lines = [
    '📷 Новая фотография CameraLink',
    `Получатель: ${link.recipient}`,
    `Группа: ${link.group}`,
    `Заметка: ${link.note || '—'}`,
    `Создана: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(link.createdAt))}`
  ];
  return lines.join('\n').slice(0, 1024);
}

async function sendTelegramPhoto(photo, contentType, link) {
  const form = new FormData();
  form.append('chat_id', telegram.chatId);
  form.append('photo', new Blob([photo], { type: contentType }), `photo-${link.token.slice(0, 8)}.${contentType === 'image/png' ? 'png' : 'jpg'}`);
  form.append('caption', telegramCaption(link));
  if (telegram.topicId) form.append('message_thread_id', telegram.topicId);
  return telegramRequest('sendPhoto', form);
}

async function handleApi(request, response, url) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    json(response, 200, { configured: authConfigured(), authenticated: isAuthenticated(request) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!sameOrigin(request)) {
      json(response, 403, { error: 'Запрос отклонён' });
      return true;
    }
    if (!authConfigured()) {
      json(response, 503, { error: 'Данные администратора не заданы или не соответствуют требованиям' });
      return true;
    }
    const ip = clientIp(request);
    const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) {
      json(response, 429, { error: 'Слишком много попыток. Повторите через 15 минут' });
      return true;
    }
    const body = await readJson(request);
    if (!credentialsMatch(body.username, body.password)) {
      attempt.count += 1;
      if (attempt.count >= 5) {
        attempt.count = 0;
        attempt.blockedUntil = Date.now() + 15 * 60 * 1000;
      }
      loginAttempts.set(ip, attempt);
      json(response, 401, { error: 'Неверный логин или пароль' });
      return true;
    }
    loginAttempts.delete(ip);
    json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(createSession()) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (!sameOrigin(request)) {
      json(response, 403, { error: 'Запрос отклонён' });
      return true;
    }
    json(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(), 'Clear-Site-Data': '"cache", "cookies", "storage"' });
    return true;
  }

  const token = segments[2];
  const action = segments[3];
  const publicCaptureRoute = segments[0] === 'api' && segments[1] === 'links' && validToken(token) && (
    (request.method === 'GET' && !action) ||
    (request.method === 'POST' && ['open', 'photo'].includes(action))
  );

  if (!publicCaptureRoute && !isAuthenticated(request)) {
    json(response, 401, { error: 'Требуется вход' });
    return true;
  }

  if (!publicCaptureRoute && ['POST', 'DELETE'].includes(request.method) && !sameOrigin(request)) {
    json(response, 403, { error: 'Запрос отклонён' });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/links') {
    json(response, 200, { links: (await storage.listLinks()).map(adminRecord) });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/telegram/status') {
    json(response, 200, await checkTelegramConnection());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/links') {
    const body = await readJson(request);
    const recipient = String(body.recipient || '').trim().slice(0, 80);
    const note = String(body.note || '').trim().slice(0, 240);
    const group = String(body.group || '').trim().slice(0, 80);
    const expires = ['24h', '3d', '7d'].includes(body.expires) ? body.expires : '24h';
    if (!recipient || !group) {
      json(response, 400, { error: 'Заполните имя/телефон и группу' });
      return true;
    }
    const link = {
      token: randomUUID().replaceAll('-', ''), recipient, note, group, expires,
      createdAt: new Date().toISOString(), expiresAt: expiryDate(expires), status: 'created'
    };
    json(response, 201, { link: adminRecord(await storage.createLink(link)) });
    return true;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/links') {
    await storage.clearLinks();
    json(response, 200, { ok: true });
    return true;
  }

  if (segments[0] !== 'api' || segments[1] !== 'links' || !validToken(segments[2])) return false;
  const link = await storage.getLink(token);
  if (!link) {
    json(response, 404, { error: 'Ссылка не найдена' });
    return true;
  }

  if (request.method === 'GET' && !action) {
    const status = effectiveStatus(link);
    json(response, 200, { link: { status, expiresAt: link.expiresAt, canCapture: !['expired', 'revoked', 'captured'].includes(status) } });
    return true;
  }

  if (request.method === 'POST' && action === 'open') {
    const status = effectiveStatus(link);
    if (['expired', 'revoked', 'captured'].includes(status)) {
      json(response, 409, { error: 'Ссылка больше не действует', status });
      return true;
    }
    if (!link.openedAt) link.openedAt = new Date().toISOString();
    link.status = 'opened';
    await storage.updateLink(link);
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'POST' && action === 'revoke') {
    if (link.status !== 'captured') link.status = 'revoked';
    await storage.updateLink(link);
    json(response, 200, { link: adminRecord(link) });
    return true;
  }

  if (request.method === 'POST' && action === 'photo') {
    const status = effectiveStatus(link);
    if (['expired', 'revoked', 'captured'].includes(status)) {
      json(response, 409, { error: 'Ссылка больше не принимает фотографии', status });
      return true;
    }
    const contentType = String(request.headers['content-type'] || '').split(';')[0];
    if (!['image/jpeg', 'image/png'].includes(contentType)) {
      json(response, 415, { error: 'Поддерживаются только JPEG и PNG' });
      return true;
    }
    const photo = await readBody(request, maxPhotoBytes);
    if (photo.length < 100) {
      json(response, 400, { error: 'Файл фотографии повреждён' });
      return true;
    }
    const extension = contentType === 'image/png' ? 'png' : 'jpg';
    const filename = `${token}.${extension}`;
    await storage.savePhoto(filename, photo, contentType);
    link.photoFilename = filename;
    link.photoContentType = contentType;
    link.photoSize = photo.length;
    link.capturedAt = new Date().toISOString();
    link.status = 'captured';
    link.telegram = { status: telegramConfigured() ? 'pending' : 'not_configured' };
    await storage.updateLink(link);

    if (telegramConfigured()) {
      try {
        const message = await sendTelegramPhoto(photo, contentType, link);
        link.telegram = { status: 'sent', sentAt: new Date().toISOString(), messageId: message.message_id };
      } catch (error) {
        console.warn(`Telegram delivery failed for ${token.slice(0, 8)}: ${error.message}`);
        link.telegram = { status: 'failed', error: String(error.message || 'Ошибка отправки').slice(0, 240) };
      }
      await storage.updateLink(link);
    }

    json(response, 201, { ok: true, status: 'captured', telegram: link.telegram });
    return true;
  }

  if (request.method === 'GET' && action === 'photo') {
    if (!link.photoFilename) {
      json(response, 404, { error: 'Фотография ещё не загружена' });
      return true;
    }
    const body = await storage.readPhoto(link.photoFilename);
    if (!body) {
      json(response, 404, { error: 'Фотография не найдена в хранилище' });
      return true;
    }
    response.writeHead(200, securityHeaders({
      'Content-Type': link.photoContentType || (extname(link.photoFilename) === '.png' ? 'image/png' : 'image/jpeg'),
      'Content-Length': body.length,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="photo-${token.slice(0, 8)}${extname(link.photoFilename)}"`
    }));
    response.end(body);
    return true;
  }

  return false;
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safePath = normalize(requested);
  if (!staticFiles.has(safePath)) return false;
  const absolutePath = join(root, safePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) return false;
  const body = await readFile(absolutePath);
  response.writeHead(200, securityHeaders({ 'Content-Type': types[extname(absolutePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' }));
  response.end(body);
  return true;
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(response, productionMissing.length ? 503 : 200, {
        ok: productionMissing.length === 0,
        storage: storage.mode,
        missing: productionMissing
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!await handleApi(request, response, url)) json(response, 404, { error: 'Маршрут не найден' });
      return;
    }
    const adminPage = url.pathname === '/' || url.pathname === '/index.html';
    if (adminPage && !isAuthenticated(request)) {
      redirect(response, '/login.html');
      return;
    }
    if (url.pathname === '/login.html' && isAuthenticated(request)) {
      redirect(response, '/');
      return;
    }
    if (!await serveStatic(response, decodeURIComponent(url.pathname))) {
      response.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      response.end('Страница не найдена');
    }
  } catch (error) {
    console.error(error);
    json(response, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
  }
}).listen(port, host, () => console.log(`CameraLink: http://${host}:${port}`));
