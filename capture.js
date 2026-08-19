const token = new URLSearchParams(window.location.search).get('token');
const steps = {
  consent: document.querySelector('#consentStep'), camera: document.querySelector('#cameraStep'),
  result: document.querySelector('#resultStep'), error: document.querySelector('#errorStep')
};
const consentCheckbox = document.querySelector('#consentCheckbox');
const startButton = document.querySelector('#startCamera');
const video = document.querySelector('#cameraPreview');
const canvas = document.querySelector('#photoCanvas');
const cameraStatus = document.querySelector('#cameraStatus');
const capturedPhoto = document.querySelector('#capturedPhoto');
const errorMessage = document.querySelector('#errorMessage');
let stream = null;

function showStep(name) { Object.entries(steps).forEach(([key, element]) => element.classList.toggle('is-hidden', key !== name)); }
function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка соединения с сервером');
    error.status = payload.status;
    throw error;
  }
  return payload;
}

function canvasBlob(quality = .82) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Не удалось подготовить фотографию')), 'image/jpeg', quality
  ));
}

function waitForVideoFrame() {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

async function captureImmediately() {
  await waitForVideoFrame();
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 960;
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  let photo = await canvasBlob();
  if (photo.size > 3.8 * 1024 * 1024) photo = await canvasBlob(.68);
  const previewUrl = URL.createObjectURL(photo);
  stopCamera();
  cameraStatus.textContent = 'Сохраняем фотографию на сервере…';
  await api(`/api/links/${token}/photo`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: photo });
  capturedPhoto.src = previewUrl;
  showStep('result');
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    errorMessage.textContent = 'Этот браузер не поддерживает доступ к камере или страница открыта без HTTPS.';
    showStep('error');
    return;
  }
  showStep('camera');
  cameraStatus.textContent = 'Разрешите доступ в системном окне браузера…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    cameraStatus.textContent = 'Камера включена — выполняем снимок…';
    await captureImmediately();
  } catch (error) {
    stopCamera();
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    if (denied) errorMessage.textContent = 'Вы не разрешили доступ к камере. Разрешение можно изменить в настройках сайта в браузере.';
    else if (error?.status) errorMessage.textContent = error.message;
    else errorMessage.textContent = 'Камера занята другим приложением, недоступна или фотографию не удалось сохранить.';
    showStep('error');
  }
}

async function initialize() {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    errorMessage.textContent = 'В адресе отсутствует действительный код ссылки.';
    showStep('error');
    return;
  }
  try {
    const payload = await api(`/api/links/${token}`);
    if (!payload.link.canCapture) {
      const messages = {
        captured: 'Эта ссылка уже была использована для фотографии.',
        revoked: 'Эта ссылка была отозвана владельцем.', expired: 'Срок действия этой ссылки истёк.'
      };
      errorMessage.textContent = messages[payload.link.status] || 'Эта ссылка больше не действует.';
      showStep('error');
      return;
    }
    await api(`/api/links/${token}/open`, { method: 'POST' });
  } catch (error) {
    errorMessage.textContent = error.message;
    showStep('error');
  }
}

consentCheckbox.addEventListener('change', () => { startButton.disabled = !consentCheckbox.checked; });
startButton.addEventListener('click', openCamera);
document.querySelector('#tryAgain').addEventListener('click', () => window.location.reload());
window.addEventListener('pagehide', stopCamera);
initialize();
