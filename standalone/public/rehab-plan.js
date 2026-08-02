const planById = id => document.getElementById(id);
const planEsc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const planForm = planById('rehabPlanForm');
const planSearch = planById('rehabPlanPatientSearch');
const planMessage = planById('rehabPlanMessage');
const planStatus = planById('rehabPlanStatus');
let planPatients = [];
let selectedPlanPatient = null;
let patientPlans = [];

async function planApi(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function localDate() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function patientLabel(patient) { return `${patient.facilityPatientId}｜${patient.name}`; }
function selectedPatientFromInput() { const query = planSearch.value.trim(); return planPatients.find(patient => query === patientLabel(patient) || query === patient.facilityPatientId || query === patient.name) || null; }
function setPlanField(name, value, { overwrite = false } = {}) { const field = planForm.elements.namedItem(name); if (field && (overwrite || !field.value.trim())) field.value = value || ''; }
function formObject() { return Object.fromEntries(new FormData(planForm).entries()); }
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
  const source = await planApi(`/api/rehab-plans/source?patientId=${encodeURIComponent(selectedPlanPatient.id)}`);
  const evidence = evaluationEvidence(source);
  planById('rehabPlanEvidence').innerHTML = evidence.length ? `<strong>下書きに使用する根拠</strong><ul>${evidence.map(item => `<li>${planEsc(item)}</li>`).join('')}</ul>` : '<p>参照できる評価・経過・患者ボイスはまだありません。</p>';
  const evaluationText = (source.latestEvaluation?.fields || []).filter(field => String(field.value || '').trim()).slice(0, 24).map(field => `${field.label}: ${field.value}`).join('\n');
  setPlanField('evaluationDate', source.latestEvaluation?.evaluationDate || localDate(), { overwrite });
  setPlanField('bodyFunction', evaluationText, { overwrite });
  setPlanField('onsetAndCourse', source.latestRecord?.preCondition || '', { overwrite });
  setPlanField('activity', source.latestRecord?.outcome || '', { overwrite });
  setPlanField('riskManagement', [source.latestRecord?.riskNotes, source.latestVoice?.concerns].filter(Boolean).join('\n'), { overwrite });
  setPlanField('patientWishes', [source.latestVoice?.patientLog, source.latestVoice?.concerns, source.latestVoice?.consultations].filter(Boolean).join('\n'), { overwrite });
  setPlanField('shortTermGoals', source.latestRecord?.nextPlan || '', { overwrite });
  setPlanField('evidence', evidence.join('\n'), { overwrite: true });
  planMessage.textContent = '評価OCR・経過記録・患者ボイスから下書きを作成しました。内容を確認して保存してください。';
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
planSearch.addEventListener('change', async () => { selectedPlanPatient = selectedPatientFromInput(); resetPlanForm(); try { await refreshPlanHistory(); } catch (error) { planMessage.textContent = error.message; } });
planById('rehabPlanLoadSource').addEventListener('click', () => loadPlanSource({ overwrite: false }).catch(error => { planMessage.textContent = error.message; }));
planById('rehabPlanCopyPrevious').addEventListener('click', async () => { try { selectedPlanPatient = selectedPatientFromInput(); await refreshPlanHistory(); if (!patientPlans.length) throw new Error('コピーできる前回計画がありません。'); const previous = patientPlans[0]; resetPlanForm(); populatePlan({ ...previous, id: '', version: Number(previous.version) + 1, status: 'DRAFT', planType: 'REASSESSMENT', evaluationDate: localDate(), updatedAt: new Date().toISOString() }); planForm.elements.id.value = ''; planStatus.textContent = '前回コピー・未保存'; } catch (error) { planMessage.textContent = error.message; } });
planById('rehabPlanNew').addEventListener('click', resetPlanForm);
planById('rehabPlanSaveDraft').addEventListener('click', () => savePlan('DRAFT').catch(error => { planMessage.textContent = error.message; }));
planById('rehabPlanConfirm').addEventListener('click', () => savePlan('CONFIRMED').catch(error => { planMessage.textContent = error.message; }));
planById('rehabPlanPrint').addEventListener('click', () => window.print());
planById('rehabPlanRefresh').addEventListener('click', () => refreshPlanHistory().catch(error => { planMessage.textContent = error.message; }));
initializePlans().catch(error => { planMessage.textContent = `計画書機能を開始できませんでした（${error.message}）。`; });
