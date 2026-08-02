const outcomeTherapistList = document.getElementById('therapistList');
const outcomeHost = outcomeTherapistList?.parentElement;

if (outcomeHost) {
  const section = document.createElement('section');
  section.className = 'outcome-command-center';
  section.innerHTML = `
    <div class="outcome-head">
      <div><p class="eyebrow">RECOVERY WARD OUTCOMES</p><h3>回復期病棟アウトカム司令塔</h3></div>
      <button id="outcomeRefresh" type="button">更新</button>
    </div>
    <p class="outcome-description">FIM、AI計画の確認状況、退院課題を患者単位で確認します。</p>
    <div id="outcomeMetrics" class="outcome-metrics"><p>読み込み中…</p></div>
    <div id="outcomeAlerts" class="outcome-alerts"></div>
    <p id="outcomeMessage" class="message" role="status"></p>`;
  outcomeHost.append(section);
  const metrics = document.getElementById('outcomeMetrics');
  const alerts = document.getElementById('outcomeAlerts');
  const message = document.getElementById('outcomeMessage');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  async function loadOutcomeCenter() {
    message.textContent = '更新中…';
    try {
      const response = await fetch('/api/outcome-command-center');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const summary = data.summary || {};
      metrics.innerHTML = `
        <article><strong>${summary.patientCount || 0}</strong><span>管理対象患者</span></article>
        <article><strong>${summary.fimRegisteredCount || 0}</strong><span>FIM登録患者</span></article>
        <article class="warning"><strong>${summary.planReviewCount || 0}</strong><span>計画・コメント要確認</span></article>
        <article class="danger"><strong>${summary.dischargeIssueCount || 0}</strong><span>退院課題あり</span></article>`;
      const attention = (data.patients || []).filter(patient => patient.reviewComments || patient.hasDischargeIssue || patient.planStatus !== 'CONFIRMED').slice(0, 8);
      alerts.innerHTML = attention.length ? `<h4>優先確認患者</h4>${attention.map(patient => `<article><div><strong>${escapeHtml(patient.facilityPatientId)}｜${escapeHtml(patient.name)}</strong><small>${patient.fimRegistered ? `FIM ${escapeHtml(patient.fimLatest?.value || '登録済み')}` : 'FIM未登録'}・計画 ${patient.planStatus === 'CONFIRMED' ? '確定' : patient.planStatus === 'DRAFT' ? '下書き' : '未作成'}</small></div><div class="outcome-tags">${patient.reviewComments ? `<span>確認 ${patient.reviewComments}件</span>` : ''}${patient.hasDischargeIssue ? '<span class="danger">退院課題</span>' : ''}</div></article>`).join('')}` : '<p class="outcome-clear">現在、優先確認患者はいません。</p>';
      message.textContent = `最終更新 ${new Date(data.updatedAt).toLocaleString('ja-JP')}`;
    } catch (error) {
      metrics.innerHTML = '<p>指標を取得できませんでした。</p>';
      alerts.innerHTML = '';
      message.textContent = error.message;
    }
  }
  document.getElementById('outcomeRefresh').addEventListener('click', loadOutcomeCenter);
  loadOutcomeCenter();
}
