import http from 'node:http';
import { readFile, writeFile, mkdir, rename, cp, rm, unlink, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { outcomeDemoPatientIds, seedOutcomeDemoData } from './outcome-demo-seed.mjs';
import { applyKnownSltaLabels, buildBbsRetryPrompt, buildBitPage1Prompt, buildBitPage2Prompt, buildBitRetryPrompt, buildFmaLowerRetryPrompt, buildFmaUpperRetryPrompt, buildRehainfoOcrPrompt, buildRoutedOcrPrompt, buildSltaProblemResponseRetryPrompt, buildStefRetryPrompt, buildTargetedRetryPrompt, inferOcrRoute, normalizeRehainfoResult } from './rehainfo-ocr-definitions.mjs';

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
const rehabVoiceAudioDir = path.join(dataDir, 'rehab-voice-audio');
const dbFile = path.join(dataDir, 'database.json');
const backupDir = path.resolve(process.env.AIOCR_BACKUP_DIR || path.join(here, 'backups'));
const port = Number(process.env.AIOCR_PORT || process.env.PORT || 8795);
const host = process.env.AIOCR_HOST || '127.0.0.1';
const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'low';
const retryReasoningEffort = process.env.OPENAI_RETRY_REASONING_EFFORT || 'high';
const requestedImageDetail = String(process.env.OPENAI_IMAGE_DETAIL || 'original').toLowerCase();
const imageDetail = ['low', 'high', 'original', 'auto'].includes(requestedImageDetail) ? requestedImageDetail : 'original';
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

let db = { version: 24, hospitals: [], patients: [], therapists: [], jobs: [], rehabRecords: [], rehabVoiceSessions: [], rehabPlans: [], rehabPlanContexts: [], outcomeGoals: [], outcomeSnapshots: [], outcomeActions: [], fimAssessments: [], recoveryWardProfiles: [], dischargeTasks: [], conferences: [], warningReviews: [], integrationRuns: [], clinicalEvents: [], pilotTimeMeasurements: [], pilotSafetyEvents: [], pilotStaffFeedback: [], pilotStudies: [], pilotApprovals: [], pilotExpansions: [] };
let writeChain = Promise.resolve();

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!authUser || !authPassword || !encryptionKey)) {
  throw new Error('External binding requires AIOCR_USERNAME, AIOCR_PASSWORD and AIOCR_ENCRYPTION_KEY');
}
if (encryptionSecret && encryptionSecret.length < 32) throw new Error('AIOCR_ENCRYPTION_KEY must be at least 32 characters');

await mkdir(imageDir, { recursive: true });
await mkdir(rehabVoiceAudioDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
if (sqlPool) {
  await sqlPool.query('CREATE TABLE IF NOT EXISTS aiocr_state (id TEXT PRIMARY KEY, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await sqlPool.query('CREATE TABLE IF NOT EXISTS aiocr_images (name TEXT PRIMARY KEY, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await sqlPool.query('CREATE TABLE IF NOT EXISTS aiocr_rehab_voice_audio (session_id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
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
if (!Array.isArray(db.therapists)) db.therapists = [];
if (!Array.isArray(db.rehabRecords)) db.rehabRecords = [];
if (!Array.isArray(db.rehabVoiceSessions)) db.rehabVoiceSessions = [];
if (!Array.isArray(db.rehabPlans)) db.rehabPlans = [];
if (!Array.isArray(db.rehabPlanContexts)) db.rehabPlanContexts = [];
if (!Array.isArray(db.outcomeGoals)) db.outcomeGoals = [];
if (!Array.isArray(db.outcomeSnapshots)) db.outcomeSnapshots = [];
if (!Array.isArray(db.outcomeActions)) db.outcomeActions = [];
if (!Array.isArray(db.fimAssessments)) db.fimAssessments = [];
if (!Array.isArray(db.recoveryWardProfiles)) db.recoveryWardProfiles = [];
if (!Array.isArray(db.dischargeTasks)) db.dischargeTasks = [];
if (!Array.isArray(db.conferences)) db.conferences = [];
if (!Array.isArray(db.warningReviews)) db.warningReviews = [];
if (!Array.isArray(db.integrationRuns)) db.integrationRuns = [];
if (!Array.isArray(db.clinicalEvents)) db.clinicalEvents = [];
if (!Array.isArray(db.pilotTimeMeasurements)) db.pilotTimeMeasurements = [];
if (!Array.isArray(db.pilotSafetyEvents)) db.pilotSafetyEvents = [];
if (!Array.isArray(db.pilotStaffFeedback)) db.pilotStaffFeedback = [];
if (!Array.isArray(db.pilotStudies)) db.pilotStudies = [];
if (!Array.isArray(db.pilotApprovals)) db.pilotApprovals = [];
if (!Array.isArray(db.pilotExpansions)) db.pilotExpansions = [];
db.version = Math.max(Number(db.version) || 0, 24);
const outcomeGoalTemplates = [
  { key: 'homeReturnRate', label: '在宅復帰率', unit: '%', publicBaseline: 83, proposedTarget: 85, direction: 'UP', sourceLabel: '公開参考値', sourceUrl: '' },
  { key: 'fimGain', label: 'FIM改善', unit: '点', publicBaseline: 27.6, proposedTarget: 30, direction: 'UP', sourceLabel: '公開参考値', sourceUrl: '' },
  { key: 'performanceIndex', label: '回復期リハ実績指数', unit: '', publicBaseline: 47.6, proposedTarget: 50, direction: 'UP', sourceLabel: '公開参考値', sourceUrl: '' },
  { key: 'planConfirmationRate', label: 'AI計画期限内確定率', unit: '%', publicBaseline: null, proposedTarget: 95, direction: 'UP', sourceLabel: '導入時の仮目標', sourceUrl: '' },
  { key: 'dataCompletionRate', label: '必須データ充足率', unit: '%', publicBaseline: null, proposedTarget: 95, direction: 'UP', sourceLabel: '導入時の仮目標', sourceUrl: '' },
];
let seededOutcomeGoals = 0;
for (const tenantId of new Set([facilityId, ...db.hospitals.filter(hospital => hospital.active !== false).map(hospital => hospital.id)])) {
  for (const template of outcomeGoalTemplates) {
    if (db.outcomeGoals.some(goal => goal.tenantId === tenantId && goal.key === template.key)) continue;
    db.outcomeGoals.push({ id: id('outcome-goal'), tenantId, ...template, target: template.proposedTarget, targetType: 'PROPOSED', active: true, createdAt: now(), updatedAt: now() });
    seededOutcomeGoals += 1;
  }
}
if (seededOutcomeGoals) await persist();
let seededRehabVoicePatients = 0;
for (const tenantId of new Set([facilityId, ...db.hospitals.filter(hospital => hospital.active !== false).map(hospital => hospital.id)])) {
  for (const [facilityPatientId, name, birthDate] of [
    ['RV001', 'リハビリボイス TEST患者1', '1950-01-15'],
    ['RV002', 'リハビリボイス TEST患者2', '1960-06-20'],
    ['RV003', 'リハビリボイス TEST患者3', '1970-11-03'],
  ]) {
    if (db.patients.some(patient => patient.tenantId === tenantId && patient.facilityPatientId === facilityPatientId)) continue;
    const timestamp = now();
    db.patients.push({ id: id('patient'), tenantId, facilityPatientId, name, birthDate, createdAt: timestamp, updatedAt: timestamp });
    seededRehabVoicePatients += 1;
  }
}
if (seededRehabVoicePatients) await persist();
const rehabAiPlanPatientSeeds = [
  ['RAP001', 'リハビリAI計画 TEST患者1', '1949-03-08'],
  ['RAP002', 'リハビリAI計画 TEST患者2', '1958-07-19'],
  ['RAP003', 'リハビリAI計画 TEST患者3', '1967-11-24'],
];
let seededRehabAiPlanPatients = 0;
const rehabAiPlanTenantIds = new Set([facilityId, ...db.hospitals.filter(hospital => hospital.active !== false).map(hospital => hospital.id)]);
for (const tenantId of rehabAiPlanTenantIds) {
  for (const [facilityPatientId, name, birthDate] of rehabAiPlanPatientSeeds) {
    if (db.patients.some(patient => patient.tenantId === tenantId && patient.facilityPatientId === facilityPatientId)) continue;
    const timestamp = now();
    db.patients.push({ id: id('patient'), tenantId, facilityPatientId, name, birthDate, createdAt: timestamp, updatedAt: timestamp, testDataType: 'REHAB_AI_PLAN' });
    seededRehabAiPlanPatients += 1;
  }
}
if (seededRehabAiPlanPatients) await persist();
const outcomeDemoTenantIds = new Set([facilityId, ...db.hospitals.filter(hospital => hospital.active !== false).map(hospital => hospital.id)]);
const outcomeDemoSeedResult = seedOutcomeDemoData({ db, tenantIds: outcomeDemoTenantIds, id, now });
if (outcomeDemoSeedResult.createdPatients || outcomeDemoSeedResult.createdRecords) await persist();
let migratedTherapistIds = 0;
const knownTherapistIds = new Map([['田中 陽介', 'PT001'], ['山本 奈緒', 'OT001'], ['伊藤 拓海', 'ST001']]);
for (const therapist of db.therapists) {
  if (therapist.therapistId) continue;
  const usedIds = new Set(db.therapists.filter(item => item.tenantId === therapist.tenantId).map(item => item.therapistId).filter(Boolean));
  const knownId = knownTherapistIds.get(therapist.name);
  if (knownId && !usedIds.has(knownId)) therapist.therapistId = knownId;
  else {
    let sequence = 1;
    while (usedIds.has(`LEGACY-${sequence}`)) sequence += 1;
    therapist.therapistId = `LEGACY-${sequence}`;
  }
  therapist.updatedAt = now();
  migratedTherapistIds += 1;
}
if (migratedTherapistIds) await persist();
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
  const pagePatterns = {
    CAT_R_ALL: /^CAT_R_([1-5])_/,
    WAIS_IV_ALL: /^WAIS_IV_((?:[1-9]|1[0-3]))_/,
    WMSR_ALL: /^WMSR_([1-9])_/,
  };
  const pattern = pagePatterns[job?.result?.testType];
  if (pattern) {
    const match = (job.result.fields || []).map(field => pattern.exec(String(field.id || ''))).find(Boolean);
    return match ? `${job.result.testType}_${match[1]}` : null;
  }
  return null;
}
function rebuildAssessmentGroups() {
  let changed = 0;
  const grouped = new Map();
  const groupedTypes = ['BIT', 'SLTA_ALL', 'CAT_R_ALL', 'WAIS_IV_ALL', 'WMSR_ALL'];
  for (const job of db.jobs.filter(candidate => groupedTypes.includes(candidate.result?.testType)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = `${job.tenantId}|${job.patientId}|${safeText(job.therapistName).toLowerCase()}|${job.result.testType}`;
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
  return {
    ...patient,
    jobCount: db.jobs.filter(j => j.tenantId === tenantId && j.patientId === patient.id).length,
    rehabRecordCount: db.rehabRecords.filter(record => record.tenantId === tenantId && record.patientId === patient.id).length,
  };
}
function publicRehabRecord(record) {
  return { ...record };
}
function publicRehabPlan(plan) {
  return { ...plan };
}
function normalizedRehabPlan(body, previous = {}) {
  const text = (key, max = 6000) => safeText(body[key] ?? previous[key], max);
  return {
    planType: ['INITIAL', 'REASSESSMENT', 'DISCHARGE'].includes(body.planType) ? body.planType : (previous.planType || 'INITIAL'),
    evaluationDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.evaluationDate || '')) ? body.evaluationDate : (previous.evaluationDate || ''),
    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.targetDate || '')) ? body.targetDate : (previous.targetDate || ''),
    diagnosis: text('diagnosis', 1000), onsetAndCourse: text('onsetAndCourse'), precautions: text('precautions'),
    bodyFunction: text('bodyFunction'), activity: text('activity'), participation: text('participation'),
    patientWishes: text('patientWishes'), familyWishes: text('familyWishes'),
    shortTermGoals: text('shortTermGoals'), longTermGoals: text('longTermGoals'), dischargeGoal: text('dischargeGoal'),
    ptApproach: text('ptApproach'), otApproach: text('otApproach'), stApproach: text('stApproach'),
    nursingApproach: text('nursingApproach'), socialApproach: text('socialApproach'),
    nutritionAndOral: text('nutritionAndOral'), riskManagement: text('riskManagement'),
    explanation: text('explanation'), evidence: text('evidence', 12000),
    aiReviewComments: text('aiReviewComments', 12000), therapistReviewComments: text('therapistReviewComments', 12000),
    doctorName: text('doctorName', 200), nurseName: text('nurseName', 200),
    ptName: text('ptName', 200), otName: text('otName', 200), stName: text('stName', 200), socialWorkerName: text('socialWorkerName', 200),
  };
}

function normalizedRehabPlanContext(body, previous = {}) {
  const text = (key, max = 6000) => safeText(body[key] ?? previous[key], max);
  const date = key => /^\d{4}-\d{2}-\d{2}$/.test(String(body[key] || '')) ? body[key] : (previous[key] || '');
  return {
    diagnosis: text('diagnosis', 1200), comorbidities: text('comorbidities'), onsetDate: date('onsetDate'), surgeryAndTreatment: text('surgeryAndTreatment'),
    medicalRestrictions: text('medicalRestrictions'), medicationsAndDevices: text('medicationsAndDevices'),
    preHospitalLife: text('preHospitalLife'), currentAdl: text('currentAdl'), cognitionCommunication: text('cognitionCommunication'),
    homeEnvironment: text('homeEnvironment'), familySupport: text('familySupport'), socialRoles: text('socialRoles'),
    patientGoals: text('patientGoals'), familyGoals: text('familyGoals'), dischargeDestination: text('dischargeDestination'),
    ptFindings: text('ptFindings'), otFindings: text('otFindings'), stFindings: text('stFindings'), nursingFindings: text('nursingFindings'), socialWorkFindings: text('socialWorkFindings'),
    risks: text('risks'), unresolvedQuestions: text('unresolvedQuestions'), sourceNotes: text('sourceNotes'),
    dataStatus: body.dataStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', lastReviewedDate: date('lastReviewedDate'), reviewedBy: text('reviewedBy', 200),
  };
}

const fimMotorItems = ['eating','grooming','bathing','dressingUpper','dressingLower','toileting','bladder','bowel','transferBedChair','transferToilet','transferTubShower','locomotion','stairs'];
const fimCognitiveItems = ['comprehension','expression','socialInteraction','problemSolving','memory'];
const fimItems = [...fimMotorItems, ...fimCognitiveItems];
function normalizeFimAssessment(body, previous = {}) {
  const scores = Object.fromEntries(fimItems.map(key => {
    const value = Number(body.scores?.[key] ?? previous.scores?.[key]);
    return [key, Number.isInteger(value) && value >= 1 && value <= 7 ? value : null];
  }));
  const valid = keys => keys.map(key => scores[key]).filter(Number.isFinite);
  const motor = valid(fimMotorItems), cognitive = valid(fimCognitiveItems);
  const evaluationDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.evaluationDate || '')) ? body.evaluationDate : (previous.evaluationDate || '');
  return {
    stage: ['ADMISSION','PERIODIC','DISCHARGE'].includes(body.stage) ? body.stage : (previous.stage || 'PERIODIC'),
    evaluationDate, evaluator: safeText(body.evaluator ?? previous.evaluator, 200), locomotionMode: body.locomotionMode === 'WHEELCHAIR' ? 'WHEELCHAIR' : 'WALK',
    scores, motorTotal: motor.length === fimMotorItems.length ? motor.reduce((a, b) => a + b, 0) : null,
    cognitiveTotal: cognitive.length === fimCognitiveItems.length ? cognitive.reduce((a, b) => a + b, 0) : null,
    total: motor.length + cognitive.length === fimItems.length ? [...motor, ...cognitive].reduce((a, b) => a + b, 0) : null,
    missingItems: fimItems.filter(key => !Number.isFinite(scores[key])), note: safeText(body.note ?? previous.note, 2000),
    status: body.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT',
  };
}
function normalizeRecoveryWardProfile(body, previous = {}) {
  const date = key => /^\d{4}-\d{2}-\d{2}$/.test(String(body[key] || '')) ? body[key] : (previous[key] || '');
  const limitDays = Number(body.limitDays ?? previous.limitDays);
  const fimIntervalDays = Number(body.fimIntervalDays ?? previous.fimIntervalDays);
  return {
    onsetDate: date('onsetDate'), admissionDate: date('admissionDate'), plannedDischargeDate: date('plannedDischargeDate'), dischargeDate: date('dischargeDate'),
    diseaseCategory: safeText(body.diseaseCategory ?? previous.diseaseCategory, 500),
    limitDays: Number.isInteger(limitDays) && limitDays >= 1 && limitDays <= 365 ? limitDays : null,
    fimIntervalDays: Number.isInteger(fimIntervalDays) && fimIntervalDays >= 1 && fimIntervalDays <= 90 ? fimIntervalDays : 14,
    wardName: safeText(body.wardName ?? previous.wardName, 200), note: safeText(body.note ?? previous.note, 2000),
  };
}
function fimPatientSummary(tenantId, patientId) {
  const assessments = db.fimAssessments.filter(item => item.tenantId === tenantId && item.patientId === patientId).sort((a, b) => a.evaluationDate.localeCompare(b.evaluationDate));
  const confirmed = assessments.filter(item => item.status === 'CONFIRMED' && Number.isFinite(item.total));
  const admission = confirmed.find(item => item.stage === 'ADMISSION') || confirmed[0] || null;
  const latest = confirmed.at(-1) || null;
  const gain = admission && latest ? latest.total - admission.total : null;
  const days = admission && latest ? Math.max(0, Math.round((new Date(`${latest.evaluationDate}T00:00:00Z`) - new Date(`${admission.evaluationDate}T00:00:00Z`)) / 86400000)) : null;
  const profile = db.recoveryWardProfiles.find(item => item.tenantId === tenantId && item.patientId === patientId) || null;
  const interval = profile?.fimIntervalDays || 14;
  const nextDue = latest ? new Date(new Date(`${latest.evaluationDate}T00:00:00Z`).getTime() + interval * 86400000).toISOString().slice(0, 10) : profile?.admissionDate || null;
  const limitDate = profile?.admissionDate && profile?.limitDays ? new Date(new Date(`${profile.admissionDate}T00:00:00Z`).getTime() + (profile.limitDays - 1) * 86400000).toISOString().slice(0, 10) : null;
  return { assessments, admission, latest, gain, days, efficiency: gain != null && days > 0 ? Math.round(gain / days * 1000) / 1000 : null, hasMissing: assessments.some(item => item.missingItems?.length), nextDue, overdue: Boolean(nextDue && nextDue < new Date().toISOString().slice(0, 10) && !profile?.dischargeDate), limitDate, profile };
}
const dischargeTaskTemplates = [
  ['TOILETING','トイレ動作'],['TRANSFER','移乗'],['WALKING','歩行・移動'],['EATING','食事'],['COGNITION','認知・安全判断'],['MEDICATION','服薬管理'],['VOIDING','排尿・排便管理'],['SWALLOWING','嚥下・食形態'],
  ['HOME','住環境・段差'],['FAMILY','家族介護力'],['EQUIPMENT','福祉用具・装具'],['HOME_VISIT','退院前訪問'],['FAMILY_TRAINING','家族指導'],['SERVICES','介護保険・地域サービス'],
];
const dischargeTaskSuggestions = {
  TOILETING:['OT','-14'], TRANSFER:['PT','-14'], WALKING:['PT','-14'], EATING:['OT・ST','-14'], COGNITION:['OT・ST','-21'], MEDICATION:['看護・薬剤','-14'], VOIDING:['看護','-14'], SWALLOWING:['ST','-21'], HOME:['OT・MSW','-35'], FAMILY:['MSW','-28'], EQUIPMENT:['PT・OT','-21'], HOME_VISIT:['PT・OT・MSW','-28'], FAMILY_TRAINING:['多職種','-14'], SERVICES:['MSW','-21'],
};
function dateOffset(date, offsetDays) { return /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? new Date(new Date(`${date}T00:00:00Z`).getTime() + Number(offsetDays) * 86400000).toISOString().slice(0, 10) : ''; }
function dischargeBoardSummary(tenantId, patientId) {
  const tasks = db.dischargeTasks.filter(task => task.tenantId === tenantId && task.patientId === patientId).sort((a, b) => a.order - b.order);
  const today = new Date().toISOString().slice(0, 10);
  const active = tasks.filter(task => !['RESOLVED','NOT_APPLICABLE'].includes(task.status));
  const tracked = tasks.filter(task => ['RESOLVED','NOT_APPLICABLE'].includes(task.status) || (task.status !== 'NOT_ASSESSED' && task.owner && task.dueDate));
  return { tasks, total: tasks.length, blocking: tasks.filter(task => task.status === 'BLOCKING').length, inProgress: tasks.filter(task => task.status === 'IN_PROGRESS').length, resolved: tasks.filter(task => task.status === 'RESOLVED').length, unassessed: tasks.filter(task => task.status === 'NOT_ASSESSED').length, overdue: active.filter(task => task.dueDate && task.dueDate < today).length, ownerMissing: active.filter(task => !task.owner).length, readiness: tasks.length ? Math.round(tasks.filter(task => ['RESOLVED','NOT_APPLICABLE'].includes(task.status)).length / tasks.length * 100) : 0, tracked: tracked.length, untracked: tasks.length - tracked.length, trackingRate: tasks.length ? Math.round(tracked.length / tasks.length * 100) : 0 };
}
function patientOutcomeWarnings(tenantId, patient) {
  const fim = fimPatientSummary(tenantId, patient.id); const discharge = dischargeBoardSummary(tenantId, patient.id); const warnings = []; const exclusions = [];
  const confirmed = fim.assessments.filter(item => item.status === 'CONFIRMED' && Number.isFinite(item.total)); const recent = confirmed.slice(-2); const today = new Date().toISOString().slice(0, 10);
  if (fim.overdue) warnings.push({ type: 'FIM_OVERDUE', severity: 'HIGH', confidence: 1, title: 'FIM評価期限超過', evidence: [`次回評価予定 ${fim.nextDue}`, `最新評価 ${fim.latest?.evaluationDate || '未登録'}`], nextData: '最新のFIM 18項目と評価実施日', action: '本日の評価可否を確認し、評価担当者と実施日を設定', ownerCandidate: '担当PT・OT・ST' });
  if (recent.length === 2) { const gap = Math.round((new Date(`${recent[1].evaluationDate}T00:00:00Z`) - new Date(`${recent[0].evaluationDate}T00:00:00Z`)) / 86400000); const delta = recent[1].total - recent[0].total; if (gap >= 7 && delta <= 2) warnings.push({ type: 'FIM_STAGNATION', severity: delta < 0 ? 'HIGH' : 'MEDIUM', confidence: 0.8, title: 'FIM改善停滞の確認候補', evidence: [`${recent[0].evaluationDate} ${recent[0].total}点`, `${recent[1].evaluationDate} ${recent[1].total}点`, `${gap}日間で${delta >= 0 ? '+' : ''}${delta}点`], nextData: '停滞項目、訓練実施状況、体調変化、病棟ADL', action: '項目別FIMと多職種記録を確認し、目標・介入・評価条件を再検討', ownerCandidate: 'カンファレンス担当者' }); } else exclusions.push('FIM確定評価が2時点未満のため停滞判定対象外');
  const planned = fim.profile?.plannedDischargeDate; if (planned) { const daysToDischarge = Math.ceil((new Date(`${planned}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000); if (daysToDischarge >= 0 && daysToDischarge <= 28 && (discharge.blocking || discharge.overdue || discharge.trackingRate < 100)) warnings.push({ type: 'DISCHARGE_DELAY', severity: daysToDischarge <= 14 ? 'HIGH' : 'MEDIUM', confidence: 0.85, title: '退棟予定遅延リスクの確認候補', evidence: [`退棟予定まで${daysToDischarge}日`, `阻害要因 ${discharge.blocking}件`, `期限超過 ${discharge.overdue}件`, `追跡完了率 ${discharge.trackingRate}%`], nextData: '家族意向、住環境、サービス調整、未解決課題の最新状況', action: '阻害要因の担当・期限を再確認し、必要なら退院支援カンファレンスを設定', ownerCandidate: 'MSW・病棟責任者' }); } else exclusions.push(planned ? '退棟予定日まで29日以上のため遅延リスク判定対象外' : '退棟予定日未登録のため遅延リスク判定対象外');
  const identified = warnings.map(warning => ({ ...warning, id: `warning_${crypto.createHash('sha256').update(`${tenantId}|${patient.id}|${warning.type}|${warning.evidence.join('|')}`).digest('hex').slice(0, 24)}` }));
  return { patientId: patient.id, facilityPatientId: patient.facilityPatientId, name: patient.name, warnings: identified, exclusions };
}
function performanceIndexSimulation(tenantId, additionalMotorFim = 0, reducedStayDays = 0) {
  const rows = db.patients.filter(patient => patient.tenantId === tenantId).flatMap(patient => {
    const profile = db.recoveryWardProfiles.find(item => item.tenantId === tenantId && item.patientId === patient.id); if (!profile?.admissionDate || !profile.limitDays) return [];
    const confirmed = db.fimAssessments.filter(item => item.tenantId === tenantId && item.patientId === patient.id && item.status === 'CONFIRMED').sort((a, b) => a.evaluationDate.localeCompare(b.evaluationDate));
    const admission = confirmed.find(item => item.stage === 'ADMISSION'); const discharge = [...confirmed].reverse().find(item => item.stage === 'DISCHARGE'); if (!admission || !discharge || !Number.isFinite(admission.motorTotal) || !Number.isFinite(discharge.motorTotal)) return [];
    const stayDays = Math.max(1, Math.round((new Date(`${discharge.evaluationDate}T00:00:00Z`) - new Date(`${profile.admissionDate}T00:00:00Z`)) / 86400000)); const bonus = (admission.scores?.locomotion <= 5 && discharge.scores?.locomotion >= 6 ? 1 : 0) + (admission.scores?.toileting <= 5 && discharge.scores?.toileting >= 6 ? 1 : 0);
    return [{ patientId: patient.id, motorGain: discharge.motorTotal - admission.motorTotal + bonus, stayQuotient: stayDays / profile.limitDays, stayDays, limitDays: profile.limitDays, bonus }];
  });
  const numerator = rows.reduce((sum, row) => sum + row.motorGain, 0); const denominator = rows.reduce((sum, row) => sum + row.stayQuotient, 0); const simulatedNumerator = numerator + rows.length * Math.max(0, Math.min(10, Number(additionalMotorFim) || 0)); const simulatedDenominator = rows.reduce((sum, row) => sum + Math.max(1, row.stayDays - Math.max(0, Math.min(30, Number(reducedStayDays) || 0))) / row.limitDays, 0);
  return { eligiblePatients: rows.length, numerator: Math.round(numerator * 100) / 100, denominator: Math.round(denominator * 1000) / 1000, currentIndex: denominator ? Math.round(numerator / denominator * 10) / 10 : null, simulatedIndex: simulatedDenominator ? Math.round(simulatedNumerator / simulatedDenominator * 10) / 10 : null, inputs: { additionalMotorFim: Number(additionalMotorFim) || 0, reducedStayDays: Number(reducedStayDays) || 0 }, rows, basis: '退棟患者のFIM運動項目利得合計 ÷ 在棟日数／算定上限日数の合計（令和8年度改定の歩行・車椅子、トイレ動作加点を反映）', disclaimer: '院内検討用の概算です。除外患者、届出期間、正式な施設基準判定は含まず、請求・届出値には使用できません。' };
}
function dischargeBlockerRanking(tenantId) {
  const weight = { HIGH: 3, MEDIUM: 2, LOW: 1 }; const groups = new Map();
  for (const task of db.dischargeTasks.filter(item => item.tenantId === tenantId && item.status === 'BLOCKING')) { const current = groups.get(task.key) || { key: task.key, label: task.label, patients: 0, score: 0, overdue: 0 }; current.patients += 1; current.score += weight[task.priority] || 1; if (task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10)) current.overdue += 1; groups.set(task.key, current); }
  return [...groups.values()].sort((a, b) => b.score - a.score || b.overdue - a.overdue || a.label.localeCompare(b.label, 'ja'));
}
function warningOutcomeComparisons(tenantId) {
  return db.warningReviews.filter(item => item.tenantId === tenantId && item.status === 'ACTIONED' && item.snapshot?.patientId).map(review => {
    const patient = db.patients.find(item => item.tenantId === tenantId && item.id === review.snapshot.patientId); const fim = fimPatientSummary(tenantId, review.snapshot.patientId); const discharge = dischargeBoardSummary(tenantId, review.snapshot.patientId); let status = 'PENDING'; let result = '次回評価待ち'; let delta = null;
    if (['FIM_STAGNATION','FIM_OVERDUE'].includes(review.snapshot.warningType) && fim.latest?.evaluationDate > String(review.snapshot.latestFimDate || '')) { delta = fim.latest.total - Number(review.snapshot.latestFimTotal || 0); status = delta >= 3 ? 'IMPROVED' : 'NOT_IMPROVED'; result = `対応後FIM ${delta >= 0 ? '+' : ''}${delta}点（${fim.latest.evaluationDate}）`; }
    if (review.snapshot.warningType === 'DISCHARGE_DELAY') { if (fim.profile?.dischargeDate) { status = 'IMPROVED'; result = `退棟日 ${fim.profile.dischargeDate}`; } else if (discharge.blocking < Number(review.snapshot.blocking || 0) || discharge.overdue < Number(review.snapshot.overdue || 0)) { status = 'IMPROVED'; result = `阻害要因 ${review.snapshot.blocking}→${discharge.blocking}件、期限超過 ${review.snapshot.overdue}→${discharge.overdue}件`; } }
    return { warningId: review.warningId, patientId: review.snapshot.patientId, facilityPatientId: patient?.facilityPatientId || '', patientName: patient?.name || '', warningType: review.snapshot.warningType, title: review.snapshot.title, actionedAt: review.updatedAt, baseline: review.snapshot, status, result, delta };
  }).sort((a, b) => String(b.actionedAt).localeCompare(String(a.actionedAt)));
}
function managementOutcomeDashboard(tenantId) {
  const records = db.patients.filter(patient => patient.tenantId === tenantId).map(patient => {
    const profile = db.recoveryWardProfiles.find(item => item.tenantId === tenantId && item.patientId === patient.id) || {}; const fim = fimPatientSummary(tenantId, patient.id); const tasks = db.dischargeTasks.filter(item => item.tenantId === tenantId && item.patientId === patient.id); const context = db.rehabPlanContexts.find(item => item.tenantId === tenantId && item.patientId === patient.id) || {}; const latestPlan = db.rehabPlans.filter(item => item.tenantId === tenantId && item.patientId === patient.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]; const admissionTotal = fim.admission?.total;
    const therapyMinutes = db.rehabRecords.filter(item => item.tenantId === tenantId && item.patientId === patient.id && Number.isFinite(Number(item.durationMinutes))).reduce((sum,item)=>sum+Number(item.durationMinutes),0);
    return { ward: profile.wardName || '病棟未登録', disease: profile.diseaseCategory || '疾患未登録', severity: !Number.isFinite(admissionTotal) ? '重症度未判定' : admissionTotal <= 53 ? '重症（入棟FIM 53点以下）' : admissionTotal <= 89 ? '中等症（54～89点）' : '軽症（90点以上）', fimGain: fim.gain, fimEfficiency: fim.efficiency, therapyMinutes, therapyUnits: Math.round(therapyMinutes / 20 * 10) / 10, planConfirmed: latestPlan?.status === 'CONFIRMED', discharged: Boolean(profile.dischargeDate), homeDischarge: Boolean(profile.dischargeDate && /自宅|在宅|home/i.test(String(context.dischargeDestination || ''))), homeVisitDone: tasks.some(item => item.key === 'HOME_VISIT' && item.status === 'RESOLVED'), familyTrainingDone: tasks.some(item => item.key === 'FAMILY_TRAINING' && item.status === 'RESOLVED') };
  });
  const aggregate = (dimension, label) => {
    const groups = new Map(); for (const record of records) { const key = record[dimension]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); }
    return { dimension, label, rows: [...groups].map(([name, rows]) => { const gains = rows.map(item => item.fimGain).filter(Number.isFinite); const efficiencies = rows.map(item => item.fimEfficiency).filter(Number.isFinite); const discharged = rows.filter(item => item.discharged); return { name, patients: rows.length, fimEvaluated: gains.length, averageFimGain: gains.length ? Math.round(gains.reduce((a,b)=>a+b,0) / gains.length * 10) / 10 : null, averageFimEfficiency: efficiencies.length ? Math.round(efficiencies.reduce((a,b)=>a+b,0) / efficiencies.length * 1000) / 1000 : null, averageTherapyUnits: Math.round(rows.reduce((sum,item)=>sum+item.therapyUnits,0) / rows.length * 10) / 10, homeReturnRate: discharged.length ? Math.round(discharged.filter(item => item.homeDischarge).length / discharged.length * 1000) / 10 : null, homeReturnNumerator: discharged.filter(item => item.homeDischarge).length, homeReturnDenominator: discharged.length, planConfirmationRate: rows.length ? Math.round(rows.filter(item => item.planConfirmed).length / rows.length * 1000) / 10 : 0, homeVisitRate: rows.length ? Math.round(rows.filter(item => item.homeVisitDone).length / rows.length * 1000) / 10 : 0, familyTrainingRate: rows.length ? Math.round(rows.filter(item => item.familyTrainingDone).length / rows.length * 1000) / 10 : 0 }; }).sort((a,b)=>b.patients-a.patients || a.name.localeCompare(b.name,'ja')) };
  };
  const snapshots = db.outcomeSnapshots.filter(item => item.tenantId === tenantId).sort((a,b)=>a.period.localeCompare(b.period)).slice(-12); const goals = Object.fromEntries(db.outcomeGoals.filter(item => item.tenantId === tenantId && item.active !== false).map(item => [item.key, item.target]));
  const groups = [aggregate('ward','病棟別'), aggregate('disease','疾患別'), aggregate('severity','重症度別')]; const allGains = records.map(item => item.fimGain).filter(Number.isFinite); const hospitalFimGain = allGains.length ? Math.round(allGains.reduce((a,b)=>a+b,0) / allGains.length * 10) / 10 : null;
  const unitBands = [['0単位',item=>item.therapyUnits===0],['1～20単位',item=>item.therapyUnits>0&&item.therapyUnits<=20],['21～40単位',item=>item.therapyUnits>20&&item.therapyUnits<=40],['41単位以上',item=>item.therapyUnits>40]]; const comparisonRows = unitBands.map(([band,match]) => { const rows=records.filter(match); const gains=rows.map(item=>item.fimGain).filter(Number.isFinite); return { band, patients:rows.length, fimEvaluated:gains.length, averageFimGain:gains.length?Math.round(gains.reduce((a,b)=>a+b,0)/gains.length*10)/10:null }; }); const unitRegistered=records.filter(item=>item.therapyUnits>0).length;
  return {
    groups,
    benchmark: { minimumGroupSize: 3, hospitalFimGain, rows: groups.flatMap(group => group.rows.filter(row => row.patients >= 3).map(row => ({ dimension: group.label, name: row.name, patients: row.patients, averageFimGain: row.averageFimGain, differenceFromHospital: Number.isFinite(row.averageFimGain) && Number.isFinite(hospitalFimGain) ? Math.round((row.averageFimGain - hospitalFimGain) * 10) / 10 : null }))), suppressedGroups: groups.reduce((sum, group) => sum + group.rows.filter(row => row.patients < 3).length, 0), privacyNote: '個人特定を防ぐため、患者3人未満の区分はベンチマークに表示しません。患者名・患者IDは出力しません。' },
    therapyComparison: { unitRegistered, totalPatients: records.length, dataCompletionRate: records.length ? Math.round(unitRegistered/records.length*1000)/10 : 0, rows: comparisonRows.filter(row=>row.patients>=3), suppressedBands: comparisonRows.filter(row=>row.patients>0&&row.patients<3).length, note: '経過記録の実施時間20分を1単位として院内参考集計します。単位数とFIM改善の関連は因果関係を示しません。3人未満の帯は非表示です。' },
    monthlyTrend: snapshots.map(item => ({ period: item.period, dataType: item.dataType, values: item.values, targetDifference: Object.fromEntries(Object.entries(item.values || {}).flatMap(([key,value]) => Number.isFinite(Number(goals[key])) ? [[key, Math.round((Number(value)-Number(goals[key]))*10)/10]] : [])) })),
    definitions: { severity: '入棟時FIM合計で重症53点以下、中等症54～89点、軽症90点以上に院内集計', homeReturnRate: '分子：退棟日登録済みかつ退院先に自宅・在宅を含む患者。分母：退棟日登録済み患者', fimGain: '患者ごとの最新確定FIM合計－入棟時確定FIM合計の平均', therapyUnits: '経過記録の実施時間合計÷20分。正式な診療報酬請求単位ではなく院内参考値' },
  };
}
function conferenceQuality(brief, startedAt) {
  const proposals = ['changes','blockers','missing','contradictions','decisions'].flatMap(key => Array.isArray(brief[key]) ? brief[key] : []);
  const withSource = proposals.filter(item => item && typeof item === 'object' && String(item.source || '').trim()).length;
  const evidenceCoverage = proposals.length ? Math.round(withSource / proposals.length * 100) : 100;
  const generationMs = Math.max(0, Date.now() - startedAt);
  return { ...brief, generationMs, evidenceCoverage, readyForConference: generationMs <= 300000 && evidenceCoverage === 100 };
}
function conferenceBrief(tenantId, patient) {
  const startedAt = Date.now();
  const fim = fimPatientSummary(tenantId, patient.id);
  const discharge = dischargeBoardSummary(tenantId, patient.id);
  const plan = db.rehabPlans.filter(item => item.tenantId === tenantId && item.patientId === patient.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
  const voice = db.rehabVoiceSessions.filter(item => item.tenantId === tenantId && item.patientId === patient.id).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
  const blockers = discharge.tasks.filter(task => task.status === 'BLOCKING').map(task => ({ text: `${task.label}: ${task.note || '対応内容未入力'}`, source: `退院支援ボード ${task.label}` }));
  const missing = [...(fim.hasMissing ? [{ text: 'FIMに未入力項目があります', source: 'FIM評価' }] : []), ...(fim.overdue ? [{ text: 'FIM評価期限を超過しています', source: 'FIM評価予定' }] : []), ...(discharge.ownerMissing ? [{ text: `退院支援の担当未設定が${discharge.ownerMissing}件あります`, source: '退院支援ボード' }] : []), ...(!plan ? [{ text: 'リハビリAI計画が未作成です', source: 'リハビリAI計画' }] : [])];
  const contradictions = [];
  const destination = `${plan?.dischargeGoal || ''} ${plan?.patientWishes || ''}`;
  if (/自宅|在宅/.test(destination) && discharge.tasks.some(task => ['HOME','FAMILY','SERVICES'].includes(task.key) && task.status === 'BLOCKING')) contradictions.push({ text: '自宅退院の希望・目標に対して、住環境・家族・地域サービスの阻害要因が残っています', source: 'リハビリAI計画 × 退院支援ボード', needsReview: true });
  if (/自立|独歩/.test(`${plan?.activity || ''} ${plan?.shortTermGoals || ''}`) && discharge.tasks.some(task => ['TRANSFER','WALKING'].includes(task.key) && task.status === 'BLOCKING')) contradictions.push({ text: '移動自立の計画記載と、移乗・歩行の退院阻害判定が一致していません', source: 'リハビリAI計画 × 退院支援ボード', needsReview: true });
  if (/常食|経口|自立/.test(`${plan?.nutritionAndOral || ''} ${plan?.activity || ''}`) && discharge.tasks.some(task => ['EATING','SWALLOWING'].includes(task.key) && task.status === 'BLOCKING')) contradictions.push({ text: '食事・嚥下の計画記載と退院阻害判定に差があります', source: 'リハビリAI計画 × 退院支援ボード', needsReview: true });
  const decisions = [...blockers.slice(0, 3).map(item => ({ text: `${item.text}の対応方針を決定`, source: item.source })), ...(fim.gain != null ? [{ text: `FIM利得${fim.gain}点を踏まえ次期目標を確認`, source: 'FIM推移' }] : [{ text: 'FIM評価日と次期目標を確認', source: 'FIM評価' }]), ...(discharge.tasks.length ? [{ text: `退院支援の追跡完了率${discharge.trackingRate}%を100%へ上げる担当と期限を決定`, source: '退院支援ボード' }] : [])];
  const conferenceHistory = db.conferences.filter(item => item.tenantId === tenantId && item.patientId === patient.id).sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt))).slice(0, 10);
  const changes = [{ text: fim.latest ? `最新FIM ${fim.latest.total ?? '未完成'}点（${fim.latest.evaluationDate}）` : 'FIM未登録', source: 'FIM評価・推移' }, { text: fim.gain != null ? `入棟時から${fim.gain >= 0 ? '+' : ''}${fim.gain}点` : 'FIM利得未算出', source: 'FIM評価・推移' }, { text: voice?.summary ? safeText(voice.summary, 500) : '最新の音声要約なし', source: voice ? 'リハビリボイス' : '院内記録登録状況' }];
  return conferenceQuality({ patient: { id: patient.id, facilityPatientId: patient.facilityPatientId, name: patient.name }, generatedAt: now(), generationMode: 'RULE_BASED', fim: { latest: fim.latest, gain: fim.gain, efficiency: fim.efficiency, nextDue: fim.nextDue }, discharge: { trackingRate: discharge.trackingRate, readiness: discharge.readiness, blocking: discharge.blocking, overdue: discharge.overdue }, changes, blockers, missing, contradictions, decisions, sources: ['FIM評価・推移', '患者別退院支援ボード', ...(plan ? ['リハビリAI計画'] : []), ...(voice ? ['リハビリボイス'] : []), ...(!voice ? ['院内記録登録状況'] : [])], previousConference: conferenceHistory[0] || null, conferenceHistory }, startedAt);
}
async function generateConferenceBrief(apiKey, baseBrief) {
  const startedAt = Date.now();
  const allowedSources = baseBrief.sources;
  const sourceData = { fim: baseBrief.fim, discharge: baseBrief.discharge, changes: baseBrief.changes, blockers: baseBrief.blockers, missing: baseBrief.missing, contradictions: baseBrief.contradictions, previousConference: baseBrief.previousConference ? { heldAt: baseBrief.previousConference.heldAt, decision: baseBrief.previousConference.decision, minutes: baseBrief.previousConference.minutes } : null };
  const prompt = `あなたは日本の回復期リハビリテーション病棟の多職種カンファレンス準備支援AIです。与えられた院内データだけを根拠に、会議で確認・決定すべき内容を日本語で整理してください。

厳守事項:
- 記録にない診断、予後、事実、数値を創作しない。
- 不一致は断定せず確認候補とする。
- 各項目のsourceは次の許可された参照元のいずれかだけを使う: ${allowedSources.join('、')}
- 根拠を特定できない項目は出力しない。
- 医療判断を確定せず、人による確認が必要な下書きとして返す。
- JSONだけを返す。

出力形式:
${JSON.stringify({ changes: [{ text: '', source: '' }], contradictions: [{ text: '', source: '' }], decisions: [{ text: '', source: '' }], missing: [{ text: '', source: '' }] })}

院内データ:
${JSON.stringify(sourceData)}`;
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, store: false, reasoning: { effort: reasoningEffort }, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }), signal: AbortSignal.timeout(120000) });
  const payload = await response.json(); if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const parsed = parsePlainModelJson(extractOutputText(payload));
  const items = key => (Array.isArray(parsed?.[key]) ? parsed[key] : []).map(item => ({ text: safeText(item?.text, 1000), source: allowedSources.includes(item?.source) ? item.source : '' })).filter(item => item.text && item.source).slice(0, 10);
  return conferenceQuality({ ...baseBrief, changes: items('changes'), contradictions: items('contradictions'), decisions: items('decisions'), missing: items('missing'), generationMode: 'AI_DRAFT', responseId: safeText(payload.id, 120) }, startedAt);
}

function rehabPlanSource(patient, tenantId) {
  const jobs = db.jobs.filter(job => job.tenantId === tenantId && job.patientId === patient.id && job.result).sort((a, b) => jobClinicalSortKey(b).localeCompare(jobClinicalSortKey(a)));
  const records = db.rehabRecords.filter(record => record.tenantId === tenantId && record.patientId === patient.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const voices = db.rehabVoiceSessions.filter(session => session.tenantId === tenantId && session.patientId === patient.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const previousPlans = db.rehabPlans.filter(plan => plan.tenantId === tenantId && plan.patientId === patient.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latestEvaluation = jobs[0] || null;
  const result = latestEvaluation ? (latestEvaluation.confirmedResult || latestEvaluation.result) : null;
  return {
    patient: publicPatient(patient, tenantId),
    latestRecord: records[0] ? publicRehabRecord(records[0]) : null,
    latestVoice: voices[0] ? { ...voices[0], hasAudio: Boolean(voices[0].hasAudio) } : null,
    latestEvaluation: latestEvaluation ? { id: latestEvaluation.id, documentType: result?.documentType || latestEvaluation.evaluationType || '', evaluationDate: jobEvaluationDate(latestEvaluation), notes: result?.notes || '', fields: (result?.fields || []).slice(0, 120).map(field => ({ label: safeText(field.label, 300), value: safeText(field.value, 1000) })) } : null,
    evaluations: jobs.slice(0, 8).map(job => ({ documentType: job.confirmedResult?.documentType || job.result?.documentType || job.evaluationType || '', evaluationDate: jobEvaluationDate(job), confirmed: Boolean(job.confirmedResult), notes: safeText((job.confirmedResult || job.result)?.notes, 2000), fields: ((job.confirmedResult || job.result)?.fields || []).filter(field => String(field.value ?? '').trim()).slice(0, 80).map(field => ({ label: safeText(field.label, 200), value: safeText(field.value, 600) })) })),
    records: records.slice(0, 10).map(publicRehabRecord),
    voices: voices.slice(0, 10).map(session => ({ createdAt: session.createdAt, patientLog: safeText(session.patientLog, 3000), concerns: safeText(session.concerns, 3000), consultations: safeText(session.consultations, 3000), summary: safeText(session.summary, 3000) })),
    previousPlans: previousPlans.slice(0, 3).map(plan => normalizedRehabPlan(plan)),
    planContext: db.rehabPlanContexts.find(context => context.tenantId === tenantId && context.patientId === patient.id) || null,
    trends: patientTrend(jobs),
  };
}

async function generateRehabPlan(apiKey, source) {
  const fields = ['diagnosis','onsetAndCourse','precautions','nutritionAndOral','bodyFunction','activity','participation','riskManagement','patientWishes','familyWishes','shortTermGoals','longTermGoals','dischargeGoal','explanation','ptApproach','otApproach','stApproach','nursingApproach','socialApproach','evidence','aiReviewComments','therapistReviewComments'];
  const prompt = `あなたは日本の病院のリハビリテーション計画書作成支援AIです。与えられた患者データだけを根拠に、日本語で計画書の下書きを作成してください。

厳守事項:
- 記録にない診断、病歴、予後、数値、患者・家族の希望を創作しない。
- 不明な計画項目は空欄にし、確認すべき内容をコメントへ記載する。
- aiReviewCommentsには、OCRの未確定情報、記録間の矛盾、古い情報、根拠不足を「対象項目: コメント」の形式で記載する。
- therapistReviewCommentsには、療法士や多職種の臨床判断が必要な事項、目標期限・達成基準・負荷量・禁忌・退院先・本人家族同意などを「対象項目: コメント」の形式で記載する。
- 短期・長期目標は根拠がある範囲で具体化する。期限や数値を推測しない。
- evidenceには参照した評価日、評価名、経過記録日、患者ボイス日を簡潔に列挙する。
- AIは確定せず、下書きだけを返す。
- 次の全キーを持つJSONオブジェクトだけを返す。各値は文字列。
${JSON.stringify(Object.fromEntries(fields.map(field => [field, ''])))}

患者データ:
${JSON.stringify(source)}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, store: false, reasoning: { effort: reasoningEffort }, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const parsed = parsePlainModelJson(extractOutputText(payload));
  return Object.fromEntries(fields.map(field => [field, safeText(parsed?.[field], field === 'evidence' || field.endsWith('Comments') ? 12000 : 6000)]));
}

async function extractFimAssessment(apiKey, imageDataUrl) {
  const schema = Object.fromEntries(fimItems.map(key => [key, null]));
  const prompt = `あなたはFIM（機能的自立度評価法）評価票の読み取り支援AIです。画像に明確に記載された18項目の得点だけを読み取ってください。

厳守事項:
- 得点は1から7の整数。空欄、判読不能、項目を特定できない場合はnull。
- 合計欄から各項目を逆算しない。推測補完しない。
- 患者名などの個人情報は出力しない。
- assessmentDateは画像に明記された場合だけYYYY-MM-DD、なければ空文字。
- stageは入棟時、定期、退棟時の明記がある場合だけADMISSION、PERIODIC、DISCHARGE。判断できなければPERIODIC。
- commentsには判読不能、複数候補、様式上の注意を日本語で記載。
- JSONだけを返す。

出力形式:
${JSON.stringify({ assessmentDate: '', stage: 'PERIODIC', scores: schema, confidence: 0, comments: '' })}`;
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, store: false, reasoning: { effort: reasoningEffort }, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl, detail: 'high' }] }] }), signal: AbortSignal.timeout(120000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const parsed = parsePlainModelJson(extractOutputText(payload));
  const scores = Object.fromEntries(fimItems.map(key => { const value = Number(parsed?.scores?.[key]); return [key, Number.isInteger(value) && value >= 1 && value <= 7 ? value : null]; }));
  return { assessmentDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed?.assessmentDate || '')) ? parsed.assessmentDate : '', stage: ['ADMISSION','PERIODIC','DISCHARGE'].includes(parsed?.stage) ? parsed.stage : 'PERIODIC', scores, confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)), comments: safeText(parsed?.comments, 2000), responseId: safeText(payload.id, 120) };
}
function numericFieldMap(job) {
  const result = job.confirmedResult || job.result;
  return new Map((result?.fields || []).flatMap(field => {
    const raw = String(field.value ?? '').trim().replace(',', '.');
    const value = /^[-+]?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    return Number.isFinite(value) ? [[String(field.label || field.id), value]] : [];
  }));
}
function jobEvaluationDate(job) {
  const value = String(job?.confirmedResult?.evaluationDate || job?.result?.evaluationDate || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}
function jobClinicalSortKey(job) {
  return `${jobEvaluationDate(job) || String(job?.createdAt || '').slice(0, 10)}|${job?.createdAt || ''}`;
}
function patientTrend(patientJobs) {
  const completed = patientJobs.filter(job => job.result && ['OCR_DONE', 'DONE'].includes(job.status));
  const representatives = [...new Map(completed.sort((a, b) => jobClinicalSortKey(a).localeCompare(jobClinicalSortKey(b))).map(job => [job.assessmentGroupId || job.id, job])).values()];
  if (representatives.length < 2) return [];
  const previous = representatives.at(-2);
  const current = representatives.at(-1);
  const previousFields = numericFieldMap(previous);
  const currentFields = numericFieldMap(current);
  return [...currentFields.entries()]
    .filter(([label]) => previousFields.has(label))
    .map(([label, value]) => ({ label, previous: previousFields.get(label), current: value, change: value - previousFields.get(label) }))
    .filter(item => item.change !== 0)
    .slice(0, 8);
}
function ocrReviewSummary(patientJobs) {
  let confirmed = 0, aiEstimated = 0, missing = 0, unreadable = 0;
  for (const job of patientJobs.filter(candidate => candidate.result)) {
    const result = job.confirmedResult || job.result;
    for (const field of result?.fields || []) {
      const value = String(field.value ?? '').trim();
      if (!value) missing += 1;
      else if (job.confirmedResult) confirmed += 1;
      else aiEstimated += 1;
    }
    if (/判読|不明|読み取れ|未記入/.test(String(result?.notes || ''))) unreadable += 1;
  }
  return { confirmed, aiEstimated, missing, unreadable };
}
let migratedLegacySummaries = 0;
for (const job of db.jobs) {
  const legacyEntries = [
    ['INITIAL', job.rehabSummary, job.rehabSummaryUpdatedAt],
    ['FOLLOW_UP', job.progressSummary, job.progressSummaryUpdatedAt],
    ['DISCHARGE', job.dischargeSummary, job.dischargeSummaryUpdatedAt],
  ];
  for (const [recordType, text, recordedAt] of legacyEntries) {
    const legacySourceKey = `${job.id}:${recordType}`;
    if (!String(text || '').trim() || db.rehabRecords.some(record => record.legacySourceKey === legacySourceKey)) continue;
    db.rehabRecords.push({
      id: id('rehab'),
      tenantId: job.tenantId,
      patientId: job.patientId,
      evaluationJobId: job.id,
      recordType,
      therapistName: '旧サマリ移行',
      preCondition: '',
      intervention: '',
      durationMinutes: null,
      assistanceLevel: '',
      painBefore: null,
      painAfter: null,
      fatigueBefore: null,
      fatigueAfter: null,
      outcome: safeText(text, 4000),
      nextPlan: '',
      riskNotes: '',
      approvalStatus: 'APPROVED',
      approvedBy: '旧サマリ移行',
      approvedAt: recordedAt || job.updatedAt || job.createdAt,
      createdAt: recordedAt || job.updatedAt || job.createdAt,
      updatedAt: recordedAt || job.updatedAt || job.createdAt,
      revisions: [],
      legacySourceKey,
    });
    migratedLegacySummaries += 1;
  }
}
if (migratedLegacySummaries) await persist();
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
async function writeRehabVoiceAudio(sessionId, mimeType, content) {
  const payload = encryptBytes(content);
  if (sqlPool) return sqlPool.query('INSERT INTO aiocr_rehab_voice_audio (session_id, mime_type, payload, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (session_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, payload = EXCLUDED.payload, updated_at = NOW()', [sessionId, mimeType, payload]);
  await writeFile(path.join(rehabVoiceAudioDir, `${sessionId}.bin`), payload);
  await writeFile(path.join(rehabVoiceAudioDir, `${sessionId}.type`), mimeType, 'utf8');
}
async function readRehabVoiceAudio(sessionId) {
  if (sqlPool) {
    const stored = await sqlPool.query('SELECT mime_type, payload FROM aiocr_rehab_voice_audio WHERE session_id = $1', [sessionId]);
    if (!stored.rowCount) return null;
    return { mimeType: stored.rows[0].mime_type, content: decryptBytes(stored.rows[0].payload) };
  }
  const payloadPath = path.join(rehabVoiceAudioDir, `${sessionId}.bin`);
  const typePath = path.join(rehabVoiceAudioDir, `${sessionId}.type`);
  if (!existsSync(payloadPath) || !existsSync(typePath)) return null;
  return { mimeType: safeText(await readFile(typePath, 'utf8'), 100), content: decryptBytes(await readFile(payloadPath)) };
}
async function deleteRehabVoiceAudio(sessionId) {
  if (sqlPool) return sqlPool.query('DELETE FROM aiocr_rehab_voice_audio WHERE session_id = $1', [sessionId]);
  for (const extension of ['bin', 'type']) {
    const target = path.join(rehabVoiceAudioDir, `${sessionId}.${extension}`);
    if (existsSync(target)) await unlink(target);
  }
}
function parseAudioDataUrl(dataUrl) {
  const match = /^data:(audio\/(?:webm|ogg|mpeg|mp4|wav|x-wav));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('録音音声の形式が不正です'), { status: 400 });
  return { mimeType: match[1], content: Buffer.from(match[2], 'base64') };
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
  const sameSheetJobs = db.jobs.filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.result && ['OCR_DONE', 'DONE'].includes(candidate.status));
  const assessmentKeys = [...new Map(sameSheetJobs
    .sort((a, b) => jobClinicalSortKey(a).localeCompare(jobClinicalSortKey(b)))
    .map(candidate => [candidate.assessmentGroupId || candidate.id, true])).keys()];
  const sheetIndex = assessmentKeys.indexOf(job.assessmentGroupId || job.id);
  const careStage = ['INITIAL', 'FOLLOW_UP', 'DISCHARGE'].includes(job.careStage) ? job.careStage : sheetIndex === 0 ? 'INITIAL' : sheetIndex > 0 ? 'FOLLOW_UP' : 'PENDING';
  const hasExistingDischarge = db.jobs.some(candidate =>
    candidate.tenantId === job.tenantId &&
    candidate.patientId === job.patientId &&
    candidate.evaluationType === job.evaluationType &&
    candidate.id !== job.id &&
    candidate.careStage === 'DISCHARGE'
  );
  const cleanResult = result => result ? {
    ...result,
    documentType: String(result.documentType ?? '').replace(/[_＿]+/g, ''),
    notes: String(result.notes ?? '').replace(/[_＿]+/g, ''),
    fields: (result.fields || [])
      .filter(field => !/_TEXT_\d+$/i.test(String(field.id || '')))
      .map(field => ({
      ...field,
      label: String(field.label ?? '').replace(/[_＿]+/g, ''),
      value: String(field.value ?? '').replace(/[_＿]+/g, ''),
      })),
  } : result;
  const pageNumberedSetTypes = ['BIT', 'CAT_R_ALL', 'WAIS_IV_ALL', 'WMSR_ALL'];
  const expectedPageCount = pageNumberedSetTypes.includes(job.result?.testType) ? sheetPageRanges[job.result.testType] : null;
  const groupedJobs = job.assessmentGroupId
    ? db.jobs.filter(candidate => candidate.tenantId === job.tenantId && candidate.assessmentGroupId === job.assessmentGroupId && candidate.result)
    : [job];
  const pageNumbers = groupedJobs.map(candidate => {
    const key = evaluationPageKey(candidate);
    const match = /_(\d+)$/.exec(key || '');
    return match ? Number(match[1]) : null;
  }).filter(page => Number.isInteger(page));
  const uniquePages = [...new Set(pageNumbers)].sort((a, b) => a - b);
  const missingPages = expectedPageCount
    ? Array.from({ length: expectedPageCount }, (_, index) => index + 1).filter(page => !uniquePages.includes(page))
    : [];
  const assessmentSet = expectedPageCount ? {
    expectedPageCount,
    capturedPageCount: uniquePages.length,
    pages: uniquePages,
    missingPages,
    complete: missingPages.length === 0,
  } : null;
  return { ...job, result: cleanResult(job.result), confirmedResult: cleanResult(job.confirmedResult), careStage, hasExistingDischarge, assessmentSet, patientName: patient?.name || '削除済み患者', imageUrl: `/api/jobs/${job.id}/image` };
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

const sheetDisplayNames = {
  FMA_1: 'Fugl-Meyer Assessment（FMA）上肢',
  FMA_2: 'Fugl-Meyer Assessment（FMA）下肢',
  BBS: 'Berg Balance Scale（BBS）',
  KOHS_1: 'コース立方体組み合わせテスト',
  STEF: 'STEF（簡易上肢機能検査）',
  SLTA_ALL: 'SLTA（標準失語症検査）',
  BIT: 'BIT（行動性無視検査）',
  CAT_R_ALL: 'CAT-R',
  WAIS_IV_ALL: 'WAIS-IV（ウェクスラー成人知能検査）',
  WMSR_ALL: 'WMS-R（ウェクスラー記憶検査）',
};

const sheetPageRanges = {
  SLTA_ALL: 12,
  BIT: 7,
  CAT_R_ALL: 5,
  WAIS_IV_ALL: 13,
  WMSR_ALL: 9,
};

function validateDetectedSheetSet(detections) {
  const errors = [];
  const recognized = detections.filter(item => item.recognized);
  if (recognized.length !== detections.length) {
    const pages = detections.map((item, index) => item.recognized ? null : index + 1).filter(Boolean);
    errors.push(`帳票を判定できない画像があります（${pages.join('、')}枚目）`);
  }
  const types = [...new Set(recognized.map(item => item.testType))];
  if (types.length > 1) errors.push('異なる種類の評価用紙が混在しています');
  const testType = types.length === 1 ? types[0] : null;
  const expectedPageCount = testType ? sheetPageRanges[testType] || 1 : null;
  if (testType && expectedPageCount > 1) {
    const pages = detections.map(item => item.testType === testType ? item.page : null);
    const unknownPositions = pages.map((page, index) => page ? null : index + 1).filter(Boolean);
    if (unknownPositions.length) errors.push(`ページ番号を判定できません（${unknownPositions.join('、')}枚目）`);
    const counts = new Map();
    pages.filter(Boolean).forEach(page => counts.set(page, (counts.get(page) || 0) + 1));
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([page]) => page);
    if (duplicates.length) errors.push(`同じ用紙を重複して撮影しています（${duplicates.join('、')}ページ）`);
    const missing = Array.from({ length: expectedPageCount }, (_, index) => index + 1).filter(page => !counts.has(page));
    if (missing.length) errors.push(`不足している用紙があります（${missing.join('、')}ページ）`);
    const orderMismatch = pages.some((page, index) => page && page !== index + 1);
    if (orderMismatch) errors.push(`用紙の順番が正しくありません（現在：${pages.map(page => page || '?').join('→')}ページ）`);
  } else if (testType && detections.length > 1) {
    errors.push('単票の評価用紙が複数枚選択されています');
  }
  return {
    valid: errors.length === 0,
    testType,
    displayName: testType ? sheetDisplayNames[testType] : null,
    expectedPageCount,
    errors,
    detections,
  };
}

const sheetDetectionReferencePrompt = `あなたはリハビリテーション評価用紙の画像分類担当です。
この判定基準は、リポジトリ内 aiocr フォルダに保存された実際の画像・PDFの固定印刷部分とレイアウトを確認して作成しています。

患者名、日付、点数、手書き文字は分類根拠にしないでください。印刷された帳票名、検査名、固定見出し、項目構成、ページ番号を優先してください。

testType は次のいずれかです:
FMA_1, FMA_2, BBS, KOHS_1, STEF, SLTA_ALL, BIT, CAT_R_ALL, WAIS_IV_ALL, WMSR_ALL, UNSUPPORTED

実資料に基づく識別特徴:
- FMA_1: 上部に "Fugl-Meyer Assessment (FMA)" と上肢を示す表題。縦長で33結果欄、上肢運動合計66点の構成。下肢と混同しない。
- FMA_2: 上部に "Fugl-Meyer Assessment (FMA)" と下肢を示す表題。縦長で17結果欄、下肢運動合計34点の構成。上肢版より項目数が少ない。
- BBS: "Berg Balance Scale" またはBBS。14のバランス課題が左右2列に並び、各0〜4点、合計56点の縦長採点表。
- KOHS_1: コース立方体組み合わせテスト。左列に立方体模様の図版が縦に並ぶ採点表。
- STEF: "STEF" または簡易上肢機能検査。横長で10検査×左右、計20の所要時間欄が密集した大きな格子表。
- SLTA_ALL: "標準失語症検査" またはSLTA。既存7セット・計84画像で確認済み。縦長で「問題および反応」と6段階評価欄があり、印刷ページ番号1〜12を優先する。
- BIT: "BIT", "Behavioural Inattention Test" または行動性無視検査。既存7セットの編集済みPDFで次の対応を確認済み。
  1=通常検査得点、2=行動検査得点+写真課題、3=電話課題+メニュー課題、4=音読課題、
  5=時計課題+硬貨課題、6=書写課題+地図課題、7=トランプ課題。
- CAT_R_ALL: "CAT-R", "Clinical Assessment for Attention"。既存7セットのPDFで次の対応を確認済み。
  1=Span、2=Cancellation and Detection Testの視覚性抹消課題、3=聴覚性検出課題、
  4=Memory Updating Test、5=Paced Auditory Serial Addition Test (PASAT)。
- WAIS_IV_ALL: "WAIS-IV"。追加された5セット・計65画像で、次のページ対応を確認済み。
  1=積木模様、2=類似、3=数唱、4=数唱後半+行列推理、5=単語前半、6=単語後半、
  7=算数+記号探し、8=パズル+知識前半、9=知識後半+符号、10=語音整列、
  11=バランス+理解前半、12=理解後半、13=絵の抹消+絵の完成。
  各ページ右下の印刷ページ番号1〜13と、この下位検査構成が一致することを確認する。
- WMSR_ALL: "WMS-R"。既存7セットのPDFで次の内部ページ対応を確認済み。
  1=情報と見当識（印刷3）、2=精神統制+図形の記憶（印刷4）、3=論理的記憶I（印刷5）、
  4=視覚性対連合I（印刷6）、5=言語性対連合I+視覚性再生I（印刷7）、
  6=数唱+視覚性記憶範囲（印刷8）、7=論理的記憶II（印刷9）、
  8=視覚性対連合II+言語性対連合II+視覚性再生II（印刷10）、9=成績集計表（印刷11）。
  WMS-Rだけは印刷ページ番号から2を引いた値を page として返す。空白のPDF末尾ページは対象外。

ページ判定規則:
- 印刷されたページ番号が見える場合は必ず最優先する。
- 設問番号、項目番号、得点、患者ID、手書きの数字をページ番号として扱わない。
- ページ番号が見えない場合だけ、固定見出しとレイアウトから推定する。
- 複数ページ帳票でページを確定できない場合は page を null にする。
- 帳票名と固定構造が一致しない、または確信が弱い場合は UNSUPPORTED にする。

次のJSONだけを返してください:
{"testType":"BBS","page":null,"confidence":0.95}`;

async function detectEvaluationSheet(apiKey, imageUrl) {
  const prompt = `あなたはリハビリテーション評価シートの画像分類器です。
画像に写っている用紙の印刷タイトル、項目名、表レイアウト、ページ番号から帳票を判定してください。
患者の手書き内容や個人情報は出力しないでください。

testTypeは次のいずれかだけを返してください:
FMA_1, FMA_2, BBS, KOHS_1, STEF, SLTA_ALL, BIT, CAT_R_ALL, WAIS_IV_ALL, WMSR_ALL, UNSUPPORTED

複数ページ帳票は、表紙や1ページ目だけでなく次の全ページを認識対象にしてください:
- SLTA_ALL: 1〜12ページ
- BIT: 1〜7ページ
- CAT_R_ALL: 1〜5ページ
- WAIS_IV_ALL: 1〜13ページ
- WMSR_ALL: 1〜9ページ

2枚目・3枚目以降では帳票タイトルが省略される場合があります。その場合も、ページ固有の印刷見出し、検査項目名、表の列構成、フッターのページ番号を組み合わせて同じ帳票として判定してください。
pageは帳票内のページ番号です。設問番号、採点番号、患者の手書き数字をページ番号として扱わないでください。
印刷ページ番号が見える場合はそれを優先し、見えない場合はページ固有のレイアウトから推定してください。単票またはページを特定できない場合はnullにしてください。
confidenceは0から1です。断定できない場合はUNSUPPORTEDにしてください。
JSON以外を返さないでください。
{"testType":"BBS","page":null,"confidence":0.95}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: 'low' },
      prompt_cache_key: 'rehainfo-sheet-detection-v4-all-reference-forms',
      input: [{ role: 'user', content: [{ type: 'input_text', text: sheetDetectionReferencePrompt }, { type: 'input_image', image_url: imageUrl, detail: 'high' }] }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
  const parsed = parsePlainModelJson(extractOutputText(payload));
  const testType = Object.hasOwn(sheetDisplayNames, parsed.testType) ? parsed.testType : 'UNSUPPORTED';
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const rawPage = Number(parsed.page);
  const maxPage = sheetPageRanges[testType] || null;
  const page = maxPage && Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= maxPage ? rawPage : null;
  const recognized = testType !== 'UNSUPPORTED' && confidence >= 0.65;
  const baseName = recognized ? sheetDisplayNames[testType] : null;
  return {
    recognized,
    testType,
    page,
    confidence,
    displayName: recognized ? `${baseName}${page ? ` ${page}ページ` : ''}` : '評価シートを認識できません',
  };
}

async function analyzeImageGeometry(apiKey, imageUrl) {
  const prompt = `# 役割
あなたは、手書き数値を含むリハビリ評価シートをAI OCRしやすい画像へ変換するための、文書画像補正判定AIです。画像を生成・編集せず、後段の画像処理が使う補正パラメータだけをJSONで返します。

# 最優先目的
手書き結果、印刷文字、罫線を欠落・変形させず、OCR対象セルが大きく、正面向きで、高コントラストになる補正を選んでください。見栄えより文字・数値の読み取りやすさを優先します。

# 判定手順
1. 用紙外周と、タイトル・帳票名・患者情報欄を含む評価表全体、およびすべてのOCR対象表・手書き結果欄を確認する。
2. 回転、台形歪み、遠近歪み、影、低コントラスト、ぼけ、背景ノイズを個別に評価する。
3. 左右2列または複数表の場合、全表と全結果欄を囲む外接四角形を選ぶ。一方だけを選ばない。
4. 用紙四隅が明瞭なら用紙四隅を優先し、不明瞭なら全OCR対象表を囲む四隅を使う。
5. 横罫線が水平から0.1度以上、縦罫線が垂直から0.1度以上ずれる、平行線が収束する、上下左右の幅が異なる場合はneedsCorrection=true。
6. 四隅は画像左上を(0,0)、右下を(100,100)とする百分率で、topLeft、topRight、bottomRight、bottomLeftの順に返す。

# 保護ルール
- 手書き値、薄い鉛筆文字、チェック、丸印、訂正痕を余白やノイズと判断しない。
- 評価表のタイトル、帳票名、患者情報欄、項目名、行、列、左右ページ、複数表を切り落とさない。
- 補正後も用紙全体が見えることを必須とし、表領域だけに切り詰めない。
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
    body: JSON.stringify({ model, reasoning: { effort: reasoningEffort }, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl, detail: imageDetail }] }] }),
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

async function requestOcr(apiKey, imageUrl, prompt, externalSignal, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('OCR request timed out')), 120000);
  timeout.unref?.();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const requestBody = JSON.stringify({
      model,
      store: false,
      reasoning: { effort: options.effort || reasoningEffort },
      prompt_cache_key: `rehainfo-ocr-${options.routeKey || 'generic'}-v1`,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl, detail: options.detail || imageDetail }] }],
    });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          const message = payload?.error?.message || `OpenAI API error ${response.status}`;
          const retryable = [408, 409, 429].includes(response.status) || response.status >= 500 || /An error occurred while processing/i.test(message);
          if (!retryable || attempt === 2) throw new Error(message);
          lastError = new Error(message);
        } else {
          const outputText = extractOutputText(payload);
          return { result: parseModelJson(outputText), responseId: safeText(payload.id, 120), outputText: safeText(outputText, 12000) };
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
        if (attempt === 2) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 800 * (2 ** attempt)));
    }
    throw lastError || new Error('OCR request failed');
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
  const currentKey = jobClinicalSortKey(job);
  const candidates = db.jobs
    .filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.id !== job.id && candidate.result && (!job.assessmentGroupId || candidate.assessmentGroupId !== job.assessmentGroupId))
    .sort((a, b) => jobClinicalSortKey(a).localeCompare(jobClinicalSortKey(b)));
  const representatives = [...new Map(candidates.map(candidate => [candidate.assessmentGroupId || candidate.id, candidate])).values()];
  return representatives.filter(candidate => jobClinicalSortKey(candidate) < currentKey).at(-1) || null;
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
  const currentKey = jobClinicalSortKey(job);
  const sameSheetJobs = db.jobs
    .filter(candidate => candidate.tenantId === job.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.result && jobClinicalSortKey(candidate) <= currentKey)
    .sort((a, b) => jobClinicalSortKey(a).localeCompare(jobClinicalSortKey(b)));
  if (!sameSheetJobs.length) throw new Error('退院サマリを作成できる評価履歴がありません');
  const groupRepresentatives = [...new Map(sameSheetJobs.map(candidate => [candidate.assessmentGroupId || candidate.id, candidate])).values()];
  const evaluations = groupRepresentatives.map((candidate, index) => ({
    stage: candidate.id === job.id ? '退院時' : index === 0 ? '初診時' : `途中経過${index}`,
    ...evaluationForSummary(candidate),
  }));
  const prompt = `あなたはリハビリテーション医療の記録作成支援者です。
同じ患者・同じ評価シートの初診から退院時までの評価履歴を比較し、次の3種類の退院サマリ案を日本語で作成してください。
1. dischargeSummary: 医療者向け。「初診時の状態」「リハビリ経過と改善点」「残存課題」「退院時評価」「退院後の生活・リハビリ方針」の構成で1200文字以内。
2. familySummary: 家族向け。専門用語を避け、できるようになったこと、残る注意点、家庭での見守り・支援方法を600文字以内。
3. patientSummary: 患者向け。尊重した前向きな表現で、改善したこと、今後気をつけること、自主練習・生活上の目標を600文字以内。
数値の方向だけで改善と断定できない項目は慎重に表現し、入力にない診断、病歴、生活環境を推測しないでください。医療者が確認・修正する草案として記載してください。
出力は説明やMarkdownを付けず、{"dischargeSummary":"...","familySummary":"...","patientSummary":"..."} のJSONだけにしてください。

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
  const generated = parsePlainModelJson(extractOutputText(payload));
  const summaries = {
    dischargeSummary: safeText(generated.dischargeSummary, 4000),
    familySummary: safeText(generated.familySummary, 4000),
    patientSummary: safeText(generated.patientSummary, 4000),
  };
  if (!summaries.dischargeSummary || !summaries.familySummary || !summaries.patientSummary) throw new Error('退院経過サマリを生成できませんでした');
  return summaries;
}

function filledFieldCount(result) {
  return (result?.fields || []).filter(field => String(field.value ?? '').trim() !== '').length;
}

function filledStefTimeCount(result) {
  return (result?.fields || []).filter(field => /^time_\d+$/.test(field.id) && String(field.value ?? '').trim() !== '').length;
}

function expectedBitFieldCount(result) {
  const pageMatch = (result?.fields || []).map(field => /^BIT_(\d)_/.exec(field.id)).find(Boolean);
  return ({ 1: 32, 2: 29, 3: 9, 5: 9, 6: 12, 7: 2 })[pageMatch?.[1]] || 1;
}

function bitPromptForPage(page) {
  if (Number(page) === 1) return buildBitPage1Prompt();
  if (Number(page) === 2) return buildBitPage2Prompt();
  return buildBitRetryPrompt();
}

function ocrIssueIds(result) {
  const fields = result?.fields || [];
  const expected = { FMA_1: 33, FMA_2: 17, BBS: 14, STEF: 20 }[result?.testType];
  const issues = fields
    .filter(field => String(field.value ?? '').trim() === '' || (Number.isFinite(field.confidence) && field.confidence < 0.82))
    .map(field => field.id);
  if (expected && fields.length >= expected && filledFieldCount(result) === expected && !issues.length) return [];
  if (result?.testType === 'BIT' && filledFieldCount(result) >= expectedBitFieldCount(result) && !issues.length) return [];
  return issues.slice(0, 80);
}

function mergeOcrResults(original, retry) {
  if (!retry || retry.testType !== original.testType) return original;
  const retried = new Map((retry.fields || []).map(field => [field.id, field]));
  return {
    ...original,
    evaluationDate: retry.evaluationDate || original.evaluationDate,
    fields: original.fields.map(field => {
      const candidate = retried.get(field.id);
      if (!candidate || !String(candidate.value ?? '').trim()) return field;
      const oldConfidence = Number(field.confidence) || 0;
      const newConfidence = Number(candidate.confidence) || 0;
      return !String(field.value ?? '').trim() || newConfidence >= oldConfidence ? candidate : field;
    }),
    notes: [original.notes, retry.notes].filter(Boolean).join(' / '),
  };
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
    let fmaLowerSpecializedAttempted = false;
    let fmaUpperSpecializedAttempted = false;
    const route = job.ocrRoute?.testType ? job.ocrRoute : inferOcrRoute(job.sourceFileName, job.pageNumber);
    const initialPrompt = route.testType ? buildRoutedOcrPrompt(route.testType, route.page) : buildRehainfoOcrPrompt();
    let ocr = await requestOcr(apiKey, imageUrl, initialPrompt, controller.signal, { effort: reasoningEffort, routeKey: `${route.testType || 'generic'}-${route.page || 0}` });
    attempts.push({ responseId: ocr.responseId, stage: route.testType ? 'routed-fast' : 'generic-fast', effort: reasoningEffort, filledFieldCount: filledFieldCount(ocr.result), output: ocr.outputText });
    if (ocr.result.testType === 'UNSUPPORTED') {
      await persist();
      const bitClassificationRetry = await requestOcr(apiKey, imageUrl, bitPromptForPage(job.ocrRoute?.page), controller.signal);
      attempts.push({ responseId: bitClassificationRetry.responseId, filledFieldCount: filledFieldCount(bitClassificationRetry.result), output: bitClassificationRetry.outputText });
      if (bitClassificationRetry.result.testType === 'BIT' && filledFieldCount(bitClassificationRetry.result) > 0) ocr = bitClassificationRetry;
    }
    if (ocr.result.testType === 'UNSUPPORTED' || (ocr.result.testType === 'FMA_1' && filledFieldCount(ocr.result) <= 17)) {
      await persist();
      const fmaLowerClassificationRetry = await requestOcr(apiKey, imageUrl, buildFmaLowerRetryPrompt(), controller.signal);
      fmaLowerSpecializedAttempted = true;
      attempts.push({ responseId: fmaLowerClassificationRetry.responseId, filledFieldCount: filledFieldCount(fmaLowerClassificationRetry.result), output: fmaLowerClassificationRetry.outputText });
      if (fmaLowerClassificationRetry.result.testType === 'FMA_2' && filledFieldCount(fmaLowerClassificationRetry.result) > 0) ocr = fmaLowerClassificationRetry;
    }
    if (ocr.result.testType === 'FMA_1' && filledFieldCount(ocr.result) < 33 && !fmaUpperSpecializedAttempted) {
      await persist();
      const fmaUpperRetry = await requestOcr(apiKey, imageUrl, buildFmaUpperRetryPrompt(), controller.signal);
      fmaUpperSpecializedAttempted = true;
      attempts.push({ responseId: fmaUpperRetry.responseId, filledFieldCount: filledFieldCount(fmaUpperRetry.result), output: fmaUpperRetry.outputText });
      if (fmaUpperRetry.result.testType === 'FMA_1' && filledFieldCount(fmaUpperRetry.result) > 0) {
        const originalFields = new Map(ocr.result.fields.map(field => [field.id, field]));
        ocr = {
          ...fmaUpperRetry,
          result: {
            ...fmaUpperRetry.result,
            fields: fmaUpperRetry.result.fields.map(field => {
              const original = originalFields.get(field.id);
              return field.value || !original?.value ? field : { ...field, value: original.value, confidence: original.confidence, x: original.x, y: original.y };
            }),
          },
        };
      }
    }
    if (ocr.result.testType === 'FMA_2' && (!fmaLowerSpecializedAttempted || filledFieldCount(ocr.result) < 17)) {
      await persist();
      const fmaLowerRetry = await requestOcr(apiKey, imageUrl, buildFmaLowerRetryPrompt(), controller.signal);
      attempts.push({ responseId: fmaLowerRetry.responseId, filledFieldCount: filledFieldCount(fmaLowerRetry.result), output: fmaLowerRetry.outputText });
      if (fmaLowerRetry.result.testType === 'FMA_2' && filledFieldCount(fmaLowerRetry.result) > 0) {
        const originalFields = new Map(ocr.result.fields.map(field => [field.id, field]));
        ocr = {
          ...fmaLowerRetry,
          result: {
            ...fmaLowerRetry.result,
            fields: fmaLowerRetry.result.fields.map(field => {
              const original = originalFields.get(field.id);
              return field.value || !original?.value ? field : { ...field, value: original.value, confidence: original.confidence, x: original.x, y: original.y };
            }),
          },
        };
      }
    }
    if (ocr.result.testType === 'BBS' && filledFieldCount(ocr.result) < 14) {
      await persist();
      const bbsRetry = await requestOcr(apiKey, imageUrl, buildBbsRetryPrompt(), controller.signal);
      attempts.push({ responseId: bbsRetry.responseId, filledFieldCount: filledFieldCount(bbsRetry.result), output: bbsRetry.outputText });
      if (bbsRetry.result.testType === 'BBS' && filledFieldCount(bbsRetry.result) > 0) {
        const originalFields = new Map(ocr.result.fields.map(field => [field.id, field]));
        ocr = {
          ...bbsRetry,
          result: {
            ...bbsRetry.result,
            fields: bbsRetry.result.fields.map(field => {
              const original = originalFields.get(field.id);
              return field.value || !original?.value ? field : { ...field, value: original.value, confidence: original.confidence, x: original.x, y: original.y };
            }),
          },
        };
      }
    }
    if (ocr.result.testType === 'STEF' && filledStefTimeCount(ocr.result) < 20) {
      await persist();
      const stefRetry = await requestOcr(apiKey, imageUrl, buildStefRetryPrompt(), controller.signal);
      attempts.push({ responseId: stefRetry.responseId, filledFieldCount: filledFieldCount(stefRetry.result), output: stefRetry.outputText });
      const retryFields = new Map(stefRetry.result.fields.map(field => [field.id, field]));
      ocr = {
        ...stefRetry,
        result: {
          ...ocr.result,
          fields: ocr.result.fields.map(field => {
            if (!/^time_\d+$/.test(field.id) || !retryFields.has(field.id)) return field;
            const retryField = retryFields.get(field.id);
            return retryField.value || !field.value
              ? retryField
              : { ...retryField, value: field.value, confidence: field.confidence, x: field.x, y: field.y };
          }),
          notes: [ocr.result.notes, stefRetry.result.notes].filter(Boolean).join(' / '),
        },
      };
    }
    if (ocr.result.testType === 'SLTA_ALL' && !ocr.result.fields.some(field => /^SLTA_(?:[1-9]|1[0-2])_TEXT_\d+$/.test(field.id) && field.value)) {
      await persist();
      const sltaProblemResponseRetry = await requestOcr(apiKey, imageUrl, buildSltaProblemResponseRetryPrompt(ocr.result.fields), controller.signal);
      attempts.push({ responseId: sltaProblemResponseRetry.responseId, filledFieldCount: filledFieldCount(sltaProblemResponseRetry.result), output: sltaProblemResponseRetry.outputText });
      if (sltaProblemResponseRetry.result.testType === 'SLTA_ALL') {
        const textFields = sltaProblemResponseRetry.result.fields.filter(field => /^SLTA_(?:[1-9]|1[0-2])_TEXT_\d+$/.test(field.id) && field.value);
        const relabeledScores = new Map(sltaProblemResponseRetry.result.fields
          .filter(field => /^#\d+$/.test(field.id) && field.label && !/^(?:6段階評価|正答数|所要時間)$/.test(field.label))
          .map(field => [field.id, field]));
        if (textFields.length || relabeledScores.size) {
          const scoreFields = ocr.result.fields
            .filter(field => !/^SLTA_(?:[1-9]|1[0-2])_TEXT_\d+$/.test(field.id))
            .map(field => {
              const relabeled = relabeledScores.get(field.id);
              return relabeled ? { ...field, label: relabeled.label } : field;
            });
          ocr = {
            ...ocr,
            result: {
              ...ocr.result,
              fields: [...scoreFields, ...textFields],
              notes: [ocr.result.notes, sltaProblemResponseRetry.result.notes].filter(Boolean).join(' / '),
            },
          };
        }
      }
    }
    if (ocr.result.testType === 'BIT' && filledFieldCount(ocr.result) < expectedBitFieldCount(ocr.result)) {
      await persist();
      const bitPage = Number(/^BIT_(\d)_/.exec(ocr.result.fields?.[0]?.id || '')?.[1]) || job.ocrRoute?.page;
      const bitRetry = await requestOcr(apiKey, imageUrl, bitPromptForPage(bitPage), controller.signal);
      attempts.push({ responseId: bitRetry.responseId, filledFieldCount: filledFieldCount(bitRetry.result), output: bitRetry.outputText });
      if (filledFieldCount(bitRetry.result) > filledFieldCount(ocr.result)) ocr = bitRetry;
    }
    const issueIds = ocrIssueIds(ocr.result);
    if (issueIds.length) {
      await persist();
      const targetedRetry = await requestOcr(apiKey, imageUrl, buildTargetedRetryPrompt(ocr.result, issueIds), controller.signal, {
        effort: retryReasoningEffort,
        detail: 'original',
        routeKey: `${ocr.result.testType}-targeted`,
      });
      attempts.push({ responseId: targetedRetry.responseId, stage: 'targeted-high-accuracy', effort: retryReasoningEffort, issueCount: issueIds.length, filledFieldCount: filledFieldCount(targetedRetry.result), output: targetedRetry.outputText });
      ocr = { ...ocr, responseId: targetedRetry.responseId, result: mergeOcrResults(ocr.result, targetedRetry.result) };
    }
    job.result = applyKnownSltaLabels(ocr.result);
    if (job.evaluationDateOverride) job.result.evaluationDate = job.evaluationDateOverride;
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
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, product: 'Standalone AI OCR', release: '2026-08-02-patient-list-scroll-1', model, reasoningEffort, retryReasoningEffort, imageDetail, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY), rehabAiPlanTestData: { facilityPatientIds: rehabAiPlanPatientSeeds.map(([facilityPatientId]) => facilityPatientId), tenantsReady: [...rehabAiPlanTenantIds].filter(tenantId => rehabAiPlanPatientSeeds.every(([facilityPatientId]) => db.patients.some(patient => patient.tenantId === tenantId && patient.facilityPatientId === facilityPatientId))).length }, outcomeDemoData: { facilityPatientIds: outcomeDemoPatientIds, patientsPerTenant: outcomeDemoPatientIds.length, tenantsReady: [...outcomeDemoTenantIds].filter(tenantId => outcomeDemoPatientIds.every(facilityPatientId => db.patients.some(patient => patient.tenantId === tenantId && patient.facilityPatientId === facilityPatientId))).length } });
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
    if (req.method === 'POST' && url.pathname === '/api/detect-sheet') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const body = await readJson(req);
      parseDataUrl(body.imageDataUrl);
      const detection = await detectEvaluationSheet(apiKey, body.imageDataUrl);
      return sendJson(res, 200, detection);
    }
    if (req.method === 'POST' && url.pathname === '/api/validate-sheet-set') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const body = await readJson(req);
      const imageDataUrls = Array.isArray(body.imageDataUrls) ? body.imageDataUrls.slice(0, 13) : [];
      if (!imageDataUrls.length) return sendJson(res, 400, { error: '確認する画像がありません' });
      imageDataUrls.forEach(parseDataUrl);
      const detections = [];
      for (const imageDataUrl of imageDataUrls) detections.push(await detectEvaluationSheet(apiKey, imageDataUrl));
      return sendJson(res, 200, validateDetectedSheetSet(detections));
    }
    if (req.method === 'POST' && url.pathname === '/api/rehab-voice/speech') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      const body = await readJson(req);
      const text = safeText(body.text, 1000);
      const speaker = body.speaker === 'patient' ? 'patient' : 'therapist';
      if (!text) return sendJson(res, 400, { error: '音声にする会話テキストがありません' });
      const speechResponse = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice: speaker === 'patient' ? 'marin' : 'cedar',
          input: text,
          instructions: speaker === 'patient'
            ? '自然な日本語で、リハビリ中の患者として落ち着いて話してください。'
            : '自然な日本語で、患者に寄り添う療法士として明瞭に話してください。',
          response_format: 'mp3',
        }),
      });
      if (!speechResponse.ok) {
        const detail = safeText(await speechResponse.text(), 500);
        return sendJson(res, speechResponse.status, { error: `AI音声を生成できませんでした：${detail}` });
      }
      const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length, 'Cache-Control': 'no-store' });
      return res.end(audioBuffer);
    }
    if (req.method === 'GET' && url.pathname === '/api/rehab-voice/sessions') {
      return sendJson(res, 200, db.rehabVoiceSessions.filter(session => session.tenantId === identity.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    if (req.method === 'POST' && url.pathname === '/api/rehab-voice/sessions') {
      const body = await readJson(req);
      const requestedId = safeText(body.id, 100);
      const sessionId = /^rehab-voice-[A-Za-z0-9._-]+$/.test(requestedId) ? requestedId : id('rehab-voice');
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      const therapist = db.therapists.find(item => item.tenantId === identity.tenantId && item.id === body.therapistId);
      const patientLabel = safeText(body.patientLabel || (patient ? `${patient.facilityPatientId}｜${patient.name}` : ''), 200);
      const therapistLabel = safeText(body.therapistLabel || (therapist ? `${therapist.therapistId || ''}｜${therapist.name}` : ''), 200);
      if (!patientLabel || !therapistLabel) return sendJson(res, 400, { error: '患者と療法士を選択してください' });
      const existingIndex = db.rehabVoiceSessions.findIndex(session => session.tenantId === identity.tenantId && session.id === sessionId);
      const previous = existingIndex >= 0 ? db.rehabVoiceSessions[existingIndex] : null;
      const session = {
        id: sessionId,
        tenantId: identity.tenantId,
        patientId: patient?.id || safeText(body.patientId, 100) || null,
        therapistId: therapist?.id || safeText(body.therapistId, 100) || null,
        patientLabel,
        therapistLabel,
        duration: safeText(body.duration, 20),
        transcript: safeText(body.transcript, 100000),
        patientLog: safeText(body.patientLog, 20000),
        rewardFeedback: safeText(body.rewardFeedback, 5000),
        concerns: safeText(body.concerns, 20000),
        empathyFeedback: safeText(body.empathyFeedback, 5000),
        consultations: safeText(body.consultations, 20000),
        audioSource: body.audioSource === 'ai-test' ? 'ai-test' : (body.audioDataUrl || previous?.hasAudio ? 'recorded' : 'none'),
        hasAudio: Boolean(body.audioDataUrl || previous?.hasAudio),
        createdAt: safeText(body.createdAt, 40) || previous?.createdAt || now(),
        updatedAt: now(),
      };
      if (body.audioDataUrl) {
        const audioPayload = parseAudioDataUrl(body.audioDataUrl);
        await writeRehabVoiceAudio(sessionId, audioPayload.mimeType, audioPayload.content);
      }
      if (existingIndex >= 0) db.rehabVoiceSessions[existingIndex] = session;
      else db.rehabVoiceSessions.push(session);
      await persist();
      return sendJson(res, existingIndex >= 0 ? 200 : 201, session);
    }
    const rehabVoiceAudioMatch = /^\/api\/rehab-voice\/sessions\/([^/]+)\/audio$/.exec(url.pathname);
    if (req.method === 'GET' && rehabVoiceAudioMatch) {
      const session = db.rehabVoiceSessions.find(item => item.tenantId === identity.tenantId && item.id === rehabVoiceAudioMatch[1]);
      if (!session) return sendJson(res, 404, { error: 'リハビリボイス履歴が見つかりません' });
      const recording = await readRehabVoiceAudio(session.id);
      if (!recording) return sendJson(res, 404, { error: '録音音声が見つかりません' });
      res.writeHead(200, { 'Content-Type': recording.mimeType, 'Content-Length': recording.content.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(recording.content);
    }
    const rehabVoiceSessionMatch = /^\/api\/rehab-voice\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && rehabVoiceSessionMatch) {
      const index = db.rehabVoiceSessions.findIndex(item => item.tenantId === identity.tenantId && item.id === rehabVoiceSessionMatch[1]);
      if (index < 0) return sendJson(res, 404, { error: 'リハビリボイス履歴が見つかりません' });
      const [deleted] = db.rehabVoiceSessions.splice(index, 1);
      await deleteRehabVoiceAudio(deleted.id);
      await persist();
      return sendJson(res, 200, { deletedId: deleted.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/patients') return sendJson(res, 200, db.patients.filter(p => p.tenantId === identity.tenantId).map(p => publicPatient(p, identity.tenantId)));
    if (req.method === 'POST' && url.pathname === '/api/patients') {
      const body = await readJson(req); const name = safeText(body.name); const facilityPatientId = safeText(body.facilityPatientId);
      if (!name || !facilityPatientId) return sendJson(res, 400, { error: '患者名と施設内患者IDは必須です' });
      if (db.patients.some(p => p.tenantId === identity.tenantId && p.facilityPatientId === facilityPatientId)) return sendJson(res, 409, { error: '同じ施設内患者IDが登録済みです' });
      const patient = { id: id('patient'), tenantId: identity.tenantId, name, facilityPatientId, birthDate: safeText(body.birthDate, 10), createdAt: now(), updatedAt: now() };
      db.patients.push(patient); await persist(); return sendJson(res, 201, publicPatient(patient, identity.tenantId));
    }
    if (req.method === 'GET' && url.pathname === '/api/integration/patient-runs') return sendJson(res, 200, db.integrationRuns.filter(item => item.tenantId === identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,20));
    if (req.method === 'GET' && url.pathname === '/api/integration/coverage') {const patients=db.patients.filter(item=>item.tenantId===identity.tenantId);const patientIds=new Set(patients.map(item=>item.id));const importedPatients=patients.filter(item=>item.importSource==='PATIENT_CSV').length;const profiles=new Set(db.recoveryWardProfiles.filter(item=>item.tenantId===identity.tenantId&&patientIds.has(item.patientId)).map(item=>item.patientId));const rehabPatients=new Set(db.rehabRecords.filter(item=>item.tenantId===identity.tenantId&&patientIds.has(item.patientId)&&item.importSource==='REHAB_RECORD_CSV').map(item=>item.patientId));const eventPatients=new Set(db.clinicalEvents.filter(item=>item.tenantId===identity.tenantId&&patientIds.has(item.patientId)).map(item=>item.patientId));const runs=db.integrationRuns.filter(item=>item.tenantId===identity.tenantId);const applied=runs.filter(item=>item.mode==='APPLY');const percent=value=>patients.length?Math.round(value/patients.length*1000)/10:0;return sendJson(res,200,{patientCount:patients.length,coverage:{patientCsv:percent(importedPatients),wardProfile:percent(profiles.size),rehabRecords:percent(rehabPatients.size),clinicalEvents:percent(eventPatients.size)},counts:{importedPatients,wardProfiles:profiles.size,rehabRecordPatients:rehabPatients.size,clinicalEventPatients:eventPatients.size},quality:{appliedRuns:applied.length,blockedRuns:applied.filter(item=>item.status==='BLOCKED').length,blockedRate:applied.length?Math.round(applied.filter(item=>item.status==='BLOCKED').length/applied.length*1000)/10:0,duplicatesPrevented:runs.reduce((sum,item)=>sum+Number(item.counts?.UNCHANGED||0),0),errorsDetected:runs.reduce((sum,item)=>sum+Number(item.counts?.ERROR||0)+Number(item.counts?.CONFLICT||0),0)},target:{duplicateInputReduction:80,label:'対象データの二重入力80%以上削減',status:percent(importedPatients)>=80&&percent(profiles.size)>=80?'MEASURED_TARGET_MET':'PILOT_MEASUREMENT_REQUIRED'},note:'カバー率は登録患者を分母にしたシステム内集計です。実際の作業時間削減率は実証導入前後の時間測定で確認してください。'});}
    if (req.method === 'POST' && url.pathname === '/api/integration/patients/import') {
      const body = await readJson(req); const rows = Array.isArray(body.rows) ? body.rows.slice(0,2000) : []; const dryRun = body.apply !== true; const seen = new Set(); const results = rows.map((raw,index) => { const facilityPatientId=safeText(raw.facilityPatientId,100); const name=safeText(raw.name,200); const birthDate=/^\d{4}-\d{2}-\d{2}$/.test(String(raw.birthDate||''))?String(raw.birthDate):''; if(!facilityPatientId||!name) return {row:index+2,status:'ERROR',facilityPatientId,message:'患者IDと患者名は必須です'}; if(seen.has(facilityPatientId)) return {row:index+2,status:'ERROR',facilityPatientId,message:'CSV内で患者IDが重複しています'}; seen.add(facilityPatientId); const existing=db.patients.find(item=>item.tenantId===identity.tenantId&&item.facilityPatientId===facilityPatientId); if(!existing) return {row:index+2,status:'CREATE',facilityPatientId,name,birthDate,message:'新規登録候補'}; const differences=[]; if(existing.name!==name) differences.push('患者名'); if((existing.birthDate||'')!==birthDate) differences.push('生年月日'); return differences.length?{row:index+2,status:'CONFLICT',facilityPatientId,message:`既存患者と${differences.join('・')}が不一致`}:{row:index+2,status:'UNCHANGED',facilityPatientId,message:'登録済み情報と一致'}; }); const counts=Object.fromEntries(['CREATE','UNCHANGED','CONFLICT','ERROR'].map(status=>[status,results.filter(item=>item.status===status).length])); let created=0; if(!dryRun&&counts.CONFLICT===0&&counts.ERROR===0){const timestamp=now(); for(const item of results.filter(result=>result.status==='CREATE')){db.patients.push({id:id('patient'),tenantId:identity.tenantId,name:item.name,facilityPatientId:item.facilityPatientId,birthDate:item.birthDate,createdAt:timestamp,updatedAt:timestamp,importSource:'PATIENT_CSV'});created+=1;}} const run={id:id('integration-run'),tenantId:identity.tenantId,type:'PATIENT_CSV',mode:dryRun?'PREVIEW':'APPLY',status:!dryRun&&(counts.CONFLICT||counts.ERROR)?'BLOCKED':'COMPLETED',counts,created,issues:results.filter(item=>['CONFLICT','ERROR'].includes(item.status)).slice(0,200),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)}; db.integrationRuns.push(run); await persist(); return sendJson(res,run.status==='BLOCKED'?409:200,{...run,results});
    }
    if (req.method === 'POST' && url.pathname === '/api/integration/clinical/import') {
      const body=await readJson(req);const rows=Array.isArray(body.rows)?body.rows.slice(0,2000):[];const dryRun=body.apply!==true;const seen=new Set();const dateKeys=['admissionDate','plannedDischargeDate','dischargeDate'];const results=rows.map((raw,index)=>{const facilityPatientId=safeText(raw.facilityPatientId,100);if(!facilityPatientId)return{row:index+2,status:'ERROR',message:'患者IDは必須です'};if(seen.has(facilityPatientId))return{row:index+2,status:'ERROR',facilityPatientId,message:'CSV内で患者IDが重複しています'};seen.add(facilityPatientId);const patient=db.patients.find(item=>item.tenantId===identity.tenantId&&item.facilityPatientId===facilityPatientId);if(!patient)return{row:index+2,status:'ERROR',facilityPatientId,message:'登録患者が見つかりません'};for(const key of dateKeys)if(raw[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(String(raw[key])))return{row:index+2,status:'ERROR',facilityPatientId,message:`${key}の日付形式が不正です`};const data={wardName:safeText(raw.wardName,200),diseaseCategory:safeText(raw.diseaseCategory,500),admissionDate:String(raw.admissionDate||''),plannedDischargeDate:String(raw.plannedDischargeDate||''),dischargeDate:String(raw.dischargeDate||''),limitDays:Number(raw.limitDays)||null};const existing=db.recoveryWardProfiles.find(item=>item.tenantId===identity.tenantId&&item.patientId===patient.id);if(!existing)return{row:index+2,status:'CREATE',facilityPatientId,patientId:patient.id,data,message:'病棟情報の新規登録候補'};const differences=Object.entries(data).filter(([key,value])=>String(existing[key]??'')!==String(value??'')).map(([key])=>key);return differences.length?{row:index+2,status:'CONFLICT',facilityPatientId,message:`既存病棟情報と${differences.join('・')}が不一致`}:{row:index+2,status:'UNCHANGED',facilityPatientId,message:'登録済み病棟情報と一致'};});const counts=Object.fromEntries(['CREATE','UNCHANGED','CONFLICT','ERROR'].map(status=>[status,results.filter(item=>item.status===status).length]));let created=0;if(!dryRun&&!counts.CONFLICT&&!counts.ERROR){const timestamp=now();for(const item of results.filter(result=>result.status==='CREATE')){db.recoveryWardProfiles.push({id:id('ward-profile'),tenantId:identity.tenantId,patientId:item.patientId,...item.data,fimIntervalDays:14,onsetDate:'',note:'CSV連携',createdAt:timestamp,updatedAt:timestamp,updatedBy:safeText(identity.hospitalName||identity.userId,200),importSource:'CLINICAL_CSV',revisions:[]});created+=1;}}const run={id:id('integration-run'),tenantId:identity.tenantId,type:'CLINICAL_CSV',mode:dryRun?'PREVIEW':'APPLY',status:!dryRun&&(counts.CONFLICT||counts.ERROR)?'BLOCKED':'COMPLETED',counts,created,issues:results.filter(item=>['CONFLICT','ERROR'].includes(item.status)).slice(0,200),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.integrationRuns.push(run);await persist();return sendJson(res,run.status==='BLOCKED'?409:200,{...run,results});
    }
    if (req.method === 'POST' && url.pathname === '/api/integration/rehab-records/import') {
      const body=await readJson(req);const rows=Array.isArray(body.rows)?body.rows.slice(0,5000):[];const dryRun=body.apply!==true;const seen=new Set();const results=rows.map((raw,index)=>{const externalRecordId=safeText(raw.externalRecordId,120),facilityPatientId=safeText(raw.facilityPatientId,100);if(!externalRecordId||!facilityPatientId)return{row:index+2,status:'ERROR',facilityPatientId,message:'外部記録IDと患者IDは必須です'};if(seen.has(externalRecordId))return{row:index+2,status:'ERROR',facilityPatientId,message:'CSV内で外部記録IDが重複しています'};seen.add(externalRecordId);const patient=db.patients.find(item=>item.tenantId===identity.tenantId&&item.facilityPatientId===facilityPatientId);if(!patient)return{row:index+2,status:'ERROR',facilityPatientId,message:'登録患者が見つかりません'};if(db.rehabRecords.some(item=>item.tenantId===identity.tenantId&&item.externalRecordId===externalRecordId))return{row:index+2,status:'UNCHANGED',facilityPatientId,message:'外部記録IDは取込済み'};const durationMinutes=Number(raw.durationMinutes),therapistName=safeText(raw.therapistName,200),intervention=safeText(raw.intervention,2000),recordedAt=String(raw.recordedAt||'');if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(recordedAt))return{row:index+2,status:'ERROR',facilityPatientId,message:'実施日時の形式が不正です'};if(!Number.isFinite(durationMinutes)||durationMinutes<=0||durationMinutes>1440)return{row:index+2,status:'ERROR',facilityPatientId,message:'実施時間は1～1440分で入力してください'};if(!therapistName||!intervention)return{row:index+2,status:'ERROR',facilityPatientId,message:'療法士名と実施内容は必須です'};return{row:index+2,status:'CREATE',facilityPatientId,patientId:patient.id,data:{externalRecordId,recordedAt,therapistName,intervention,durationMinutes,outcome:safeText(raw.outcome,2000)},message:'新規記録候補'};});const counts=Object.fromEntries(['CREATE','UNCHANGED','CONFLICT','ERROR'].map(status=>[status,results.filter(item=>item.status===status).length]));let created=0;if(!dryRun&&!counts.ERROR){const timestamp=now();for(const item of results.filter(result=>result.status==='CREATE')){db.rehabRecords.push({id:id('rehab'),tenantId:identity.tenantId,patientId:item.patientId,recordType:'FOLLOW_UP',...item.data,preCondition:'',assistanceLevel:'',painBefore:null,painAfter:null,fatigueBefore:null,fatigueAfter:null,nextPlan:'',riskNotes:'',approvalStatus:'APPROVED',approvedBy:item.data.therapistName,approvedAt:timestamp,createdAt:timestamp,updatedAt:timestamp,revisions:[],importSource:'REHAB_RECORD_CSV'});created++;}}const run={id:id('integration-run'),tenantId:identity.tenantId,type:'REHAB_RECORD_CSV',mode:dryRun?'PREVIEW':'APPLY',status:!dryRun&&counts.ERROR?'BLOCKED':'COMPLETED',counts,created,issues:results.filter(item=>item.status==='ERROR').slice(0,200),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.integrationRuns.push(run);await persist();return sendJson(res,run.status==='BLOCKED'?409:200,{...run,results});
    }
    if (req.method === 'POST' && url.pathname === '/api/integration/clinical-events/import') {
      const body=await readJson(req);const rows=Array.isArray(body.rows)?body.rows.slice(0,5000):[];const dryRun=body.apply!==true;const seen=new Set();const results=rows.map((raw,index)=>{const externalEventId=safeText(raw.externalEventId,120),facilityPatientId=safeText(raw.facilityPatientId,100),eventType=String(raw.eventType||'').toUpperCase();if(!externalEventId||!facilityPatientId)return{row:index+2,status:'ERROR',facilityPatientId,message:'外部イベントIDと患者IDは必須です'};if(seen.has(externalEventId))return{row:index+2,status:'ERROR',facilityPatientId,message:'CSV内で外部イベントIDが重複しています'};seen.add(externalEventId);const patient=db.patients.find(item=>item.tenantId===identity.tenantId&&item.facilityPatientId===facilityPatientId);if(!patient)return{row:index+2,status:'ERROR',facilityPatientId,message:'登録患者が見つかりません'};if(db.clinicalEvents.some(item=>item.tenantId===identity.tenantId&&item.externalEventId===externalEventId))return{row:index+2,status:'UNCHANGED',facilityPatientId,message:'外部イベントIDは取込済み'};if(!['PRESCRIPTION','LAB'].includes(eventType))return{row:index+2,status:'ERROR',facilityPatientId,message:'種別はPRESCRIPTIONまたはLABです'};const occurredAt=String(raw.occurredAt||''),title=safeText(raw.title,500);if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(occurredAt))return{row:index+2,status:'ERROR',facilityPatientId,message:'発生日時の形式が不正です'};if(!title)return{row:index+2,status:'ERROR',facilityPatientId,message:'項目名は必須です'};return{row:index+2,status:'CREATE',facilityPatientId,patientId:patient.id,data:{externalEventId,eventType,occurredAt,title,value:safeText(raw.value,500),unit:safeText(raw.unit,100),note:safeText(raw.note,2000)},message:'新規臨床イベント候補'};});const counts=Object.fromEntries(['CREATE','UNCHANGED','CONFLICT','ERROR'].map(status=>[status,results.filter(item=>item.status===status).length]));let created=0;if(!dryRun&&!counts.ERROR){const timestamp=now();for(const item of results.filter(result=>result.status==='CREATE')){db.clinicalEvents.push({id:id('clinical-event'),tenantId:identity.tenantId,patientId:item.patientId,...item.data,importSource:'CLINICAL_EVENT_CSV',createdAt:timestamp,createdBy:safeText(identity.hospitalName||identity.userId,200)});created++;}}const run={id:id('integration-run'),tenantId:identity.tenantId,type:'CLINICAL_EVENT_CSV',mode:dryRun?'PREVIEW':'APPLY',status:!dryRun&&counts.ERROR?'BLOCKED':'COMPLETED',counts,created,issues:results.filter(item=>item.status==='ERROR').slice(0,200),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.integrationRuns.push(run);await persist();return sendJson(res,run.status==='BLOCKED'?409:200,{...run,results,usageNote:'処方・検査は参照情報です。診断や治療判断には原システムと医療者確認が必要です。'});
    }
    if (req.method === 'GET' && url.pathname === '/api/clinical-events') {const patientId=safeText(url.searchParams.get('patientId'));return sendJson(res,200,db.clinicalEvents.filter(item=>item.tenantId===identity.tenantId&&(!patientId||item.patientId===patientId)).sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0,500));}
    if (req.method === 'GET' && url.pathname === '/api/pilot/time-summary') {
      const rows = db.pilotTimeMeasurements.filter(item => item.tenantId === identity.tenantId).sort((a,b) => String(b.measuredAt).localeCompare(String(a.measuredAt)));
      const workflowLabels = { RECORD: '記録入力', PLAN: 'リハビリ計画書', CONFERENCE: 'カンファレンス資料', DISCHARGE: '退院支援', OTHER: 'その他' };
      const workflows = Object.keys(workflowLabels).map(workflow => {
        const selected = rows.filter(item => item.workflow === workflow);
        const baseline = selected.filter(item => item.phase === 'BASELINE');
        const trial = selected.filter(item => item.phase === 'TRIAL');
        const average = list => list.length ? Math.round(list.reduce((sum,item) => sum + item.minutesPerCase, 0) / list.length * 10) / 10 : null;
        const baselineAverage = average(baseline), trialAverage = average(trial);
        const reductionRate = baselineAverage && trialAverage != null ? Math.round((baselineAverage - trialAverage) / baselineAverage * 1000) / 10 : null;
        return { workflow, label: workflowLabels[workflow], baselineCount: baseline.length, trialCount: trial.length, baselineAverage, trialAverage, reductionRate, target: 30, status: reductionRate == null ? 'MEASUREMENT_REQUIRED' : reductionRate >= 30 ? 'TARGET_MET' : 'BELOW_TARGET' };
      });
      const comparable = workflows.filter(item => item.reductionRate != null);
      return sendJson(res, 200, { measurements: rows.slice(0,100), workflows, target: 30, comparableWorkflows: comparable.length, targetMetWorkflows: comparable.filter(item => item.status === 'TARGET_MET').length, note: '同一業務の導入前と試行中を複数回測定して比較します。患者の状態や担当者などの条件差を確認したうえで導入判断に使用してください。' });
    }
    if (req.method === 'POST' && url.pathname === '/api/pilot/time-measurements') {
      const body = await readJson(req); const phase = String(body.phase || '').toUpperCase(); const workflow = String(body.workflow || '').toUpperCase(); const measuredAt = String(body.measuredAt || ''); const minutes = Number(body.minutes); const cases = body.cases === '' || body.cases == null ? 1 : Number(body.cases);
      if (!['BASELINE','TRIAL'].includes(phase)) return sendJson(res,400,{error:'測定区分は導入前または試行中を選択してください'});
      if (!['RECORD','PLAN','CONFERENCE','DISCHARGE','OTHER'].includes(workflow)) return sendJson(res,400,{error:'対象業務を選択してください'});
      if (!/^\d{4}-\d{2}-\d{2}$/.test(measuredAt)) return sendJson(res,400,{error:'測定日を入力してください'});
      if (!Number.isFinite(minutes)||minutes<=0||minutes>1440) return sendJson(res,400,{error:'所要時間は1～1440分で入力してください'});
      if (!Number.isInteger(cases)||cases<1||cases>1000) return sendJson(res,400,{error:'対象件数は1～1000件で入力してください'});
      const item={id:id('pilot-time'),tenantId:identity.tenantId,phase,workflow,measuredAt,minutes:Math.round(minutes*10)/10,cases,minutesPerCase:Math.round(minutes/cases*10)/10,staffRole:safeText(body.staffRole,100),note:safeText(body.note,1000),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};
      db.pilotTimeMeasurements.push(item); await persist(); return sendJson(res,201,item);
    }
    if (req.method === 'GET' && url.pathname === '/api/pilot/safety-summary') {
      const events=db.pilotSafetyEvents.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt)));
      const serious=events.filter(item=>item.severity==='SERIOUS'); const open=events.filter(item=>item.status==='OPEN');
      return sendJson(res,200,{events:events.slice(0,100),counts:{total:events.length,serious:serious.length,open:open.length,patientMismatch:events.filter(item=>item.category==='PATIENT_MISMATCH').length,aiProposal:events.filter(item=>item.category==='AI_PROPOSAL').length,nearMiss:events.filter(item=>item.category==='NEAR_MISS').length},gate:{label:'重大事故0件',status:serious.length===0?'MET':'NOT_MET'},note:'安全事象は個人を責めるためではなく、再発防止と実証継続判断のために記録します。重大事象が1件でもある場合は試行を停止し、責任者が原因と対策を確認してください。'});
    }
    if (req.method === 'POST' && url.pathname === '/api/pilot/safety-events') {
      const body=await readJson(req);const category=String(body.category||'').toUpperCase(),severity=String(body.severity||'').toUpperCase(),occurredAt=String(body.occurredAt||'');
      if(!['NEAR_MISS','PATIENT_MISMATCH','AI_PROPOSAL','SYSTEM','OTHER'].includes(category))return sendJson(res,400,{error:'安全事象の種別を選択してください'});
      if(!['LOW','MEDIUM','SERIOUS'].includes(severity))return sendJson(res,400,{error:'重大度を選択してください'});
      if(!/^\d{4}-\d{2}-\d{2}$/.test(occurredAt))return sendJson(res,400,{error:'発生日を入力してください'});
      const description=safeText(body.description,2000);if(!description)return sendJson(res,400,{error:'事象内容は必須です'});
      const item={id:id('pilot-safety'),tenantId:identity.tenantId,category,severity,occurredAt,description,immediateAction:safeText(body.immediateAction,2000),status:'OPEN',createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};
      db.pilotSafetyEvents.push(item);await persist();return sendJson(res,201,item);
    }
    const pilotSafetyMatch=/^\/api\/pilot\/safety-events\/([^/]+)$/.exec(url.pathname);
    if(req.method==='PUT'&&pilotSafetyMatch){const item=db.pilotSafetyEvents.find(entry=>entry.tenantId===identity.tenantId&&entry.id===pilotSafetyMatch[1]);if(!item)return sendJson(res,404,{error:'安全事象が見つかりません'});const body=await readJson(req);if(body.status!=='RESOLVED')return sendJson(res,400,{error:'解決済みへの変更だけ実行できます'});const resolution=safeText(body.resolution,2000);if(!resolution)return sendJson(res,400,{error:'原因と再発防止策を入力してください'});item.status='RESOLVED';item.resolution=resolution;item.resolvedAt=now();item.resolvedBy=safeText(identity.hospitalName||identity.userId,200);await persist();return sendJson(res,200,item);}
    if(req.method==='GET'&&url.pathname==='/api/pilot/staff-feedback-summary'){
      const rows=db.pilotStaffFeedback.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.submittedAt).localeCompare(String(a.submittedAt)));const average=key=>rows.length?Math.round(rows.reduce((sum,item)=>sum+item[key],0)/rows.length*10)/10:null;const agree=rows.filter(item=>item.continueUse==='YES').length;const agreementRate=rows.length?Math.round(agree/rows.length*1000)/10:0;
      return sendJson(res,200,{responses:rows.length,agreementCount:agree,agreementRate,averages:{usability:average('usability'),usefulness:average('usefulness'),burden:average('burden')},roles:[...new Set(rows.map(item=>item.staffRole).filter(Boolean))],feedback:rows.slice(0,50),gate:{label:'利用継続合意80％以上',target:80,status:rows.length<3?'MORE_RESPONSES_REQUIRED':agreementRate>=80?'MET':'NOT_MET'},note:'少なくとも3人以上から回答を集め、職種の偏りと自由記載を責任者が確認して本導入を判断してください。'});
    }
    if(req.method==='POST'&&url.pathname==='/api/pilot/staff-feedback'){
      const body=await readJson(req);const continueUse=String(body.continueUse||'').toUpperCase();const score=key=>Number(body[key]);
      if(!['YES','NO','UNSURE'].includes(continueUse))return sendJson(res,400,{error:'利用継続意向を選択してください'});for(const key of ['usability','usefulness','burden'])if(!Number.isInteger(score(key))||score(key)<1||score(key)>5)return sendJson(res,400,{error:'各評価は1～5で入力してください'});
      const item={id:id('pilot-feedback'),tenantId:identity.tenantId,staffRole:safeText(body.staffRole,100),continueUse,usability:score('usability'),usefulness:score('usefulness'),burden:score('burden'),comment:safeText(body.comment,2000),submittedAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.pilotStaffFeedback.push(item);await persist();return sendJson(res,201,item);
    }
    if(req.method==='GET'&&url.pathname==='/api/pilot/readiness'){
      const times=db.pilotTimeMeasurements.filter(item=>item.tenantId===identity.tenantId);const workflows=['RECORD','PLAN','CONFERENCE','DISCHARGE','OTHER'];const reductions=workflows.flatMap(workflow=>{const selected=times.filter(item=>item.workflow===workflow);const baseline=selected.filter(item=>item.phase==='BASELINE'),trial=selected.filter(item=>item.phase==='TRIAL');if(!baseline.length||!trial.length)return[];const avg=list=>list.reduce((sum,item)=>sum+item.minutesPerCase,0)/list.length;const before=avg(baseline),after=avg(trial);return[{workflow,reductionRate:Math.round((before-after)/before*1000)/10}];});const bestReduction=reductions.length?Math.max(...reductions.map(item=>item.reductionRate)):null;
      const safety=db.pilotSafetyEvents.filter(item=>item.tenantId===identity.tenantId);const serious=safety.filter(item=>item.severity==='SERIOUS').length,open=safety.filter(item=>item.status==='OPEN').length;const feedback=db.pilotStaffFeedback.filter(item=>item.tenantId===identity.tenantId),agreementRate=feedback.length?Math.round(feedback.filter(item=>item.continueUse==='YES').length/feedback.length*1000)/10:0;
      const gates=[{key:'TIME',label:'主要業務時間30％以上削減',status:bestReduction==null?'MORE_DATA':bestReduction>=30?'MET':'NOT_MET',value:bestReduction==null?'未比較':`${bestReduction}%`,evidence:`比較可能 ${reductions.length}業務`},{key:'SAFETY',label:'重大事故0件・未解決0件',status:serious===0&&open===0?'MET':'STOP',value:`重大${serious}件・未解決${open}件`,evidence:`安全事象 ${safety.length}件`},{key:'AGREEMENT',label:'回答3人以上・継続意向80％以上',status:feedback.length<3?'MORE_DATA':agreementRate>=80?'MET':'NOT_MET',value:`${agreementRate}%`,evidence:`回答 ${feedback.length}人`}];
      const status=gates.some(item=>item.status==='STOP')?'STOP':gates.every(item=>item.status==='MET')?'READY':gates.some(item=>item.status==='NOT_MET')?'NOT_READY':'MORE_DATA';const labels={READY:'本導入候補',STOP:'試行停止・安全確認',NOT_READY:'改善後に再評価',MORE_DATA:'実証データ不足'};
      return sendJson(res,200,{status,label:labels[status],gates,decisionNote:status==='READY'?'システム内の定量条件は満たしています。病院の責任者、情報管理部門、現場代表が結果と対象範囲を確認して最終承認してください。':status==='STOP'?'安全確認と再発防止策の承認が完了するまで試行を再開しないでください。':'不足データまたは未達項目を確認し、対象業務と試行条件を揃えて再測定してください。',limitations:'この判定は登録済み実証データに基づく支援情報であり、病院の正式な導入承認を代替しません。'});
    }
    if(req.method==='GET'&&url.pathname==='/api/pilot/study'){
      const study=db.pilotStudies.find(item=>item.tenantId===identity.tenantId)||null; if(!study)return sendJson(res,200,{study:null,phase:'NOT_CONFIGURED',progress:0,message:'対象病棟、責任者、期間を設定してください。'}); const today=now().slice(0,10); let phase='PLANNED',progress=0,message='実証開始前です。'; if(today>=study.baselineStart&&today<=study.baselineEnd){phase='BASELINE';message='導入前の現状時間を測定中です。';}else if(today>study.baselineEnd&&today<study.trialStart){phase='SAFETY_CHECK';message='匿名・テストデータによる安全確認期間です。';}else if(today>=study.trialStart&&today<=study.trialEnd){phase='TRIAL';message='限定患者で試行中です。';}else if(today>study.trialEnd){phase='EVALUATION';message='効果、安全性、操作負荷を評価してください。';} const start=new Date(`${study.baselineStart}T00:00:00Z`),end=new Date(`${study.trialEnd}T00:00:00Z`),current=new Date(`${today}T00:00:00Z`); if(current>=start)progress=Math.max(0,Math.min(100,Math.round((current-start)/(end-start)*100))); return sendJson(res,200,{study,phase,progress,message});
    }
    if(req.method==='PUT'&&url.pathname==='/api/pilot/study'){
      const body=await readJson(req);const wardName=safeText(body.wardName,200),owner=safeText(body.owner,200),baselineStart=String(body.baselineStart||''),baselineEnd=String(body.baselineEnd||''),trialStart=String(body.trialStart||''),trialEnd=String(body.trialEnd||''),patientLimit=Number(body.patientLimit);const dates=[baselineStart,baselineEnd,trialStart,trialEnd];if(!wardName||!owner)return sendJson(res,400,{error:'対象病棟と実証責任者は必須です'});if(dates.some(value=>!/^\d{4}-\d{2}-\d{2}$/.test(value)))return sendJson(res,400,{error:'すべての期間を入力してください'});if(!(baselineStart<=baselineEnd&&baselineEnd<trialStart&&trialStart<=trialEnd))return sendJson(res,400,{error:'導入前測定、安全確認、試行の順になるよう期間を設定してください'});if(!Number.isInteger(patientLimit)||patientLimit<1||patientLimit>500)return sendJson(res,400,{error:'患者上限は1～500人で入力してください'});const existing=db.pilotStudies.find(item=>item.tenantId===identity.tenantId),timestamp=now();if(existing){Object.assign(existing,{wardName,owner,baselineStart,baselineEnd,trialStart,trialEnd,patientLimit,note:safeText(body.note,2000),updatedAt:timestamp,updatedBy:safeText(identity.hospitalName||identity.userId,200)});await persist();return sendJson(res,200,existing);}const study={id:id('pilot-study'),tenantId:identity.tenantId,wardName,owner,baselineStart,baselineEnd,trialStart,trialEnd,patientLimit,note:safeText(body.note,2000),createdAt:timestamp,updatedAt:timestamp,updatedBy:safeText(identity.hospitalName||identity.userId,200)};db.pilotStudies.push(study);await persist();return sendJson(res,201,study);
    }
    if(req.method==='GET'&&url.pathname==='/api/pilot/approvals'){
      const roles=['HOSPITAL_DIRECTOR','INFORMATION_SECURITY','CLINICAL_REPRESENTATIVE'];const all=db.pilotApprovals.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));const latest=roles.map(role=>all.find(item=>item.role===role)||null);const approved=latest.filter(item=>item?.decision==='APPROVE').length,rejected=latest.filter(item=>item?.decision==='REJECT').length;return sendJson(res,200,{latest,history:all.slice(0,50),summary:{approved,rejected,pending:roles.length-approved-rejected,status:rejected?'REJECTED':approved===roles.length?'APPROVED':'PENDING'},note:'三者すべての承認が揃った場合だけ本導入承認済みと表示します。却下後に再申請する場合も過去の判断履歴は保持します。'});
    }
    if(req.method==='POST'&&url.pathname==='/api/pilot/approvals'){
      const body=await readJson(req),role=String(body.role||'').toUpperCase(),decision=String(body.decision||'').toUpperCase(),approverName=safeText(body.approverName,200),comment=safeText(body.comment,2000);if(!['HOSPITAL_DIRECTOR','INFORMATION_SECURITY','CLINICAL_REPRESENTATIVE'].includes(role))return sendJson(res,400,{error:'承認者区分を選択してください'});if(!['APPROVE','REJECT'].includes(decision))return sendJson(res,400,{error:'承認または却下を選択してください'});if(!approverName)return sendJson(res,400,{error:'確認者名は必須です'});if(decision==='REJECT'&&!comment)return sendJson(res,400,{error:'却下理由を入力してください'});const item={id:id('pilot-approval'),tenantId:identity.tenantId,role,decision,approverName,comment,createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.pilotApprovals.push(item);await persist();return sendJson(res,201,item);
    }
    if(req.method==='GET'&&url.pathname==='/api/pilot/expansions'){
      const roles=['HOSPITAL_DIRECTOR','INFORMATION_SECURITY','CLINICAL_REPRESENTATIVE'],approvals=db.pilotApprovals.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))),formallyApproved=roles.every(role=>approvals.find(item=>item.role===role)?.decision==='APPROVE');const safety=db.pilotSafetyEvents.filter(item=>item.tenantId===identity.tenantId),safe=safety.every(item=>item.severity!=='SERIOUS'&&item.status!=='OPEN');const expansions=db.pilotExpansions.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(item=>({...item,monitoringEndDate:new Date(new Date(`${item.startDate}T00:00:00Z`).getTime()+(item.monitoringDays-1)*86400000).toISOString().slice(0,10)}));return sendJson(res,200,{eligible:formallyApproved&&safe,formalApproval:formallyApproved,safetyClear:safe,expansions,note:'三者の正式承認と安全確認が揃った場合だけ拡大計画を登録できます。拡大後も重点監視期間中は安全事象と業務時間を継続測定してください。'});
    }
    if(req.method==='POST'&&url.pathname==='/api/pilot/expansions'){
      const roles=['HOSPITAL_DIRECTOR','INFORMATION_SECURITY','CLINICAL_REPRESENTATIVE'],approvals=db.pilotApprovals.filter(item=>item.tenantId===identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));if(!roles.every(role=>approvals.find(item=>item.role===role)?.decision==='APPROVE'))return sendJson(res,409,{error:'三者の正式承認が揃うまで病棟拡大は登録できません'});if(db.pilotSafetyEvents.some(item=>item.tenantId===identity.tenantId&&(item.severity==='SERIOUS'||item.status==='OPEN')))return sendJson(res,409,{error:'重大または未解決の安全事象があるため拡大できません'});const body=await readJson(req),wardName=safeText(body.wardName,200),owner=safeText(body.owner,200),startDate=String(body.startDate||''),patientLimit=Number(body.patientLimit),monitoringDays=Number(body.monitoringDays);if(!wardName||!owner)return sendJson(res,400,{error:'拡大対象病棟と責任者は必須です'});if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return sendJson(res,400,{error:'拡大開始日を入力してください'});if(!Number.isInteger(patientLimit)||patientLimit<1||patientLimit>1000)return sendJson(res,400,{error:'患者上限は1～1000人で入力してください'});if(!Number.isInteger(monitoringDays)||monitoringDays<7||monitoringDays>90)return sendJson(res,400,{error:'重点監視期間は7～90日で入力してください'});const item={id:id('pilot-expansion'),tenantId:identity.tenantId,wardName,owner,startDate,patientLimit,monitoringDays,status:'PLANNED',note:safeText(body.note,2000),createdAt:now(),createdBy:safeText(identity.hospitalName||identity.userId,200)};db.pilotExpansions.push(item);await persist();return sendJson(res,201,item);
    }
    const pilotExpansionMatch=/^\/api\/pilot\/expansions\/([^/]+)$/.exec(url.pathname);
    if(req.method==='PUT'&&pilotExpansionMatch){const item=db.pilotExpansions.find(entry=>entry.tenantId===identity.tenantId&&entry.id===pilotExpansionMatch[1]);if(!item)return sendJson(res,404,{error:'病棟拡大計画が見つかりません'});const body=await readJson(req),action=String(body.action||'').toUpperCase(),reason=safeText(body.reason,2000);if(!['START','PAUSE','RESUME','COMPLETE'].includes(action))return sendJson(res,400,{error:'操作が不正です'});if(action==='PAUSE'&&!reason)return sendJson(res,400,{error:'一時停止理由を入力してください'});if(['START','RESUME'].includes(action)){const roles=['HOSPITAL_DIRECTOR','INFORMATION_SECURITY','CLINICAL_REPRESENTATIVE'],approvals=db.pilotApprovals.filter(entry=>entry.tenantId===identity.tenantId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));if(!roles.every(role=>approvals.find(entry=>entry.role===role)?.decision==='APPROVE'))return sendJson(res,409,{error:'正式承認を再確認してください'});if(db.pilotSafetyEvents.some(entry=>entry.tenantId===identity.tenantId&&(entry.severity==='SERIOUS'||entry.status==='OPEN')))return sendJson(res,409,{error:'安全事象を解決するまで開始・再開できません'});}const allowed={START:['PLANNED'],PAUSE:['ACTIVE'],RESUME:['PAUSED'],COMPLETE:['ACTIVE','PAUSED']};if(!allowed[action].includes(item.status))return sendJson(res,409,{error:`現在の状態では${action}を実行できません`});const next={START:'ACTIVE',PAUSE:'PAUSED',RESUME:'ACTIVE',COMPLETE:'COMPLETED'}[action],timestamp=now();item.status=next;item.updatedAt=timestamp;item.statusHistory??=[];item.statusHistory.push({action,status:next,reason,at:timestamp,by:safeText(identity.hospitalName||identity.userId,200)});if(action==='START')item.startedAt=timestamp;if(action==='COMPLETE')item.completedAt=timestamp;await persist();return sendJson(res,200,item);}
    if (req.method === 'GET' && url.pathname === '/api/therapists') {
      return sendJson(res, 200, db.therapists
        .filter(therapist => therapist.tenantId === identity.tenantId)
        .sort((a, b) => a.name.localeCompare(b.name, 'ja')));
    }
    if (req.method === 'POST' && url.pathname === '/api/therapists') {
      const body = await readJson(req);
      const therapistId = safeText(body.therapistId, 40);
      const name = safeText(body.name, 120);
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(therapistId)) return sendJson(res, 400, { error: '療法士IDは半角英数字・ピリオド・ハイフン・アンダースコアで入力してください。' });
      if (!name) return sendJson(res, 400, { error: '療法士名を入力してください。' });
      if (db.therapists.some(therapist => therapist.tenantId === identity.tenantId && therapist.therapistId === therapistId)) return sendJson(res, 409, { error: '同じ療法士IDが登録されています。' });
      if (db.therapists.some(therapist => therapist.tenantId === identity.tenantId && therapist.name === name)) return sendJson(res, 409, { error: '同じ名前の療法士が登録されています。' });
      const timestamp = now();
      const therapist = { id: id('therapist'), tenantId: identity.tenantId, therapistId, name, createdAt: timestamp, updatedAt: timestamp };
      db.therapists.push(therapist);
      await persist();
      return sendJson(res, 201, therapist);
    }
    const therapistMatch = /^\/api\/therapists\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && therapistMatch) {
      const index = db.therapists.findIndex(therapist => therapist.tenantId === identity.tenantId && therapist.id === therapistMatch[1]);
      if (index < 0) return sendJson(res, 404, { error: '療法士が見つかりません。' });
      const [deleted] = db.therapists.splice(index, 1);
      await persist();
      return sendJson(res, 200, { deletedId: deleted.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/rehab-plans') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const plans = db.rehabPlans
        .filter(plan => plan.tenantId === identity.tenantId && (!patientId || plan.patientId === patientId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(publicRehabPlan);
      return sendJson(res, 200, plans);
    }
    if (req.method === 'GET' && url.pathname === '/api/outcome-command-center') {
      const patients = db.patients.filter(patient => patient.tenantId === identity.tenantId);
      const patientRows = patients.map(patient => {
        const plans = db.rehabPlans.filter(plan => plan.tenantId === identity.tenantId && plan.patientId === patient.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const latestPlan = plans[0] || null;
        const context = db.rehabPlanContexts.find(item => item.tenantId === identity.tenantId && item.patientId === patient.id) || null;
        const jobs = db.jobs.filter(job => job.tenantId === identity.tenantId && job.patientId === patient.id && job.result);
        const fimSummary = fimPatientSummary(identity.tenantId, patient.id);
        const dischargeBoard = dischargeBoardSummary(identity.tenantId, patient.id);
        const fimValues = jobs.flatMap(job => {
          const result = job.confirmedResult || job.result;
          return (result?.fields || []).filter(field => /FIM|機能的自立度評価/i.test(`${result?.documentType || ''} ${field.label || ''}`) && String(field.value || '').trim()).map(field => ({ label: safeText(field.label, 200), value: safeText(field.value, 100), date: jobEvaluationDate(job) }));
        });
        const reviewComments = [latestPlan?.aiReviewComments, latestPlan?.therapistReviewComments, context?.unresolvedQuestions].filter(value => String(value || '').trim()).length;
        const profileRequired = ['admissionDate','diseaseCategory','limitDays','plannedDischargeDate'];
        const dataQualityIssues = [
          ...(!fimSummary.latest ? ['FIM未登録'] : []), ...(fimSummary.overdue ? ['FIM評価期限超過'] : []), ...(fimSummary.hasMissing ? ['FIM未入力項目'] : []),
          ...(!fimSummary.profile ? ['病棟情報未登録'] : profileRequired.filter(key => !fimSummary.profile[key]).map(key => ({ admissionDate:'入棟日未入力', diseaseCategory:'疾患区分未入力', limitDays:'算定上限日数未入力', plannedDischargeDate:'退棟予定日未入力' })[key])),
          ...(latestPlan?.status !== 'CONFIRMED' ? ['計画未確定'] : []), ...(reviewComments ? ['確認コメント未解決'] : []),
        ];
        return {
          patientId: patient.id, facilityPatientId: patient.facilityPatientId, name: patient.name,
          planStatus: latestPlan?.status || 'NONE', planUpdatedAt: latestPlan?.updatedAt || null,
          contextStatus: context?.dataStatus || 'NONE', fimRegistered: Boolean(fimSummary.latest) || fimValues.length > 0,
          fimLatest: fimSummary.latest ? { value: fimSummary.latest.total, date: fimSummary.latest.evaluationDate, motorTotal: fimSummary.latest.motorTotal, cognitiveTotal: fimSummary.latest.cognitiveTotal } : (fimValues.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null),
          fimGain: fimSummary.gain, fimEfficiency: fimSummary.efficiency, fimMissing: fimSummary.hasMissing, fimNextDue: fimSummary.nextDue, fimOverdue: fimSummary.overdue,
          wardProfile: fimSummary.profile, limitDate: fimSummary.limitDate,
          reviewComments, dischargeDestination: safeText(context?.dischargeDestination, 500),
          hasDischargeIssue: dischargeBoard.blocking > 0 || Boolean(context && (!context.dischargeDestination || context.unresolvedQuestions || context.risks)),
          dischargeReadiness: dischargeBoard.readiness, dischargeBlocking: dischargeBoard.blocking, dischargeOverdue: dischargeBoard.overdue, dischargeOwnerMissing: dischargeBoard.ownerMissing,
          dataQualityIssues,
        };
      }).sort((a, b) => (b.reviewComments - a.reviewComments) || a.facilityPatientId.localeCompare(b.facilityPatientId));
      const confirmedCount = patientRows.filter(row => row.planStatus === 'CONFIRMED').length;
      const contexts = db.rehabPlanContexts.filter(context => context.tenantId === identity.tenantId);
      const requiredContextFields = ['diagnosis', 'medicalRestrictions', 'preHospitalLife', 'currentAdl', 'homeEnvironment', 'familySupport', 'patientGoals', 'dischargeDestination'];
      const completedFields = contexts.reduce((sum, context) => sum + requiredContextFields.filter(key => String(context[key] || '').trim()).length, 0);
      const derivedValues = {
        planConfirmationRate: patientRows.length ? Math.round(confirmedCount / patientRows.length * 1000) / 10 : 0,
        dataCompletionRate: patientRows.length ? Math.round(completedFields / (patientRows.length * requiredContextFields.length) * 1000) / 10 : 0,
      };
      const latestSnapshot = db.outcomeSnapshots.filter(snapshot => snapshot.tenantId === identity.tenantId).sort((a, b) => b.period.localeCompare(a.period))[0] || null;
      const goals = db.outcomeGoals.filter(goal => goal.tenantId === identity.tenantId && goal.active !== false).map(goal => ({
        ...goal,
        current: Number.isFinite(Number(latestSnapshot?.values?.[goal.key])) ? Number(latestSnapshot.values[goal.key]) : (derivedValues[goal.key] ?? goal.publicBaseline),
        currentSource: Number.isFinite(Number(latestSnapshot?.values?.[goal.key])) ? 'HOSPITAL_SNAPSHOT' : (derivedValues[goal.key] != null ? 'LIVE_SYSTEM' : 'PUBLIC_BASELINE'),
      }));
      const actions = db.outcomeActions.filter(action => action.tenantId === identity.tenantId && action.status !== 'DONE').sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
      const warningRows = patients.map(patient => patientOutcomeWarnings(identity.tenantId, patient)); const tenantWarningReviews = db.warningReviews.filter(item => item.tenantId === identity.tenantId); const earlyWarnings = warningRows.flatMap(row => row.warnings.map(warning => ({ ...warning, patientId: row.patientId, facilityPatientId: row.facilityPatientId, patientName: row.name, review: tenantWarningReviews.find(item => item.warningId === warning.id) || null }))).sort((a, b) => ({ HIGH: 0, MEDIUM: 1 }[a.severity] - ({ HIGH: 0, MEDIUM: 1 }[b.severity])));
      const actionedWarnings = tenantWarningReviews.filter(item => item.status === 'ACTIONED').length; const dismissedWarnings = tenantWarningReviews.filter(item => item.status === 'FALSE_ALERT').length; const reviewedWarnings = actionedWarnings + dismissedWarnings; const trackedWarningIds = new Set([...earlyWarnings.map(item => item.id), ...tenantWarningReviews.map(item => item.warningId)]); const unresolvedWarnings = earlyWarnings.filter(item => !item.review || item.review.status === 'UNRESOLVED').length;
      return sendJson(res, 200, {
        updatedAt: now(),
        summary: {
          patientCount: patientRows.length,
          fimRegisteredCount: patientRows.filter(row => row.fimRegistered).length,
          planReviewCount: patientRows.filter(row => row.planStatus !== 'CONFIRMED' || row.reviewComments > 0).length,
          dischargeIssueCount: patientRows.filter(row => row.hasDischargeIssue).length,
          dataQualityIssueCount: patientRows.filter(row => row.dataQualityIssues.length).length,
          earlyWarningCount: earlyWarnings.length,
        },
        goals, latestSnapshot, actions, patients: patientRows, earlyWarnings, warningAudit: warningRows, blockerRanking: dischargeBlockerRanking(identity.tenantId), performanceIndexSimulation: performanceIndexSimulation(identity.tenantId), warningOutcomeComparisons: warningOutcomeComparisons(identity.tenantId), managementDashboard: managementOutcomeDashboard(identity.tenantId), warningMetrics: { total: trackedWarningIds.size, active: earlyWarnings.length, actioned: actionedWarnings, falseAlerts: dismissedWarnings, unresolved: unresolvedWarnings, actionRate: trackedWarningIds.size ? Math.round(actionedWarnings / trackedWarningIds.size * 100) : 0, falseAlertRate: reviewedWarnings ? Math.round(dismissedWarnings / reviewedWarnings * 100) : 0 },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/outcome-performance-simulation') return sendJson(res, 200, performanceIndexSimulation(identity.tenantId, url.searchParams.get('additionalMotorFim'), url.searchParams.get('reducedStayDays')));
    const outcomeWarningReviewMatch = /^\/api\/outcome-warnings\/([^/]+)\/review$/.exec(url.pathname);
    if (req.method === 'PUT' && outcomeWarningReviewMatch) {
      const body = await readJson(req); const status = ['ACTIONED','FALSE_ALERT','UNRESOLVED'].includes(body.status) ? body.status : '';
      if (!status) return sendJson(res, 400, { error: '警告の確認結果を選択してください' });
      const warningId = safeText(outcomeWarningReviewMatch[1], 100); const timestamp = now(); let review = db.warningReviews.find(item => item.tenantId === identity.tenantId && item.warningId === warningId);
      if (!review) { const active = db.patients.filter(item => item.tenantId === identity.tenantId).flatMap(patient => patientOutcomeWarnings(identity.tenantId, patient).warnings.map(warning => ({ patient, warning }))).find(item => item.warning.id === warningId); const fim = active ? fimPatientSummary(identity.tenantId, active.patient.id) : null; const discharge = active ? dischargeBoardSummary(identity.tenantId, active.patient.id) : null; review = { id: id('warning-review'), tenantId: identity.tenantId, warningId, createdAt: timestamp, revisions: [], snapshot: active ? { patientId: active.patient.id, warningType: active.warning.type, title: active.warning.title, latestFimDate: fim?.latest?.evaluationDate || '', latestFimTotal: fim?.latest?.total ?? null, blocking: discharge?.blocking || 0, overdue: discharge?.overdue || 0 } : null }; db.warningReviews.push(review); }
      else { review.revisions = Array.isArray(review.revisions) ? review.revisions : []; review.revisions.push({ at: timestamp, by: safeText(identity.hospitalName || identity.userId, 200), status: review.status, note: review.note }); }
      Object.assign(review, { status, note: safeText(body.note, 1000), updatedAt: timestamp, updatedBy: safeText(identity.hospitalName || identity.userId, 200) }); await persist(); return sendJson(res, 200, review);
    }
    if (req.method === 'GET' && url.pathname === '/api/recovery-ward-profile') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      const profile = db.recoveryWardProfiles.find(item => item.tenantId === identity.tenantId && item.patientId === patientId);
      return sendJson(res, 200, profile || { patientId, ...normalizeRecoveryWardProfile({}) });
    }
    if (req.method === 'GET' && url.pathname === '/api/conference-brief') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      return sendJson(res, 200, conferenceBrief(identity.tenantId, patient));
    }
    if (req.method === 'POST' && url.pathname === '/api/conference-brief/ai') {
      const body = await readJson(req); const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      if (!process.env.OPENAI_API_KEY) return sendJson(res, 503, { error: 'AIが利用できないためルール版を使用してください' });
      try { return sendJson(res, 200, await generateConferenceBrief(process.env.OPENAI_API_KEY, conferenceBrief(identity.tenantId, patient))); }
      catch (error) { return sendJson(res, 502, { error: `AIカンファレンス資料を作成できませんでした: ${safeText(error.message, 500)}` }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/conferences') {
      const body = await readJson(req); const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const timestamp = now(); const action = safeText(body.action, 1000); const owner = safeText(body.owner, 200); const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || '')) ? body.dueDate : '';
      const conference = { id: id('conference'), tenantId: identity.tenantId, patientId: patient.id, heldAt: /^\d{4}-\d{2}-\d{2}$/.test(String(body.heldAt || '')) ? body.heldAt : timestamp.slice(0, 10), participants: safeText(body.participants, 1000), minutes: safeText(body.minutes, 5000), decision: safeText(body.decision, 2000), action, owner, dueDate, sources: Array.isArray(body.sources) ? body.sources.map(value => safeText(value, 200)).filter(Boolean).slice(0, 20) : [], createdAt: timestamp, createdBy: safeText(identity.hospitalName || identity.userId, 200), revisions: [] };
      db.conferences.push(conference);
      if (action) db.outcomeActions.push({ id: id('outcome-action'), tenantId: identity.tenantId, patientId: patient.id, patientLabel: `${patient.facilityPatientId}｜${patient.name}`, category: 'CONFERENCE', title: action, owner, dueDate, status: 'OPEN', createdAt: timestamp, updatedAt: timestamp });
      await persist(); return sendJson(res, 201, conference);
    }
    const conferenceMatch = /^\/api\/conferences\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && conferenceMatch) {
      const conference = db.conferences.find(item => item.tenantId === identity.tenantId && item.id === conferenceMatch[1]);
      if (!conference) return sendJson(res, 404, { error: 'カンファレンス記録が見つかりません' });
      const body = await readJson(req); const timestamp = now(); conference.revisions = Array.isArray(conference.revisions) ? conference.revisions : [];
      conference.revisions.push({ at: timestamp, by: safeText(identity.hospitalName || identity.userId, 200), data: { heldAt: conference.heldAt, participants: conference.participants, minutes: conference.minutes, decision: conference.decision, action: conference.action, owner: conference.owner, dueDate: conference.dueDate } });
      Object.assign(conference, { heldAt: /^\d{4}-\d{2}-\d{2}$/.test(String(body.heldAt || '')) ? body.heldAt : conference.heldAt, participants: safeText(body.participants, 1000), minutes: safeText(body.minutes, 5000), decision: safeText(body.decision, 2000), action: safeText(body.action, 1000), owner: safeText(body.owner, 200), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || '')) ? body.dueDate : '', updatedAt: timestamp, updatedBy: safeText(identity.hospitalName || identity.userId, 200) });
      await persist(); return sendJson(res, 200, conference);
    }
    if (req.method === 'GET' && url.pathname === '/api/discharge-board') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      return sendJson(res, 200, { patient: { id: patient.id, facilityPatientId: patient.facilityPatientId, name: patient.name }, templates: dischargeTaskTemplates.map(([key, label]) => ({ key, label })), ...dischargeBoardSummary(identity.tenantId, patient.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/discharge-board/initialize') {
      const body = await readJson(req); const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const timestamp = now(); let created = 0;
      for (const [order, [key, label]] of dischargeTaskTemplates.entries()) {
        if (db.dischargeTasks.some(task => task.tenantId === identity.tenantId && task.patientId === patient.id && task.key === key)) continue;
        db.dischargeTasks.push({ id: id('discharge-task'), tenantId: identity.tenantId, patientId: patient.id, key, label, order, status: 'NOT_ASSESSED', priority: 'MEDIUM', owner: '', dueDate: '', note: '', createdAt: timestamp, updatedAt: timestamp, revisions: [] }); created += 1;
      }
      if (created) await persist(); return sendJson(res, 200, { created, ...dischargeBoardSummary(identity.tenantId, patient.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/discharge-board/suggest-schedule') {
      const body = await readJson(req); const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const profile = db.recoveryWardProfiles.find(item => item.tenantId === identity.tenantId && item.patientId === patient.id);
      if (!profile?.plannedDischargeDate) return sendJson(res, 400, { error: '回復期病棟情報で退棟予定日を登録してください' });
      const timestamp = now(); let changed = 0;
      for (const task of db.dischargeTasks.filter(item => item.tenantId === identity.tenantId && item.patientId === patient.id)) {
        const [ownerRole, offset] = dischargeTaskSuggestions[task.key] || ['', '']; let taskChanged = false;
        if (!task.owner && ownerRole) { task.owner = ownerRole; task.ownerSource = 'PROPOSED'; taskChanged = true; }
        if (!task.dueDate && offset) { task.dueDate = dateOffset(profile.plannedDischargeDate, offset); task.dueDateSource = 'PROPOSED'; taskChanged = true; }
        if (taskChanged) { task.updatedAt = timestamp; task.scheduleBasis = `退棟予定日 ${profile.plannedDischargeDate}`; changed += 1; }
      }
      if (changed) await persist(); return sendJson(res, 200, { changed, plannedDischargeDate: profile.plannedDischargeDate, ...dischargeBoardSummary(identity.tenantId, patient.id) });
    }
    if (req.method === 'PUT' && url.pathname === '/api/discharge-board') {
      const body = await readJson(req); const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const updates = Array.isArray(body.tasks) ? body.tasks.slice(0, dischargeTaskTemplates.length) : []; const timestamp = now();
      for (const update of updates) {
        const task = db.dischargeTasks.find(item => item.tenantId === identity.tenantId && item.patientId === patient.id && item.id === update.id); if (!task) continue;
        const previousOwner = task.owner || ''; const previousDueDate = task.dueDate || '';
        task.revisions = Array.isArray(task.revisions) ? task.revisions : []; task.revisions.push({ at: timestamp, by: safeText(identity.hospitalName || identity.userId, 200), status: task.status, owner: task.owner, dueDate: task.dueDate, note: task.note });
        task.status = ['NOT_ASSESSED','BLOCKING','IN_PROGRESS','RESOLVED','NOT_APPLICABLE'].includes(update.status) ? update.status : task.status;
        task.priority = ['HIGH','MEDIUM','LOW'].includes(update.priority) ? update.priority : task.priority; task.owner = safeText(update.owner, 200); task.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(update.dueDate || '')) ? update.dueDate : ''; task.note = safeText(update.note, 2000); task.updatedAt = timestamp;
        if (task.owner && (task.owner !== previousOwner || task.ownerSource === 'PROPOSED')) task.ownerSource = 'USER_CONFIRMED';
        if (task.dueDate && (task.dueDate !== previousDueDate || task.dueDateSource === 'PROPOSED')) task.dueDateSource = 'USER_CONFIRMED';
      }
      if (updates.length) await persist(); return sendJson(res, 200, dischargeBoardSummary(identity.tenantId, patient.id));
    }
    if (req.method === 'PUT' && url.pathname === '/api/recovery-ward-profile') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const timestamp = now(); let profile = db.recoveryWardProfiles.find(item => item.tenantId === identity.tenantId && item.patientId === patient.id);
      if (!profile) { profile = { id: id('ward-profile'), tenantId: identity.tenantId, patientId: patient.id, createdAt: timestamp, revisions: [] }; db.recoveryWardProfiles.push(profile); }
      else { profile.revisions = Array.isArray(profile.revisions) ? profile.revisions : []; profile.revisions.push({ at: timestamp, by: safeText(identity.hospitalName || identity.userId, 200), data: normalizeRecoveryWardProfile(profile) }); }
      Object.assign(profile, normalizeRecoveryWardProfile(body, profile), { updatedAt: timestamp, updatedBy: safeText(identity.hospitalName || identity.userId, 200) }); await persist(); return sendJson(res, 200, { ...profile, summary: fimPatientSummary(identity.tenantId, patient.id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/fim-assessments') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      return sendJson(res, 200, fimPatientSummary(identity.tenantId, patientId));
    }
    if (req.method === 'POST' && url.pathname === '/api/fim-ocr') {
      const body = await readJson(req);
      if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(String(body.imageDataUrl || ''))) return sendJson(res, 400, { error: 'FIM評価票のJPEG、PNG、WebP画像を選択してください' });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      try { return sendJson(res, 200, await extractFimAssessment(apiKey, body.imageDataUrl)); }
      catch (error) { return sendJson(res, 502, { error: `FIM評価票を読み取れませんでした: ${safeText(error.message, 500)}` }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/fim-export.csv') {
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const headers = ['facilityPatientId','patientName','stage','evaluationDate','evaluator','status','locomotionMode',...fimItems,'motorTotal','cognitiveTotal','total','note'];
      const rows = db.fimAssessments.filter(item => item.tenantId === identity.tenantId).sort((a, b) => a.evaluationDate.localeCompare(b.evaluationDate)).map(item => {
        const patient = db.patients.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === item.patientId);
        const values = [patient?.facilityPatientId, patient?.name,item.stage,item.evaluationDate,item.evaluator,item.status,item.locomotionMode,...fimItems.map(key => item.scores?.[key]),item.motorTotal,item.cognitiveTotal,item.total,item.note];
        return values.map(quote).join(',');
      });
      const csv = `\uFEFF${headers.join(',')}\r\n${rows.join('\r\n')}\r\n`;
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="fim-assessments.csv"', 'Cache-Control': 'no-store' }); res.end(csv); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/outcome-management-report.csv') {
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`; const dashboard = managementOutcomeDashboard(identity.tenantId); const headers = ['集計軸','区分','患者数','FIM評価患者数','平均FIM利得','平均FIM効率','平均参考単位数','在宅復帰率','在宅復帰分子','在宅復帰分母','計画確定率','退院前訪問実施率','家族指導実施率']; const rows = dashboard.groups.flatMap(group => group.rows.map(row => [group.label,row.name,row.patients,row.fimEvaluated,row.averageFimGain,row.averageFimEfficiency,row.averageTherapyUnits,row.homeReturnRate,row.homeReturnNumerator,row.homeReturnDenominator,row.planConfirmationRate,row.homeVisitRate,row.familyTrainingRate].map(quote).join(','))); const csv = `\uFEFF${headers.map(quote).join(',')}\r\n${rows.join('\r\n')}\r\n`;
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="outcome-management-report.csv"', 'Cache-Control': 'no-store' }); res.end(csv); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/outcome-monthly-report.html') {
      const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); const dashboard = managementOutcomeDashboard(identity.tenantId); const requestedPeriod = /^\d{4}-\d{2}$/.test(String(url.searchParams.get('period') || '')) ? url.searchParams.get('period') : ''; const snapshot = db.outcomeSnapshots.filter(item => item.tenantId === identity.tenantId && (!requestedPeriod || item.period === requestedPeriod)).sort((a,b)=>b.period.localeCompare(a.period))[0] || null; const patients = db.patients.filter(item => item.tenantId === identity.tenantId); const warningCount = patients.flatMap(patient => patientOutcomeWarnings(identity.tenantId, patient).warnings).length; const groupTables = dashboard.groups.map(group => `<section><h2>${esc(group.label)}</h2><table><thead><tr><th>区分</th><th>患者数</th><th>平均FIM利得</th><th>平均参考単位</th><th>在宅復帰率</th><th>計画確定率</th><th>退院前訪問</th><th>家族指導</th></tr></thead><tbody>${group.rows.map(row=>`<tr><td>${esc(row.name)}</td><td>${row.patients}</td><td>${row.averageFimGain??'―'}</td><td>${row.averageTherapyUnits}</td><td>${row.homeReturnRate??'―'}%（${row.homeReturnNumerator}/${row.homeReturnDenominator}）</td><td>${row.planConfirmationRate}%</td><td>${row.homeVisitRate}%</td><td>${row.familyTrainingRate}%</td></tr>`).join('')}</tbody></table></section>`).join(''); const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>回復期病棟 月次アウトカム報告</title><style>body{font-family:sans-serif;color:#172536;margin:24px}header{border-bottom:3px solid #234f7d}h1{margin-bottom:4px}.meta,.notice{padding:10px;background:#eef5fc}.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kpi div{padding:10px;border:1px solid #ccd9e7}.kpi b{display:block;font-size:22px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #bbc8d5;padding:6px;text-align:right}th:first-child,td:first-child{text-align:left}thead{background:#e8f2ff}.definitions{font-size:12px}@media print{button{display:none}body{margin:10mm}}</style></head><body><header><h1>回復期病棟 月次アウトカム報告</h1><p>${esc(identity.hospitalName || '院内')}・対象月 ${esc(snapshot?.period || '月次実績未登録')}・作成 ${esc(now().slice(0,10))}</p><button onclick="window.print()">印刷・PDF保存</button></header><p class="notice">院内会議用の匿名集計です。患者名・患者IDを含みません。正式な行政提出様式や診療報酬請求値としては使用できません。</p><div class="kpi"><div><span>管理対象患者</span><b>${patients.length}</b></div><div><span>早期警告</span><b>${warningCount}</b></div><div><span>単位データ登録率</span><b>${dashboard.therapyComparison.dataCompletionRate}%</b></div><div><span>月次実績区分</span><b>${esc(snapshot?.dataType || '未登録')}</b></div></div>${snapshot?`<section><h2>月次実績</h2><p>在宅復帰率 ${snapshot.values?.homeReturnRate??'―'}%　FIM改善 ${snapshot.values?.fimGain??'―'}点　実績指数 ${snapshot.values?.performanceIndex??'―'}</p></section>`:''}${groupTables}<section class="definitions"><h2>集計条件</h2>${Object.values(dashboard.definitions).map(value=>`<p>${esc(value)}</p>`).join('')}<p>${esc(dashboard.benchmark.privacyNote)}</p><p>${esc(dashboard.therapyComparison.note)}</p></section></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pilot/report.html') {
      const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); const times=db.pilotTimeMeasurements.filter(item=>item.tenantId===identity.tenantId); const workflowLabels={RECORD:'記録入力',PLAN:'リハビリ計画書',CONFERENCE:'カンファレンス資料',DISCHARGE:'退院支援',OTHER:'その他'};
      const timeRows=Object.entries(workflowLabels).map(([key,label])=>{const rows=times.filter(item=>item.workflow===key),before=rows.filter(item=>item.phase==='BASELINE'),after=rows.filter(item=>item.phase==='TRIAL');const avg=list=>list.length?Math.round(list.reduce((sum,item)=>sum+item.minutesPerCase,0)/list.length*10)/10:null;const baseline=avg(before),trial=avg(after);return{label,baseline,trial,reduction:baseline&&trial!=null?Math.round((baseline-trial)/baseline*1000)/10:null,before:before.length,after:after.length};}); const comparable=timeRows.filter(item=>item.reduction!=null),best=comparable.length?Math.max(...comparable.map(item=>item.reduction)):null;
      const safety=db.pilotSafetyEvents.filter(item=>item.tenantId===identity.tenantId),serious=safety.filter(item=>item.severity==='SERIOUS').length,open=safety.filter(item=>item.status==='OPEN').length; const feedback=db.pilotStaffFeedback.filter(item=>item.tenantId===identity.tenantId),agreement=feedback.length?Math.round(feedback.filter(item=>item.continueUse==='YES').length/feedback.length*1000)/10:0;
      const gates=[['主要業務時間30％以上削減',best==null?'データ不足':best>=30?'達成':'未達',best==null?'未比較':`${best}%`],['重大事故0件・未解決0件',serious===0&&open===0?'達成':'試行停止',`重大${serious}件・未解決${open}件`],['回答3人以上・継続意向80％以上',feedback.length<3?'データ不足':agreement>=80?'達成':'未達',`${agreement}%・${feedback.length}人`]]; const overall=gates.some(row=>row[1]==='試行停止')?'試行停止・安全確認':gates.every(row=>row[1]==='達成')?'本導入候補':gates.some(row=>row[1]==='未達')?'改善後に再評価':'実証データ不足';
      const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>実証報告</title><style>body{font-family:sans-serif;color:#172536;margin:24px}header{border-bottom:3px solid #234f7d}.notice{padding:10px;background:#eef5fc}.decision{padding:16px;border:2px solid #234f7d;font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #bbc8d5;padding:7px;text-align:left}thead{background:#e8f2ff}.meta{color:#52677d}@media print{button{display:none}body{margin:10mm}}</style></head><body><header><h1>実証導入結果報告</h1><p>${esc(identity.hospitalName||'院内')}・作成日 ${now().slice(0,10)}</p><button onclick="window.print()">印刷・PDF保存</button></header><p class="notice">患者名・患者IDを含まない院内承認会議用の集計です。この報告は正式な導入承認を代替しません。</p><p class="decision">総合判定：<strong>${esc(overall)}</strong></p><h2>導入判定条件</h2><table><thead><tr><th>条件</th><th>判定</th><th>実績</th></tr></thead><tbody>${gates.map(row=>`<tr>${row.map(value=>`<td>${esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><h2>作業時間</h2><table><thead><tr><th>業務</th><th>導入前</th><th>試行中</th><th>削減率</th><th>測定数</th></tr></thead><tbody>${timeRows.map(row=>`<tr><td>${esc(row.label)}</td><td>${row.baseline??'―'}分</td><td>${row.trial??'―'}分</td><td>${row.reduction==null?'―':`${row.reduction}%`}</td><td>${row.before}/${row.after}</td></tr>`).join('')}</tbody></table><h2>安全性</h2><p>安全事象 ${safety.length}件、重大 ${serious}件、未解決 ${open}件、患者取り違え ${safety.filter(item=>item.category==='PATIENT_MISMATCH').length}件</p><h2>利用者合意</h2><p>回答 ${feedback.length}人、継続意向 ${agreement}%、回答職種 ${esc([...new Set(feedback.map(item=>item.staffRole).filter(Boolean))].join('・')||'未回答')}</p><h2>最終確認欄</h2><p>病院責任者：________________　情報管理部門：________________　現場代表：________________</p><p class="meta">対象範囲、試行期間、測定条件、未解決課題、再発防止策を確認して本導入を判断してください。</p></body></html>`;
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(html);return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fim-import') {
      const body = await readJson(req); const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
      let imported = 0; const errors = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]; const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.facilityPatientId === safeText(row.facilityPatientId, 100));
        if (!patient) { errors.push({ row: index + 2, error: '患者IDが見つかりません' }); continue; }
        const normalized = normalizeFimAssessment({ ...row, scores: Object.fromEntries(fimItems.map(key => [key, row[key]])) });
        if (!normalized.evaluationDate) { errors.push({ row: index + 2, error: '評価日が不正です' }); continue; }
        const timestamp = now(); db.fimAssessments.push({ id: id('fim'), tenantId: identity.tenantId, patientId: patient.id, patientLabel: `${patient.facilityPatientId}｜${patient.name}`, ...normalized, createdAt: timestamp, updatedAt: timestamp, createdBy: safeText(identity.hospitalName || identity.userId, 200), revisions: [], importSource: 'CSV' }); imported += 1;
      }
      if (imported) await persist(); return sendJson(res, 200, { imported, errors });
    }
    if (req.method === 'POST' && url.pathname === '/api/fim-assessments') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const normalized = normalizeFimAssessment(body);
      if (!normalized.evaluationDate) return sendJson(res, 400, { error: '評価日を入力してください' });
      const timestamp = now();
      const assessment = { id: id('fim'), tenantId: identity.tenantId, patientId: patient.id, patientLabel: `${patient.facilityPatientId}｜${patient.name}`, ...normalized, createdAt: timestamp, updatedAt: timestamp, createdBy: safeText(identity.hospitalName || identity.userId, 200), revisions: [] };
      db.fimAssessments.push(assessment); await persist(); return sendJson(res, 201, assessment);
    }
    const fimAssessmentMatch = /^\/api\/fim-assessments\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && fimAssessmentMatch) {
      const assessment = db.fimAssessments.find(item => item.tenantId === identity.tenantId && item.id === fimAssessmentMatch[1]);
      if (!assessment) return sendJson(res, 404, { error: 'FIM評価が見つかりません' });
      const body = await readJson(req); const timestamp = now(); assessment.revisions = Array.isArray(assessment.revisions) ? assessment.revisions : []; assessment.revisions.push({ at: timestamp, by: safeText(identity.hospitalName || identity.userId, 200), data: normalizeFimAssessment(assessment) }); Object.assign(assessment, normalizeFimAssessment(body, assessment), { updatedAt: timestamp, updatedBy: safeText(identity.hospitalName || identity.userId, 200) }); await persist(); return sendJson(res, 200, assessment);
    }
    if (req.method === 'PUT' && url.pathname === '/api/outcome-goals') {
      const body = await readJson(req);
      const goal = db.outcomeGoals.find(item => item.tenantId === identity.tenantId && item.key === safeText(body.key, 80));
      const target = Number(body.target);
      if (!goal || !Number.isFinite(target) || target < 0 || target > 1000) return sendJson(res, 400, { error: '目標値を確認してください' });
      goal.target = target; goal.targetType = 'HOSPITAL_DEFINED'; goal.updatedAt = now(); goal.updatedBy = safeText(identity.hospitalName || identity.userId, 200);
      await persist();
      return sendJson(res, 200, goal);
    }
    if (req.method === 'POST' && url.pathname === '/api/outcome-snapshots') {
      const body = await readJson(req);
      const period = /^\d{4}-\d{2}$/.test(String(body.period || '')) ? body.period : '';
      if (!period) return sendJson(res, 400, { error: '集計月を入力してください' });
      const values = Object.fromEntries(outcomeGoalTemplates.flatMap(template => {
        const value = Number(body.values?.[template.key]);
        return Number.isFinite(value) && value >= 0 ? [[template.key, value]] : [];
      }));
      let snapshot = db.outcomeSnapshots.find(item => item.tenantId === identity.tenantId && item.period === period);
      if (!snapshot) { snapshot = { id: id('outcome-snapshot'), tenantId: identity.tenantId, period, createdAt: now() }; db.outcomeSnapshots.push(snapshot); }
      Object.assign(snapshot, { values, note: safeText(body.note, 2000), dataType: body.dataType === 'SAMPLE' ? 'SAMPLE' : 'HOSPITAL_ACTUAL', updatedAt: now(), updatedBy: safeText(identity.hospitalName || identity.userId, 200) });
      await persist();
      return sendJson(res, 200, snapshot);
    }
    if (req.method === 'POST' && url.pathname === '/api/outcome-actions') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      const title = safeText(body.title, 500);
      if (!patient || !title) return sendJson(res, 400, { error: '患者と対応内容を入力してください' });
      const timestamp = now();
      const action = { id: id('outcome-action'), tenantId: identity.tenantId, patientId: patient.id, patientLabel: `${patient.facilityPatientId}｜${patient.name}`, title, owner: safeText(body.owner, 200), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || '')) ? body.dueDate : '', category: ['FIM','PLAN','DISCHARGE','FAMILY','RISK','OTHER'].includes(body.category) ? body.category : 'OTHER', status: 'OPEN', createdAt: timestamp, updatedAt: timestamp };
      db.outcomeActions.push(action); await persist(); return sendJson(res, 201, action);
    }
    const outcomeActionMatch = /^\/api\/outcome-actions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && outcomeActionMatch) {
      const action = db.outcomeActions.find(item => item.tenantId === identity.tenantId && item.id === outcomeActionMatch[1]);
      if (!action) return sendJson(res, 404, { error: '対応項目が見つかりません' });
      const body = await readJson(req); action.status = body.status === 'DONE' ? 'DONE' : 'OPEN'; action.completedAt = action.status === 'DONE' ? now() : null; action.updatedAt = now(); await persist(); return sendJson(res, 200, action);
    }
    if (req.method === 'GET' && url.pathname === '/api/rehab-plan-context') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      const context = db.rehabPlanContexts.find(item => item.tenantId === identity.tenantId && item.patientId === patientId);
      return sendJson(res, 200, context || { patientId, ...normalizedRehabPlanContext({}), updatedAt: null });
    }
    if (req.method === 'PUT' && url.pathname === '/api/rehab-plan-context') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const timestamp = now();
      let context = db.rehabPlanContexts.find(item => item.tenantId === identity.tenantId && item.patientId === patient.id);
      if (!context) {
        context = { id: id('rehab-plan-context'), tenantId: identity.tenantId, patientId: patient.id, createdAt: timestamp };
        db.rehabPlanContexts.push(context);
      }
      Object.assign(context, normalizedRehabPlanContext(body, context), { updatedAt: timestamp, updatedBy: safeText(identity.hospitalName || identity.userId, 200) });
      await persist();
      return sendJson(res, 200, context);
    }
    if (req.method === 'GET' && url.pathname === '/api/rehab-plans/source') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      return sendJson(res, 200, rehabPlanSource(patient, identity.tenantId));
    }
    if (req.method === 'POST' && url.pathname === '/api/rehab-plans/generate') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: 'OPENAI_API_KEYが設定されていません' });
      try {
        const plan = await generateRehabPlan(apiKey, rehabPlanSource(patient, identity.tenantId));
        return sendJson(res, 200, { plan, generatedAt: now(), status: 'AI_DRAFT', saved: false });
      } catch (error) {
        return sendJson(res, 502, { error: `AI計画を作成できませんでした: ${safeText(error.message, 500)}` });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/rehab-plans') {
      const body = await readJson(req);
      const patient = db.patients.find(item => item.tenantId === identity.tenantId && item.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const timestamp = now();
      const existingPlans = db.rehabPlans.filter(plan => plan.tenantId === identity.tenantId && plan.patientId === patient.id);
      const plan = {
        id: id('rehab-plan'), tenantId: identity.tenantId, patientId: patient.id,
        patientLabel: `${patient.facilityPatientId}｜${patient.name}`,
        version: Math.max(0, ...existingPlans.map(item => Number(item.version) || 0)) + 1,
        status: body.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT',
        ...normalizedRehabPlan(body),
        createdBy: safeText(body.createdBy || identity.hospitalName || identity.userId, 200),
        confirmedBy: body.status === 'CONFIRMED' ? safeText(body.createdBy || identity.hospitalName || identity.userId, 200) : '',
        confirmedAt: body.status === 'CONFIRMED' ? timestamp : null,
        createdAt: timestamp, updatedAt: timestamp, revisions: [],
      };
      db.rehabPlans.push(plan);
      await persist();
      return sendJson(res, 201, publicRehabPlan(plan));
    }
    const rehabPlanMatch = /^\/api\/rehab-plans\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && rehabPlanMatch) {
      const plan = db.rehabPlans.find(item => item.tenantId === identity.tenantId && item.id === rehabPlanMatch[1]);
      if (!plan) return sendJson(res, 404, { error: 'リハビリ計画書が見つかりません' });
      const body = await readJson(req);
      const timestamp = now();
      plan.revisions = Array.isArray(plan.revisions) ? plan.revisions : [];
      plan.revisions.push({ at: timestamp, by: safeText(body.updatedBy || identity.hospitalName || identity.userId, 200), status: plan.status, data: normalizedRehabPlan(plan) });
      Object.assign(plan, normalizedRehabPlan(body, plan));
      plan.status = body.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT';
      plan.confirmedBy = plan.status === 'CONFIRMED' ? safeText(body.updatedBy || identity.hospitalName || identity.userId, 200) : '';
      plan.confirmedAt = plan.status === 'CONFIRMED' ? timestamp : null;
      plan.updatedAt = timestamp;
      await persist();
      return sendJson(res, 200, publicRehabPlan(plan));
    }
    if (req.method === 'DELETE' && rehabPlanMatch) {
      const index = db.rehabPlans.findIndex(item => item.tenantId === identity.tenantId && item.id === rehabPlanMatch[1]);
      if (index < 0) return sendJson(res, 404, { error: 'リハビリ計画書が見つかりません' });
      const [deleted] = db.rehabPlans.splice(index, 1);
      await persist();
      return sendJson(res, 200, { deletedId: deleted.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/rehab-records') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      const records = db.rehabRecords
        .filter(record => record.tenantId === identity.tenantId && record.patientId === patientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(publicRehabRecord);
      return sendJson(res, 200, records);
    }
    if (req.method === 'GET' && url.pathname === '/api/patients/pre-rehab-summary') {
      const patientId = safeText(url.searchParams.get('patientId'));
      const patient = db.patients.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === patientId);
      if (!patient) return sendJson(res, 404, { error: '患者が見つかりません' });
      const patientJobs = db.jobs.filter(job => job.tenantId === identity.tenantId && job.patientId === patientId);
      const records = db.rehabRecords.filter(record => record.tenantId === identity.tenantId && record.patientId === patientId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latestRecord = records[0] || null;
      const latestEvaluation = patientJobs.filter(job => job.result).sort((a, b) => jobClinicalSortKey(b).localeCompare(jobClinicalSortKey(a)))[0] || null;
      return sendJson(res, 200, {
        patient: publicPatient(patient, identity.tenantId),
        latestRecord: latestRecord ? publicRehabRecord(latestRecord) : null,
        pendingApprovalCount: records.filter(record => record.approvalStatus === 'PENDING').length,
        trends: patientTrend(patientJobs),
        ocrReview: ocrReviewSummary(patientJobs),
        latestEvaluationDate: latestEvaluation ? jobEvaluationDate(latestEvaluation) : '',
        latestEvaluationRecordedAt: latestEvaluation?.createdAt || null,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/rehab-records') {
      const body = await readJson(req);
      const patient = db.patients.find(candidate => candidate.tenantId === identity.tenantId && candidate.id === body.patientId);
      if (!patient) return sendJson(res, 400, { error: '患者を選択してください' });
      const intervention = safeText(body.intervention, 4000);
      const outcome = safeText(body.outcome, 4000);
      if (!intervention || !outcome) return sendJson(res, 400, { error: '実施内容と実施後所見は必須です' });
      const timestamp = now();
      const therapistName = safeText(body.therapistName || identity.hospitalName || identity.userId, 200);
      const record = {
        id: id('rehab'), tenantId: identity.tenantId, patientId: patient.id,
        evaluationJobId: db.jobs.some(job => job.tenantId === identity.tenantId && job.patientId === patient.id && job.id === body.evaluationJobId) ? body.evaluationJobId : null,
        recordType: ['INITIAL', 'FOLLOW_UP', 'DISCHARGE'].includes(body.recordType) ? body.recordType : 'FOLLOW_UP',
        therapistName,
        preCondition: safeText(body.preCondition, 2000), intervention,
        durationMinutes: Number.isFinite(Number(body.durationMinutes)) ? Math.max(0, Math.min(1440, Number(body.durationMinutes))) : null,
        assistanceLevel: safeText(body.assistanceLevel, 100),
        painBefore: Number.isFinite(Number(body.painBefore)) ? Math.max(0, Math.min(10, Number(body.painBefore))) : null,
        painAfter: Number.isFinite(Number(body.painAfter)) ? Math.max(0, Math.min(10, Number(body.painAfter))) : null,
        fatigueBefore: Number.isFinite(Number(body.fatigueBefore)) ? Math.max(0, Math.min(10, Number(body.fatigueBefore))) : null,
        fatigueAfter: Number.isFinite(Number(body.fatigueAfter)) ? Math.max(0, Math.min(10, Number(body.fatigueAfter))) : null,
        outcome, nextPlan: safeText(body.nextPlan, 2000), riskNotes: safeText(body.riskNotes, 2000),
        approvalStatus: 'APPROVED',
        approvedBy: therapistName,
        approvedAt: timestamp,
        createdAt: timestamp, updatedAt: timestamp, revisions: [],
      };
      db.rehabRecords.push(record);
      await persist();
      return sendJson(res, 201, publicRehabRecord(record));
    }
    const deleteRehabRecordMatch = /^\/api\/rehab-records\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && deleteRehabRecordMatch) {
      const index = db.rehabRecords.findIndex(record => record.tenantId === identity.tenantId && record.id === deleteRehabRecordMatch[1]);
      if (index < 0) return sendJson(res, 404, { error: '経過記録が見つかりません' });
      const [deletedRecord] = db.rehabRecords.splice(index, 1);
      await persist();
      return sendJson(res, 200, { deletedId: deletedRecord.id, patientId: deletedRecord.patientId });
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
      const sourceFileName = safeText(body.fileName, 240);
      const pageNumber = Math.max(0, Math.min(99, Number(body.pageNumber) || 0)) || null;
      const ocrRoute = inferOcrRoute(sourceFileName, pageNumber);
      const evaluationDateOverride = /^\d{4}-\d{2}-\d{2}$/.test(String(body.evaluationDateOverride || '')) ? String(body.evaluationDateOverride) : '';
      const therapistName = safeText(body.therapistName || identity.hospitalName || identity.userId, 200);
      const job = { id: jobId, tenantId: identity.tenantId, patientId: patient.id, therapistName, evaluationType: ocrRoute.testType ? '帳票確認中' : '帳票判定中', status: 'REQUEST', imageFile, imageType: image.mime, sourceFileName, pageNumber, evaluationDateOverride, ocrRoute, result: null, confirmedResult: null, error: null, createdAt: now(), updatedAt: now(), confirmedAt: null };
      db.jobs.push(job); await persist(); setImmediate(() => runOcr(job.id)); return sendJson(res, 202, jobView(job));
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && jobMatch) {
        const jobIndex = db.jobs.findIndex(job => job.tenantId === identity.tenantId && job.id === jobMatch[1]);
        if (jobIndex < 0) return sendJson(res, 404, { error: 'OCR履歴が見つかりません' });
        const [job] = db.jobs.splice(jobIndex, 1);
        activeOcrControllers.get(job.id)?.abort(new Error('OCR history deleted by user'));
        activeOcrControllers.delete(job.id);
        await deleteImage(job.imageFile);
        await persist();
        return sendJson(res, 200, { ok: true, deletedId: job.id });
      }
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
        .sort((a, b) => jobClinicalSortKey(b).localeCompare(jobClinicalSortKey(a)));
      const latestAssessmentKey = sameSheetJobs[0]?.assessmentGroupId || sameSheetJobs[0]?.id;
      if ((job.assessmentGroupId || job.id) !== latestAssessmentKey) return sendJson(res, 409, { error: '評価実施日が最新のシートだけを退院にできます' });
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
      const previousJobs = db.jobs.filter(candidate => candidate.tenantId === identity.tenantId && candidate.patientId === job.patientId && candidate.evaluationType === job.evaluationType && candidate.id !== job.id && candidate.result && (!job.assessmentGroupId || candidate.assessmentGroupId !== job.assessmentGroupId) && jobClinicalSortKey(candidate) < jobClinicalSortKey(job));
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
      job.familySummary = safeText(body.familySummary, 4000);
      job.patientSummary = safeText(body.patientSummary, 4000);
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
      const summaries = await generateDischargeSummary(apiKey, job);
      return sendJson(res, 200, summaries);
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
    if (req.method === 'GET' && url.pathname === '/api/admin/backup-status') {
      if (identity.role !== 'ADMIN') return sendJson(res, 403, { error: '管理者権限が必要です' }); const names=(await readdir(backupDir,{withFileTypes:true})).filter(item=>item.isDirectory()&&item.name.startsWith('backup-')).map(item=>item.name).sort().reverse();const backups=[];for(const name of names.slice(0,10)){try{const manifest=JSON.parse(await readFile(path.join(backupDir,name,'manifest.json'),'utf8'));backups.push({name,createdAt:manifest.createdAt,encrypted:manifest.encrypted===true,facilityId:manifest.facilityId});}catch{backups.push({name,createdAt:null,encrypted:null,invalidManifest:true});}}return sendJson(res,200,{backupDirectoryConfigured:Boolean(backupDir),count:names.length,latest:backups[0]||null,backups,restorePolicy:'復元はサービス停止、対象バックアップ確認、現行データ退避後に管理者が実施します。画面からの自動復元は行いません。'});
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
