const fimKeys = ['eating','grooming','bathing','dressingUpper','dressingLower','toileting','bladder','bowel','transferBedChair','transferToilet','transferTubShower','locomotion','stairs','comprehension','expression','socialInteraction','problemSolving','memory'];
const taskTemplates = [['TOILETING','トイレ動作'],['TRANSFER','移乗'],['WALKING','歩行・移動'],['EATING','食事'],['COGNITION','認知・安全判断'],['MEDICATION','服薬管理'],['VOIDING','排尿・排便管理'],['SWALLOWING','嚥下・食形態'],['HOME','住環境・段差'],['FAMILY','家族介護力'],['EQUIPMENT','福祉用具・装具'],['HOME_VISIT','退院前訪問'],['FAMILY_TRAINING','家族指導'],['SERVICES','介護保険・地域サービス']];

const dateOffset = (days, base = new Date()) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days)).toISOString().slice(0, 10);
const timestampFor = date => `${date}T09:00:00.000Z`;
const scores = (base, index) => Object.fromEntries(fimKeys.map((key, itemIndex) => [key, Math.max(1, Math.min(7, base + ((itemIndex + index) % 3 === 0 ? 1 : 0)))]));
const totals = value => {
  const motor = fimKeys.slice(0, 13).reduce((sum, key) => sum + value[key], 0);
  const cognitive = fimKeys.slice(13).reduce((sum, key) => sum + value[key], 0);
  return { motorTotal: motor, cognitiveTotal: cognitive, total: motor + cognitive };
};

export const outcomeDemoPatientIds = Array.from({ length: 12 }, (_, index) => `OUT${String(index + 1).padStart(3, '0')}`);

export function seedOutcomeDemoData({ db, tenantIds, id, now }) {
  let createdPatients = 0;
  let createdRecords = 0;
  const today = new Date();
  const wards = ['回復期A病棟', '回復期B病棟', '回復期C病棟'];
  const diseases = ['脳血管疾患', '運動器疾患', '廃用症候群'];
  const staff = ['田中 PT', '山本 OT', '伊藤 ST'];
  for (const tenantId of tenantIds) {
    for (let index = 0; index < outcomeDemoPatientIds.length; index += 1) {
      const facilityPatientId = outcomeDemoPatientIds[index];
      let patient = db.patients.find(item => item.tenantId === tenantId && item.facilityPatientId === facilityPatientId);
      if (!patient) {
        const timestamp = now();
        patient = { id: id('patient'), tenantId, facilityPatientId, name: `アウトカムデモ 患者${String(index + 1).padStart(2, '0')}`, birthDate: `${1946 + index}-01-15`, createdAt: timestamp, updatedAt: timestamp, testDataType: 'OUTCOME_COMMAND_CENTER' };
        db.patients.push(patient);
        createdPatients += 1;
      }
      const admissionDate = dateOffset(-70 + index, today);
      const latestDate = dateOffset(-8 + (index % 4), today);
      const discharged = index < 4;
      const dischargeDate = discharged ? dateOffset(-2 + (index % 2), today) : '';
      const plannedDischargeDate = discharged ? dischargeDate : dateOffset(7 + (index % 3) * 7, today);
      if (!db.recoveryWardProfiles.some(item => item.tenantId === tenantId && item.patientId === patient.id)) {
        db.recoveryWardProfiles.push({ id: id('ward-profile'), tenantId, patientId: patient.id, onsetDate: dateOffset(-80 + index, today), admissionDate, plannedDischargeDate, dischargeDate, diseaseCategory: diseases[index % 3], limitDays: index % 3 === 0 ? 150 : 90, fimIntervalDays: 14, wardName: wards[index % 3], note: 'アウトカム司令塔デモデータ', createdAt: now(), updatedAt: now(), updatedBy: 'デモデータ', revisions: [], demoSeed: 'OUTCOME_V1' });
        createdRecords += 1;
      }
      if (!db.fimAssessments.some(item => item.tenantId === tenantId && item.patientId === patient.id)) {
        const admissionScores = scores(2 + (index % 3), index);
        const gain = index % 4 === 3 ? 0 : 1 + (index % 3);
        const latestScores = scores(Math.min(6, 2 + (index % 3) + gain), index);
        const admissionTotals = totals(admissionScores), latestTotals = totals(latestScores);
        db.fimAssessments.push({ id: id('fim'), tenantId, patientId: patient.id, stage: 'ADMISSION', evaluationDate: admissionDate, evaluator: staff[index % 3], locomotionMode: 'WALK', scores: admissionScores, ...admissionTotals, missingItems: [], note: '入棟時評価（デモ）', status: 'CONFIRMED', createdAt: timestampFor(admissionDate), updatedAt: timestampFor(admissionDate), revisions: [], demoSeed: 'OUTCOME_V1' });
        db.fimAssessments.push({ id: id('fim'), tenantId, patientId: patient.id, stage: discharged ? 'DISCHARGE' : 'PERIODIC', evaluationDate: discharged ? dischargeDate : latestDate, evaluator: staff[index % 3], locomotionMode: 'WALK', scores: latestScores, ...latestTotals, missingItems: [], note: index % 4 === 3 ? '改善停滞を確認中（デモ）' : '定期評価（デモ）', status: 'CONFIRMED', createdAt: timestampFor(discharged ? dischargeDate : latestDate), updatedAt: timestampFor(discharged ? dischargeDate : latestDate), revisions: [], demoSeed: 'OUTCOME_V1' });
        createdRecords += 2;
      }
      if (!db.rehabPlanContexts.some(item => item.tenantId === tenantId && item.patientId === patient.id)) {
        db.rehabPlanContexts.push({ id: id('rehab-plan-context'), tenantId, patientId: patient.id, diagnosis: diseases[index % 3], currentAdl: '病棟内ADLを多職種で評価中', homeEnvironment: index % 2 ? '集合住宅・段差あり' : '戸建て・家族同居', familySupport: index % 3 ? '家族支援あり' : '支援調整が必要', patientGoals: '安全に生活範囲を広げたい', familyGoals: '退院後の介助方法を確認したい', dischargeDestination: index % 3 === 2 ? '介護施設' : '自宅', ptFindings: '移動能力を段階的に評価', otFindings: 'ADLと住環境を確認', stFindings: '認知・嚥下を必要時評価', nursingFindings: '病棟ADLを共有', socialWorkFindings: '退院支援を調整', risks: index % 4 === 3 ? 'FIM改善停滞の確認が必要' : '', unresolvedQuestions: '', sourceNotes: 'アウトカム司令塔デモ', dataStatus: 'VERIFIED', lastReviewedDate: latestDate, reviewedBy: staff[index % 3], createdAt: now(), updatedAt: now(), demoSeed: 'OUTCOME_V1' });
        createdRecords += 1;
      }
      if (!db.rehabPlans.some(item => item.tenantId === tenantId && item.patientId === patient.id)) {
        db.rehabPlans.push({ id: id('rehab-plan'), tenantId, patientId: patient.id, version: 1, planType: 'INITIAL', evaluationDate: latestDate, targetDate: plannedDischargeDate, diagnosis: diseases[index % 3], bodyFunction: 'FIM推移を確認', activity: '病棟ADLの拡大', participation: '退院後の生活再開', patientWishes: '自宅または次の生活場所へ安全に移りたい', familyWishes: '介助方法を確認したい', shortTermGoals: '2週間で主要ADLを1段階改善', longTermGoals: '安全な退院生活を整える', dischargeGoal: index % 3 === 2 ? '施設生活へ移行' : '自宅退院', ptApproach: '移動練習', otApproach: 'ADL練習', stApproach: '必要時評価', nursingApproach: '病棟実践', socialApproach: '退院調整', riskManagement: '転倒と体調変化を確認', evidence: 'FIM・病棟情報・退院支援ボード', aiReviewComments: '', therapistReviewComments: 'デモデータ確認済み', status: index % 4 === 3 ? 'DRAFT' : 'CONFIRMED', createdAt: now(), updatedAt: now(), confirmedAt: index % 4 === 3 ? null : now(), revisions: [], demoSeed: 'OUTCOME_V1' });
        createdRecords += 1;
      }
      if (!db.rehabRecords.some(item => item.tenantId === tenantId && item.patientId === patient.id && item.demoSeed === 'OUTCOME_V1')) {
        const durationMinutes = [120, 600, 1000][index % 3];
        db.rehabRecords.push({ id: id('rehab'), tenantId, patientId: patient.id, recordType: 'FOLLOW_UP', recordedAt: latestDate, therapistName: staff[index % 3], intervention: 'アウトカム比較用のリハビリ実施記録', durationMinutes, outcome: 'FIMと退院課題を継続評価', approvalStatus: 'APPROVED', approvedBy: staff[index % 3], approvedAt: now(), createdAt: now(), updatedAt: now(), revisions: [], demoSeed: 'OUTCOME_V1' });
        createdRecords += 1;
      }
      if (!db.dischargeTasks.some(item => item.tenantId === tenantId && item.patientId === patient.id)) {
        taskTemplates.forEach(([key, label], order) => {
          const blocking = !discharged && ((index % 4 === 1 && ['HOME','FAMILY'].includes(key)) || (index % 4 === 3 && ['TOILETING','WALKING'].includes(key)));
          const resolved = discharged || order < 6 || (index % 2 === 0 && ['HOME_VISIT','FAMILY_TRAINING'].includes(key));
          const status = blocking ? 'BLOCKING' : resolved ? 'RESOLVED' : 'IN_PROGRESS';
          db.dischargeTasks.push({ id: id('discharge-task'), tenantId, patientId: patient.id, key, label, order, status, priority: blocking ? 'HIGH' : 'MEDIUM', owner: blocking ? (key === 'HOME' ? 'OT・MSW' : '担当療法士') : staff[index % 3], dueDate: blocking ? dateOffset(-2, today) : plannedDischargeDate, note: blocking ? '担当と期限を確認するデモ課題' : 'デモ確認済み', createdAt: now(), updatedAt: now(), revisions: [], demoSeed: 'OUTCOME_V1' });
        });
        createdRecords += taskTemplates.length;
      }
      if (!db.outcomeActions.some(item => item.tenantId === tenantId && item.patientId === patient.id && item.demoSeed === 'OUTCOME_V1')) {
        db.outcomeActions.push({ id: id('outcome-action'), tenantId, patientId: patient.id, patientLabel: `${facilityPatientId}｜${patient.name}`, category: index % 2 ? 'DISCHARGE' : 'FIM', title: index % 4 === 3 ? 'FIM停滞要因を多職種で確認' : '次回評価と退院課題を確認', owner: staff[index % 3], dueDate: dateOffset(3 + (index % 5), today), status: index < 4 ? 'DONE' : 'OPEN', createdAt: now(), updatedAt: now(), demoSeed: 'OUTCOME_V1' });
        createdRecords += 1;
      }
    }
    for (const [period, homeReturnRate, fimGain, performanceIndex] of [['2026-05',80,25.1,44.2],['2026-06',82,27.4,47.1],['2026-07',85,30.2,50.4]]) {
      if (db.outcomeSnapshots.some(item => item.tenantId === tenantId && item.period === period && item.demoSeed === 'OUTCOME_V1')) continue;
      db.outcomeSnapshots.push({ id: id('outcome-snapshot'), tenantId, period, dataType: 'SAMPLE', values: { homeReturnRate, fimGain, performanceIndex }, note: 'OUT患者による理解用デモ推移', createdAt: now(), updatedAt: now(), demoSeed: 'OUTCOME_V1' });
      createdRecords += 1;
    }
  }
  return { createdPatients, createdRecords };
}
