import assert from 'node:assert/strict';
import { applyKnownSltaLabels, buildBbsRetryPrompt, buildBitRetryPrompt, buildFmaLowerRetryPrompt, buildFmaUpperRetryPrompt, buildRehainfoOcrPrompt, buildSltaProblemResponseRetryPrompt, buildStefRetryPrompt, normalizeRehainfoResult } from '../rehainfo-ocr-definitions.mjs';

const prompt = buildRehainfoOcrPrompt();
for (const type of ['FMA_1', 'FMA_2', 'BBS', 'KOHS_1', 'STEF', 'SLTA_ALL', 'BIT']) assert.ok(prompt.includes(type));
assert.match(buildBitRetryPrompt(), /手書きした数字だけ/);
assert.match(buildBitRetryPrompt(), /写真課題/);
assert.match(buildBitRetryPrompt(), /音読課題/);
assert.match(buildFmaLowerRetryPrompt(), /FMA）下肢機能/);
assert.match(buildFmaLowerRetryPrompt(), /右端にある「結果」列/);
assert.match(buildFmaLowerRetryPrompt(), /左側の「評価項目」列/);
assert.match(buildFmaLowerRetryPrompt(), /「結果 #0」のような連番名は禁止/);
assert.match(buildFmaLowerRetryPrompt(), /印刷された0〜16/);
assert.match(buildBbsRetryPrompt(), /同じ行の手書き点数と対応付け/);
assert.match(buildBbsRetryPrompt(), /空のlabelは禁止/);
assert.match(buildStefRetryPrompt(), /行見出しの「検査1〜10」/);
assert.match(buildStefRetryPrompt(), /列見出しの「右」「左」/);
assert.match(buildStefRetryPrompt(), /「検査1 右 所要時間」/);
assert.match(buildSltaProblemResponseRetryPrompt(), /すべてのページで「問題および反応」欄/);
assert.match(buildSltaProblemResponseRetryPrompt(), /SLTA_1_TEXT_0/);
assert.match(buildSltaProblemResponseRetryPrompt(), /SLTA_4_TEXT_0/);
assert.match(buildSltaProblemResponseRetryPrompt(), /SLTA_12_TEXT_0/);
assert.match(buildSltaProblemResponseRetryPrompt(), /「6段階評価」「正答数」「所要時間」だけの汎用的なlabelは禁止/);
const sltaRelabelPrompt = buildSltaProblemResponseRetryPrompt([{ id: '#0', label: '6段階評価', value: '5', x: 82, y: 30 }]);
assert.match(sltaRelabelPrompt, /「①卵」/);
assert.match(sltaRelabelPrompt, /"id":"#0"/);
assert.match(sltaRelabelPrompt, /"value":"5"/);
assert.match(buildFmaUpperRetryPrompt(), /FMA）上肢機能/);
assert.match(buildFmaUpperRetryPrompt(), /左側の「評価項目」列/);
assert.match(buildFmaUpperRetryPrompt(), /上から順に33個/);
assert.match(buildFmaUpperRetryPrompt(), /「結果 #0」のような連番名/);
assert.match(prompt, /用紙へ印刷されている実際の評価項目名/);

const fma = normalizeRehainfoResult({ testType: 'FMA_1', fields: [{ id: '#0', value: '2' }, { id: '#1', value: '9' }] });
assert.equal(fma.fields.length, 33);
assert.equal(fma.fields[0].value, '2');
assert.equal(fma.fields[1].value, '');
assert.equal(fma.documentType, 'Fugl-Meyer Assessment（FMA）上肢');

const fmaWithLabels = normalizeRehainfoResult({ testType: 'FMA_1', fields: [{ id: '#0', label: '肩関節 屈曲共同運動', value: '2' }] });
assert.equal(fmaWithLabels.fields[0].label, '肩関節 屈曲共同運動');

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

const sltaPage1Text = normalizeRehainfoResult({ testType: 'SLTA_ALL', fields: [
  { id: '#0', label: '6段階評価', value: '5' },
  { id: 'SLTA_1_TEXT_0', label: '問題および反応 1', value: '犬が走っています' },
  { id: 'SLTA_2_TEXT_0', label: '2ページ 問題および反応 1', value: '鉛筆です' },
  { id: 'SLTA_3_TEXT_0', label: '3ページ 問題および反応 1', value: '本を読みます' },
  { id: 'SLTA_10_TEXT_0', label: '10ページ 問題および反応 1', value: '昨日学校へ行きました' },
  { id: 'SLTA_12_TEXT_0', label: '12ページ 問題および反応 1', value: '文章を書きます' },
] });
assert.equal(sltaPage1Text.fields.length, 6);
assert.equal(sltaPage1Text.fields[1].value, '犬が走っています');
assert.equal(sltaPage1Text.fields[2].value, '鉛筆です');
assert.equal(sltaPage1Text.fields[3].value, '本を読みます');
assert.equal(sltaPage1Text.fields[4].value, '昨日学校へ行きました');
assert.equal(sltaPage1Text.fields[5].value, '文章を書きます');

const sltaPage1Labeled = applyKnownSltaLabels(normalizeRehainfoResult({
  testType: 'SLTA_ALL',
  fields: [
    { id: '#0', label: '6段階評価', value: '5' },
    { id: '#1', label: '6段階評価', value: '3' },
    { id: '#9', label: '6段階評価', value: '1' },
    { id: '#11', label: '6段階評価', value: '6' },
    { id: '#20', label: '6段階評価', value: '5' },
  ],
}));
assert.deepEqual(sltaPage1Labeled.fields.map(field => field.label), [
  '①卵',
  '②馬',
  '⑩家',
  '①生徒が先生に賞状をもらっている',
  '⑩女の子が男の子になぐられている',
]);

const sltaAllPagesLabeled = applyKnownSltaLabels(normalizeRehainfoResult({
  testType: 'SLTA_ALL',
  fields: ['#22', '#44', '#65', '#87', '#94', '#112', '#124', '#146', '#168', '#192', '#204', '#213']
    .map(id => ({ id, label: '6段階評価', value: '5' })),
}));
assert.deepEqual(sltaAllPagesLabeled.fields.map(field => field.label), [
  '①歯ブラシと鉛筆を持ってください',
  '①本',
  '①馬',
  'まんがの説明',
  '語数',
  '①いぬ',
  '①馬',
  '①生徒が先生に賞状をもらっている',
  '①犬',
  '①本',
  '①川に落ちました',
  '計算 正答数4',
]);

console.log('rehainfo OCR definitions test: OK');
