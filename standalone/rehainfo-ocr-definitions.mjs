const indexed = (count, label, allowedValues = null) => Array.from({ length: count }, (_, index) => ({
  id: `#${index}`,
  label: `${label} #${index}`,
  allowedValues,
}));

export const REHAINFO_OCR_DEFINITIONS = {
  FMA_1: {
    documentType: 'Fugl-Meyer Assessment（FMA）上肢',
    fields: indexed(33, '結果', ['0', '1', '2', '']),
    instruction: '右端の「結果」列の#0〜#32だけを上から順に読み取る。値は0、1、2、空欄のみ。',
  },
  FMA_2: {
    documentType: 'Fugl-Meyer Assessment（FMA）下肢',
    fields: indexed(17, '結果', ['0', '1', '2', '']),
    instruction: '右端の「結果」列の#0〜#16だけを上から順に読み取る。値は0、1、2、空欄のみ。',
  },
  BBS: {
    documentType: 'Berg Balance Scale（BBS）',
    fields: indexed(14, '結果', ['0', '1', '2', '3', '4', '']),
    instruction: 'No.0〜13の14行にある「結果」列だけを読み取る。値は0〜4、空欄のみ。',
  },
  KOHS_1: {
    documentType: 'コース立方体組み合わせテスト記録用紙',
    fields: Array.from({ length: 17 }, (_, index) => ({ id: `test_${index + 1}`, label: `テスト${index + 1}　所要時間（秒）`, allowedValues: null })),
    instruction: 'テスト1〜17の「所要時間」列だけを読み取る。M.NNは分秒として秒数の整数に変換。空欄は空文字。',
  },
  STEF: {
    documentType: 'STEF（簡易上肢機能検査）',
    fields: [
      ...Array.from({ length: 20 }, (_, index) => ({ id: `time_${index}`, label: `検査${Math.floor(index / 2) + 1} ${index % 2 === 0 ? '右' : '左'}　所要時間`, allowedValues: null })),
      ...Array.from({ length: 20 }, (_, index) => ({ id: `num_${index}`, label: `検査${Math.floor(index / 2) + 1} ${index % 2 === 0 ? '右' : '左'}　時間外個数`, allowedValues: null })),
    ],
    instruction: '検査1〜10の右・左それぞれの「所要時間」と「時間外個数」の2列だけを読み取る。その他は対象外。',
  },
  SLTA_ALL: {
    documentType: 'SLTA（標準失語症検査）',
    dynamicPrefix: '#',
    instruction: 'rehainfoのSLTA_1〜SLTA_12と同じ「6段階評価」「正答数」「所要時間」の記入セルだけを対象とし、グローバル#番号をidに使う。説明文や問題文は読み取らない。',
  },
  BIT: {
    documentType: 'BIT（行動性無視検査）',
    dynamicPrefix: 'BIT_',
    instruction: 'rehainfoのBIT_1〜BIT_7と同じ結果欄（見落とし数、誤り数、所要時間、得点）だけを読み取る。問題文と患者の自由記載は対象外。idはBIT_<ページ>_<項目番号>とする。',
  },
};

export function buildRehainfoOcrPrompt() {
  const definitions = Object.entries(REHAINFO_OCR_DEFINITIONS).map(([code, definition]) =>
    `- ${code}: ${definition.documentType}\n  ${definition.instruction}`
  ).join('\n');
  return `あなたはrehainfoのリハビリ評価票OCRです。以下の既存rehainfo定義以外の堳帳は抽出しないでください。\n${definitions}\n
最初に帳票全体からtestTypeを一つ判定し、その定義で指定されたセルだけを読み取ります。判定できない場合はtestTypeをUNSUPPORTED、fieldsを空配列にします。推測補完は禁止。空欄は空文字。各値のセル中央位置を、画像左上0・右下100のx、yで返します。JSON以外は返しません。
{"testType":"FMA_1|FMA_2|BBS|KOHS_1|STEF|SLTA_ALL|BIT|UNSUPPORTED","documentType":"帳票名","evaluationDate":"YYYY-MM-DDまたは空","fields":[{"id":"定義どおりのid","label":"定義どおりの項目名","value":"読取値","confidence":0.0,"x":0.0,"y":0.0}],"notes":"判読不能箇所"}`;
}

export function buildBbsRetryPrompt() {
  return `この画像はBerg Balance Scale（BBS）の評価票です。左右2列に分かれた手書きの「点数」欄だけを読み取ってください。
左列はNo.0〜6、右列はNo.7〜13です。印刷された選択肢の数字ではなく、各行の大きな手書き数字を対象にします。値は0、1、2、3、4のいずれかです。
各値の中心位置を画像左上0・右下100のx、yで返してください。読める数字を空欄にしないでください。JSON以外は返しません。
{"testType":"BBS","documentType":"Berg Balance Scale（BBS）","evaluationDate":"","fields":[{"id":"#0","label":"結果 #0","value":"0","confidence":0.0,"x":0.0,"y":0.0}],"notes":""}`;
}

export function buildStefRetryPrompt() {
  const fields = Array.from({ length: 20 }, (_, index) => ({
    id: `time_${index}`,
    label: `検査${Math.floor(index / 2) + 1} ${index % 2 === 0 ? '右' : '左'}　所要時間`,
    value: '',
    confidence: 0,
    x: 0,
    y: 0,
  }));
  return `この画像はSTEF（簡易上肢機能検査）の記録用紙です。左側の大きな主表だけを対象にし、検査1〜10の各行にある右・左の手書き「所要時間」数値を読み取ってください。
右側にある得点換算表、基準値、印刷済みの数字、時間外個数、得点は読み取らないでください。所要時間欄の手書き小数（例: 6.54、12.57）を小数点を含めて転記します。
idは検査1右=time_0、検査1左=time_1、検査2右=time_2、検査2左=time_3、以後同じ順で検査10左=time_19です。20項目を必ずこの順番・このidで返し、手書き数字が見える欄を空文字にしないでください。推測できない欄だけ空文字にします。
各値のセル中央位置を画像左上0・右下100のx、yで返してください。JSON以外は返しません。
${JSON.stringify({ testType: 'STEF', documentType: 'STEF（簡易上肢機能検査）', evaluationDate: '', fields, notes: '' })}`;
}

export function buildBitRetryPrompt() {
  return `この画像がBIT（Behavioural Inattention Test／行動性無視検査）の採点記録用紙かを最初に確認してください。
「通常検査得点」「行動検査得点」「線分抹消試験」「写真課題」「音読課題」「時計課題」「トランプ課題」などの見出しがあればBITです。BITでなければtestTypeをUNSUPPORTED、fieldsを空配列にしてください。
印刷された換算表、課題の問題、患者が課題中に付けた印や文字はOCR対象外です。検査者が結果欄に手書きした数字だけを読み取ってください。

対象となる欄:
- 「誤反応数」「見落し数」「書き落し数」
- 各行の「評価点」
- 網掛けされた「得点」
- 所要時間が手書きされている場合は「所要時間」

細い鉛筆書きも対象です。印刷済み数字と手書き数字を区別し、手書き数字が見えるセルを空欄にしないでください。
用紙下部のページ番号を確認し、idはBIT_<ページ番号>_<上から数えた結果セル番号>とします。セル番号は0から開始し、左から右、上から下の順です。
labelには課題名と欄名を具体的に記載します。各値の中心位置を画像左上0・右下100のx、yで返してください。推測できない値だけ空文字にし、JSON以外は返しません。
{"testType":"BIT|UNSUPPORTED","documentType":"BIT（行動性無視検査）","evaluationDate":"","fields":[{"id":"BIT_5_0","label":"時計課題(a) 誤反応数","value":"0","confidence":0.0,"x":0.0,"y":0.0}],"notes":""}`;
}

function position(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

export function normalizeRehainfoResult(parsed) {
  const testType = String(parsed?.testType || 'UNSUPPORTED');
  const definition = REHAINFO_OCR_DEFINITIONS[testType];
  if (!definition) return { testType: 'UNSUPPORTED', documentType: '対象外帳票', evaluationDate: '', fields: [], notes: String(parsed?.notes || '対応するrehainfo評価票を判定できませんでした。') };
  const sourceFields = Array.isArray(parsed.fields) ? parsed.fields : [];
  const incoming = new Map(sourceFields.map((field, index) => {
    let id = String(field.id ?? '').trim();
    if (testType === 'BBS') {
      const match = id.match(/(?:#|no\.?|bbs[_-]?|result[_-]?)?\s*(\d{1,2})$/i);
      if (match && Number(match[1]) <= 13) id = `#${Number(match[1])}`;
      else if (!id && index <= 13) id = `#${index}`;
    }
    return [id, field];
  }));
  if (testType === 'BBS' && ![...incoming.keys()].some(id => /^#(?:[0-9]|1[0-3])$/.test(id))) {
    sourceFields.slice(0, 14).forEach((field, index) => incoming.set(`#${index}`, field));
  }
  let fields;
  if (definition.fields) {
    fields = definition.fields.map(field => {
      const source = incoming.get(field.id) || {};
      let value = String(source.value ?? '').trim();
      if (field.allowedValues && !field.allowedValues.includes(value)) value = '';
      return { id: field.id, label: field.label, value, confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null, x: position(source.x), y: position(source.y) };
    });
  } else {
    fields = [...incoming.values()].filter(field => {
      const id = String(field.id || '');
      return testType === 'SLTA_ALL' ? /^#\d{1,3}$/.test(id) : /^BIT_[1-7]_\d{1,3}$/.test(id);
    }).slice(0, 300).map(field => ({ id: String(field.id), label: String(field.label || field.id).slice(0, 120), value: String(field.value ?? '').slice(0, 1000), confidence: Number.isFinite(Number(field.confidence)) ? Math.max(0, Math.min(1, Number(field.confidence))) : null, x: position(field.x), y: position(field.y) }));
  }
  return { testType, documentType: definition.documentType, evaluationDate: String(parsed.evaluationDate || '').slice(0, 20), fields, notes: String(parsed.notes || '').slice(0, 3000) };
}
