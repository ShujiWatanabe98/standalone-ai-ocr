import assert from 'node:assert/strict';
import { applyKnownSltaLabels, buildBbsRetryPrompt, buildBitPage1Prompt, buildBitPage2Prompt, buildBitRetryPrompt, buildCatRPagePrompt, buildFmaLowerRetryPrompt, buildFmaUpperRetryPrompt, buildRehainfoOcrPrompt, buildRoutedOcrPrompt, buildSltaProblemResponseRetryPrompt, buildStefRetryPrompt, buildTargetedRetryPrompt, buildWaisIvPagePrompt, inferOcrRoute, normalizeRehainfoResult } from '../rehainfo-ocr-definitions.mjs';

const prompt = buildRehainfoOcrPrompt();
for (const type of ['FMA_1', 'FMA_2', 'BBS', 'KOHS_1', 'STEF', 'SLTA_ALL', 'BIT', 'CAT_R_ALL', 'WAIS_IV_ALL', 'WMSR_ALL']) assert.ok(prompt.includes(type));
assert.match(buildBitRetryPrompt(), /手書きした数字だけ/);
assert.match(buildBitRetryPrompt(), /写真課題/);
assert.match(buildBitRetryPrompt(), /音読課題/);
const bitPage1Prompt = buildBitPage1Prompt();
assert.match(bitPage1Prompt, /線分抹消試験：6つの結果セル/);
assert.match(bitPage1Prompt, /文章抹消試験：4つの結果セル/);
assert.match(bitPage1Prompt, /星印抹消試験：6つの結果セル/);
assert.match(bitPage1Prompt, /模写試験：（1）の3セル、（2）の1セル/);
assert.match(bitPage1Prompt, /線分二等分試験：3つの結果セル/);
assert.match(bitPage1Prompt, /描画試験：3つの結果セル/);
assert.equal((bitPage1Prompt.match(/"id":"BIT_1_\d+"/g) || []).length, 32);
assert.match(buildRoutedOcrPrompt('BIT', 1), /BIT_1_31/);
const bitPage2Prompt = buildBitPage2Prompt();
assert.equal((bitPage2Prompt.match(/"id":"BIT_2_\d+"/g) || []).length, 29);
assert.match(bitPage2Prompt, /写真1 見落とし数/);
assert.match(bitPage2Prompt, /写真2 評価点/);
assert.match(bitPage2Prompt, /写真3 評価点/);
assert.match(bitPage2Prompt, /電話課題 誤反応数/);
assert.match(bitPage2Prompt, /メニュー課題 得点/);
assert.match(bitPage2Prompt, /音読課題 読み落とし数/);
assert.match(bitPage2Prompt, /時計課題 誤反応数/);
assert.match(bitPage2Prompt, /効果課題 見落とし数/);
assert.match(bitPage2Prompt, /書写課題 書き落し数/);
assert.match(bitPage2Prompt, /地図課題 誤反応数/);
assert.match(bitPage2Prompt, /トランプ課題 見落し数/);
assert.match(buildRoutedOcrPrompt('BIT', 2), /BIT_2_28/);
assert.equal((buildCatRPagePrompt(1).match(/"id":"CAT_R_1_\d+"/g) || []).length, 4);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 1), /Digit Span Forward/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 1), /Tapping Span Backward/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 1), /「sec」「秒」「%」「桁」「桁数」などの単位/);
const normalizedCatRPage1 = normalizeRehainfoResult({
  testType: 'CAT_R_ALL',
  fields: [{ id: 'CAT_R_1_0', label: 'Digit Span Forward', value: '４桁', x: 50, y: 50 }],
});
assert.equal(normalizedCatRPage1.fields[0].value, '4');
const normalizedCatRUnits = normalizeRehainfoResult({
  testType: 'CAT_R_ALL',
  fields: [
    { id: 'CAT_R_2_24', label: '下の表 a図形△ 所要時間', value: '46 sec.' },
    { id: 'CAT_R_3_1', label: '下の表 正答率', value: '86%' },
    { id: 'CAT_R_3_2', label: '下の表 全正答数', value: '43/50' },
    { id: 'CAT_R_5_3', label: '一番下の表 1秒条件 正答率', value: '65.0％' },
  ],
});
assert.deepEqual(normalizedCatRUnits.fields.map(field => field.value), ['46', '86', '43', '65.0']);
assert.equal((buildCatRPagePrompt(2).match(/"id":"CAT_R_2_\d+"/g) || []).length, 28);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /a図形△ 6行目 正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /c数字3 6行目 正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /d仮名か 6行目 正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /下の表 d仮名か 所要時間/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /ページ中央にある表から、a図形△、b図形、c数字3、d仮名かの各1〜6行目/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 2), /「a図形△ 正答数」行とそれより下/);
const normalizedCatRPage2 = normalizeRehainfoResult({
  testType: 'CAT_R_ALL',
  fields: [
    { id: 'CAT_R_2_27', label: '下の表 d仮名か 所要時間', value: '80' },
    { id: 'CAT_R_2_28', label: '視覚性抹消課題 a図形△ 正答数', value: '57' },
    { id: 'CAT_R_2_32', label: '視覚性抹消課題 d仮名か False Positive', value: '1' },
  ],
});
assert.deepEqual(normalizedCatRPage2.fields.map(field => field.id), ['CAT_R_2_27']);
assert.equal((buildCatRPagePrompt(3).match(/"id":"CAT_R_3_\d+"/g) || []).length, 6);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 3), /下の表 全正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 3), /下の表 False Negative/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 3), /下の表 False Positive/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 3), /1段目の「全正答数、正答率、False Negative」、2段目の「全反応数、的中率、False Positive」/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 3), /「聴覚性検出課題 セット1 正答数」から「聴覚性検出課題 セット5 fp」まで/);
const normalizedCatRPage3 = normalizeRehainfoResult({
  testType: 'CAT_R_ALL',
  fields: [
    { id: 'CAT_R_3_0', label: '聴覚性検出課題 セット1 正答数', value: '10' },
    { id: 'CAT_R_3_2', label: '聴覚性検出課題 セット5 fp', value: '4' },
    { id: 'CAT_R_3_1', label: '下の表 全正答数', value: '43/50' },
  ],
});
assert.deepEqual(normalizedCatRPage3.fields.map(field => field.label), ['下の表 全正答数']);
assert.equal((buildCatRPagePrompt(4).match(/"id":"CAT_R_4_\d+"/g) || []).length, 4);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 4), /2スパンの上の表 3スパン 正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 4), /2スパンの上の表 4スパン 正答率/);
assert.equal((buildCatRPagePrompt(5).match(/"id":"CAT_R_5_\d+"/g) || []).length, 4);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 5), /一番下の表 2秒条件 正答数/);
assert.match(buildRoutedOcrPrompt('CAT_R_ALL', 5), /一番下の表 1秒条件 正答率/);
assert.equal((buildWaisIvPagePrompt(1).match(/"id":"WAIS_IV_1_\d+"/g) || []).length, 20);
assert.equal((buildWaisIvPagePrompt(4).match(/"id":"WAIS_IV_4_\d+"/g) || []).length, 28);
assert.equal((buildWaisIvPagePrompt(8).match(/"id":"WAIS_IV_8_\d+"/g) || []).length, 52);
assert.equal((buildWaisIvPagePrompt(11).match(/"id":"WAIS_IV_11_\d+"/g) || []).length, 60);
assert.match(buildRoutedOcrPrompt('WAIS_IV_ALL', 4), /数値と英字を空白なしで連結/);
assert.match(buildRoutedOcrPrompt('WAIS_IV_ALL', 8), /所要時間と回答だけを読む/);
const normalizedWais = normalizeRehainfoResult({
  testType: 'WAIS_IV_ALL',
  fields: [
    { id: 'WAIS_IV_1_0', label: '練習 第1試行 所要時間', value: '46 sec.' },
    { id: 'WAIS_IV_4_0', label: '練習A 回答', value: '3 A' },
    { id: 'WAIS_IV_8_1', label: '項目1 回答', value: '2-DK' },
    { id: 'WAIS_IV_11_0', label: '回答1 所要時間', value: '12秒' },
  ],
});
assert.deepEqual(normalizedWais.fields.map(field => field.value), ['46', '3A', '2DK', '12']);
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

for (const [testType, validId, invalidId, documentType] of [
  ['CAT_R_ALL', 'CAT_R_5_3', 'CAT_R_6_0', 'CAT-R（標準注意検査法）'],
  ['WAIS_IV_ALL', 'WAIS_IV_13_2', 'WAIS_IV_14_0', 'WAIS-IV（ウェクスラー成人知能検査）'],
  ['WMSR_ALL', 'WMSR_9_4', 'WMSR_10_0', 'WMS-R（ウェクスラー記憶検査）'],
]) {
  const normalized = normalizeRehainfoResult({
    testType,
    fields: [
      { id: validId, label: '印刷項目名', value: '12', confidence: 0.9, x: 45, y: 60 },
      { id: invalidId, label: '対象外', value: '99' },
    ],
  });
  assert.equal(normalized.documentType, documentType);
  assert.equal(normalized.fields.length, 1);
  assert.equal(normalized.fields[0].id, validId);
  assert.equal(normalized.fields[0].value, '12');
}

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

assert.deepEqual(inferOcrRoute('CAT-R08.pdf（3ページ）'), { testType: 'CAT_R_ALL', page: 3 });
assert.deepEqual(inferOcrRoute('FMALE_ケース07.jpeg'), { testType: 'FMA_2', page: null });
assert.deepEqual(inferOcrRoute('WAIS-IV09.pdf', 12), { testType: 'WAIS_IV_ALL', page: 12 });
assert.match(buildRoutedOcrPrompt('WMSR_ALL', 4), /WMSR_4_0/);
assert.match(buildTargetedRetryPrompt({ testType: 'BBS', documentType: 'BBS', fields: [{ id: '#1', label: '項目', value: '' }] }, ['#1']), /"#1"/);

console.log('rehainfo OCR definitions test: OK');
