import http from 'node:http';
import { readFile, writeFile, mkdir, rename, cp, rm, unlink } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildBbsRetryPrompt, buildBitRetryPrompt, buildFmaLowerRetryPrompt, buildRehainfoOcrPrompt, buildStefRetryPrompt, normalizeRehainfoResult } from './rehainfo-ocr-definitions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const localEnvFile = path.resolve(here, '..', 'standalone-ai-ocr.local.env');
if (process.env.AIOCR_SKIP_LOCAL_ENV !== '1' && existsSync(localEnvFile)) {
  const localEnv = await readFile(localEnvFile, 'utf8');
  for (const line of localEnv.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[2] === '' || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const publicDir = path.join(here, 'public');
const dataDir = path.resolve(process.env.AIOCR_DATA_DIR || path.join(here, 'data'));
const imageDir = path.join(dataDir, 'images');
const dbFile = path.join(dataDir, 'database.json');
const backupDir = path.resolve(process.env.AIOCR_BACKUP_DIR || path.join(here, 'backups'));
const port = Number(process.env.AIOCR_PORT || process.env.PORT || 8795);
const host = process.env.AIOCR_HOST || '127.0.0.1';
const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const requestedImageDetail = String(process.env.OPENAI_IMAGE_DETAIL || 'high').toLowerCase();
const imageDetail = ['low', 'high', 'original', 'auto'].includes(requestedImageDetail) ? requestedImageDetail : 'high';
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

let db = { version: 3, hospitals: [], patients: [], jobs: [] };
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
if (!Array.isArray(db.hospitals)) db.hospitals = [];
if ('audit' in db) { delete db.audit; await persist(); }
const interruptedJobs = db.jobs.filter(job => ['REQUEST', 'PROCESSING'].includes(job.status));
if (interruptedJobs.length) {
  interruptedJobs.forEach(job => { job.status = 'ERROR'; job.error = 'サーバー再起動でOCRが中断されました。再OCRを実行してください。'; job.updatedAt = new Date().toISOString(); });
  await persist();
}

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function evaluationPageKey(job) {
  if (job?.result?.testType === 'BIT') {
    const match = (job.result.fields || []).map(field => /^BIT_(\d+)_/.exec(String(field.id || ''))).find(Boolean);
    return match ? `BIT_${match[1]}` : null;
  }
  if (job?.result?.testType === 'SLTA_ALL') {
    const numbers = (job.result.fields || []).map(field => /^#(\d+)$/.exec(String(field.id || ''))).filter(Boolean).map(match => Number(match[1]));
    return numbers.length ? `SLTA_${Math.min(...numbers)}_${Math.max(...numbers)}` : null;
  }
  return null;
}
function rebuildAssessmentGroups() {
  let changed = 0;
  const grouped = new Map();
  for (const job of db.jobs.filter(candidate => ['BIT', 'SLTA_ALL'].includes(candidate.result?.testType)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = `${job.tenantId}|${job.patientId}|${job.result.testType}`;
    const pageKey = evaluationPageKey(job);
    let state = grouped.get(key);
    if (!state || (pageKey && state.pages.has(pageKey))) {
      state = { id: `assessment_${job.id}`, pages: new Set() };
      grouped.set(key, state);
    }
    if (pageKey) state.pages.add(pageKey);
    if (job.assessmentGroupId !== state.id) {
      job.assessmentGroupId = state.id;
      changed++;
    }
  }
  return changed;
}
if (rebuildAssessmentGroups()) await persist();
function safeText(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const supplied = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function publicHospital(hospital) {
  return { id: hospital.id, name: hospital.name, loginName: hospital.loginName, active: hospital.active !== false, createdAt: hospital.createdAt, updatedAt: hospital.updatedAt };
}
function publicPatient(patient, tenantId) {
  return { ...patient, jobCount: db.jobs.filter(j => j.tenantId === tenantId && j.patientId === patient.id).length };
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
  if (!authUser && !authPassword && db.hospitals.length === 0) return { userId: 'local-user', tenantId: facilityId, role: 'ADMIN' };
  const token = parseCookies(req).aiocr_session;
  const session = token ? sessions.get(token) : null;
  if (session && session.expiresAt > Date.now()) return session;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const separator = supplied.indexOf(':');
  if (separator < 0) return null;
  return authenticateCredentials(supplied.slice(0, separator), supplied.slice(separator + 1));
}

function authenticateCredentials(username, password) {
  const supplied = Buffer.from(`${username}:${password}`);
  const expected = Buffer.from(`${authUser}:${authPassword}`);
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return { userId: authUser, tenantId: facilityId, role: 'ADMIN', hospitalName: null };
  const hospital = db.hospitals.find(item => item.active !== false && item.loginName === username);
  return hospital && verifyPassword(password, hospital.passwordHash)
    ? { userId: hospital.loginName, tenantId: hospital.id, role: 'HOSPITAL', hospitalName: hospital.name }
    : null;
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
  const sameSheetJobs = db.jobs
    .filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.result && ['OCR_DONE', 'DONE'].includes(candidate.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const assessmentKeys = [...new Set(sameSheetJobs.map(candidate => candidate.assessmentGroupId || candidate.id))];
  const sheetIndex = assessmentKeys.indexOf(job.assessmentGroupId || job.id);
  const careStage = ['INITIAL', 'FOLLOW_UP', 'DISCHARGE'].includes(job.careStage) ? job.careStage : sheetIndex === 0 ? 'INITIAL' : sheetIndex > 0 ? 'FOLLOW_UP' : 'PENDING';
  return { ...job, careStage, patientName: patient?.name || '削除済み患者', imageUrl: `/api/jobs/${job.id}/image` };
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
    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl, detail: imageDetail }] }] }),
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
      body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl, detail: imageDetail }] }] }),
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

async function generateRehabSummary(apiKey, job) {
  const evaluation = evaluationForSummary(job);
  const prompt = `あなたはリハビリテーション医療の記録作成支援者です。
以下の初診時評価結果だけを根拠として、日本語で簡潔な「リハビリ方針案」を作成してください。
構成は「評価要約」「短期目標」「介入方針」「リスク・注意点」「再評価方針」とし、合計800文字以内にしてください。
入力にない診断、病歴、予後を推測して断定しないでください。医療者が確認・修正する草案として記載してください。

初診時評価:
${JSON.stringify(evaluation)}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const summary = safeText(extractOutputText(payload), 4000);
  if (!summary) throw new Error('サマリを生成できませんでした');
  return summary;
}

function evaluationForSummary(job) {
  const groupedJobs = job.assessmentGroupId
    ? db.jobs.filter(candidate => candidate.tenantId === job.tenantId && candidate.assessmentGroupId === job.assessmentGroupId && candidate.result).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [job];
  if (groupedJobs.length > 1) {
    return {
      documentType: job.evaluationType,
      pages: groupedJobs.map((candidate, index) => {
        const result = candidate.confirmedResult || candidate.result;
        return {
          page: evaluationPageKey(candidate) || index + 1,
          evaluationDate: result?.evaluationDate || '',
          fields: (result?.fields || []).map(field => ({ label: field.label, value: field.value })).filter(field => String(field.value ?? '').trim() !== ''),
          notes: result?.notes || '',
        };
      }),
    };
  }
  const result = groupedJobs[0]?.confirmedResult || groupedJobs[0]?.result;
  return {
    documentType: result?.documentType || job.evaluationType,
    evaluationDate: result?.evaluationDate || '',
    fields: (result?.fields || []).map(field => ({ label: field.label, value: field.value })).filter(field => String(field.value ?? '').trim() !== ''),
    notes: result?.notes || '',
  };
}

function previousSameSheetJob(job) {
  return db.jobs
    .filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.id !== job.id && candidate.result && candidate.createdAt < job.createdAt && (!job.assessmentGroupId || candidate.assessmentGroupId !== job.assessmentGroupId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

async function generateProgressSummary(apiKey, job) {
  const previousJob = previousSameSheetJob(job);
  if (!previousJob) throw new Error('比較できる前回のシートがありません');
  const prompt = `あなたはリハビリテーション医療の記録作成支援者です。
同じ患者・同じ評価シートの前回評価と今回評価を比較し、日本語で簡潔な「途中経過サマリ案」を作成してください。
構成は「改善した点」「改善していない点・低下した点」「総合評価」「今後のリハビリ方針」とし、合計1000文字以内にしてください。
数値の方向だけで改善と断定できない項目は慎重に表現し、入力にない診断や原因を推測しないでください。医療者が確認・修正する草案として記載してください。

シート名: ${job.evaluationType}
前回評価:
${JSON.stringify(evaluationForSummary(previousJob))}

今回評価:
${JSON.stringify(evaluationForSummary(job))}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const summary = safeText(extractOutputText(payload), 4000);
  if (!summary) throw new Error('途中経過サマリを生成できませんでした');
  return summary;
}

async function generateDischargeSummary(apiKey, job) {
  const sameSheetJobs = db.jobs
    .filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.result && candidate.createdAt <= job.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!sameSheetJobs.length) throw new Error('退院サマリを作成できる評価履歴がありません');
  const groupRepresentatives = [...new Map(sameSheetJobs.map(candidate => [candidate.assessmentGroupId || candidate.id, candidate])).values()];
  const evaluations = groupRepresentatives.map((candidate, index) => ({
    stage: candidate.id === job.id ? '退院時' : index === 0 ? '初診時' : `途中経過${index}`,
    ...evaluationForSummary(candidate),
  }));
  const prompt = `あなたはリハビリテーション医療の記録作成支援者です。
同じ患者・同じ評価シートの初診から退院時までの評価履歴を比較し、日本語で簡潔な「退院経過サマリ案」を作成してください。
構成は「初診時の状態」「リハビリ経過と改善点」「残存課題」「退院時評価」「退院後の生活・リハビリ方針」とし、合計1200文字以内にしてください。
数値の方向だけで改善と断定できない項目は慎重に表現し、入力にない診断、病歴、生活環境を推測しないでください。医療者が確認・修正する草案として記載してください。

シート名: ${job.evaluationType}
評価履歴:
${JSON.stringify(evaluations)}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const summary = safeText(extractOutputText(payload), 4000);
  if (!summary) throw new Error('退院経過サマリを生成できませんでした');
  return summary;
}

function filledFieldCount(result) {
  return (result?.fields || []).filter(field => String(field.value ?? '').trim() !== '').length;
}

function filledStefTimeCount(result) {
  return (result?.fields || []).filter(field => /^time_\d+$/.test(field.id) && String(field.value ?? '').trim() !== '').length;
}

function expectedBitFieldCount(result) {
  const pageMatch = (result?.fields || []).map(field => /^BIT_(\d)_/.exec(field.id)).find(Boolean);
  return ({ 3: 9, 5: 9, 6: 12, 7: 2 })[pageMatch?.[1]] || 1;
}

async function runOcr(jobId) {
  const job = db.jobs.find(item => item.id === jobId);
  if (!job || job.status !== 'REQUEST') return;
  const controller = new AbortController();
  activeOcrControllers.set(jobId, controller);
  job.status = 'PROCESSING'; job.updatedAt = now(); job.error = null;
  await persist();
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEYが設定されていません');
    const bytes = await readImage(job.imageFile);
    if (!bytes) throw new Error('OCR画像が見つかりません');
    const imageUrl = `data:${job.imageType};base64,${bytes.toString('base64')}`;
    const attempts = [];
    let ocr = await requestOcr(apiKey, imageUrl, buildRehainfoOcrPrompt(), controller.signal);
    attempts.push({ responseId: ocr.responseId, filledFieldCount: filledFieldCount(ocr.result), output: ocr.outputText });
    if (ocr.result.testType === 'UNSUPPORTED') {
      await persist();
      const bitClassificationRetry = await requestOcr(apiKey, imageUrl, buildBitRetryPrompt(), controller.signal);
      attempts.push({ responseId: bitClassificationRetry.responseId, filledFieldCount: filledFieldCount(bitClassificationRetry.result), output: bitClassificationRetry.outputText });
      if (bitClassificationRetry.result.testType === 'BIT' && filledFieldCount(bitClassificationRetry.result) > 0) ocr = bitClassificationRetry;
    }
    if (ocr.result.testType === 'UNSUPPORTED' || (ocr.result.testType === 'FMA_1' && filledFieldCount(ocr.result) <= 17)) {
      await persist();
      const fmaLowerClassificationRetry = await requestOcr(apiKey, imageUrl, buildFmaLowerRetryPrompt(), controller.signal);
      attempts.push({ responseId: fmaLowerClassificationRetry.responseId, filledFieldCount: filledFieldCount(fmaLowerClassificationRetry.result), output: fmaLowerClassificationRetry.outputText });
      if (fmaLowerClassificationRetry.result.testType === 'FMA_2' && filledFieldCount(fmaLowerClassificationRetry.result) > 0) ocr = fmaLowerClassificationRetry;
    }
    if (ocr.result.testType === 'FMA_2' && filledFieldCount(ocr.result) < 17) {
      await persist();
      const fmaLowerRetry = await requestOcr(apiKey, imageUrl, buildFmaLowerRetryPrompt(), controller.signal);
      attempts.push({ responseId: fmaLowerRetry.responseId, filledFieldCount: filledFieldCount(fmaLowerRetry.result), output: fmaLowerRetry.outputText });
      if (fmaLowerRetry.result.testType === 'FMA_2' && filledFieldCount(fmaLowerRetry.result) > filledFieldCount(ocr.result)) ocr = fmaLowerRetry;
    }
    if (ocr.result.testType === 'BBS' && filledFieldCount(ocr.result) === 0) {
      await persist();
      ocr = await requestOcr(apiKey, imageUrl, buildBbsRetryPrompt(), controller.signal);
      attempts.push({ responseId: ocr.responseId, filledFieldCount: filledFieldCount(ocr.result), output: ocr.outputText });
    }
    if (ocr.result.testType === 'STEF' && filledStefTimeCount(ocr.result) === 0) {
      await persist();
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
    if (ocr.result.testType === 'BIT' && filledFieldCount(ocr.result) < expectedBitFieldCount(ocr.result)) {
      await persist();
      const bitRetry = await requestOcr(apiKey, imageUrl, buildBitRetryPrompt(), controller.signal);
      attempts.push({ responseId: bitRetry.responseId, filledFieldCount: filledFieldCount(bitRetry.result), output: bitRetry.outputText });
      if (filledFieldCount(bitRetry.result) > filledFieldCount(ocr.result)) ocr = bitRetry;
    }
    job.result = ocr.result;
    job.evaluationType = job.result.documentType || '帳票名不明';
    rebuildAssessmentGroups();
    job.rawResponseId = ocr.responseId;
    job.ocrAttempts = attempts;
    const filledCount = filledFieldCount(job.result);
    if (job.result.testType === 'BBS' && filledCount === 0) throw new Error('BBSの点数を読み取れませんでした。画像を確認して再実行してください。');
    if (job.result.testType === 'FMA_2' && filledCount === 0) throw new Error('FMA下肢の結果欄を読み取れませんでした。画像を確認して再実行してください。');
    if (job.result.testType === 'STEF' && filledStefTimeCount(job.result) === 0) throw new Error('STEFの所要時間を読み取れませんでした。画像を確認して再実行してください。');
    if (job.result.testType === 'BIT' && filledCount === 0) throw new Error('BITの手書き結果を読み取れませんでした。画像を確認して再実行してください。');
    job.status = 'OCR_DONE'; job.updatedAt = now();
  } catch (error) {
    if (controller.signal.aborted || job.status === 'STOPPED') {
      job.status = 'STOPPED'; job.error = null; job.updatedAt = now();
    } else {
      job.status = 'ERROR'; job.error = safeText(error.message || error, 1000); job.updatedAt = now();
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
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
  createReadStream(target).pipe(res); return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: '不正な送信元です' });
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, product: 'Standalone AI OCR', release: '2026-07-27-compact-ocr-fields-1', model, imageDetail, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY) });
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if ((!authUser || !authPassword) && db.hospitals.length === 0) return sendJson(res, 200, { ok: true, userId: 'local-user', tenantId: facilityId, role: 'ADMIN', redirect: '/admin.html' });
      if (loginRateLimited(req)) return sendJson(res, 429, { error: 'ログイン失敗が多すぎます。15分後に再試行してください' });
      const body = await readJson(req);
      const authenticated = authenticateCredentials(safeText(body.username), String(body.password || ''));
      if (!authenticated) { recordLoginFailure(req); return sendJson(res, 401, { error: 'ユーザー名またはパスワードが違います' }); }
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { ...authenticated, expiresAt: Date.now() + sessionTtlMs });
      res.setHeader('Set-Cookie', `aiocr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlMs / 1000}${secureCookies ? '; Secure' : ''}`);
      return sendJson(res, 200, { ok: true, userId: authenticated.userId, tenantId: authenticated.tenantId, role: authenticated.role, hospitalName: authenticated.hospitalName, redirect: authenticated.role === 'ADMIN' ? '/admin.html' : '/' });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const identity = requestIdentity(req); return identity ? sendJson(res, 200, { authenticated: true, userId: identity.userId, tenantId: identity.tenantId, role: identity.role, hospitalName: identity.hospitalName || null }) : sendJson(res, 401, { authenticated: false });
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
    if (req.method === 'GET' && url.pathname === '/') {
      if (identity.role === 'ADMIN') { res.writeHead(302, { Location: '/admin.html' }); return res.end(); }
      if (await serveStatic('/index.html', res)) return;
    }
    if (req.method === 'GET' && url.pathname === '/index.html' && identity.role === 'ADMIN') {
      res.writeHead(302, { Location: '/admin.html' }); return res.end();
    }
    if (url.pathname === '/admin.html' || url.pathname === '/admin.js') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: 'ADMIN権限が必要です' });
      if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/hospitals') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: 'ADMIN権限が必要です' });
      return sendJson(res, 200, db.hospitals.map(publicHospital).sort((a, b) => a.name.localeCompare(b.name, 'ja')));
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/hospitals') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: 'ADMIN権限が必要です' });
      const body = await readJson(req);
      const name = safeText(body.name, 120);
      const loginName = safeText(body.loginName, 80);
      const password = String(body.password || '');
      if (!name || !/^[A-Za-z0-9._@-]{3,80}$/.test(loginName)) return sendJson(res, 400, { error: '病院名と3文字以上のログイン名を入力してください' });
      if (password.length < 8 || password.length > 200) return sendJson(res, 400, { error: 'パスワードは8文字以上で設定してください' });
      if (loginName === authUser || db.hospitals.some(item => item.loginName === loginName)) return sendJson(res, 409, { error: 'このログイン名は既に使用されています' });
      const timestamp = now();
      const hospital = { id: id('hospital'), name, loginName, passwordHash: hashPassword(password), active: true, createdAt: timestamp, updatedAt: timestamp };
      db.hospitals.push(hospital);
      await persist();
      return sendJson(res, 201, publicHospital(hospital));
    }
    const hospitalAdminMatch = /^\/api\/admin\/hospitals\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && hospitalAdminMatch) {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: 'ADMIN権限が必要です' });
      const hospital = db.hospitals.find(item => item.id === hospitalAdminMatch[1]);
      if (!hospital) return sendJson(res, 404, { error: '病院が見つかりません' });
      const body = await readJson(req);
      const name = safeText(body.name, 120);
      const loginName = safeText(body.loginName, 80);
      const password = String(body.password || '');
      if (!name || !/^[A-Za-z0-9._@-]{3,80}$/.test(loginName)) return sendJson(res, 400, { error: '病院名と3文字以上のログイン名を入力してください' });
      if (password && (password.length < 8 || password.length > 200)) return sendJson(res, 400, { error: '変更するパスワードは8文字以上で設定してください' });
      if (loginName === authUser || db.hospitals.some(item => item.id !== hospital.id && item.loginName === loginName)) return sendJson(res, 409, { error: 'このログイン名は既に使用されています' });
      hospital.name = name;
      hospital.loginName = loginName;
      if (password) hospital.passwordHash = hashPassword(password);
      hospital.updatedAt = now();
      for (const [token, session] of sessions) if (session.tenantId === hospital.id) sessions.delete(token);
      await persist();
      return sendJson(res, 200, publicHospital(hospital));
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze-image-geometry') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const body = await readJson(req); parseDataUrl(body.imageDataUrl);
      const analysis = await analyzeImageGeometry(apiKey, body.imageDataUrl);
      await persist(); return sendJson(res, 200, analysis);
    }
    if (req.method === 'GET' && url.pathname === '/api/patients') return sendJson(res, 200, db.patients.filter(p => p.tenantId === identity.tenantId).map(p => publicPatient(p, identity.tenantId)));
    if (req.method === 'POST' && url.pathname === '/api/patients') {
      const body = await readJson(req); const name = safeText(body.name); const facilityPatientId = safeText(body.facilityPatientId);
      if (!name || !facilityPatientId) return sendJson(res, 400, { error: '患者名と施設内患者IDは必須です' });
      if (db.patients.some(p => p.tenantId === identity.tenantId && p.facilityPatientId === facilityPatientId)) return sendJson(res, 409, { error: '同じ施設内患者IDが登録済みです' });
      const patient = { id: id('patient'), tenantId: identity.tenantId, name, facilityPatientId, birthDate: safeText(body.birthDate, 10), createdAt: now(), updatedAt: now() };
      db.patients.push(patient); await persist(); return sendJson(res, 201, publicPatient(patient, identity.tenantId));
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const jobs = db.jobs.filter(j => j.tenantId === identity.tenantId && (!patientId || j.patientId === patientId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(jobView);
      return sendJson(res, 200, jobs);
    }
    if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
      const jobsToDelete = db.jobs.filter(job => job.tenantId === identity.tenantId);
      for (const job of jobsToDelete) {
        activeOcrControllers.get(job.id)?.abort(new Error('OCR history deleted by user'));
        activeOcrControllers.delete(job.id);
        await deleteImage(job.imageFile);
      }
      const deletedIds = new Set(jobsToDelete.map(job => job.id));
      db.jobs = db.jobs.filter(job => !deletedIds.has(job.id));
      await persist();
      return sendJson(res, 200, { ok: true, deletedCount: jobsToDelete.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(req); const patient = db.patients.find(p => p.tenantId === identity.tenantId && p.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const image = parseDataUrl(body.imageDataUrl); const jobId = id('ocr'); const ext = image.mime === 'image/png' ? '.png' : image.mime === 'image/webp' ? '.webp' : '.jpg';
      const imageFile = `${jobId}${ext}`; await writeImage(imageFile, image.bytes);
      const job = { id: jobId, tenantId: identity.tenantId, patientId: patient.id, evaluationType: '帳票判定中', status: 'REQUEST', imageFile, imageType: image.mime, result: null, confirmedResult: null, error: null, createdAt: now(), updatedAt: now(), confirmedAt: null };
      db.jobs.push(job); await persist(); setImmediate(() => runOcr(job.id)); return sendJson(res, 202, jobView(job));
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
      job.status = 'STOPPED'; job.error = null; job.stoppedAt = now(); job.updatedAt = job.stoppedAt;
      activeOcrControllers.get(job.id)?.abort(new Error('OCR stopped by user'));
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const dischargeMatch = /^\/api\/jobs\/([^/]+)\/discharge$/.exec(url.pathname);
    if (req.method === 'POST' && dischargeMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === dischargeMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (!job.result || !['OCR_DONE', 'DONE'].includes(job.status)) return sendJson(res, 409, { error: 'OCR完了後のシートを退院にしてください' });
      const sameSheetJobs = db.jobs
        .filter(candidate => candidate.tenantId === identity.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.result && ['OCR_DONE', 'DONE'].includes(candidate.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (sameSheetJobs[0]?.id !== job.id) return sendJson(res, 409, { error: '最新のシートだけを退院にできます' });
      job.careStage = 'DISCHARGE';
      job.dischargedAt = now();
      job.updatedAt = job.dischargedAt;
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const undoDischargeMatch = /^\/api\/jobs\/([^/]+)\/discharge\/undo$/.exec(url.pathname);
    if (req.method === 'POST' && undoDischargeMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === undoDischargeMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (job.careStage !== 'DISCHARGE') return sendJson(res, 409, { error: '退院状態のシートだけを途中経過に戻せます' });
      const previousJobs = db.jobs.filter(candidate => candidate.tenantId === identity.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.id !== job.id && candidate.result && candidate.createdAt < job.createdAt);
      if (!previousJobs.length) return sendJson(res, 409, { error: '前回記録がないため途中経過には戻せません' });
      job.careStage = 'FOLLOW_UP';
      delete job.dischargedAt;
      job.updatedAt = now();
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const initialSummaryMatch = /^\/api\/jobs\/([^/]+)\/initial-summary$/.exec(url.pathname);
    if (req.method === 'PUT' && initialSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === initialSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'INITIAL') return sendJson(res, 409, { error: '初診シートだけにリハビリ方針を保存できます' });
      const body = await readJson(req);
      job.rehabSummary = safeText(body.rehabSummary, 4000);
      job.rehabSummaryUpdatedAt = now();
      job.updatedAt = job.rehabSummaryUpdatedAt;
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const generateInitialSummaryMatch = /^\/api\/jobs\/([^/]+)\/initial-summary\/generate$/.exec(url.pathname);
    if (req.method === 'POST' && generateInitialSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === generateInitialSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'INITIAL') return sendJson(res, 409, { error: '初診シートだけでサマリを生成できます' });
      if (!job.result) return sendJson(res, 409, { error: 'OCR完了後にサマリを生成してください' });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const rehabSummary = await generateRehabSummary(apiKey, job);
      return sendJson(res, 200, { rehabSummary });
    }
    const progressSummaryMatch = /^\/api\/jobs\/([^/]+)\/progress-summary$/.exec(url.pathname);
    if (req.method === 'PUT' && progressSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === progressSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'FOLLOW_UP') return sendJson(res, 409, { error: '途中経過シートだけにサマリを保存できます' });
      const body = await readJson(req);
      job.progressSummary = safeText(body.progressSummary, 4000);
      job.progressSummaryUpdatedAt = now();
      job.updatedAt = job.progressSummaryUpdatedAt;
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const generateProgressSummaryMatch = /^\/api\/jobs\/([^/]+)\/progress-summary\/generate$/.exec(url.pathname);
    if (req.method === 'POST' && generateProgressSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === generateProgressSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'FOLLOW_UP') return sendJson(res, 409, { error: '途中経過シートだけでサマリを生成できます' });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const progressSummary = await generateProgressSummary(apiKey, job);
      return sendJson(res, 200, { progressSummary });
    }
    const dischargeSummaryMatch = /^\/api\/jobs\/([^/]+)\/discharge-summary$/.exec(url.pathname);
    if (req.method === 'PUT' && dischargeSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === dischargeSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'DISCHARGE') return sendJson(res, 409, { error: '退院シートだけに退院経過サマリを保存できます' });
      const body = await readJson(req);
      job.dischargeSummary = safeText(body.dischargeSummary, 4000);
      job.dischargeSummaryUpdatedAt = now();
      job.updatedAt = job.dischargeSummaryUpdatedAt;
      await persist();
      return sendJson(res, 200, jobView(job));
    }
    const generateDischargeSummaryMatch = /^\/api\/jobs\/([^/]+)\/discharge-summary\/generate$/.exec(url.pathname);
    if (req.method === 'POST' && generateDischargeSummaryMatch) {
      const job = db.jobs.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === generateDischargeSummaryMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
      if (jobView(job).careStage !== 'DISCHARGE') return sendJson(res, 409, { error: '退院シートだけで退院経過サマリを生成できます' });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const dischargeSummary = await generateDischargeSummary(apiKey, job);
      return sendJson(res, 200, { dischargeSummary });
    }
    const retryMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
    if (req.method === 'POST' && retryMatch) { const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === retryMatch[1]); if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' }); if (!['ERROR', 'OCR_DONE', 'STOPPED'].includes(job.status)) return sendJson(res, 409, { error: '現在の状態では再実行できません' }); job.status = 'REQUEST'; job.error = null; job.stoppedAt = null; job.updatedAt = now(); await persist(); setImmediate(() => runOcr(job.id)); return sendJson(res, 202, jobView(job)); }
    const confirmMatch = /^\/api\/jobs\/([^/]+)\/confirm$/.exec(url.pathname);
    if (req.method === 'PUT' && confirmMatch) {
      const job = db.jobs.find(j => j.tenantId === identity.tenantId && j.id === confirmMatch[1]); if (!job) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' }); if (job.status !== 'OCR_DONE' && job.status !== 'DONE') return sendJson(res, 409, { error: 'OCR完了後に確定してください' });
      const body = await readJson(req); const result = body.result; if (!result || !Array.isArray(result.fields)) return sendJson(res, 400, { error: '結果形式が不正です' });
      job.confirmedResult = parseModelJson(JSON.stringify(result)); job.status = 'DONE'; job.confirmedAt = now(); job.updatedAt = now(); await persist(); return sendJson(res, 200, jobView(job));
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/backup') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: '管理者権限が必要です' });
      const destination = await createBackup(); await persist();
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
