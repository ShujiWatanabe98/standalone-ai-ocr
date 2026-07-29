const cameraDialog = document.querySelector('#cameraDialog');
const openButton = document.querySelector('#openCameraButton');
const closeButton = document.querySelector('#closeCameraButton');
const shootButton = document.querySelector('#shootCameraButton');
const finishButton = document.querySelector('#finishCameraButton');
const video = document.querySelector('#cameraVideo');
const canvas = document.querySelector('#cameraCanvas');
const cameraGuide = document.querySelector('#cameraGuide');
const status = document.querySelector('#cameraStatus');
const imageInput = document.querySelector('#imageInput');
const sheetOverlay = document.querySelector('#cameraSheetOverlay');
const captureSlots = document.querySelector('#cameraCaptureSlots');
const captureCount = document.querySelector('#cameraCaptureCount');
const previewDialog = document.querySelector('#cameraPreviewDialog');
const previewImage = document.querySelector('#cameraPreviewImage');
const closePreviewButton = document.querySelector('#closeCameraPreviewButton');

let stream = null;
const maxCameraCaptures = 12;
let capturedSheets = Array(maxCameraCaptures).fill(null);
let activeCaptureIndex = 0;
let detectionController = null;
let liveDetectionTimer = null;
let liveDetectionActive = false;

function capturedSheetCount() {
  return capturedSheets.filter(Boolean).length;
}

function renderCaptureSheet() {
  if (!captureSlots) return;
  const capturedCount = capturedSheetCount();
  captureCount.textContent = `${capturedCount} / ${maxCameraCaptures}枚`;
  captureSlots.innerHTML = Array.from({ length: maxCameraCaptures }, (_, index) => {
    const item = capturedSheets[index];
    return item
      ? `<article class="camera-capture-slot filled${index === activeCaptureIndex ? ' active' : ''}"><span>${index + 1}</span><button class="camera-slot-select" type="button" data-select-capture="${index}" aria-label="${index + 1}枚目を選択して画像を表示"><img src="${item.url}" alt="${index + 1}枚目の撮影画像"></button><button class="camera-slot-remove" type="button" data-remove-capture="${index}" aria-label="${index + 1}枚目を削除">×</button></article>`
      : `<article class="camera-capture-slot${index === activeCaptureIndex ? ' active' : ''}"><span>${index + 1}</span><button class="camera-slot-select" type="button" data-select-capture="${index}" aria-label="${index + 1}枚目を撮影先に選択"><small>未撮影</small></button></article>`;
  }).join('');
  captureSlots.querySelectorAll('[data-select-capture]').forEach(button => button.addEventListener('click', () => {
    activeCaptureIndex = Number(button.dataset.selectCapture);
    const item = capturedSheets[activeCaptureIndex];
    renderCaptureSheet();
    if (item && previewDialog && previewImage) {
      previewImage.src = item.url;
      previewImage.alt = `${activeCaptureIndex + 1}枚目の撮影画像`;
      previewDialog.showModal();
    }
  }));
  captureSlots.querySelectorAll('[data-remove-capture]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const index = Number(button.dataset.removeCapture);
    const removed = capturedSheets[index];
    capturedSheets[index] = null;
    if (removed?.url) URL.revokeObjectURL(removed.url);
    activeCaptureIndex = index;
    shootButton.disabled = false;
    renderCaptureSheet();
    status.textContent = `撮影済み ${capturedSheetCount()} / ${maxCameraCaptures}枚`;
  }));
  finishButton.hidden = capturedCount === 0;
}

function clearCaptureSheet() {
  capturedSheets.filter(Boolean).forEach(item => URL.revokeObjectURL(item.url));
  capturedSheets = Array(maxCameraCaptures).fill(null);
  activeCaptureIndex = 0;
  renderCaptureSheet();
}

function showSheetOverlay(text, state = 'detecting') {
  if (!sheetOverlay) return;
  sheetOverlay.textContent = text;
  sheetOverlay.dataset.state = state;
  sheetOverlay.hidden = false;
}

function hideSheetOverlay() {
  if (!sheetOverlay) return;
  sheetOverlay.hidden = true;
  sheetOverlay.textContent = '';
  delete sheetOverlay.dataset.state;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('撮影画像を読み込めませんでした。'));
    reader.readAsDataURL(blob);
  });
}

function liveFrameDataUrl() {
  if (!video.videoWidth || !video.videoHeight) return null;
  const maxLongEdge = 960;
  const scale = Math.min(1, maxLongEdge / Math.max(video.videoWidth, video.videoHeight));
  const liveCanvas = document.createElement('canvas');
  liveCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  liveCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  liveCanvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, liveCanvas.width, liveCanvas.height);
  return liveCanvas.toDataURL('image/jpeg', 0.72);
}

function stopLiveDetection() {
  liveDetectionActive = false;
  if (liveDetectionTimer) clearTimeout(liveDetectionTimer);
  liveDetectionTimer = null;
  detectionController?.abort();
  detectionController = null;
}

function scheduleLiveDetection(delay = 600) {
  if (!liveDetectionActive || !cameraDialog.open || !stream) return;
  if (liveDetectionTimer) clearTimeout(liveDetectionTimer);
  liveDetectionTimer = setTimeout(async () => {
    liveDetectionTimer = null;
    const imageDataUrl = liveFrameDataUrl();
    if (imageDataUrl) await detectEvaluationSheet(imageDataUrl, { live: true });
    if (liveDetectionActive) scheduleLiveDetection(2000);
  }, delay);
}

function startLiveDetection() {
  stopLiveDetection();
  liveDetectionActive = true;
  showSheetOverlay('評価シートを判定中…', 'detecting');
  scheduleLiveDetection();
}

async function detectEvaluationSheet(imageSource, { live = false } = {}) {
  detectionController?.abort();
  const controller = new AbortController();
  detectionController = controller;
  if (!live || sheetOverlay?.dataset.state !== 'recognized') {
    showSheetOverlay('評価シートを判定中…', 'detecting');
  }
  try {
    const imageDataUrl = typeof imageSource === 'string' ? imageSource : await blobToDataUrl(imageSource);
    const response = await fetch('/api/detect-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (controller.signal.aborted) return;
    if (result.recognized) {
      showSheetOverlay(result.displayName, 'recognized');
      status.textContent = `評価シート：${result.displayName}`;
    } else {
      showSheetOverlay('評価シートを認識できません', 'unknown');
      status.textContent = live
        ? '用紙全体と帳票名が枠内に写るように調整してください'
        : '用紙全体と帳票名が鮮明に写るように撮り直してください';
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    showSheetOverlay('評価シートの判定に失敗しました', 'error');
    status.textContent = error.message;
  } finally {
    if (detectionController === controller) detectionController = null;
  }
}

function stopCamera() {
  stopLiveDetection();
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

function clearCapture() {
  hideSheetOverlay();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザではカメラ撮影を利用できません。HTTPS接続を確認してください。');
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 2560 },
      height: { ideal: 1920 }
    }
  });
  video.srcObject = stream;
  await video.play();
  startLiveDetection();
}

async function openCamera() {
  clearCapture();
  clearCaptureSheet();
  cameraDialog.showModal();
  status.textContent = 'カメラを起動しています…';
  try {
    await startCamera();
    status.textContent = '評価シートを枠内に合わせてください';
  } catch (error) {
    status.textContent = error.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザの権限設定を確認してください。'
      : error.message;
    shootButton.disabled = true;
  }
}

function closeCamera() {
  stopCamera();
  clearCapture();
  clearCaptureSheet();
  shootButton.disabled = false;
  if (cameraDialog.open) cameraDialog.close();
}

function captureFrame() {
  if (!video.videoWidth || !video.videoHeight) return;
  stopLiveDetection();
  shootButton.disabled = true;
  const videoRect = video.getBoundingClientRect();
  const guideRect = cameraGuide.getBoundingClientRect();
  const coverScale = Math.max(
    videoRect.width / video.videoWidth,
    videoRect.height / video.videoHeight
  );
  const renderedWidth = video.videoWidth * coverScale;
  const renderedHeight = video.videoHeight * coverScale;
  const renderedLeft = videoRect.left + (videoRect.width - renderedWidth) / 2;
  const renderedTop = videoRect.top + (videoRect.height - renderedHeight) / 2;
  const sourceX = Math.max(0, (guideRect.left - renderedLeft) / coverScale);
  const sourceY = Math.max(0, (guideRect.top - renderedTop) / coverScale);
  const sourceWidth = Math.min(
    video.videoWidth - sourceX,
    guideRect.width / coverScale
  );
  const sourceHeight = Math.min(
    video.videoHeight - sourceY,
    guideRect.height / coverScale
  );
  canvas.width = Math.max(1, Math.round(sourceWidth));
  canvas.height = Math.max(1, Math.round(sourceHeight));
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );
  canvas.toBlob(blob => {
    if (!blob) {
      status.textContent = '撮影画像を作成できませんでした。もう一度お試しください。';
      shootButton.disabled = false;
      startLiveDetection();
      return;
    }
    const file = new File(
      [blob],
      `a4-camera-${String(activeCaptureIndex + 1).padStart(2, '0')}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`,
      { type: 'image/jpeg', lastModified: Date.now() }
    );
    const replaced = capturedSheets[activeCaptureIndex];
    if (replaced?.url) URL.revokeObjectURL(replaced.url);
    capturedSheets[activeCaptureIndex] = { file, url: URL.createObjectURL(blob) };
    const nextEmptyIndex = capturedSheets.findIndex(item => !item);
    if (nextEmptyIndex >= 0) activeCaptureIndex = nextEmptyIndex;
    renderCaptureSheet();
    const capturedCount = capturedSheetCount();
    if (capturedCount >= maxCameraCaptures) {
      status.textContent = '12枚撮影しました。「撮影した画像を使用」を押してください。';
    } else {
      shootButton.disabled = false;
      status.textContent = `撮影済み ${capturedCount} / ${maxCameraCaptures}枚。続けて撮影できます。`;
      startLiveDetection();
    }
  }, 'image/jpeg', 0.94);
}

function finishCaptures() {
  if (!capturedSheetCount()) return;
  const transfer = new DataTransfer();
  capturedSheets.filter(Boolean).forEach(item => transfer.items.add(item.file));
  imageInput.files = transfer.files;
  imageInput.dispatchEvent(new Event('change', { bubbles: true }));
  closeCamera();
}

openButton?.addEventListener('click', openCamera);
closeButton?.addEventListener('click', closeCamera);
shootButton?.addEventListener('click', captureFrame);
finishButton?.addEventListener('click', finishCaptures);
closePreviewButton?.addEventListener('click', () => previewDialog?.close());
cameraDialog?.addEventListener('cancel', event => {
  event.preventDefault();
  closeCamera();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && cameraDialog?.open) stopLiveDetection();
  else if (!document.hidden && cameraDialog?.open && stream) startLiveDetection();
});
