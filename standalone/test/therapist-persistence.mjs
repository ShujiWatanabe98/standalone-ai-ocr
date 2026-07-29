import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = await mkdtemp(path.join(process.cwd(), 'tmp-therapist-test-'));
const port = 55491;
const base = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from('test-admin:test-password').toString('base64')}`;
let child;

async function start() {
  let stderr = '';
  child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      AIOCR_SKIP_LOCAL_ENV: '1',
      AIOCR_DATA_DIR: dataDir,
      AIOCR_PORT: String(port),
      AIOCR_USERNAME: 'test-admin',
      AIOCR_PASSWORD: 'test-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes(base)) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('exit', code => reject(new Error(`server exited: ${code}\n${stderr}`)));
  });
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

try {
  await start();
  const created = await api('/api/therapists', { method: 'POST', body: JSON.stringify({ therapistId: 'PT-TEST-001', name: '永続化テスト療法士' }) });
  assert.equal(created.therapistId, 'PT-TEST-001');
  assert.equal(created.name, '永続化テスト療法士');
  await stop();

  await start();
  const therapists = await api('/api/therapists');
  assert.equal(therapists.length, 1);
  assert.equal(therapists[0].therapistId, 'PT-TEST-001');
  assert.equal(therapists[0].name, '永続化テスト療法士');
  console.log('therapist persistence: ok');
} finally {
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}
