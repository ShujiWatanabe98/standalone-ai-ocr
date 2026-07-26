import http from 'node:http';
import { readFile, writeFile, mkdir, rename, cp, rm, unlink } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildBbsRetryPrompt, buildRehainfoOcrPrompt, buildStefRetryPrompt, normalizeRehainfoResult } from './rehainfo-ocr-definitions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.resolve(process.env.AIOCR_DATA_DIR || path.join(here, 'data'));
const imageDir = path.join(dataDir, 'images');
const dbFile = path.join(dataDir, 'database.json');
const backupDir = path.resolve(process.env.AIOCR_BACKUP_DIR || path.join(here, 'backups'));
const port = Number(process.env.AIOCR_PORT || process.env.PORT || 8795);
const host = process.env.AIOCR_HOST || '127.0.0.1';
const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const authUser = process.env.AIOCR_USERNAME || '';
const authPassword = process.env.AIOCR_PASSWORD || '';
const facilityId = process.env.AIOCR_FACILITY_ID || 'local-facility';
const encryptionSecret = process.env.AIOCR_ENCRYPTION_KEY || '';
const encryptionKey = encryptionSecret ? crypto.createHash('sha256').update(encryptionSecret, 'utf8').digest() : null;
const sessionTtlMs = 8 * 60 * 60 * 1000;
const sessions = new Map();
const activeOcrControllers = new Map();
const loginAttempts = new Map();
const maxBodyBytes = 16 * 1024 * 1024;
const imageRetentionDays = Math.max(0, Number(process.env.AIOCR_IMAGE_RETENTION_DAYS || 0));
const secureCookies = process.env.NODE_ENV === 'production';
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const databaseUrl = process.env.DATABASE_URL || '';
const sqlPool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

let db = { version: 1, patients: [], jobs: [], audit: [] };
let writeChain = Promise.resolve();

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!authUser || !authPassword || !encryptionKey)) {
  throw new Error('External binding requires AIOCR_USERNAME, AIOCR_PASSWORD and AIOCR_ENCRYPTION_KEY');
}
if (encryptionSecret && encryptionSecret.length < 32) throw new Error('AIOCR_ENCRYPTION_KEY must be at least 32 characters');

await mkdir(imageDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
if (sqlPool) {
  await sqlPool.query('CREATE TABLE IF NOT EXISTS aiocr_state (id TEXT PRIMARY KEY, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await sqlPool.query('CREATE TABLE IF NOT EXISTS aiocr_images (name TEXT PRIMARY KEY, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const stored = await sqlPool.query("SELECT payload FROM aiocr_state WHERE id = 'main'");
  if (stored.rowCount) {
    const parsed = JSON.parse(decryptBytes(stored.rows[0].payload).toString('utf8'));
    db = { ...db, ...parsed };
  } else if (existsSync(dbFile)) {
    const parsed = JSON.parse(decryptBytes(await readFile(dbFile)).toString('utf8'));
    db = { ...db, ...parsed };
    await persist();
  } else {
    await persist();
  }
} else if (existsSync(dbFile)) {
  const parsed = JSON.parse(decryptBytes(await readFile(dbFile)).toString('utf8'));
  db = { ...db, ...parsed };
  db.patients.forEach(patient => { if (!patient.tenantId) patient.tenantId = facilityId; });
  db.jobs.forEach(job => { if (!job.tenantId) job.tenantId = facilityId; });
} else {
  await persist();
}
db.patients.forEach(patient => { if (!patient.tenantId) patient.tenantId = facilityId; });
db.jobs.forEach(job => { if (!job.tenantId) job.tenantId = facilityId; });
const interruptedJobs = db.jobs.filter(job => ['REQUEST', 'PROCESSING'].includes(job.status));
if (interruptedJobs.length) {
  interruptedJobs.forEach(job => { job.status = 'ERROR'; job.error = 'サーバー再起動でOCRが中断されました。再OCRを実行してください。'; job.updatedAt = new Date().toISOString(); });
  await persist();
}

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function safeText(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function publicPatient(patient, tenantId) {
  return { ...patient, jobCount: db.jobs.filter(j => j.tenantId === tenantId && j.patientId === patient.id).length };
}
function audit(action, entityType, entityId, detail = {}) {
  if (!detail.tenantId) {
    const entity = entityType === 'job' ? db.jobs.find(item => item.id === entityId)
      : entityType === 'patient' ? db.patients.find(item => item.id === entityId) : null;
    if (entity?.tenantId) detail.tenantId = entity.tenantId;
  }
  db.audit.push({ id: id('audit'), at: now(), actor: 'local-user', action, entityType, entityId, detail });
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
}
function encryptBytes(content) {
  const plain = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!encryptionKey) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('AIOCR1'), iv, cipher.getAuthTag(), encrypted]);
}
function decryptBytes(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.subarray(0, 6).toString() !== 'AIOCR1') return bytes;
  if (!encryptionKey) throw new Error('Encrypted data requires AIOCR_ENCRYPTION_KEY');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(6, 18));
  decipher.setAuthTag(bytes.subarray(18, 34));
  return Buffer.concat([decipher.update(bytes.subarray(34)), decipher.final()]);
}
function persist() {
  writeChain = writeChain.then(async () => {
    const payload = encryptBytes(Buffer.from(JSON.stringify(db, null, 2), 'utf8'));
    if (sqlPool) {
      await sqlPool.query("INSERT INTO aiocr_state (id, payload, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()", [payload]);
      return;
    }
    const temp = `${dbFile}.tmp`;
    await writeFile(temp, payload);
    await rename(temp, dbFile);
  });
  return writeChain;
}
async function writeImage(name, content) {
  const payload = encryptBytes(content);
  if (sqlPool) return sqlPool.query('INSERT INTO aiocr_images (name, payload, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()', [name, payload]);
  return writeFile(path.join(imageDir, name), payload);
}
async function readImage(name) {
  if (sqlPool) {
    const stored = await sqlPool.query('SELECT payload FROM aiocr_images WHERE name = $1', [name]);
    if (!stored.rowCount) return null;
    return decryptBytes(stored.rows[0].payload);
  }
  const target = path.join(imageDir, name);
  return existsSync(target) ? decryptBytes(await readFile(target)) : null;
}
async function deleteImage(name) {
  if (sqlPool) return sqlPool.query('DELETE FROM aiocr_images WHERE name = $1', [name]);
  const target = path.join(imageDir, name);
  if (existsSync(target)) await unlink(target);
}
async function createBackup() {
  await persist();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `backup-${stamp}`);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'database.json'), encryptBytes(Buffer.from(JSON.stringify(db, null, 2), 'utf8')));
  if (sqlPool) {
    const images = await sqlPool.query('SELECT name, payload FROM aiocr_images');
    const destinationImages = path.join(destination, 'images');
    await mkdir(destinationImages, { recursive: true });
    await Promise.all(images.rows.map(image => writeFile(path.join(destinationImages, image.name), image.payload)));
  } else if (existsSync(imageDir)) await cp(imageDir, path.join(destination, 'images'), { recursive: true });
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, createdAt: now(), encrypted: Boolean(encryptionKey), facilityId }, null, 2), 'utf8');
  return destination;
}

async function enforceImageRetention() {
  if (!imageRetentionDays) return;
  const threshold = Date.now() - imageRetentionDays * 86400000;
  for (const job of db.jobs) {
    if (job.imageDeletedAt || job.status !== 'DONE' || !job.confirmedAt || Date.parse(job.confirmedAt) > threshold) continue;
    await deleteImage(job.imageFile);
    job.imageDeletedAt = now();
    audit('IMAGE_RETENTION_DELETED', 'job', job.id, { tenantId: job.tenantId, retentionDays: imageRetentionDays });
  }
  await persist();
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => { const index = part.indexOf('='); return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }));
}

function requestIdentity(req) {
  if (!authUser && !authPassword) return { userId: 'local-user', tenantId: facilityId, role: 'ADMIN' };
  const token = parseCookies(req).aiocr_session;
  const session = token ? sessions.get(token) : null;
  if (session && session.expiresAt > Date.now()) return session;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const expected = `${authUser}:${authPassword}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes)
    ? { userId: authUser, tenantId: facilityId, role: 'ADMIN' } : null;
}

function validCredentials(username, password) {
  const supplied = Buffer.from(`${username}:${password}`);
  const expected = Buffer.from(`${authUser}:${authPassword}`);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function loginRateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const cutoff = Date.now() - 15 * 60 * 1000;
  const attempts = (loginAttempts.get(key) || []).filter(value => value > cutoff);
  loginAttempts.set(key, attempts);
  return attempts.length >= 5;
}
function recordLoginFailure(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now()); loginAttempts.set(key, attempts);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('送信データが大きすぎます'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON形式が不正です'), { status: 400 }); }
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl || ''));
  if (!match || !allowedImageTypes.has(match[1])) throw Object.assign(new Error('JPEG、PNG、WebP画像を選択してください'), { status: 400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw Object.assign(new Error('画像は12MB以下にしてください'), { status: 400 });
  return { mime: match[1], bytes };
}

function jobView(job) {
  const patient = db.patients.find(p => p.tenantId === job.tenantId && p.id === job.patientId);
  return { ...job, patientName: patient?.name || '削除済み患者', imageUrl: `/api/jobs/${job.id}/image` };
}

function extractOutputText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) for (const content of item.content || []) if (typeof content.text === 'string') parts.push(content.text);
  return parts.join('\n');
}

function parseModelJson(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  return normalizeRehainfoResult(parsed);
}

function parsePlainModelJson(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function analyzeImageGeometry(apiKey, imageUrl) {
  const prompt = `# 役割
あなたは、手書き数値を含むリハビリ評価シートをAI OCRしやすい画像へ変換するための、文書画像補正判定AIです。画像を生成・編集せず、後段の画像処理が使う補正パラメータだけをJSONで返します。

# 最優先目的
手書き結果、印刷文字、罫線を欠落・変形させず、OCR対象セルが大きく、正面向きで、高コントラストになる補正を選んでください。見栄えより文字・数値の読み取りやすさを優先します。

# 判定手順
1. 用紙外周と、すべてのOCR対象表・手書き結果欄を確認する。
2. 回転、台形歪み、遠近歪み、影、低コントラスト、ぼけ、背景ノイズを個別に評価する。
3. 左右2列または複数表の場合、全表と全結果欄を囲む外接四角形を選ぶ。一方だけを選ばない。
4. 用紙四隅が明瞭なら用紙四隅を優先し、不明瞭なら全OCR対象表を囲む四隅を使う。
5. 横罫線が水平から0.1度以上、縦罫線が垂直から0.1度以上ずれる、平行線が収束する、上下左右の幅が異なる場合はneedsCorrection=true。
6. 四隅は画像左上を(0,0)、右下を(100,100)とする百分率で、topLeft、topRight、bottomRight、bottomLeftの順に返す。

# 保護ルール
- 手書き値、薄い鉛筆文字、チェック、丸印、訂正痕を余白やノイズと判断しない。
- 項目名、行、列、左右ページ、複数表を切り落とさない。
- ページ番号、机、影は四隅決定に使わない。
- 四隅が不確実な場合は過剰に切り込まず、confidenceを下げる。
- OCR内容を推測・転記・補完しない。

# 画像強調の選択
- grayscale: 色情報がOCRに不要で、グレースケール化が文字を明瞭にする場合のみtrue。
- autoContrast: 薄い文字や影があり、階調補正が有効ならtrue。
- sharpen: none、light、mediumから選ぶ。強い処理は禁止。
- denoise: none、light、mediumから選ぶ。細い手書き線を消す処理は禁止。

# 出力
JSON以外を返さない。すべてのキーを必ず返す。
{"needsCorrection":true,"confidence":0.0,"rotationDegrees":0.0,"reason":"短い判定理由","corners":{"topLeft":{"x":0,"y":0},"topRight":{"x":100,"y":0},"bottomRight":{"x":100,"y":100},"bottomLeft":{"x":0,"y":100}},"enhancements":{"grayscale":false,"autoContrast":true,"sharpen":"light","denoise":"none"}}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl }] }] }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const parsed = parsePlainModelJson(extractOutputText(payload));
  const point = value => ({ x: Math.max(0, Math.min(100, Number(value?.x))), y: Math.max(0, Math.min(100, Number(value?.y))) });
  const corners = { topLeft: point(parsed.corners?.topLeft), topRight: point(parsed.corners?.topRight), bottomRight: point(parsed.corners?.bottomRight), bottomLeft: point(parsed.corners?.bottomLeft) };
  const width = ((corners.topRight.x - corners.topLeft.x) + (corners.bottomRight.x - corners.bottomLeft.x)) / 2;
  const height = ((corners.bottomLeft.y - corners.topLeft.y) + (corners.bottomRight.y - corners.topRight.y)) / 2;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const level = value => ['none', 'light', 'medium'].includes(value) ? value : 'none';
  const enhancements = { grayscale: Boolean(parsed.enhancements?.grayscale), autoContrast: Boolean(parsed.enhancements?.autoContrast), sharpen: level(parsed.enhancements?.sharpen), denoise: level(parsed.enhancements?.denoise) };
  return { needsCorrection: Boolean(parsed.needsCorrection) && confidence >= 0.65 && width >= 35 && height >= 35, confidence, rotationDegrees: Math.max(-45, Math.min(45, Number(parsed.rotationDegrees) || 0)), reason: safeText(parsed.reason, 300), corners, enhancements, responseId: safeText(payload.id, 120) };
}

async function requestOcr(apiKey, imageUrl, prompt, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('OCR request timed out')), 120000);
  timeout.unref?.();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl }] }] }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
    const outputText = extractOutputText(payload);
    return { result: parseModelJson(outputText), responseId: safeText(payload.id, 120), outputText: safeText(outputText, 12000) };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', relayAbort);
  }
}

function filledFieldCount(result) {
  return (result?.fields || []).filter(field => String(field.value ?? '').trim() !== '').length;
}

function filledStefTimeCount(result) {
  return (result?.fields || []).filter(field => /^time_\d+$/.test(field.id) && String(field.value ?? '').trim() !== '').length;
}

async function runOcr(jobId) {
  const job = db.jobs.find(item => item.id === jobId);
  if (!job || job.status !== 'REQUEST') return;
  const controller = new AbortController();
  activeOcrControllers.set(jobId, controller);
  job.status = 'PROCESSING'; job.updatedAt = now(); job.error = null;
  audit('OCR_STARTED', 'job', job.id, { model }); await persist();
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEYが設定されていません');
    const bytes = await readImage(job.imageFile);
    if (!bytes) throw new Error('OCR画像が見つかりません');
    const imageUrl = `data:${job.imageType};base64,${bytes.toString('base64')}`;
    const attempts = [];
    let ocr = await requestOcr(apiKey, imageUrl, buildRehainfoOcrPrompt(), controller.signal);
    attempts.push({ responseId: ocr.responseId, filledFieldCount: filledFieldCount(ocr.result), output: ocr.outputText });
    if (ocr.result.testType === 'BBS' && filledFieldCount(ocr.result) === 0) {
      audit('OCR_RETRY_EMPTY_BBS', 'job', job.id, { attempt: 2 }); await persist();
      ocr = await requestOcr(apiKey, imageUrl, buildBbsRetryPrompt(), controller.signal);
      attempts.push({ responseId: ocr.responseId, filledFieldCount: filledFieldCount(ocr.result), output: ocr.outputText });
    }
    if (ocr.result.testType === 'STEF' && filledStefTimeCount(ocr.result) === 0) {
      audit('OCR_RETRY_EMPTY_STEF_TIME', 'job', job.id, { attempt: attempts.length + 1 }); await persist();
      const stefRetry = await requestOcr(apiKey, imageUrl, buildStefRetryPrompt(), controller.signal);
      attempts.push({ responseId: stefRetry.responseId, filledFieldCount: filledFieldCount(stefRetry.result), output: stefRetry.outputText });
      const retryFields = new Map(stefRetry.result.fields.map(field => [field.id, field]));
      ocr = {
        ...stefRetry,
        result: {
          ...ocr.result,
          fields: ocr.result.fields.map(field => /^time_\d+$/.test(field.id) && retryFields.has(field.id) ? retryFields.get(field.id) : field),
          notes: [ocr.result.notes, stefRetry.result.notes].filter(Boolean).join(' / '),
        },
      };
    }
    job.result = ocr.result;
    job.evaluationType = job.result.documentType || '帳票名不明';
    job.rawResponseId = ocr.responseId;
    job.ocrAttempts = attempts;
    const filledCount = filledFieldCount(job.result);
    if (job.result.testType === 'BBS' && filledCount === 0) throw new Error('BBSの点数を読み取れませんでした。画像を確認して再実行してください。');
    if (job.result.testType === 'STEF' && filledStefTimeCount(job.result) === 0) throw new Error('STEFの所要時間を読み取れませんでした。画像を確認して再実行してください。');
    job.status = 'OCR_DONE'; job.updatedAt = now();
    audit('OCR_COMPLETED', 'job', job.id, { fieldCount: job.result.fields.length, filledFieldCount: filledCount, attempts: attempts.length, responseId: job.rawResponseId });
  } catch (error) {
    if (controller.signal.aborted || job.status === 'STOPPED') {
      job.status = 'STOPPED'; job.error = null; job.updatedAt = now();
    } else {
      job.status = 'ERROR'; job.error = safeText(error.message || error, 1000); job.updatedAt = now();
      audit('OCR_FAILED', 'job', job.id, { error: job.error });
    }
  } finally {
    activeOcrControllers.delete(jobId);
  }
  await persist();
}

async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir) || !existsSync(target)) return false;
  const ext = path.extname(target).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
  createReadStream(target).pipe(res); return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: '不正な送信元です' });
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, product: 'Standalone AI OCR', model, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY) });
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!authUser || !authPassword) return sendJson(res, 200, { ok: true, userId: 'local-user', tenantId: facilityId });
      if (loginRateLimited(req)) return sendJson(res, 429, { error: 'ログイン失敗が多すぎます。15分後に再試行してください' });
      const body = await readJson(req);
      if (!validCredentials(safeText(body.username), String(body.password || ''))) { recordLoginFailure(req); audit('LOGIN_FAILED', 'authentication', safeText(body.username), { tenantId: facilityId }); await persist(); return sendJson(res, 401, { error: 'ユーザー名またはパスワードが違います' }); }
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { userId: authUser, tenantId: facilityId, role: 'ADMIN', expiresAt: Date.now() + sessionTtlMs });
      res.setHeader('Set-Cookie', `aiocr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}${secureCookies ? '; Secure' : ''}`);
      audit('LOGIN_SUCCEEDED', 'session', token.slice(0, 8), { tenantId: facilityId }); await persist();
      return sendJson(res, 200, { ok: true, userId: authUser, tenantId: facilityId });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const identity = requestIdentity(req); return identity ? sendJson(res, 200, { authenticated: true, userId: identity.userId, tenantId: identity.tenantId }) : sendJson(res, 401, { authenticated: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(req).aiocr_session; if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', `aiocr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`); return sendJson(res, 200, { ok: true });
    }
    const identity = requestIdentity(req);
    if (!identity) {
      if (req.method === 'GET' && ['/login.html', '/styles.css', '/login.js'].includes(url.pathname) && await serveStatic(url.pathname, res)) return;
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
      return sendJson(res, 401, { error: '認証が必要です' });
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze-image-geometry') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const body = await readJson(req); parseDataUrl(body.imageDataUrl);
      const analysis = await analyzeImageGeometry(apiKey, body.imageDataUrl);
      audit('AI_IMAGE_GEOMETRY_ANALYZED', 'image', id('geometry'), { needsCorrection: analysis.needsCorrection, confidence: analysis.confidence, responseId: analysis.responseId });
      await persist(); return sendJson(res, 200, analysis);
    }
    if (req.method === 'GET' && url.pathname === '/api/patients') return sendJson(res, 200, db.patients.filter(p => p.tenantId === identity.tenantId).map(p => publicPatient(p, identity.tenantId)));
    if (req.method === 'POST' && url.pathname === '/api/patients') {
      const body = await readJson(req); const name = safeText(body.name); const facilityPatientId = safeText(body.facilityPatientId);
      if (!name || !facilityPatientId) return sendJson(res, 400, { error: '患者名と施設内患者IDは必須です' });
      if (db.patients.some(p => p.tenantId === identity.tenantId && p.facilityPatientId === facilityPatientId)) return sendJson(res, 409, { error: '同じ施設内患者IDが登録済みです' });
      const patient = { id: id('patient'), tenantId: identity.tenantId, name, facilityPatientId, birthDate: safeText(body.birthDate, 10), createdAt: now(), updatedAt: now() };
      db.patients.push(patient); audit('PATIENT_CREATED', 'patient', patient.id, { tenantId: identity.tenantId }); await persist(); return sendJson(res, 201, publicPatient(patient, identity.tenantId));
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const jobs = db.jobs.filter(j => j.tenantId === identity.tenantId && (!patientId || j.patientId === patientId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(jobView);
      return sendJson(res, 200, jobs);
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(req); const patient = db.patients.find(p => p.tenantId === identity.tenantId && p.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const image = parseDataUrl(body.imageDataUrl); const jobId = id('ocr'); const ext = image.mime === 'image/png' ? '.png' : image.mime === 'image/webp' ? '.webp' : '.jpg';
      const imageFile = `${jobId}${ext}`; await writeImage(imageFile, image.bytes);
      const job = { id: jobId, tenantId: identity.tenantId, patientId: patient.id, evaluationType: '帳票判定中', status: 'REQUEST', imageFile, imageType: image.mime, result: null, confirmedResult: null, error: null, createdAt: now(), updatedAt: now(), confirmedAt: null };
      db.jobs.push(job); audit('JOB_CREATED', 'job', job.id, { patientId: patient.id }); await persist(); setImmediate(() => runOcr(job.id)); return sendJson(res, 202, jobView(job));
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && jobMatch) { const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === jobMatch[1]); return job ? sendJson(res, 200, jobView(job)) : sendJson(res, 404, { error: 'OCR履歴が見つかりません' }); }
    const imageMatch = /^\/api\/jobs\/([^/]+)\/image$/.exec(url.pathname);
    if (req.method === 'GET' && imageMatch) {
      const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === imageMatch[1]); if (!job) return sendJson(res, 404, { error: '画像が見つかりません' });
      const imageBytes = await readImage(job.imageFile); if (!imageBytes) return sendJson(res, 404, { error: '画像が見つかりません' });
      res.writeHead(200, { 'Content-Type': job.imageType, 'Content-Length': imageBytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(imageBytes);
    }
    const stopMatch = /^\/api\/jobs\/([^/]+)\/stop$/.exec(url.pathname);
    if (req.method === 'POST' && stopMatch) {
      const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === stopMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (!['REQUEST', 'PROCESSING'].includes(job.status)) return sendJson(res, 409, { error: '現在の状態では停止できません' });
      const previousStatus = job.status; job.status = 'STOPPED'; job.error = null; job.stoppedAt = now(); job.updatedAt = job.stoppedAt;
      activeOcrControllers.get(job.id)?.abort(new Error('OCR stopped by user'));
      audit('OCR_STOP_REQUESTED', 'job', job.id, { previousStatus }); await persist();
      return sendJson(res, 200, jobView(job));
    }
    const retryMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
    if (req.method === 'POST' && retryMatch) { const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === retryMatch[1]); if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' }); if (!['ERROR', 'OCR_DONE', 'STOPPED'].includes(job.status)) return sendJson(res, 409, { error: '現在の状態では再実行できません' }); job.status = 'REQUEST'; job.error = null; job.stoppedAt = null; job.updatedAt = now(); audit('JOB_RETRIED', 'job', job.id); await persist(); setImmediate(() => runOcr(job.id)); return sendJson(res, 202, jobView(job)); }
    const confirmMatch = /^\/api\/jobs\/([^/]+)\/confirm$/.exec(url.pathname);
    if (req.method === 'PUT' && confirmMatch) {
      const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === confirmMatch[1]); if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' }); if (job.status !== 'OCR_DONE' && job.status !== 'DONE') return sendJson(res, 409, { error: 'OCR完了後に確定してください' });
      const body = await readJson(req); const result = body.result; if (!result || !Array.isArray(result.fields)) return sendJson(res, 400, { error: '結果形式が不正です' });
      job.confirmedResult = parseModelJson(JSON.stringify(result)); job.status = 'DONE'; job.confirmedAt = now(); job.updatedAt = now(); audit('RESULT_CONFIRMED', 'job', job.id, { fieldCount: job.confirmedResult.fields.length }); await persist(); return sendJson(res, 200, jobView(job));
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') return sendJson(res, 200, db.audit.filter(a => !a.detail?.tenantId || a.detail.tenantId === identity.tenantId).slice(-500).reverse());
    if (req.method === 'DELETE' && url.pathname === '/api/audit') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: '管理者権限が必要です' });
      const deletedCount = db.audit.length;
      db.audit = [];
      await persist();
      return sendJson(res, 200, { ok: true, deletedCount });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/backup') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: '管理者権限が必要です' });
      const destination = await createBackup(); audit('BACKUP_CREATED', 'backup', path.basename(destination), { tenantId: identity.tenantId }); await persist();
      return sendJson(res, 201, { ok: true, backup: path.basename(destination) });
    }
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) { sendJson(res, error.status || 500, { error: safeText(error.message || error, 1000) }); }
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Standalone AI OCR: http://${host}:${address.port}`);
});
await enforceImageRetention();
const retentionTimer = setInterval(() => enforceImageRetention().catch(error => console.error('retention error', error)), 24 * 60 * 60 * 1000);
retentionTimer.unref();

export { server };
