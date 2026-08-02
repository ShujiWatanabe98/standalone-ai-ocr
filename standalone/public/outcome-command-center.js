const outcomeTherapistList = document.getElementById('therapistList');
const outcomeHost = outcomeTherapistList?.parentElement;

if (outcomeHost) {
  const section = document.createElement('section');
  section.className = 'outcome-command-center';
  section.innerHTML = `<div class="outcome-head"><div><p class="eyebrow">RECOVERY WARD OUTCOMES</p><h3>回復期病棟アウトカム司令塔</h3></div><button id="outcomeRefresh" type="button">更新</button></div><p class="outcome-description">西大和モデル：在宅復帰、FIM改善、実績指数を軸に、患者別の未完了業務まで管理します。公開値は基準値、目標値は導入時の提案であり、院内で変更できます。</p><div id="outcomeGoals" class="outcome-goals"><p>読み込み中…</p></div><div id="outcomeMetrics" class="outcome-metrics"></div><details class="outcome-input"><summary>月次実績を登録</summary><form id="outcomeSnapshotForm"><label>集計月<input name="period" type="month" required></label><label>在宅復帰率（%）<input name="homeReturnRate" type="number" min="0" max="100" step="0.1"></label><label>FIM改善（点）<input name="fimGain" type="number" min="0" step="0.1"></label><label>実績指数<input name="performanceIndex" type="number" min="0" step="0.1"></label><label>データ区分<select name="dataType"><option value="HOSPITAL_ACTUAL">院内実測値</option><option value="SAMPLE">サンプル</option></select></label><label>注記<input name="note" placeholder="集計条件など"></label><button class="secondary" type="submit">月次実績を保存</button></form></details><div id="outcomeAlerts" class="outcome-alerts"></div><section class="outcome-actions"><h4>担当者・期限付きアクション</h4><form id="outcomeActionForm"><select name="patientId" required><option value="">患者を選択</option></select><select name="category"><option value="FIM">FIM</option><option value="PLAN">計画</option><option value="DISCHARGE">退院支援</option><option value="FAMILY">家族支援</option><option value="RISK">リスク</option><option value="OTHER">その他</option></select><input name="title" required placeholder="対応内容"><input name="owner" placeholder="担当者"><input name="dueDate" type="date"><button class="secondary" type="submit">追加</button></form><div id="outcomeActionList"></div></section><p id="outcomeMessage" class="message" role="status"></p>`;
  outcomeHost.append(section);
  const purpose = document.createElement('div');
  purpose.className = 'outcome-description outcome-purpose';
  purpose.innerHTML = '<strong>この機能で実現すること</strong><p>患者ごとのFIM、AI計画、退院課題を一か所に集め、対応の遅れや入力漏れを早期に発見します。担当者と期限を明確にして多職種で解決し、在宅復帰率、FIM改善、実績指数の向上につなげるための管理機能です。</p>';
  section.querySelector('.outcome-head').after(purpose);
  const fimLabels = { eating:'食事', grooming:'整容', bathing:'清拭', dressingUpper:'更衣（上半身）', dressingLower:'更衣（下半身）', toileting:'トイレ動作', bladder:'排尿管理', bowel:'排便管理', transferBedChair:'移乗（ベッド・椅子）', transferToilet:'移乗（トイレ）', transferTubShower:'移乗（浴槽・シャワー）', locomotion:'移動', stairs:'階段', comprehension:'理解', expression:'表出', socialInteraction:'社会的交流', problemSolving:'問題解決', memory:'記憶' };
  const fimMotorKeys = Object.keys(fimLabels).slice(0, 13);
  const fimScoreOptions = '<option value="">未入力</option>' + [1,2,3,4,5,6,7].map(value => `<option value="${value}">${value}</option>`).join('');
  section.querySelector('.outcome-input').insertAdjacentHTML('beforebegin', `<details class="fim-input"><summary>FIM 18項目を登録・推移確認</summary><form id="fimAssessmentForm"><div class="fim-meta"><label>患者<select name="patientId" required><option value="">患者を選択</option></select></label><label>評価区分<select name="stage"><option value="ADMISSION">入棟時</option><option value="PERIODIC">定期</option><option value="DISCHARGE">退棟時</option></select></label><label>評価日<input name="evaluationDate" type="date" required></label><label>評価者<input name="evaluator"></label><label>確定状態<select name="status"><option value="DRAFT">下書き</option><option value="CONFIRMED">確認済み</option></select></label><label>移動方法<select name="locomotionMode"><option value="WALK">歩行</option><option value="WHEELCHAIR">車椅子</option></select></label></div><h5>運動項目</h5><div class="fim-score-grid">${fimMotorKeys.map(key => `<label>${fimLabels[key]}<select name="${key}">${fimScoreOptions}</select></label>`).join('')}</div><h5>認知項目</h5><div class="fim-score-grid">${Object.keys(fimLabels).slice(13).map(key => `<label>${fimLabels[key]}<select name="${key}">${fimScoreOptions}</select></label>`).join('')}</div><label>注記<textarea name="note" rows="2"></textarea></label><div class="fim-form-actions"><output id="fimLiveTotal">運動 ―／認知 ―／合計 ―</output><button class="secondary" type="submit">FIM評価を保存</button></div></form><div id="fimTrend"></div></details>`);
  const fimDetails = section.querySelector('.fim-input');
  fimDetails.insertAdjacentHTML('afterbegin', `<div class="fim-data-tools"><a href="/api/fim-export.csv" download>FIM CSV出力</a><label>FIM CSV取込<input id="fimCsvImport" type="file" accept=".csv,text/csv"></label><span id="fimCsvMessage"></span></div><form id="wardProfileForm"><h5>回復期病棟情報</h5><div class="fim-meta"><label>患者<select name="patientId" required><option value="">患者を選択</option></select></label><label>病棟名<input name="wardName"></label><label>発症・受傷日<input name="onsetDate" type="date"></label><label>入棟日<input name="admissionDate" type="date"></label><label>退棟予定日<input name="plannedDischargeDate" type="date"></label><label>退棟日<input name="dischargeDate" type="date"></label><label>疾患・状態区分<input name="diseaseCategory" placeholder="院内確認済み区分"></label><label>確認済み算定上限日数<input name="limitDays" type="number" min="1" max="365"></label><label>FIM評価間隔（日）<input name="fimIntervalDays" type="number" min="1" max="90" value="14"></label></div><label>注記<textarea name="note" rows="2"></textarea></label><div class="fim-form-actions"><output id="wardProfileStatus">患者を選択してください</output><button class="secondary" type="submit">病棟情報を保存</button></div></form>`);
  fimDetails.querySelector('.fim-data-tools').insertAdjacentHTML('afterbegin', '<label class="fim-ocr-button">FIM評価票をAI読取<input id="fimOcrImage" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></label><span id="fimOcrMessage"></span>');
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  let outcomeData = null;
  const sourceName = value => ({ PUBLIC_BASELINE: '公開基準値', LIVE_SYSTEM: 'システム集計', HOSPITAL_SNAPSHOT: '院内月次実績' })[value] || value;

  async function outcomeApi(path, options = {}) { const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body; }
  function renderGoals(goals) {
    byId('outcomeGoals').innerHTML = goals.map(goal => { const current = goal.current ?? '未登録'; const numeric = Number(goal.current); const progress = Number.isFinite(numeric) && goal.target ? Math.min(100, Math.round(numeric / goal.target * 100)) : 0; return `<article><div class="goal-title"><strong>${escapeHtml(goal.label)}</strong><span>${escapeHtml(sourceName(goal.currentSource))}</span></div><div class="goal-numbers"><b>${escapeHtml(current)}${escapeHtml(goal.unit)}</b><span>目標 <button type="button" data-goal-key="${escapeHtml(goal.key)}" data-goal-target="${goal.target}">${goal.target}${escapeHtml(goal.unit)} 編集</button></span></div><div class="goal-bar"><i style="width:${progress}%"></i></div><small>${goal.publicBaseline == null ? '公開基準値なし' : `公開基準 ${goal.publicBaseline}${escapeHtml(goal.unit)}`}・${goal.targetType === 'PROPOSED' ? '提案目標' : '院内設定目標'}</small></article>`; }).join('');
    byId('outcomeGoals').querySelectorAll('[data-goal-key]').forEach(button => button.addEventListener('click', async () => { const value = window.prompt('新しい目標値を入力してください', button.dataset.goalTarget); if (value == null) return; await outcomeApi('/api/outcome-goals', { method: 'PUT', body: JSON.stringify({ key: button.dataset.goalKey, target: value }) }); await loadOutcomeCenter(); }));
  }
  function renderActions(actions) {
    byId('outcomeActionList').innerHTML = actions.length ? actions.map(action => `<article><div><strong>${escapeHtml(action.patientLabel)}</strong><span>${escapeHtml(action.title)}</span><small>${escapeHtml(action.category)}・担当 ${escapeHtml(action.owner || '未設定')}・期限 ${escapeHtml(action.dueDate || '未設定')}</small></div><button type="button" data-complete-action="${escapeHtml(action.id)}">完了</button></article>`).join('') : '<p>未完了アクションはありません。</p>';
    byId('outcomeActionList').querySelectorAll('[data-complete-action]').forEach(button => button.addEventListener('click', async () => { await outcomeApi(`/api/outcome-actions/${encodeURIComponent(button.dataset.completeAction)}`, { method: 'PUT', body: JSON.stringify({ status: 'DONE' }) }); await loadOutcomeCenter(); }));
  }
  async function loadFimTrend(patientId) {
    const trend = byId('fimTrend');
    if (!patientId) { trend.innerHTML = '<p>患者を選択するとFIM推移を表示します。</p>'; return; }
    const data = await outcomeApi(`/api/fim-assessments?patientId=${encodeURIComponent(patientId)}`);
    trend.innerHTML = `<div class="fim-summary"><span>入棟時 <b>${data.admission?.total ?? '―'}</b></span><span>最新 <b>${data.latest?.total ?? '―'}</b></span><span>利得 <b>${data.gain ?? '―'}</b></span><span>効率 <b>${data.efficiency ?? '―'}</b></span></div>${data.assessments.length ? data.assessments.map(item => `<article><strong>${item.evaluationDate}・${item.stage === 'ADMISSION' ? '入棟時' : item.stage === 'DISCHARGE' ? '退棟時' : '定期'}</strong><span>運動 ${item.motorTotal ?? '未完成'}／認知 ${item.cognitiveTotal ?? '未完成'}／合計 ${item.total ?? '未完成'}</span><small>${item.status === 'CONFIRMED' ? '確認済み' : '下書き'}${item.missingItems?.length ? `・未入力 ${item.missingItems.length}項目` : ''}</small></article>`).join('') : '<p>FIM評価はまだありません。</p>'}`;
  }
  async function loadWardProfile(patientId) {
    const form = byId('wardProfileForm');
    if (!patientId) { form.reset(); byId('wardProfileStatus').textContent = '患者を選択してください'; return; }
    const profile = await outcomeApi(`/api/recovery-ward-profile?patientId=${encodeURIComponent(patientId)}`);
    form.reset();
    for (const [key, value] of Object.entries(profile)) { const field = form.elements.namedItem(key); if (field && value != null) field.value = value; }
    form.elements.patientId.value = patientId;
    byId('wardProfileStatus').textContent = profile.updatedAt ? `保存済み ${new Date(profile.updatedAt).toLocaleString('ja-JP')}` : '未登録';
  }
  function parseFimCsv(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    const parseLine = line => { const values = []; let value = '', quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = ''; } else value += char; } values.push(value); return values; };
    if (!lines.length) return [];
    const headers = parseLine(lines[0]);
    return lines.slice(1).map(line => { const values = parseLine(line); return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])); });
  }
  function updateFimLiveTotal() {
    const form = byId('fimAssessmentForm'); const values = key => Number(form.elements[key].value); const motor = fimMotorKeys.map(values); const cognitive = Object.keys(fimLabels).slice(13).map(values); const complete = list => list.every(value => value >= 1 && value <= 7); byId('fimLiveTotal').textContent = `運動 ${complete(motor) ? motor.reduce((a,b)=>a+b,0) : '―'}／認知 ${complete(cognitive) ? cognitive.reduce((a,b)=>a+b,0) : '―'}／合計 ${complete([...motor,...cognitive]) ? [...motor,...cognitive].reduce((a,b)=>a+b,0) : '―'}`;
  }
  async function loadOutcomeCenter() {
    byId('outcomeMessage').textContent = '更新中…';
    try {
      outcomeData = await outcomeApi('/api/outcome-command-center');
      renderGoals(outcomeData.goals || []);
      const summary = outcomeData.summary || {};
      byId('outcomeMetrics').innerHTML = `<article><strong>${summary.patientCount || 0}</strong><span>管理対象患者</span></article><article><strong>${summary.fimRegisteredCount || 0}</strong><span>FIM登録患者</span></article><article class="warning"><strong>${summary.planReviewCount || 0}</strong><span>計画・コメント要確認</span></article><article class="danger"><strong>${summary.dischargeIssueCount || 0}</strong><span>退院課題あり</span></article><article class="warning"><strong>${summary.dataQualityIssueCount || 0}</strong><span>データ品質要確認</span></article>`;
      const attention = (outcomeData.patients || []).filter(patient => patient.reviewComments || patient.hasDischargeIssue || patient.planStatus !== 'CONFIRMED' || patient.dataQualityIssues?.length).slice(0, 8);
      byId('outcomeAlerts').innerHTML = attention.length ? `<h4>優先確認患者</h4>${attention.map(patient => `<article><div><strong>${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</strong><small>${patient.fimRegistered ? `FIM ${escapeHtml(patient.fimLatest?.value || '登録済み')}` : 'FIM未登録'}・計画 ${patient.planStatus === 'CONFIRMED' ? '確定' : patient.planStatus === 'DRAFT' ? '下書き' : '未作成'}</small><small>${(patient.dataQualityIssues || []).map(escapeHtml).join('・')}</small></div><div class="outcome-tags">${patient.reviewComments ? `<span>確認 ${patient.reviewComments}件</span>` : ''}${patient.fimOverdue ? '<span class="danger">FIM期限超過</span>' : ''}${patient.hasDischargeIssue ? '<span class="danger">退院課題</span>' : ''}</div></article>`).join('')}` : '<p class="outcome-clear">現在、優先確認患者はいません。</p>';
      const patientSelect = byId('outcomeActionForm').elements.patientId; const selected = patientSelect.value; patientSelect.innerHTML = '<option value="">患者を選択</option>' + (outcomeData.patients || []).map(patient => `<option value="${escapeHtml(patient.patientId)}">${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</option>`).join(''); patientSelect.value = selected;
      const fimPatientSelect = byId('fimAssessmentForm').elements.patientId; const selectedFimPatient = fimPatientSelect.value; fimPatientSelect.innerHTML = '<option value="">患者を選択</option>' + (outcomeData.patients || []).map(patient => `<option value="${escapeHtml(patient.patientId)}">${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</option>`).join(''); fimPatientSelect.value = selectedFimPatient;
      const profilePatientSelect = byId('wardProfileForm').elements.patientId; const selectedProfilePatient = profilePatientSelect.value; profilePatientSelect.innerHTML = '<option value="">患者を選択</option>' + (outcomeData.patients || []).map(patient => `<option value="${escapeHtml(patient.patientId)}">${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</option>`).join(''); profilePatientSelect.value = selectedProfilePatient;
      renderActions(outcomeData.actions || []);
      byId('outcomeMessage').textContent = `最終更新 ${new Date(outcomeData.updatedAt).toLocaleString('ja-JP')}`;
    } catch (error) { byId('outcomeMessage').textContent = error.message; }
  }
  byId('outcomeRefresh').addEventListener('click', loadOutcomeCenter);
  byId('outcomeSnapshotForm').addEventListener('submit', async event => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget).entries()); const values = Object.fromEntries(['homeReturnRate','fimGain','performanceIndex'].flatMap(key => form[key] === '' ? [] : [[key, Number(form[key])]])); await outcomeApi('/api/outcome-snapshots', { method: 'POST', body: JSON.stringify({ period: form.period, values, dataType: form.dataType, note: form.note }) }); event.currentTarget.reset(); await loadOutcomeCenter(); });
  byId('outcomeActionForm').addEventListener('submit', async event => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget).entries()); await outcomeApi('/api/outcome-actions', { method: 'POST', body: JSON.stringify(form) }); event.currentTarget.reset(); await loadOutcomeCenter(); });
  byId('fimAssessmentForm').addEventListener('change', event => { updateFimLiveTotal(); if (event.target.name === 'patientId') { byId('wardProfileForm').elements.patientId.value = event.target.value; Promise.all([loadFimTrend(event.target.value), loadWardProfile(event.target.value)]).catch(error => { byId('fimTrend').textContent = error.message; }); } });
  byId('fimAssessmentForm').addEventListener('submit', async event => { event.preventDefault(); const formData = Object.fromEntries(new FormData(event.currentTarget).entries()); const scores = Object.fromEntries(Object.keys(fimLabels).map(key => [key, formData[key] === '' ? null : Number(formData[key])])); const patientId = formData.patientId; await outcomeApi('/api/fim-assessments', { method: 'POST', body: JSON.stringify({ patientId, stage: formData.stage, evaluationDate: formData.evaluationDate, evaluator: formData.evaluator, status: formData.status, locomotionMode: formData.locomotionMode, note: formData.note, scores }) }); event.currentTarget.reset(); updateFimLiveTotal(); await Promise.all([loadFimTrend(patientId), loadOutcomeCenter()]); byId('fimAssessmentForm').elements.patientId.value = patientId; });
  byId('wardProfileForm').addEventListener('change', event => { if (event.target.name === 'patientId') { byId('fimAssessmentForm').elements.patientId.value = event.target.value; Promise.all([loadWardProfile(event.target.value), loadFimTrend(event.target.value)]).catch(error => { byId('wardProfileStatus').textContent = error.message; }); } });
  byId('wardProfileForm').addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()); const saved = await outcomeApi('/api/recovery-ward-profile', { method: 'PUT', body: JSON.stringify(data) }); byId('wardProfileStatus').textContent = `保存しました・算定上限日 ${saved.summary.limitDate || '未計算'}・次回FIM ${saved.summary.nextDue || '未設定'}`; await loadOutcomeCenter(); });
  byId('fimCsvImport').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; const rows = parseFimCsv(await file.text()); const result = await outcomeApi('/api/fim-import', { method: 'POST', body: JSON.stringify({ rows }) }); byId('fimCsvMessage').textContent = `${result.imported}件取込・エラー${result.errors.length}件`; event.target.value = ''; await loadOutcomeCenter(); });
  byId('fimOcrImage').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const message = byId('fimOcrMessage'); message.textContent = 'AI読取中…（30秒～2分）';
    try {
      const imageDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('画像を読み込めませんでした')); reader.readAsDataURL(file); });
      const result = await outcomeApi('/api/fim-ocr', { method: 'POST', body: JSON.stringify({ imageDataUrl }) });
      const form = byId('fimAssessmentForm');
      for (const [key, value] of Object.entries(result.scores || {})) if (form.elements[key]) form.elements[key].value = value ?? '';
      if (result.assessmentDate) form.elements.evaluationDate.value = result.assessmentDate;
      form.elements.stage.value = result.stage || 'PERIODIC'; form.elements.status.value = 'DRAFT';
      form.elements.note.value = [form.elements.note.value, `AI読取（信頼度 ${Math.round(result.confidence * 100)}%）: ${result.comments || '全項目を療法士が確認してください'}`].filter(Boolean).join('\n');
      updateFimLiveTotal();
      const missing = Object.values(result.scores || {}).filter(value => value == null).length;
      message.textContent = `AI下書きを反映しました・信頼度${Math.round(result.confidence * 100)}%・未読取${missing}項目。確認後に保存してください。`;
    } catch (error) { message.textContent = error.message; }
    finally { event.target.value = ''; }
  });
  loadOutcomeCenter();
}
