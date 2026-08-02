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
  async function loadOutcomeCenter() {
    byId('outcomeMessage').textContent = '更新中…';
    try {
      outcomeData = await outcomeApi('/api/outcome-command-center');
      renderGoals(outcomeData.goals || []);
      const summary = outcomeData.summary || {};
      byId('outcomeMetrics').innerHTML = `<article><strong>${summary.patientCount || 0}</strong><span>管理対象患者</span></article><article><strong>${summary.fimRegisteredCount || 0}</strong><span>FIM登録患者</span></article><article class="warning"><strong>${summary.planReviewCount || 0}</strong><span>計画・コメント要確認</span></article><article class="danger"><strong>${summary.dischargeIssueCount || 0}</strong><span>退院課題あり</span></article>`;
      const attention = (outcomeData.patients || []).filter(patient => patient.reviewComments || patient.hasDischargeIssue || patient.planStatus !== 'CONFIRMED').slice(0, 8);
      byId('outcomeAlerts').innerHTML = attention.length ? `<h4>優先確認患者</h4>${attention.map(patient => `<article><div><strong>${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</strong><small>${patient.fimRegistered ? `FIM ${escapeHtml(patient.fimLatest?.value || '登録済み')}` : 'FIM未登録'}・計画 ${patient.planStatus === 'CONFIRMED' ? '確定' : patient.planStatus === 'DRAFT' ? '下書き' : '未作成'}</small></div><div class="outcome-tags">${patient.reviewComments ? `<span>確認 ${patient.reviewComments}件</span>` : ''}${patient.hasDischargeIssue ? '<span class="danger">退院課題</span>' : ''}</div></article>`).join('')}` : '<p class="outcome-clear">現在、優先確認患者はいません。</p>';
      const patientSelect = byId('outcomeActionForm').elements.patientId; const selected = patientSelect.value; patientSelect.innerHTML = '<option value="">患者を選択</option>' + (outcomeData.patients || []).map(patient => `<option value="${escapeHtml(patient.patientId)}">${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</option>`).join(''); patientSelect.value = selected;
      renderActions(outcomeData.actions || []);
      byId('outcomeMessage').textContent = `最終更新 ${new Date(outcomeData.updatedAt).toLocaleString('ja-JP')}`;
    } catch (error) { byId('outcomeMessage').textContent = error.message; }
  }
  byId('outcomeRefresh').addEventListener('click', loadOutcomeCenter);
  byId('outcomeSnapshotForm').addEventListener('submit', async event => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget).entries()); const values = Object.fromEntries(['homeReturnRate','fimGain','performanceIndex'].flatMap(key => form[key] === '' ? [] : [[key, Number(form[key])]])); await outcomeApi('/api/outcome-snapshots', { method: 'POST', body: JSON.stringify({ period: form.period, values, dataType: form.dataType, note: form.note }) }); event.currentTarget.reset(); await loadOutcomeCenter(); });
  byId('outcomeActionForm').addEventListener('submit', async event => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget).entries()); await outcomeApi('/api/outcome-actions', { method: 'POST', body: JSON.stringify(form) }); event.currentTarget.reset(); await loadOutcomeCenter(); });
  loadOutcomeCenter();
}
