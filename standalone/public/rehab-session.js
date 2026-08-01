const byId = id => document.getElementById(id);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const consent = byId('rehabConsent');
const patientSearch = byId('rehabPatientSearch');
const therapistSearch = byId('rehabTherapistSearch');
const startButton = byId('rehabStartButton');
const stopButton = byId('rehabStopButton');
const elapsed = byId('rehabElapsedTime');
const status = byId('rehabRecordingStatus');
const transcript = byId('rehabTranscript');
const audio = byId('rehabAudioPlayback');
const outputs = byId('rehabSessionOutputs');
const historyList = byId('rehabVoiceHistoryList');
const historyStorageKey = 'rehabVoiceHistoryV1';

let recognition = null;
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let timerId = null;
let startedAt = null;
let finalTranscript = '';
let recording = false;
let sessionPatients = [];
let sessionTherapists = [];
let voicePlaybackStopped = false;
let activeVoiceAudio = null;
let pendingRecordedSession = null;

function openAudioDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('rehabVoiceAudioDatabase', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recordings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRecordedAudio(id, blob) {
  const database = await openAudioDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('recordings', 'readwrite');
    transaction.objectStore('recordings').put(blob, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function loadRecordedAudio(id) {
  const database = await openAudioDatabase();
  const blob = await new Promise((resolve, reject) => {
    const request = database.transaction('recordings', 'readonly').objectStore('recordings').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return blob;
}

function escapeMarkup(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function loadVoiceHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(historyStorageKey) || '[]');
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

async function postVoiceSession(item, audioBlob = null) {
  let audioDataUrl = null;
  if (audioBlob) audioDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(audioBlob);
  });
  const patient = sessionPatients.find(candidate => item.patientLabel === `${candidate.facilityPatientId}｜${candidate.name}` || item.patientLabel === candidate.facilityPatientId || item.patientLabel === candidate.name);
  const therapist = sessionTherapists.find(candidate => item.therapistLabel === `${candidate.therapistId || ''}｜${candidate.name}` || item.therapistLabel === candidate.therapistId || item.therapistLabel === candidate.name);
  const response = await fetch('/api/rehab-voice/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item, patientId: patient?.id || null, therapistId: therapist?.id || null, audioDataUrl }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function refreshVoiceHistoryFromServer({ migrateLocal = false } = {}) {
  if (migrateLocal) {
    for (const item of loadVoiceHistory()) await postVoiceSession(item);
  }
  const response = await fetch('/api/rehab-voice/sessions');
  const history = await response.json();
  if (!response.ok) throw new Error(history.error || `HTTP ${response.status}`);
  localStorage.setItem(historyStorageKey, JSON.stringify(history.slice(0, 100)));
  renderVoiceHistory();
}

function renderVoiceHistory() {
  const history = loadVoiceHistory();
  historyList.innerHTML = history.length ? history.map(item => `<article class="card rehab-voice-history-card">
    <div><strong>${escapeMarkup(item.patientLabel)}｜${escapeMarkup(item.therapistLabel)}</strong><p>${escapeMarkup(new Date(item.createdAt).toLocaleString('ja-JP'))}・経過時間 ${escapeMarkup(item.duration)}</p></div>
    <div class="history-actions"><button type="button" data-rehab-voice-detail="${escapeMarkup(item.id)}">詳細</button></div>
  </article>`).join('') : '<p>履歴はありません。</p>';
  historyList.querySelectorAll('[data-rehab-voice-detail]').forEach(button => button.addEventListener('click', () => openVoiceHistoryDetail(button.dataset.rehabVoiceDetail)));
}

function openVoiceHistoryDetail(id) {
  const item = loadVoiceHistory().find(candidate => candidate.id === id);
  if (!item) return;
  byId('rehabVoiceDetailContent').innerHTML = `<div class="jobhead"><div><h2>${escapeMarkup(item.patientLabel)}</h2><p>${escapeMarkup(item.therapistLabel)}・${escapeMarkup(new Date(item.createdAt).toLocaleString('ja-JP'))}・経過時間 ${escapeMarkup(item.duration)}</p></div></div>
    <div class="rehab-voice-history-detail">
      <section><h3>会話内容</h3><div class="rehab-voice-audio-actions"><button id="playRehabVoiceAi" class="primary" type="button" data-default-label="${item.audioSource === 'ai-test' ? 'テスト用AIボイスを再生' : '録音ボイスを再生'}">${item.audioSource === 'ai-test' ? 'テスト用AIボイスを再生' : '録音ボイスを再生'}</button><button id="stopRehabVoiceAi" type="button" disabled>停止</button><small>${item.audioSource === 'ai-test' ? 'このTEST履歴の音声だけはAIが生成したテスト音声です。' : 'リハビリ中に実際に録音した音声を再生します。'}</small></div><div id="syncedRehabTranscript" class="synced-transcript">${syncedTranscriptMarkup(item.transcript)}</div></section>
      <section><h3>1）患者さん目線でのリハビリログ</h3><p>${escapeMarkup(item.patientLog)}</p><p class="rehab-feedback">${escapeMarkup(item.rewardFeedback)}</p></section>
      <section><h3>2）リハビリに関する不安・不満</h3><p>${escapeMarkup(item.concerns)}</p><p class="rehab-feedback">${escapeMarkup(item.empathyFeedback)}</p></section>
      <section><h3>3）リハビリに関する相談事</h3><p>${escapeMarkup(item.consultations)}</p></section>
    </div>`;
  byId('playRehabVoiceAi').addEventListener('click', () => playHistoryAudio(item));
  byId('stopRehabVoiceAi').addEventListener('click', stopSyncedVoice);
  byId('rehabVoiceDetailDialog').showModal();
}

function transcriptLines(value) {
  return String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
}

function syncedTranscriptMarkup(value) {
  const lines = transcriptLines(value);
  return lines.length ? lines.map((line, index) => `<span class="synced-transcript-line" data-voice-line="${index}">${escapeMarkup(line)}</span>`).join('') : '<span>文字記録なし</span>';
}

function stopSyncedVoice() {
  voicePlaybackStopped = true;
  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    if (typeof activeVoiceAudio.onended === 'function') activeVoiceAudio.onended();
    activeVoiceAudio.src = '';
    activeVoiceAudio = null;
  }
  document.querySelectorAll('.synced-transcript-line.playing').forEach(line => line.classList.remove('playing'));
  const playButton = byId('playRehabVoiceAi');
  const stopButton = byId('stopRehabVoiceAi');
  if (playButton) { playButton.disabled = false; playButton.textContent = playButton.dataset.defaultLabel || 'ボイスを再生'; }
  if (stopButton) stopButton.disabled = true;
}

function highlightTranscriptLine(index) {
  document.querySelectorAll('.synced-transcript-line.playing').forEach(line => line.classList.remove('playing'));
  const lineElement = document.querySelector(`[data-voice-line="${index}"]`);
  lineElement?.classList.add('playing');
  lineElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function playHistoryAudio(item) {
  if (item.audioSource === 'ai-test') return playSyncedVoice(item.transcript);
  stopSyncedVoice();
  voicePlaybackStopped = false;
  const playButton = byId('playRehabVoiceAi');
  const stopButton = byId('stopRehabVoiceAi');
  playButton.disabled = true;
  stopButton.disabled = false;
  try {
    let blob = null;
    const serverResponse = await fetch(`/api/rehab-voice/sessions/${encodeURIComponent(item.id)}/audio`);
    if (serverResponse.ok) blob = await serverResponse.blob();
    if (!blob) blob = await loadRecordedAudio(item.id);
    if (!blob) throw new Error('この履歴の録音音声が見つかりません。');
    const objectUrl = URL.createObjectURL(blob);
    const lines = transcriptLines(item.transcript);
    activeVoiceAudio = new Audio(objectUrl);
    activeVoiceAudio.ontimeupdate = () => {
      if (!activeVoiceAudio.duration || !lines.length) return;
      highlightTranscriptLine(Math.min(lines.length - 1, Math.floor(activeVoiceAudio.currentTime / activeVoiceAudio.duration * lines.length)));
    };
    await new Promise((resolve, reject) => {
      activeVoiceAudio.onended = resolve;
      activeVoiceAudio.onerror = () => reject(new Error('録音音声を再生できませんでした。'));
      activeVoiceAudio.play().catch(reject);
    });
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    activeVoiceAudio = null;
    stopSyncedVoice();
  }
}

async function playSyncedVoice(value) {
  const lines = transcriptLines(value);
  if (!lines.length) return;
  stopSyncedVoice();
  voicePlaybackStopped = false;
  const playButton = byId('playRehabVoiceAi');
  const stopButton = byId('stopRehabVoiceAi');
  playButton.disabled = true;
  playButton.textContent = 'AI音声を生成・再生中…';
  stopButton.disabled = false;
  try {
    for (let index = 0; index < lines.length && !voicePlaybackStopped; index += 1) {
      highlightTranscriptLine(index);
      const rawLine = lines[index].replace(/^\[[^\]]+\]\s*/, '');
      const speaker = rawLine.startsWith('患者：') ? 'patient' : 'therapist';
      const spokenText = rawLine.replace(/^(患者|療法士)：/, '');
      const response = await fetch('/api/rehab-voice/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spokenText, speaker }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      activeVoiceAudio = new Audio(objectUrl);
      await new Promise((resolve, reject) => {
        activeVoiceAudio.onended = resolve;
        activeVoiceAudio.onerror = () => reject(new Error('AI音声を再生できませんでした'));
        activeVoiceAudio.play().catch(reject);
      });
      URL.revokeObjectURL(objectUrl);
      activeVoiceAudio = null;
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    stopSyncedVoice();
  }
}

function saveVoiceHistory() {
  const history = loadVoiceHistory();
  const historyId = `rehab-voice-${Date.now()}`;
  history.unshift({
    id: historyId,
    createdAt: new Date().toISOString(),
    patientLabel: patientSearch.value.trim(),
    therapistLabel: therapistSearch.value.trim(),
    duration: elapsed.textContent,
    transcript: transcript.value.trim(),
    patientLog: byId('rehabPatientLog').textContent,
    rewardFeedback: byId('rehabRewardFeedback').textContent,
    concerns: byId('rehabConcerns').textContent,
    empathyFeedback: byId('rehabEmpathyFeedback').textContent,
    consultations: byId('rehabConsultations').textContent,
    audioSource: 'recorded',
  });
  localStorage.setItem(historyStorageKey, JSON.stringify(history.slice(0, 100)));
  renderVoiceHistory();
  return history[0];
}

function seedRehabVoiceTestHistory() {
  const history = loadVoiceHistory();
  const therapistLabels = sessionTherapists.slice(0, 3).map(therapist => `${therapist.therapistId || ''}｜${therapist.name}`);
  while (therapistLabels.length < 3) therapistLabels.push(`TEST-PT0${therapistLabels.length + 1}｜テスト療法士${therapistLabels.length + 1}`);
  const timedDialogue = turns => turns.map(([time, patient, therapist]) => `[${time}] 患者：${patient}\n[${time}] 療法士：${therapist}`).join('\n');
  const samples = [
    {
      id: 'rehab-voice-test-rv001', patientLabel: 'RV001｜リハビリボイス TEST患者1', therapistLabel: therapistLabels[0], duration: '00:20:15',
      transcript: timedDialogue([
        ['00:00', '今日は歩く練習を頑張りたいです。ただ、朝から右膝が少し重い感じがあります。', '始める前に痛みを確認しましょう。今の痛みを0から10で表すとどのくらいですか。'],
        ['01:00', '座っていると2くらいで、立つと3くらいです。昨日より少しだけ気になります。', '分かりました。痛みが強くならない範囲で、まず座ったまま足首と膝を動かして温めます。'],
        ['02:00', '足首を動かすのは大丈夫です。膝を伸ばすと少し突っ張ります。', '勢いをつけず、伸ばせるところまでで止めましょう。呼吸は止めずにゆっくり続けてください。'],
        ['03:00', '10回できました。最初より膝が軽くなった気がします。', '良い変化です。次は椅子から立つ練習を3回行います。手すりを使って構いません。'],
        ['04:00', '立つ瞬間が少し怖いです。前に転びそうになったことがあります。', '足を少し後ろへ引き、体を前に倒してから立ちましょう。私が横で支えるので安心してください。'],
        ['05:00', '1回目は立てました。膝の痛みは3のままです。', '姿勢は安定しています。立った後すぐ歩かず、ふらつきがないことを確認してから動きます。'],
        ['06:00', '3回ともできました。最後は手に力を入れすぎず立てました。', 'とても良いです。では歩行器を使って廊下を往復します。疲れたら途中で止まりましょう。'],
        ['07:00', '歩き始めは右足が出しにくいです。転ばないか不安です。', '歩行器を先に少し進め、右足、左足の順で進みましょう。歩幅は小さくて大丈夫です。'],
        ['08:00', 'ゆっくりなら進めます。右膝もさっきより気になりません。', '目線が足元だけにならないよう、時々前を見ましょう。今のペースを保てています。'],
        ['09:00', '廊下の半分まで来ました。少し息が上がっています。', 'ここで一度止まりましょう。息を吐くことを意識して、呼吸が整うまで休みます。'],
        ['10:00', '息は落ち着きました。疲れは10段階で4くらいです。', '続けられる範囲ですが、無理はしません。帰りは途中にある椅子まで歩いて休憩しましょう。'],
        ['11:00', '方向転換が難しいです。足が絡みそうになります。', '歩行器を小さく動かしながら、足も小刻みに動かします。一度に大きく回らないことが安全のポイントです。'],
        ['12:00', '小さく回ると安定しました。これなら家でもできそうです。', '自宅では通路の幅や家具の位置も関係します。物を床に置かず、十分な幅を確保しましょう。'],
        ['13:00', '家の廊下に小さな敷物があります。引っかからないか心配です。', '敷物は足や歩行器が引っかかる可能性があります。ご家族と相談して撤去するのが安全です。'],
        ['14:00', '家族にも伝えます。家で一人のときはどんな練習ならできますか。', '椅子に座った足首運動と膝伸ばしなら行えます。立つ練習はご家族がいる時間にしましょう。'],
        ['15:00', '回数は今日と同じ10回でよいですか。', 'はい。痛みが強くならなければ各10回を1日2回から始め、疲れが残る日は1回に減らしてください。'],
        ['16:00', '痛みがどのくらいになったら中止した方がよいですか。', '今より2段階以上強くなる、鋭い痛みが出る、腫れが増える場合は中止して職員へ伝えてください。'],
        ['17:00', '分かりました。今日は思ったより歩けて少し自信が出ました。', '廊下を安全に往復でき、方向転換も改善しました。できたことを覚えておきましょう。'],
        ['18:00', '退院までに杖で歩けるようになりたいです。可能でしょうか。', '状態を見ながら歩行器での安定性を高め、その後に杖を検討します。次回も今日の歩行を確認します。'],
        ['19:00', '次回も膝の状態を伝えます。家族にも敷物のことを話します。', 'お願いします。最後に座って呼吸と痛みを確認します。今の膝の痛みはいくつですか。'],
        ['20:00', '痛みは2くらいで、始める前より軽いです。疲れはありますが気分は良いです。', '20分間おつかれさまでした。今日は安全に歩けたことと、自宅での注意点を確認できました。'],
      ]),
      patientLog: '今日は廊下で歩く練習に取り組みました。右膝の痛みに注意しながら、自分のペースで歩けました。',
      rewardFeedback: '歩く練習を最後まで続けられました。今日の一歩が次の自信につながります。',
      concerns: '右膝が少し痛い。転ばないか不安。',
      empathyFeedback: '不安を伝えてくださりありがとうございます。痛みと安全を確認しながら一緒に進めましょう。',
      consultations: '家でもできる歩行練習を教えてほしい。',
    },
    {
      id: 'rehab-voice-test-rv002', patientLabel: 'RV002｜リハビリボイス TEST患者2', therapistLabel: therapistLabels[1], duration: '00:18:42',
      transcript: timedDialogue([
        ['00:00', '今日は右肩が少しこわばっています。着替えのときに袖を通すのがつらいです。', '痛みと動きを確認してから、着替えにつながる練習を行いましょう。痛みは0から10でいくつですか。'],
        ['01:00', 'じっとしていると1で、腕を上げると4くらいです。', '痛みが4を超えない範囲で進めます。まず肩をすくめず、肘を曲げ伸ばしして温めましょう。'],
        ['02:00', '肘は問題なく動きます。肩を上げると途中で引っかかる感じがあります。', '引っかかる手前で止め、反対の手で右腕を支えてゆっくり動かします。'],
        ['03:00', '支えると少し上まで動かせます。', '昨日より動く範囲が広がっています。痛みを我慢して押し込まず、滑らかに動かすことを優先します。'],
        ['04:00', '10回できました。肩の周りが温かくなりました。', '次はタオルを机の上で前に滑らせます。体を少し前へ倒して腕を伸ばしましょう。'],
        ['05:00', 'この運動は痛みが少ないです。家でもできそうです。', '安定した机と椅子があればできます。タオルを遠くへ押しすぎないことがポイントです。'],
        ['06:00', '朝の着替えに時間がかかって、家族を待たせるのが申し訳ないです。', '急ぐと肩へ力が入りやすくなります。時間に余裕を持ち、自分でできる部分を続けることが大切です。'],
        ['07:00', '前開きの服なら少し楽ですが、かぶる服は難しいです。', '今は前開きの服を選ぶのが安全です。袖は動かしにくい右腕から通すと負担が減ります。'],
        ['08:00', '右腕から袖を通すのですね。いつも左から着ていました。', '脱ぐときは反対に、動かしやすい左腕から抜きます。実際の上着で順番を練習しましょう。'],
        ['09:00', '右の袖は通せました。背中側の服を引くところが難しいです。', '左手で裾を持ち、体を少し前に倒しながら引きます。必要なら長い柄の補助具も検討できます。'],
        ['10:00', '補助具があるなら試してみたいです。', '次回準備します。今日はタオルを使って、背中へ手を回す動きの代わりを練習します。'],
        ['11:00', '肩の前が少し疲れてきました。痛みは3くらいです。', 'ここで休憩しましょう。腕をクッションに乗せ、肩の力を抜いて深呼吸します。'],
        ['12:00', '休むと楽になりました。夜に肩が痛くて眠れない日もあります。', '寝る姿勢も影響します。右腕の下に薄い枕やタオルを置き、肩が後ろへ落ちないよう支えてください。'],
        ['13:00', '横向きで寝てもよいですか。', '痛い右肩を下にするのは避けましょう。左向きなら右腕を抱き枕やクッションで支えると楽です。'],
        ['14:00', '今夜試してみます。運動は寝る前にもしてよいですか。', '軽い運動は可能ですが、強く動かすと目が覚めることがあります。寝る直前は小さな動きにしてください。'],
        ['15:00', '一人で着替えられるようになるまで、どのくらいかかりますか。', '回復速度には個人差があります。今の動きなら、方法を工夫することで一部はすでに自分で行えます。'],
        ['16:00', '全部できるまで待つのではなく、やり方を変えるのですね。', 'その通りです。痛みを減らしながら自分でできる範囲を増やし、難しい部分だけ助けてもらいましょう。'],
        ['17:00', '家族に全部やってもらうより、自分でできる方がうれしいです。', '今日、右腕から袖を通す動作はご自身でできました。成功した手順をご家族にも共有しましょう。'],
        ['18:00', '次はズボンや靴下も練習したいです。', '次回は下衣の着替えも確認しましょう。姿勢の安定性を見て、必要なら道具も紹介します。'],
        ['19:00', '今日は肩の痛みが強くならずに練習できました。', '終了前の痛みを確認します。腕を楽な位置に置いた状態と、上げた状態ではいくつですか。'],
        ['20:00', '休んでいると1、上げると3です。着替えの順番が分かって安心しました。', '20分間おつかれさまでした。今日は右腕から着て左腕から脱ぐ方法と、自宅運動を確認できました。'],
      ]),
      patientLog: '今日は腕を上げる運動に取り組み、昨日より広い範囲まで動かせました。',
      rewardFeedback: '昨日からの変化が見えています。焦らず積み重ねていきましょう。',
      concerns: '着替えのときに肩がつらい。',
      empathyFeedback: '日常動作でのつらさを教えてくださりありがとうございます。負担の少ない方法を一緒に探しましょう。',
      consultations: 'いつ頃一人で着替えられるようになるか相談したい。',
    },
    {
      id: 'rehab-voice-test-rv003', patientLabel: 'RV003｜リハビリボイス TEST患者3', therapistLabel: therapistLabels[2], duration: '00:25:08',
      transcript: timedDialogue([
        ['00:00', '今日は階段の練習ですね。自宅の階段を使えるか心配です。', 'まず平地で足の力とふらつきを確認し、その後に低い段差から始めます。'],
        ['01:00', '自宅は玄関に2段、二階までに12段あります。手すりは右側です。', '上りと下りで手すりの位置が変わるので、両方の向きを想定して練習しましょう。'],
        ['02:00', '左足より右足の方が力が入りにくいです。', '上るときは力の入りやすい左足から、下りるときは右足から出す方法を練習します。'],
        ['03:00', '順番を忘れそうです。', '「上りは良い足、下りは弱い足」と覚えましょう。最初は私が声をかけます。'],
        ['04:00', '手すりを持って1段上がれました。少し怖いですが痛みはありません。', '足裏全体を段に乗せられています。急がず、両足がそろってから次へ進みます。'],
        ['05:00', '2段目も上がれました。手にかなり力が入っています。', '今は安全が優先なので手すりをしっかり使って構いません。肩をすくめすぎないようにしましょう。'],
        ['06:00', '下りる方が怖いです。段の端が見えにくく感じます。', '足元を確認しながら右足を一段下へ置きます。私が前方から支えます。'],
        ['07:00', '右足を下ろせました。左足をそろえるときにふらつきました。', '手すりへ体を近づけ、体重を右足へ急に移さないようにします。もう一度ゆっくり行いましょう。'],
        ['08:00', '2回目はふらつきが少なかったです。', '動作の順番が安定してきました。ここで椅子に座り、息と疲れを確認します。'],
        ['09:00', '疲れは10段階で5です。息は少し上がっています。', '2分ほど休み、水分を一口取りましょう。疲れが3程度に下がってから再開します。'],
        ['10:00', '疲れは3まで下がりました。もう一度できます。', '次は4段を連続して上ります。左足、右足をそろえる順番で進めましょう。'],
        ['11:00', '4段上がれました。途中で順番も間違えませんでした。', 'とても安定しています。自宅でも最初は一段ずつ両足をそろえる方法が安全です。'],
        ['12:00', '荷物を持って階段を上がることはできますか。', '今は両手の安全を優先し、荷物は持たないでください。ご家族に運んでもらうか、肩掛けも状態を見て判断します。'],
        ['13:00', '洗濯物を二階へ運ぶ必要があります。どうしたらよいでしょう。', '退院直後はご家族にお願いしましょう。生活動線を一階へまとめる方法も退院支援で相談できます。'],
        ['14:00', '家族は昼間いないので、一階だけで過ごせるか確認したいです。', 'ベッド、トイレ、食事場所を一階で確保できるか、家屋状況を担当者と一緒に整理しましょう。'],
        ['15:00', '家族にも階段での支え方を教えてもらえますか。', '可能です。家族指導の時間を設け、後ろから引っ張らず斜め下で支える方法を練習してもらいます。'],
        ['16:00', '退院前に家族と一緒に練習できると安心です。', '次回の面会予定を確認して日程を調整します。自宅階段の写真や寸法があるとより具体的に練習できます。'],
        ['17:00', '家族に写真を撮ってきてもらいます。手すりの高さも測った方がよいですか。', 'はい。段数、段の高さ、幅、手すりの位置を確認してください。玄関の2段も写真があると役立ちます。'],
        ['18:00', '今日4段できたので、少し希望が持てました。', '安全な順番を守り、休憩も自分から取れました。退院に向けた良い練習になっています。'],
        ['19:00', '次は何段くらい練習しますか。', '疲れと安定性を見ながら6段を目標にします。段数よりも、安全な動作を繰り返せることを優先します。'],
        ['20:00', '分かりました。家族指導と自宅の写真について相談します。', '20分間おつかれさまでした。今日は階段の順番、安全な支え方、退院後の生活動線を確認できました。'],
      ]),
      patientLog: '今日は手すりを使って階段昇降を練習しました。安全な足の順番を確認できました。',
      rewardFeedback: '難しい階段練習に挑戦できました。安全な方法を身につける大切な一歩です。',
      concerns: '退院後に自宅の階段を安全に使えるか心配。',
      empathyFeedback: '退院後の生活への心配は大切な情報です。自宅環境に合わせた方法を一緒に確認しましょう。',
      consultations: '家族にも階段での安全な支え方を説明してほしい。',
    },
  ];
  let changed = false;
  samples.forEach((sample, index) => {
    const existingIndex = history.findIndex(item => item.id === sample.id);
    const createdAt = existingIndex >= 0 ? history[existingIndex].createdAt : new Date(Date.now() - index * 86400000).toISOString();
    const updated = { ...sample, createdAt, audioSource: 'ai-test' };
    if (existingIndex >= 0) history[existingIndex] = updated;
    else history.push(updated);
    changed = true;
  });
  if (changed) localStorage.setItem(historyStorageKey, JSON.stringify(history.slice(0, 100)));
  renderVoiceHistory();
  refreshVoiceHistoryFromServer({ migrateLocal: true }).catch(error => { status.textContent = `サーバー履歴を更新できませんでした（${error.message}）。`; });
}

function updateStartAvailability() {
  const patientQuery = patientSearch.value.trim();
  const therapistQuery = therapistSearch.value.trim();
  const patientSelected = sessionPatients.some(patient => patientQuery === `${patient.facilityPatientId}｜${patient.name}` || patientQuery === patient.facilityPatientId || patientQuery === patient.name);
  const therapistSelected = sessionTherapists.some(therapist => therapistQuery === `${therapist.therapistId || ''}｜${therapist.name}` || therapistQuery === therapist.therapistId || therapistQuery === therapist.name);
  startButton.disabled = recording || !consent.checked || !patientSelected || !therapistSelected;
}

async function loadSessionPeople() {
  try {
    [sessionPatients, sessionTherapists] = await Promise.all([
      fetch('/api/patients').then(response => response.ok ? response.json() : Promise.reject(new Error('患者一覧を取得できません'))),
      fetch('/api/therapists').then(response => response.ok ? response.json() : Promise.reject(new Error('療法士一覧を取得できません'))),
    ]);
    byId('rehabPatientSearchList').innerHTML = sessionPatients.map(patient => `<option value="${escapeMarkup(`${patient.facilityPatientId}｜${patient.name}`)}">${escapeMarkup(patient.name)}</option>`).join('');
    byId('rehabTherapistSearchList').innerHTML = sessionTherapists.map(therapist => `<option value="${escapeMarkup(`${therapist.therapistId || ''}｜${therapist.name}`)}">${escapeMarkup(therapist.name)}</option>`).join('');
    updateStartAvailability();
    seedRehabVoiceTestHistory();
  } catch (error) {
    status.textContent = error.message;
  }
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function updateElapsed() {
  elapsed.textContent = formatElapsed(Date.now() - startedAt);
}

function sentences(text) {
  return text.split(/(?<=[。！？!?\n])/).map(value => value.trim()).filter(Boolean);
}

function matchingLines(text, pattern) {
  const matches = sentences(text).filter(line => pattern.test(line));
  return matches.length ? matches.join('\n') : '明確な発言はありませんでした。';
}

function createOutputs() {
  const text = transcript.value.trim();
  const duration = elapsed.textContent;
  byId('rehabPatientLog').textContent = text
    ? `今日は${duration}のリハビリに取り組みました。\n会話記録：${text}`
    : `今日は${duration}のリハビリに取り組みました。会話の文字記録はありません。`;
  byId('rehabRewardFeedback').textContent = '今日もリハビリに取り組めました。おつかれさまでした。小さな積み重ねを一緒に続けていきましょう。';
  byId('rehabConcerns').textContent = matchingLines(text, /不安|心配|怖|痛|つら|辛|困|不満|嫌|できない|難しい/);
  byId('rehabEmpathyFeedback').textContent = '感じた不安や不満を話してくださりありがとうございます。無理をせず、次回のリハビリで療法士と一緒に確認しましょう。';
  byId('rehabConsultations').textContent = matchingLines(text, /相談|どうしたら|できますか|でしょうか|したい|してほしい|教えて|いつ|どのくらい|？|\?/);
  outputs.hidden = false;
}

function stopRecognition() {
  if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch {}
    recognition = null;
  }
}

function finishSession() {
  if (!recording) return;
  recording = false;
  clearInterval(timerId);
  updateElapsed();
  stopRecognition();
  createOutputs();
  pendingRecordedSession = saveVoiceHistory();
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  mediaStream?.getTracks().forEach(track => track.stop());
  updateStartAvailability();
  stopButton.disabled = true;
  status.textContent = '記録を終了しました。会話内容と録音ボイスを履歴へ保存しています。';
}

function startSpeechRecognition() {
  if (!SpeechRecognition) {
    status.textContent = '録音中です。このブラウザーはリアルタイム文字起こしに対応していないため、会話内容は手入力してください。';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const value = event.results[index][0].transcript;
      if (event.results[index].isFinal) finalTranscript += `${value}\n`;
      else interim += value;
    }
    transcript.value = `${finalTranscript}${interim}`.trimStart();
    transcript.scrollTop = transcript.scrollHeight;
  };
  recognition.onerror = event => {
    if (event.error !== 'aborted') status.textContent = `録音は継続しています。文字起こしを利用できませんでした（${event.error}）。手入力で修正できます。`;
  };
  recognition.onend = () => {
    if (recording) {
      try { recognition.start(); } catch {}
    }
  };
  recognition.start();
}

async function startSession() {
  updateStartAvailability();
  if (startButton.disabled || recording) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const options = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 };
    mediaRecorder = new MediaRecorder(mediaStream, options);
    audioChunks = [];
    mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
    mediaRecorder.onstop = async () => {
      if (!audioChunks.length) return;
      const recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (pendingRecordedSession) {
        try {
          await storeRecordedAudio(pendingRecordedSession.id, recordedBlob);
          await postVoiceSession(pendingRecordedSession, recordedBlob);
          await refreshVoiceHistoryFromServer();
          status.textContent = '記録を終了しました。会話内容と録音ボイスをサーバーへ保存しました。';
        } catch (error) {
          status.textContent = `ブラウザーには保存しましたが、サーバーへ保存できませんでした（${error.message}）。`;
        }
      }
      pendingRecordedSession = null;
      if (audio.src) URL.revokeObjectURL(audio.src);
      audio.src = URL.createObjectURL(recordedBlob);
      audio.hidden = false;
    };
    finalTranscript = transcript.value.trim() ? `${transcript.value.trim()}\n` : '';
    outputs.hidden = true;
    recording = true;
    startedAt = Date.now();
    elapsed.textContent = '00:00:00';
    timerId = setInterval(updateElapsed, 1000);
    mediaRecorder.start(1000);
    startSpeechRecognition();
    startButton.disabled = true;
    stopButton.disabled = false;
    status.textContent = '録音・文字起こし中です。終了時は「記録を終了」を押してください。';
  } catch (error) {
    status.textContent = `マイクを開始できませんでした。ブラウザーのマイク許可を確認してください（${error.message}）。`;
  }
}

consent.addEventListener('change', updateStartAvailability);
patientSearch.addEventListener('input', updateStartAvailability);
patientSearch.addEventListener('change', updateStartAvailability);
therapistSearch.addEventListener('input', updateStartAvailability);
therapistSearch.addEventListener('change', updateStartAvailability);
startButton.addEventListener('click', startSession);
stopButton.addEventListener('click', finishSession);
byId('refreshRehabVoiceHistory').addEventListener('click', () => refreshVoiceHistoryFromServer().catch(error => { status.textContent = error.message; }));
byId('closeRehabVoiceDetail').addEventListener('click', () => { stopSyncedVoice(); byId('rehabVoiceDetailDialog').close(); });
window.addEventListener('beforeunload', () => {
  clearInterval(timerId);
  stopRecognition();
  mediaStream?.getTracks().forEach(track => track.stop());
});

loadSessionPeople();
renderVoiceHistory();
