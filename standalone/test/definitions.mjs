import assert from 'node:assert/strict';
import { buildBitRetryPrompt, buildFmaLowerRetryPrompt, buildRehainfoOcrPrompt, normalizeRehainfoResult } from '../rehainfo-ocr-definitions.mjs';

const prompt = buildRehainfoOcrPrompt();
for (const type of ['FMA_1', 'FMA_2', 'BBS', 'KOHS_1', 'STEF', 'SLTA_ALL', 'BIT']) assert.ok(prompt.includes(type));
assert.match(buildBitRetryPrompt(), /手書きした数字だけ/);
assert.match(buildBitRetryPrompt(), /写真課題/);
assert.match(buildBitRetryPrompt(), /音読課題/);
assert.match(buildFmaLowerRetryPrompt(), /FMA）下肢機能/);
assert.match(buildFmaLowerRetryPrompt(), /右端にある「結果」列/);
assert.match(buildFmaLowerRetryPrompt(), /印刷された0〜16/);

const fma = normalizeRehainfoResult({ testType: 'FMA_1', fields: [{ id: '#0', value: '2' }, { id: '#1', value: '9' }] });
assert.equal(fma.fields.length, 33);
assert.equal(fma.fields[0].value, '2');
assert.equal(fma.fields[1].value, '');
assert.equal(fma.documentType, 'Fugl-Meyer Assessment（FMA）上肢');

const stef = normalizeRehainfoResult({ testType: 'STEF', fields: [{ id: 'time_0', value: '12.34' }, { id: 'num_0', value: '2' }, { id: 'other', value: '対象外' }] });
assert.equal(stef.fields.length, 40);
assert.equal(stef.fields.some(field => field.id === 'other'), false);

const bbsAliases = normalizeRehainfoResult({ testType: 'BBS', fields: [{ id: 'No.0', value: '4' }, { id: 'BBS_7', value: '3' }, { id: 'result-13', value: '1' }] });
assert.equal(bbsAliases.fields[0].value, '4');
assert.equal(bbsAliases.fields[7].value, '3');
assert.equal(bbsAliases.fields[13].value, '1');

const bbsOrdered = normalizeRehainfoResult({ testType: 'BBS', fields: [{ id: 'left first', value: '2' }, { id: 'left second', value: '3' }] });
assert.equal(bbsOrdered.fields[0].value, '2');
assert.equal(bbsOrdered.fields[1].value, '3');

const unsupported = normalizeRehainfoResult({ testType: 'UNKNOWN', fields: [{ id: 'name', value: '患者名' }] });
assert.equal(unsupported.testType, 'UNSUPPORTED');
assert.equal(unsupported.fields.length, 0);

const noUnderscores = normalizeRehainfoResult({ testType: 'BBS', fields: [{ id: '#0', value: '__2＿' }] });
assert.equal(noUnderscores.fields[0].value, '2');

console.log('rehainfo OCR definitions test: OK');
