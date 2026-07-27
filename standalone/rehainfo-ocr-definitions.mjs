const indexed = (count, label, allowedValues = null) => Array.from({ length: count }, (_, index) => ({
  id: `#${index}`,
  label: `${label} #${index}`,
  allowedValues,
}));

const SLTA_LABEL_GROUPS = [
  [0, ['①卵', '②馬', '③自転車', '④太陽', '⑤靴下', '⑥電話', '⑦水', '⑧眼鏡', '⑨帽子', '⑩家']],
  [11, ['①生徒が先生に賞状をもらっている', '②おかあさんが赤ちゃんにご飯を食べさせている', '③おとうさんが子供を椅子に座らせている', '④男の子がバスに乗る', '⑤鳥が飛んでいる', '⑥子どもが風船をふくらませている', '⑦女の子が本を読んでいる', '⑧男の子は女の子が絵をかいているのを見ている', '⑨電車が鉄橋を渡っている', '⑩女の子が男の子になぐられている']],
  [22, ['①歯ブラシと鉛筆を持ってください', '②櫛を100円玉の横に置いてください', '③100円玉を裏返してからハンカチをとってください', '④櫛でマッチをさわってください', '⑤100円玉と万年筆をハンカチの上に置いてください', '⑥鍵をマッチの上に置いてください', '⑦鏡にさわってから万年筆をとってください', '⑧鋏と歯ブラシを入れ替えてください', '⑨歯ブラシを鏡の手前に置いてください', '⑩鍵を鋏と鉛筆の間においてください']],
  [33, ['①め', '②あ', '③ほ', '④た', '⑤や', '⑥ぬ', '⑦き', '⑧ね', '⑨せ', '⑩れ']],
  [44, ['①本', '②鉛筆', '③犬', '④時計', '⑤御飯', '⑥こま', '⑦山', '⑧新聞', '⑨飛行機', '⑩金魚', '⑪薬', '⑫たいこ', '⑬机', '⑭わに', '⑮ちょうちん', '⑯とりい', '⑰たけのこ', '⑱鹿', '⑲ふすま', '⑳かど松']],
  [65, ['①馬', '②家（いえ）', '③眼鏡', '④水', '⑤電話', '⑥太陽', '⑦卵', '⑧帽子', '⑨靴下', '⑩自動車']],
  [76, ['①（子どもがすやすやと）寝ている', '②（子どもが本を）読んでいる', '③（子どもが水を）飲んでいる', '④（子どもがプールで）泳いでいる', '⑤（子どもがバスに）乗る', '⑥（鳥が空を）飛んでいる', '⑦（この人は手紙を）書いている', '⑧（この人はたいこを）たたいている', '⑨（電車が鉄橋を）渡っている', '⑩（子どもが風船を）ふくらませている']],
  [87, ['まんがの説明', '①空が青い', '②友だちに手紙を出した', '③となりの町で火事があった', '④雨が降り続いているのできょうも散歩にいけません', '⑤わたしのいえに田舎から大きな小包がとどいた']],
  [94, ['語数', '①本', '②時計', '③新聞', '④犬', '⑤鉛筆']],
  [101, ['①た', '②ね', '③ほ', '④あ', '⑤や', '⑥め', '⑦ぬ', '⑧き', '⑨せ', '⑩れ']],
  [112, ['①いぬ', '②ほん', '③とけい', '④しんぶん', '⑤えんぴつ']],
  [118, ['①鳥が飛んでいる', '②女の子が本を読んでいる', '③男の子がバスに乗る', '④電車が鉄橋を渡っている', '⑤子どもが風船をふくらませている']],
  [124, ['①馬', '②自動車', '③電話', '④靴下', '⑤水', '⑥太陽', '⑦卵', '⑧帽子', '⑨家', '⑩眼鏡']],
  [135, ['①うま', '②でんわ', '③じどうしゃ', '④めがね', '⑤たまご', '⑥ぼうし', '⑦くつした', '⑧みず', '⑨たいよう', '⑩いえ']],
  [146, ['①生徒が先生に賞状をもらっている', '②おかあさんが赤ちゃんに御飯を食べさせている', '③鳥が飛んでいる', '④男の子がバスに乗る', '⑤子どもが風船をふくらませている', '⑥電車が鉄橋を渡っている', '⑦おとうさんが子どもを椅子に座らせている', '⑧女の子が本を読んでいる', '⑨男の子は女の子が絵をかいているのを見ている', '⑩女の子が男の子になぐられている']],
  [157, ['①歯ブラシと鉛筆を持ってください', '②鍵をマッチの上に置いてください', '③櫛を100円玉の横に置いてください', '④鋏と歯ブラシを入れ替えてください', '⑤100円玉を裏返してからハンカチをとってください', '⑥櫛でマッチをさわってください', '⑦100円玉と万年筆をハンカチの上に置いてください', '⑧歯ブラシを鋏の手前に置いてください', '⑨鏡にさわってから万年筆をとってください', '⑩鏡を鋏と鉛筆の間に置いてください']],
  [168, ['①犬', '②本', '③時計', '④新聞', '⑤鉛筆']],
  [174, ['①ほん', '②いぬ', '③とけい', '④えんぴつ', '⑤しんぶん']],
  [180, ['まんがの説明']],
  [181, ['①た', '②ほ', '③あ', '④や', '⑤き', '⑥め', '⑦せ', '⑧れ', '⑨ぬ', '⑩ね']],
  [192, ['①本', '②犬', '③時計', '④新聞', '⑤鉛筆']],
  [198, ['①ほん', '②とけい', '③いぬ', '④えんぴつ', '⑤しんぶん']],
  [204, ['①川に落ちました', '②風が吹いてきました', '③男の人が歩いています', '④ステッキで拾いました', '⑤帽子がとばされました']],
  [210, ['計算 正答数1', '計算 正答数2', '計算 正答数3', '計算 正答数4']],
];
const SLTA_KNOWN_LABELS = new Map(SLTA_LABEL_GROUPS.flatMap(([start, labels]) =>
  labels.map((label, index) => [`#${start + index}`, label])
));

export function applyKnownSltaLabels(result) {
  if (result?.testType !== 'SLTA_ALL' || !Array.isArray(result.fields)) return result;
  return {
    ...result,
    fields: result.fields.map(field => {
      const label = SLTA_KNOWN_LABELS.get(String(field.id || ''));
      return label ? { ...field, label } : field;
    }),
  };
}

export const REHAINFO_OCR_DEFINITIONS = {
  FMA_1: {
    documentType: 'Fugl-Meyer Assessment（FMA）上肢',
    fields: indexed(33, '結果', ['0', '1', '2', '']),
    instruction: '左側の「評価項目」列と右端の「結果」列を同じ行ごとに対応付け、#0〜#32を上から順に読み取る。labelには印刷された評価項目名、valueには0、1、2、空欄の結果を入れる。',
  },
  FMA_2: {
    documentType: 'Fugl-Meyer Assessment（FMA）下肢',
    fields: indexed(17, '結果', ['0', '1', '2', '']),
    instruction: '右端の「結果」列の#0〜#16だけを上から順に読み取る。値は0、1、2、空欄のみ。',
  },
  BBS: {
    documentType: 'Berg Balance Scale（BBS）',
    fields: indexed(14, '結果', ['0', '1', '2', '3', '4', '']),
    instruction: 'No.0〜13の14行について、印刷された評価項目名と手書きの「点数」欄を同じ行ごとに対応付ける。labelには評価項目名、valueには0〜4または空欄を入れる。',
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
    instruction: '行見出しの検査1〜10と列見出しの右・左を確認し、各所要時間を同じ行・列に対応付ける。labelは「検査1 右 所要時間」の形式にする。時間外個数も同様に検査番号と左右を対応付ける。',
  },
  SLTA_ALL: {
    documentType: 'SLTA（標準失語症検査）',
    dynamicPrefix: '#',
    instruction: 'rehainfoのSLTA_1〜SLTA_12と同じ「6段階評価」「正答数」「所要時間」の記入セルを対象とし、グローバル#番号をidに使う。全ページで「問題および反応」欄のテキストも読み取る。',
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
最初に帳票全体からtestTypeを一つ判定し、その定義で指定されたセルだけを読み取ります。判定できない場合はtestTypeをUNSUPPORTED、fieldsを空配列にします。推測補完は禁止。空欄は空文字。各値のセル中央位置を、画像左上0・右下100のx、yで返します。
各fieldのlabelには「結果 #0」のような連番名ではなく、その値と同じ行に用紙へ印刷されている実際の評価項目名をOCRして記載してください。見出しが複数段の場合は、意味が分かるように上位見出しと行名を組み合わせます。値の欄名（結果、得点、所要時間など）も必要に応じて末尾に付けます。JSON以外は返しません。
{"testType":"FMA_1|FMA_2|BBS|KOHS_1|STEF|SLTA_ALL|BIT|UNSUPPORTED","documentType":"帳票名","evaluationDate":"YYYY-MM-DDまたは空","fields":[{"id":"定義どおりのid","label":"用紙に印刷された実際の評価項目名","value":"読取値","confidence":0.0,"x":0.0,"y":0.0}],"notes":"判読不能箇所"}`;
}

export function buildBbsRetryPrompt() {
  return `この画像はBerg Balance Scale（BBS）の評価票です。左右2列に分かれた手書きの「点数」欄だけを読み取ってください。
左列はNo.0〜6、右列はNo.7〜13です。印刷された選択肢の数字ではなく、各行の大きな手書き数字を対象にします。値は0、1、2、3、4のいずれかです。
各行に印刷された評価項目名を読み取り、同じ行の手書き点数と対応付けてlabelへ具体的に記載してください。評価項目名が複数行の場合は一つの名称として結合してください。「結果 #0」のような連番名や空のlabelは禁止です。
各値の中心位置を画像左上0・右下100のx、yで返してください。読める数字を空欄にしないでください。JSON以外は返しません。
{"testType":"BBS","documentType":"Berg Balance Scale（BBS）","evaluationDate":"","fields":[{"id":"#0","label":"椅子からの立ち上がり","value":"0","confidence":0.0,"x":0.0,"y":0.0}],"notes":""}`;
}

export function buildFmaLowerRetryPrompt() {
  const labels = ['膝屈筋群', '膝蓋腱・アキレス腱', '股屈曲', '膝屈曲', '足背屈', '股伸展', '内転', '膝伸展', '足底屈', '膝屈曲', '足背屈', '膝90°まで屈曲', '足関節背屈', '腱反射', '振戦', '測定異常', '非麻痺側との時間差'];
  const fields = labels.map((label, index) => ({ id: `#${index}`, label, value: '', confidence: 0, x: 0, y: 0 }));
  return `この画像が「Fugl-Meyer Assessment（FMA）下肢機能」の評価用紙かを、用紙上部の表題で確認してください。
FMA下肢でなければtestTypeをUNSUPPORTED、fieldsを空配列にしてください。

FMA下肢の場合は、左側の「評価項目」列と、表の右端にある「結果」列を同じ行ごとに対応付けて上から順に17個読み取ります。
各fieldのlabelには「評価項目」列に印刷された名称をそのまま記載し、valueには同じ行の「結果」列の手書き数字を記載してください。「結果 #0」のような連番名は禁止です。
対象値は0、1、2のいずれかです。さらに右側の細い「#」列に印刷された0〜16、説明文中の採点基準、ページ番号はOCR結果に含めないでください。
細い縦線のように見える手書きの1、丸く書かれた0、崩れた2を注意深く区別してください。
各項目のidは上から#0〜#16で固定し、省略や並べ替えをしないでください。x、yは各手書き結果値の中心位置を画像左上0・右下100として返してください。
JSON以外は返しません。
${JSON.stringify({ testType: 'FMA_2|UNSUPPORTED', documentType: 'Fugl-Meyer Assessment（FMA）下肢', evaluationDate: '', fields, notes: '' })}`;
}

export function buildFmaUpperRetryPrompt() {
  const fields = Array.from({ length: 33 }, (_, index) => ({
    id: `#${index}`,
    label: '',
    value: '',
    confidence: 0,
    x: 0,
    y: 0,
  }));
  return `この画像が「Fugl-Meyer Assessment（FMA）上肢機能」の評価用紙かを、用紙上部の表題で確認してください。
FMA上肢でなければtestTypeをUNSUPPORTED、fieldsを空配列にしてください。

FMA上肢の場合は、左側の「評価項目」列と、表の右端にある「結果」列を同じ行ごとに対応付けて上から順に33個読み取ります。
各fieldのlabelには「評価項目」列に印刷された名称をOCRし、そのまま記載してください。見出しが複数段の場合は、共同運動・手関節・手指などの上位見出しと行名を組み合わせ、項目を識別できる名称にしてください。
valueには同じ行の「結果」列の手書き数字を記載してください。「結果 #0」のような連番名や、空のlabelは禁止です。
対象値は0、1、2のいずれかです。右側の細い「#」列に印刷された0〜32、説明文中の採点基準、ページ番号はOCR結果に含めないでください。
細い縦線のように見える手書きの1、丸く書かれた0、崩れた2を注意深く区別してください。
各項目のidは上から#0〜#32で固定し、省略や並べ替えをしないでください。x、yは各手書き結果値の中心位置を画像左上0・右下100として返してください。
JSON以外は返しません。
${JSON.stringify({ testType: 'FMA_1|UNSUPPORTED', documentType: 'Fugl-Meyer Assessment（FMA）上肢', evaluationDate: '', fields, notes: '' })}`;
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
  return `この画像はSTEF（簡易上肢機能検査）の記録用紙です。左側の大きな主表だけを対象にし、行見出しの「検査1〜10」と列見出しの「右」「左」を読み取って、各欄の手書き「所要時間」数値と対応付けてください。
右側にある得点換算表、基準値、印刷済みの数字、時間外個数、得点は読み取らないでください。所要時間欄の手書き小数（例: 6.54、12.57）を小数点を含めて転記します。
idは検査1右=time_0、検査1左=time_1、検査2右=time_2、検査2左=time_3、以後同じ順で検査10左=time_19です。20項目を必ずこの順番・このidで返し、手書き数字が見える欄を空文字にしないでください。推測できない欄だけ空文字にします。
labelは読み取った行見出しと列見出しを使い、「検査1 右 所要時間」「検査1 左 所要時間」の形式で記載してください。「結果 #0」のような連番名や、検査番号・左右のないlabelは禁止です。
各値のセル中央位置を画像左上0・右下100のx、yで返してください。JSON以外は返しません。
${JSON.stringify({ testType: 'STEF', documentType: 'STEF（簡易上肢機能検査）', evaluationDate: '', fields, notes: '' })}`;
}

export function buildSltaProblemResponseRetryPrompt(scoreFields = []) {
  const scores = scoreFields
    .filter(field => /^#\d{1,3}$/.test(String(field?.id || '')))
    .map(field => ({ id: field.id, value: field.value, x: field.x, y: field.y }))
    .slice(0, 100);
  return `この画像がSLTA（標準失語症検査）の1〜12ページのどれかを、用紙のページ番号と内容から確認してください。
SLTAの評価用紙でなければ、testTypeをUNSUPPORTED、fieldsを空配列にしてください。

SLTAの場合は、すべてのページで「問題および反応」欄にあるテキストを上から順に読み取ってください。
印刷された問題文、語句、検査者が記載した反応の文字を省略せずに読み取り、同じ問題・反応のまとまりごとに1項目にします。
下記の「既に読み取った評価欄」については、画像上のx、y位置と同じ行を確認し、同じidでfieldを返してください。labelは「6段階評価」ではなく、同じ行の「問題および反応」に印刷された実際の項目名にします。例えば1ページ目の該当行なら「①卵」のように、番号・記号・語句を含めて転記します。valueは下記の既存値を変更せず、そのまま返します。
「6段階評価」「正答数」「所要時間」だけの汎用的なlabelは禁止です。
idはSLTA_<ページ番号>_TEXT_<項目番号>とします。例えば1ページ目はSLTA_1_TEXT_0、4ページ目はSLTA_4_TEXT_0、12ページ目はSLTA_12_TEXT_0から始め、同じページ内では上から連番にします。
labelは「1ページ 問題および反応 1」「12ページ 問題および反応 1」のように、ページ番号と項目番号が分かる形式にしてください。valueは読み取ったテキストです。
x、yは各テキストのまとまりの中心位置を画像左上0・右下100として返してください。判読できない文字は推測せず「［判読不能］」と記載してください。JSON以外は返しません。
既に読み取った評価欄: ${JSON.stringify(scores)}
{"testType":"SLTA_ALL|UNSUPPORTED","documentType":"SLTA（標準失語症検査）","evaluationDate":"","fields":[{"id":"SLTA_12_TEXT_0","label":"12ページ 問題および反応 1","value":"読み取った問題および反応のテキスト","confidence":0.0,"x":0.0,"y":0.0}],"notes":""}`;
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

function withoutOcrUnderscores(value) {
  return String(value ?? '').replace(/[_＿]+/g, '').trim();
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
      let value = withoutOcrUnderscores(source.value);
      if (field.allowedValues && !field.allowedValues.includes(value)) value = '';
      const sourceLabel = withoutOcrUnderscores(source.label).slice(0, 120);
      return { id: field.id, label: sourceLabel || field.label, value, confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null, x: position(source.x), y: position(source.y) };
    });
  } else {
    fields = [...incoming.values()].filter(field => {
      const id = String(field.id || '');
      return testType === 'SLTA_ALL' ? /^(?:#\d{1,3}|SLTA_(?:[1-9]|1[0-2])_TEXT_\d{1,2})$/.test(id) : /^BIT_[1-7]_\d{1,3}$/.test(id);
    }).slice(0, 300).map(field => ({ id: String(field.id), label: withoutOcrUnderscores(field.label || field.id).slice(0, 120), value: withoutOcrUnderscores(field.value).slice(0, 1000), confidence: Number.isFinite(Number(field.confidence)) ? Math.max(0, Math.min(1, Number(field.confidence))) : null, x: position(field.x), y: position(field.y) }));
  }
  return { testType, documentType: definition.documentType, evaluationDate: String(parsed.evaluationDate || '').slice(0, 20), fields, notes: String(parsed.notes || '').slice(0, 3000) };
}
