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

let stream = null;
let capturedBlob = null;
let previewUrl = null;

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
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

function clearCapture() {
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
}

async function openCamera() {
  clearCapture();
  cameraDialog.showModal();
  status.textContent = 'カメラを起動しています…';
  try {
    await startCamera();
    status.textContent = 'A4用紙を枠内に合わせてください';
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
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    if (!blob) {
      status.textContent = '撮影画像を作成できませんでした。もう一度お試しください。';
      return;
    }
    capturedBlob = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl;
    setPreviewing(true);
  }, 'image/jpeg', 0.94);
}

function retake() {
  capturedBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute('src');
  setPreviewing(false);
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
  if (document.hidden && cameraDialog?.open) stopCamera();
});
