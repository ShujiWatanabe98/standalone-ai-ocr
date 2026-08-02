const planById = id => document.getElementById(id);
const planEsc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const planForm = planById('rehabPlanForm');
const planSearch = planById('rehabPlanPatientSearch');
const planMessage = planById('rehabPlanMessage');
const planStatus = planById('rehabPlanStatus');
const ocrHistorySection = planById('view-history');
const rehabPlanSection = planById('view-rehab-plan');
if (ocrHistorySection && rehabPlanSection) ocrHistorySection.insertAdjacentElement('afterend', rehabPlanSection);
const rehabPlanHeading = rehabPlanSection?.querySelector('h2');
if (rehabPlanHeading) rehabPlanHeading.textContent = 'リハビリAI計画';
let planPatients = [];
let selectedPlanPatient = null;
let patientPlans = [];

const aiPlanButton = planById('rehabPlanLoadSource');
aiPlanButton.textContent = 'AI計画を作成';
aiPlanButton.classList.remove('secondary');
aiPlanButton.classList.add('primary');
const planToolbar = rehabPlanSection.querySelector('.rehab-plan-toolbar');
const contextDetails = document.createElement('details');
contextDetails.className = 'rehab-plan-context';
contextDetails.innerHTML = `<summary>AI計画用データを入力・確認</summary><form id="rehabPlanContextForm"><div class="plan-grid plan-meta"><label>確認状態<select name="dataStatus"><option value="UNVERIFIED">未確認を含む</option><option value="VERIFIED">療法士確認済み</option></select></label><label>最終確認日<input name="lastReviewedDate" type="date"></label><label>確認者<input name="reviewedBy" placeholder="担当療法士名"></label><label>発症・受傷日<input name="onsetDate" type="date"></label></div><fieldset><legend>医学情報</legend><div class="plan-grid"><label>診断名<textarea name="diagnosis" rows="2"></textarea></label><label>併存疾患<textarea name="comorbidities" rows="2"></textarea></label><label>手術・治療経過<textarea name="surgeryAndTreatment" rows="3"></textarea></label><label>禁忌・医学的制約<textarea name="medicalRestrictions" rows="3"></textarea></label><label>薬剤・装具・医療機器<textarea name="medicationsAndDevices" rows="3"></textarea></label><label>リスク<textarea name="risks" rows="3"></textarea></label></div></fieldset><fieldset><legend>生活・活動・参加</legend><div class="plan-grid"><label>入院前の生活・ADL<textarea name="preHospitalLife" rows="3"></textarea></label><label>現在のADL<textarea name="currentAdl" rows="3"></textarea></label><label>認知・コミュニケーション<textarea name="cognitionCommunication" rows="3"></textarea></label><label>住環境<textarea name="homeEnvironment" rows="3"></textarea></label><label>家族の支援力・介護状況<textarea name="familySupport" rows="3"></textarea></label><label>仕事・家庭・地域での役割<textarea name="socialRoles" rows="3"></textarea></label></div></fieldset><fieldset><legend>希望・退院方針</legend><div class="plan-grid"><label>本人の希望・優先事項<textarea name="patientGoals" rows="3"></textarea></label><label>家族の希望・課題<textarea name="familyGoals" rows="3"></textarea></label><label>想定する退院先<textarea name="dischargeDestination" rows="3"></textarea></label><label>未確認・質問事項<textarea name="unresolvedQuestions" rows="3"></textarea></label></div></fieldset><fieldset><legend>多職種所見</legend><div class="plan-grid"><label>PT所見<textarea name="ptFindings" rows="3"></textarea></label><label>OT所見<textarea name="otFindings" rows="3"></textarea></label><label>ST所見<textarea name="stFindings" rows="3"></textarea></label><label>看護所見<textarea name="nursingFindings" rows="3"></textarea></label><label>退院支援・MSW所見<textarea name="socialWorkFindings" rows="3"></textarea></label><label>情報源・確認方法<textarea name="sourceNotes" rows="3" placeholder="本人聴取、家族聴取、診療録など"></textarea></label></div></fieldset><div class="context-actions"><button id="rehabPlanContextSave" class="secondary" type="submit">AI計画用データを保存</button><span id="rehabPlanContextMessage" role="status"></span></div></form>`;
planToolbar.after(contextDetails);
const contextForm = planById('rehabPlanContextForm');
const contextMessage = planById('rehabPlanContextMessage');
const planActions = planForm.querySelector('.rehab-plan-actions');
const reviewFieldset = document.createElement('fieldset');
reviewFieldset.className = 'plan-review-comments';
reviewFieldset.innerHTML = '<legend>確認コメント</legend><p class="plan-review-help">AIが判断できない箇所と、療法士・多職種の確認が必要な箇所です。確認後に修正し、計画書を確定してください。</p><div class="plan-grid"><label>AI確認コメント<textarea name="aiReviewComments" rows="6" placeholder="データ不足・矛盾・OCR未確定など"></textarea></label><label>療法士確認コメント<textarea name="therapistReviewComments" rows="6" placeholder="臨床判断・目標期限・負荷量・同意確認など"></textarea></label></div>';
planActions.before(reviewFieldset);

async function planApi(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function localDate() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function patientLabel(patient) { return `${patient.facilityPatientId}｜${patient.name}`; }
function selectedPatientFromInput() { const query = planSearch.value.trim(); return planPatients.find(patient => query === patientLabel(patient) || query === patient.facilityPatientId || query === patient.name) || null; }
async function loadPlanContext() {
  if (!selectedPlanPatient) { contextForm.reset(); contextMessage.textContent = '患者を選択してください。'; return; }
  const context = await planApi(`/api/rehab-plan-context?patientId=${encodeURIComponent(selectedPlanPatient.id)}`);
  contextForm.reset();
  for (const [key, value] of Object.entries(context)) { const field = contextForm.elements.namedItem(key); if (field && value != null) field.value = value; }
  contextMessage.textContent = context.updatedAt ? `保存済み（${new Date(context.updatedAt).toLocaleString('ja-JP')}更新）` : '未登録です。分かる範囲から入力してください。';
}
async function savePlanContext(event) {
  event.preventDefault();
  selectedPlanPatient = selectedPatientFromInput();
  if (!selectedPlanPatient) throw new Error('登録患者を選択してください。');
  contextMessage.textContent = '保存中…';
  const data = { ...Object.fromEntries(new FormData(contextForm).entries()), patientId: selectedPlanPatient.id };
  const saved = await planApi('/api/rehab-plan-context', { method: 'PUT', body: JSON.stringify(data) });
  contextMessage.textContent = `保存しました（${new Date(saved.updatedAt).toLocaleString('ja-JP')}）。AI計画作成時に参照されます。`;
}
function setPlanField(name, value, { overwrite = false } = {}) { const field = planForm.elements.namedItem(name); if (field && (overwrite || !field.value.trim())) field.value = value || ''; }
function formObject() { return Object.fromEntries(new FormData(planForm).entries()); }
function showPlanError(error) {
  const message = error?.message || '処理に失敗しました。';
  planStatus.textContent = '作成エラー';
  planStatus.className = 'badge plan-status-error';
  planMessage.textContent = message;
  planById('rehabPlanEvidence').innerHTML = `<div class="plan-error"><strong>AI計画を作成できませんでした</strong><p>${planEsc(message)}</p><p>患者を選び直して、もう一度「AI計画を作成」を押してください。</p></div>`;
}
function resetPlanForm() {
  planForm.reset();
  planForm.elements.id.value = '';
  planForm.elements.evaluationDate.value = localDate();
  planStatus.textContent = '新規・未保存';
  planStatus.className = 'badge plan-status-draft';
  planMessage.textContent = '';
}
function evaluationEvidence(source) {
  const evaluation = source.latestEvaluation;
  const fields = (evaluation?.fields || []).filter(field => String(field.value || '').trim()).slice(0, 14);
  const trendLines = (source.trends || []).map(item => `${item.label}: ${item.previous} → ${item.current}（${item.change > 0 ? '+' : ''}${item.change}）`);
  return [
    evaluation ? `${evaluation.documentType || '評価用紙'} ${evaluation.evaluationDate || ''}` : '',
    ...fields.map(field => `${field.label}: ${field.value}`),
    ...trendLines,
    source.latestRecord ? `最新経過: ${source.latestRecord.outcome || ''} / 次回: ${source.latestRecord.nextPlan || ''}` : '',
    source.latestVoice ? `患者ボイス: ${source.latestVoice.patientLog || ''} / 不安: ${source.latestVoice.concerns || ''} / 相談: ${source.latestVoice.consultations || ''}` : '',
  ].filter(Boolean);
}
async function loadPlanSource({ overwrite = false } = {}) {
  selectedPlanPatient = selectedPatientFromInput();
  if (!selectedPlanPatient) throw new Error('登録患者を選択してください。');
  aiPlanButton.disabled = true;
  aiPlanButton.textContent = 'AIが作成中…';
  planStatus.textContent = 'AI作成中';
  planMessage.textContent = '評価OCR・経過記録・患者ボイス・前回計画を確認しています。';
  planById('rehabPlanEvidence').innerHTML = '<div class="plan-generating"><strong>AI計画を作成しています</strong><p>患者データを確認しています。このままお待ちください（通常30秒～2分）。</p></div>';
  try {
    const generated = await planApi('/api/rehab-plans/generate', { method: 'POST', body: JSON.stringify({ patientId: selectedPlanPatient.id }) });
    for (const [name, value] of Object.entries(generated.plan || {})) setPlanField(name, value, { overwrite: true });
    const evidence = String(generated.plan?.evidence || '').split('\n').filter(Boolean);
    planById('rehabPlanEvidence').innerHTML = evidence.length ? `<strong>AIが参照した根拠</strong><ul>${evidence.map(item => `<li>${planEsc(item)}</li>`).join('')}</ul>` : '<p>AIが明示できる参照根拠はありません。確認コメントを確認してください。</p>';
    planStatus.textContent = 'AI下書き・未保存';
    planStatus.className = 'badge plan-status-ai';
    planMessage.textContent = 'AIが下書きを作成しました。確認コメントを解消し、内容を確認してから保存・確定してください。';
  } finally {
    aiPlanButton.disabled = false;
    aiPlanButton.textContent = 'AI計画を作成';
  }
  await refreshPlanHistory();
}
function populatePlan(plan) {
  resetPlanForm();
  for (const [key, value] of Object.entries(plan)) { const field = planForm.elements.namedItem(key); if (field && value != null) field.value = value; }
  planForm.elements.id.value = plan.id;
  planStatus.textContent = `${plan.status === 'CONFIRMED' ? '確定' : '下書き'}・第${plan.version}版`;
  planStatus.className = `badge ${plan.status === 'CONFIRMED' ? 'plan-status-confirmed' : 'plan-status-draft'}`;
  planMessage.textContent = `${new Date(plan.updatedAt).toLocaleString('ja-JP')}に更新された計画書を表示しています。`;
  planForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function refreshPlanHistory() {
  if (!selectedPlanPatient) selectedPlanPatient = selectedPatientFromInput();
  if (!selectedPlanPatient) { planById('rehabPlanHistoryList').innerHTML = '<p>患者を選択してください。</p>'; return; }
  patientPlans = await planApi(`/api/rehab-plans?patientId=${encodeURIComponent(selectedPlanPatient.id)}`);
  const list = planById('rehabPlanHistoryList');
  list.innerHTML = patientPlans.length ? patientPlans.map(plan => `<article class="card"><div><strong>第${plan.version}版・${plan.planType === 'INITIAL' ? '初回' : plan.planType === 'DISCHARGE' ? '退院時' : '再評価'}</strong><small>${plan.evaluationDate || '-'}・${plan.status === 'CONFIRMED' ? '確定' : '下書き'}・更新 ${new Date(plan.updatedAt).toLocaleString('ja-JP')}</small></div><div class="history-actions"><button type="button" data-open-plan="${planEsc(plan.id)}">開く</button><button type="button" data-delete-plan="${planEsc(plan.id)}">削除</button></div></article>`).join('') : '<p>計画書はまだありません。</p>';
  list.querySelectorAll('[data-open-plan]').forEach(button => button.addEventListener('click', () => populatePlan(patientPlans.find(plan => plan.id === button.dataset.openPlan))));
  list.querySelectorAll('[data-delete-plan]').forEach(button => button.addEventListener('click', async () => { if (button.dataset.confirm !== 'true') { button.dataset.confirm = 'true'; button.textContent = '再押下で削除'; return; } await planApi(`/api/rehab-plans/${encodeURIComponent(button.dataset.deletePlan)}`, { method: 'DELETE' }); await refreshPlanHistory(); }));
}
async function savePlan(status) {
  selectedPlanPatient = selectedPatientFromInput();
  if (!selectedPlanPatient) throw new Error('登録患者を選択してください。');
  const data = { ...formObject(), patientId: selectedPlanPatient.id, status };
  const id = data.id;
  const saved = await planApi(id ? `/api/rehab-plans/${encodeURIComponent(id)}` : '/api/rehab-plans', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
  populatePlan(saved);
  await refreshPlanHistory();
  planMessage.textContent = status === 'CONFIRMED' ? '計画書を確定しました。修正すると新しい改訂履歴が残ります。' : '下書きを保存しました。';
}
async function initializePlans() {
  planPatients = await planApi('/api/patients');
  planById('rehabPlanPatientList').innerHTML = planPatients.map(patient => `<option value="${planEsc(patientLabel(patient))}"></option>`).join('');
  resetPlanForm();
}
planSearch.addEventListener('change', async () => { selectedPlanPatient = selectedPatientFromInput(); resetPlanForm(); try { await Promise.all([refreshPlanHistory(), loadPlanContext()]); } catch (error) { planMessage.textContent = error.message; } });
contextForm.addEventListener('submit', event => savePlanContext(event).catch(error => { contextMessage.textContent = error.message; }));
planById('rehabPlanLoadSource').addEventListener('click', () => loadPlanSource({ overwrite: false }).catch(showPlanError));
planById('rehabPlanCopyPrevious').addEventListener('click', async () => { try { selectedPlanPatient = selectedPatientFromInput(); await refreshPlanHistory(); if (!patientPlans.length) throw new Error('コピーできる前回計画がありません。'); const previous = patientPlans[0]; resetPlanForm(); populatePlan({ ...previous, id: '', version: Number(previous.version) + 1, status: 'DRAFT', planType: 'REASSESSMENT', evaluationDate: localDate(), updatedAt: new Date().toISOString() }); planForm.elements.id.value = ''; planStatus.textContent = '前回コピー・未保存'; } catch (error) { planMessage.textContent = error.message; } });
planById('rehabPlanNew').addEventListener('click', resetPlanForm);
planById('rehabPlanSaveDraft').addEventListener('click', () => savePlan('DRAFT').catch(error => { planMessage.textContent = error.message; }));
planById('rehabPlanConfirm').addEventListener('click', () => savePlan('CONFIRMED').catch(error => { planMessage.textContent = error.message; }));
planById('rehabPlanPrint').addEventListener('click', () => window.print());
planById('rehabPlanRefresh').addEventListener('click', () => refreshPlanHistory().catch(error => { planMessage.textContent = error.message; }));
initializePlans().catch(error => { planMessage.textContent = `計画書機能を開始できませんでした（${error.message}）。`; });
