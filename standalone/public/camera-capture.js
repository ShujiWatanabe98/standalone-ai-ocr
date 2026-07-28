const cameraDialog = document.querySelector('#cameraDialog');
const openButton = document.querySelector('#openCameraButton');
const closeButton = document.querySelector('#closeCameraButton');
const shootButton = document.querySelector('#shootCameraButton');
const retakeButton = document.querySelector('#retakeCameraButton');
const useButton = document.querySelector('#useCameraButton');
const video = document.querySelector('#cameraVideo');
const preview = document.querySelector('#cameraPreview');
const canvas = document.querySelector('#cameraCanvas');
const status = document.querySelector('#cameraStatus');
const imageInput = document.querySelector('#imageInput');
const sheetOverlay = document.querySelector('#cameraSheetOverlay');

let stream = null;
let capturedBlob = null;
let previewUrl = null;
let detectionController = null;
let liveDetectionTimer = null;
let liveDetectionActive = false;

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
  if (!liveDetectionActive || !cameraDialog.open || !stream || cameraDialog.classList.contains('previewing')) return;
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

function setPreviewing(previewing) {
  cameraDialog.classList.toggle('previewing', previewing);
  shootButton.hidden = previewing;
  retakeButton.hidden = !previewing;
  useButton.hidden = !previewing;
  status.textContent = previewing
    ? '用紙全体が鮮明に写っていることを確認してください'
    : 'A4用紙を枠内に合わせてください';
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
  capturedBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute('src');
  setPreviewing(false);
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
  shootButton.disabled = false;
  if (cameraDialog.open) cameraDialog.close();
}

function captureFrame() {
  if (!video.videoWidth || !video.videoHeight) return;
  stopLiveDetection();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    if (!blob) {
      status.textContent = '撮影画像を作成できませんでした。もう一度お試しください。';
      startLiveDetection();
      return;
    }
    capturedBlob = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl;
    setPreviewing(true);
    detectEvaluationSheet(blob);
  }, 'image/jpeg', 0.94);
}

function retake() {
  stopLiveDetection();
  hideSheetOverlay();
  capturedBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute('src');
  setPreviewing(false);
  startLiveDetection();
}

function useCapture() {
  if (!capturedBlob) return;
  const file = new File(
    [capturedBlob],
    `a4-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`,
    { type: 'image/jpeg', lastModified: Date.now() }
  );
  const transfer = new DataTransfer();
  transfer.items.add(file);
  imageInput.files = transfer.files;
  imageInput.dispatchEvent(new Event('change', { bubbles: true }));
  closeCamera();
}

openButton?.addEventListener('click', openCamera);
closeButton?.addEventListener('click', closeCamera);
shootButton?.addEventListener('click', captureFrame);
retakeButton?.addEventListener('click', retake);
useButton?.addEventListener('click', useCapture);
cameraDialog?.addEventListener('cancel', event => {
  event.preventDefault();
  closeCamera();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && cameraDialog?.open) stopLiveDetection();
  else if (!document.hidden && cameraDialog?.open && stream && !cameraDialog.classList.contains('previewing')) startLiveDetection();
});
