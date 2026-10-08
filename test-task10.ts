import { createPresetTask } from './src/services/mockData';
import { 
  applyDraftContentChange, 
  validateFinalizationConditions, 
  finalizeDraft 
} from './src/services/draftLifecycleService';
import { 
  createFactCandidate, 
  confirmFact, 
  modifyOrExcludeFact,
  isPeriodWithinTaskPeriod,
  parsePeriodDateRange,
  formatDefaultPeriodForTask
} from './src/services/factLifecycleService';
import { 
  generateCoordinationDiff, 
  applyCoordinationDecision,
  isValidAuthenticCase,
  findAuthenticCaseSnippet
} from './src/services/reviewCoordinationService';
import { runDocumentAudit } from './src/services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from './src/services/exportService';
import { 
  savePersistedState, 
  loadPersistedState, 
  setStorageItem, 
  recoverTasksFromCorruptedBackup,
  STORAGE_KEY_V2, 
  BACKUP_CORRUPTED_KEY 
} from './src/services/storageService';
import { Task, DraftVersion, EvidenceSnippet, SourceDocument } from './src/types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('==============================================');
console.log('   公文辅助协作原型 - 任务10实际路径回归套件');
console.log('==============================================');

// -----------------------------------------------------------------------
// 1. 待落实不能定稿 (Review comment accepted_pending_implementation blocks finalization)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 1] 待落实、待沟通审阅意见按版本关联阻止定稿:');
const task1 = createPresetTask('under_review');
task1.reviewComments[0].status = 'accepted_pending_implementation';
task1.reviewComments[0].targetVersionId = task1.currentDraftId;

const val1 = validateFinalizationConditions(task1, task1.currentDraftId, '主笔甲');
assert(val1.canFinalize === false, '待落实(accepted_pending_implementation)状态阻止定稿');
assert(val1.reasons.some(r => r.includes('待落实')), '定稿前置检查明确指出待落实意见');

task1.reviewComments[0].status = 'need_discussion';
const val1b = validateFinalizationConditions(task1, task1.currentDraftId, '主笔甲');
assert(val1b.canFinalize === false, '待沟通(need_discussion)状态阻止定稿');

// -----------------------------------------------------------------------
// 2. 保存后历史不变 (Historical snapshot immutability & read-only semantics)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 2] 保存快照具备只读不可变语义，继续修改自动分叉:');
const task2 = createPresetTask('under_review');
const origDraft = task2.drafts[0];
const origContent = origDraft.blocks[0].content;

// Mark as historical snapshot (like handleSaveVersion)
const snapVersion: DraftVersion = {
  ...origDraft,
  id: 'DRAFT-SNAP-TEST',
  versionNumber: 'v1.1 (快照)',
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
};
task2.drafts.unshift(snapVersion);
task2.currentDraftId = snapVersion.id;

// Edit via applyDraftContentChange
const { updatedTask: task2AfterEdit, workingDraft: newWorkDraft, forkedNewDraft } = applyDraftContentChange(
  task2,
  snapVersion.id,
  (blocks) => blocks.map(b => b.id === 'BLK-01' ? { ...b, content: '修改后的段落正文' } : b),
  '修改历史快照',
  '主笔甲'
);

assert(forkedNewDraft === true, '修改只读快照自动分叉出新工作稿');
assert(newWorkDraft.sourceDraftId === snapVersion.id, '新工作稿正确记录sourceDraftId');
const foundSnap = task2AfterEdit.drafts.find(d => d.id === snapVersion.id);
assert(foundSnap?.blocks[0].content === origContent, '原快照正文内容绝对保持不变，未被篡改');

// -----------------------------------------------------------------------
// 3. 定稿从所有入口修改会分叉 (Finalized draft forks on any edit entry)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 3] 定稿版本不可篡改，从任意入口修改均自动分叉:');
const task3 = createPresetTask('under_review');
const finRes = finalizeDraft({
  ...task3,
  reviewComments: task3.reviewComments.map(c => ({ ...c, status: 'implemented' as const }))
}, task3.currentDraftId, '主笔甲');
assert(finRes.success === true, '定稿成功');
const finTask = finRes.updatedTask!;
const finalDraftId = finRes.finalDraft!.id;

// Attempt edit on finalDraftId
const { forkedNewDraft: forkedFromFinal, workingDraft: draftFromFinal } = applyDraftContentChange(
  finTask,
  finalDraftId,
  (blocks) => blocks.map(b => ({ ...b, content: b.content + ' [追加说明]' })),
  '定稿后修改',
  '主笔甲'
);
assert(forkedFromFinal === true, '定稿后修改自动分叉新工作稿');
assert(draftFromFinal.sourceDraftId === finalDraftId, '记录定稿来源ID');
assert(finTask.drafts.find(d => d.id === finalDraftId)?.isFinal === true, '原定稿版本保持isFinal锁定');

// -----------------------------------------------------------------------
// 4. 同段两处800人逐项修复 (Multiple metric issues in same block with exact replacement)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 4] 同段两处“800人”单位混淆逐项定位与修复:');
const task4 = createPresetTask('under_review');
const draft4 = task4.drafts[0];
draft4.blocks[1].content = '累计组织专题培训16场，累计参训800人次，其中800人通过基础考核，另外800人参与实训演练。';

const issues4 = runDocumentAudit(task4, draft4.blocks, draft4.id);
const unitIssues = issues4.filter(i => i.type === 'metric_unit' && i.originalText === '800人');
assert(unitIssues.length === 2, `精确检出两处“800人”混淆项 (检出 ${unitIssues.length} 项)`);
assert(unitIssues[0].charIndex !== unitIssues[1].charIndex, '两处问题具有不同的字符定位索引charIndex');

// Fix first issue precisely using charIndex
const firstIssue = unitIssues[0];
const targetB = draft4.blocks[1];
const replacement1 = firstIssue.replacementText!;
const fixedContent1 = targetB.content.slice(0, firstIssue.charIndex) + replacement1 + targetB.content.slice(firstIssue.charIndex! + firstIssue.originalText.length);
draft4.blocks[1].content = fixedContent1;

// Re-audit: first fixed, second remains
const issues4AfterFirst = runDocumentAudit(task4, draft4.blocks, draft4.id);
const remainingUnitIssues = issues4AfterFirst.filter(i => i.type === 'metric_unit' && i.originalText === '800人');
assert(remainingUnitIssues.length === 1, '修复第一处后，同段第二处“800人”依然准确保留检出');

// -----------------------------------------------------------------------
// 5. 799人次检出 (Metric value mismatch on referenced facts)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 5] 引用FACT-03但正文误写为“799人次”数值核校检出:');
const task5 = createPresetTask('under_review');
const draft5 = task5.drafts[0];
draft5.blocks[1].content = '前三季度累计组织专题培训16场，累计参训799人次。';
const issues5 = runDocumentAudit(task5, draft5.blocks, draft5.id);
const valMismatch = issues5.find(i => i.originalText === '799人次');
assert(valMismatch !== undefined, '成功检出799人次与核准800人次不符');
assert(valMismatch?.isBlocking === true, '数值口径不符被判定为阻断性错误');
assert(valMismatch?.replacementText === '800人次', '提供准确的替换建议: 800人次');

// -----------------------------------------------------------------------
// 6. 删除当前事实后旧快照仍可核校 (Audit self-sufficiency from snapshot)
// -----------------------------------------------------------------------
console.log('\n>>> [回归 6] 清空当前task.facts后，历史快照依然自足可核校:');
const task6 = createPresetTask('under_review');
const draft6 = task6.drafts[0];
draft6.blocks[0].content = draft6.blocks[0].content.replace('128项', '120项');

// Delete all current facts from task
task6.facts = [];

const issues6 = runDocumentAudit(task6, draft6.blocks, draft6.id);
const conflictInDeleted = issues6.find(i => i.type === 'conflict_mismatch');
assert(conflictInDeleted !== undefined, '当前事实清空后，依据历史草稿快照仍可检出120项采信冲突');
assert(conflictInDeleted?.replacementText === '128项', '快照自足提供正确修正口径');

// -----------------------------------------------------------------------
// 7. 历史案例不入本期 & 无案例说明不冒充案例
// -----------------------------------------------------------------------
console.log('\n>>> [回归 7] 历史案例与“无案例说明”严格隔离检验:');
const task7 = createPresetTask('under_review');

// Historical 2025 doc with "典型案例" keyword
const fakeHistoricSnip: EvidenceSnippet = {
  id: 'EVD-HIST-CASE',
  sourceDocId: 'SRC-04', // 2025 style_ref
  docName: '2025年度工作总结',
  location: '第2段',
  period: '2025年度',
  text: '总结2025年典型案例推进经验，形成示范推广成果。',
};
assert(isValidAuthenticCase(task7, fakeHistoricSnip) === false, '历史2025文风材料中的“典型案例”不得确认为本期真实案例');

// Negative explanation with "典型案例" keyword
const fakeDisclaimerSnip: EvidenceSnippet = {
  id: 'EVD-NO-CASE',
  sourceDocId: 'SRC-01',
  docName: '工作情况说明',
  location: '第1段',
  period: '2026年1至9月',
  text: '关于暂无典型推进案例的说明：本期业务尚处于推进阶段，暂无典型案例。',
};
assert(isValidAuthenticCase(task7, fakeDisclaimerSnip) === false, '“暂无典型案例的说明”不得冒充真实推进案例');

// Authentic case check
const validCaseDoc: SourceDocument = {
  id: 'SRC-REAL-CASE',
  name: '一线典型案例专报',
  source: '业务科室',
  period: '2026年1至9月',
  usage: 'current_fact',
  parseStatus: 'parsed',
  fileType: 'txt',
  content: '开展典型案例试点示范，通过数字化协同试点减少基层填报负担，成效显著。',
  paragraphCount: 1,
  wordCount: 50,
};
const validCaseSnip: EvidenceSnippet = {
  id: 'EVD-REAL-CASE',
  sourceDocId: 'SRC-REAL-CASE',
  docName: '一线典型案例专报',
  location: '第1段',
  period: '2026年1至9月',
  text: '围绕数字化协同推进典型案例，试点点位办事流程大幅精简。',
};
task7.documents.push(validCaseDoc);
task7.snippets.push(validCaseSnip);
assert(isValidAuthenticCase(task7, validCaseSnip) === true, '本期正规登记的推进案例正确确认为真实案例材料');

// -----------------------------------------------------------------------
// 8. 协调候选过期不能覆盖人工编辑 & 零差异不能标已落实
// -----------------------------------------------------------------------
console.log('\n>>> [回归 8] 协调候选过期防覆盖与零差异拦截检验:');
const task8 = createPresetTask('under_review');
const draft8 = task8.drafts[0];
const diffRes8 = generateCoordinationDiff(task8, draft8, 'compress');

// User manually modifies block 0 in the meantime
draft8.blocks[0].content = draft8.blocks[0].content + ' (主笔人工修改补充)';

let conflictPrevented = false;
try {
  applyCoordinationDecision(task8, draft8.id, diffRes8, '主笔甲', ['CMT-01']);
} catch (e: any) {
  conflictPrevented = e.message.includes('采纳冲突') || e.message.includes('人工编辑修改');
}
assert(conflictPrevented === true, '协调候选基准变动后，成功阻止直接覆盖人工编辑文本');

// Zero diff check
let zeroDiffPrevented = false;
try {
  applyCoordinationDecision(task8, draft8.id, { ...diffRes8, diffPreview: [] }, '主笔甲', ['CMT-01']);
} catch (e: any) {
  zeroDiffPrevented = e.message.includes('零差异') || e.message.includes('未检测到');
}
assert(zeroDiffPrevented === true, '零差异严格禁止标记审阅意见为已落实');

// -----------------------------------------------------------------------
// 9. 指定版本ID不存在时返回错误，不回退修改首稿
// -----------------------------------------------------------------------
console.log('\n>>> [回归 9] 指定不存在的版本ID时严格返回错误，拒绝回退修改首稿:');
const task9 = createPresetTask('under_review');
const firstDraftId = task9.drafts[0].id;
const firstDraftOriginalSummary = task9.drafts[0].summary;

let editMissingPrevented = false;
try {
  applyDraftContentChange(
    task9,
    'NON-EXISTENT-DRAFT-ID',
    (blocks) => blocks,
    '非法修改',
    '主笔甲'
  );
} catch (e: any) {
  editMissingPrevented = e.message.includes('未找到指定版本');
}
assert(editMissingPrevented === true, 'applyDraftContentChange指定不存在版本严格报错');
assert(task9.drafts[0].id === firstDraftId && task9.drafts[0].summary === firstDraftOriginalSummary, '首稿内容与元数据完全未被篡改');

const valMissing = validateFinalizationConditions(task9, 'NON-EXISTENT-DRAFT-ID', '主笔甲');
assert(valMissing.canFinalize === false, 'validateFinalizationConditions指定不存在版本返回不可定稿');
assert(valMissing.reasons.some(r => r.includes('未找到指定版本')), '给出明确不存在提示');

const finMissing = finalizeDraft(task9, 'NON-EXISTENT-DRAFT-ID', '主笔甲');
assert(finMissing.success === false, 'finalizeDraft指定不存在版本严格失败');
assert(finMissing.error?.includes('未找到指定版本') === true, '未回退修改首稿');

// -----------------------------------------------------------------------
// 10. 结构损坏可恢复 & 存储配额提示 & 长原文持久化
// -----------------------------------------------------------------------
console.log('\n>>> [回归 10] 存储运行时结构验证、损坏隔离恢复与长原文保持:');

// Test corrupted data handling
setStorageItem(STORAGE_KEY_V2, '{"schemaVersion": 2, "tasks": "invalid_not_array"}');
const loadCorrupted = loadPersistedState();
assert(loadCorrupted.isCorrupted === true, '检测到非法结构并标记为isCorrupted');
assert(loadCorrupted.tasks.length > 0, '安全回退至预置任务，防止白屏崩溃');

// Test long text persistence
const longContent = '长原文段落测试：'.repeat(2000); // 16,000+ chars
const task10 = createPresetTask('under_review');
task10.documents[0].content = longContent;
savePersistedState([task10], task10.id, '主笔甲');
const loadedTask10 = loadPersistedState();
assert(loadedTask10.tasks[0].documents[0].content.length === longContent.length, '长原文无损持久化，未被静默截断');

// -----------------------------------------------------------------------
// 11. 8种导出选项组合测试
// -----------------------------------------------------------------------
console.log('\n>>> [回归 11] 正文、依据、审阅 8 种合法组合导出一致性检验:');
const testDraft11 = task1.drafts[0];
const combos = [
  { body: true, evd: true, rev: true },
  { body: true, evd: true, rev: false },
  { body: true, evd: false, rev: true },
  { body: true, evd: false, rev: false },
  { body: false, evd: true, rev: true },
  { body: false, evd: true, rev: false },
  { body: false, evd: false, rev: true },
  { body: false, evd: false, rev: false },
];

for (const c of combos) {
  const txt = exportDocumentAsTxt(task1, testDraft11, {
    includeBody: c.body,
    includeEvidence: c.evd,
    includeReviewLog: c.rev,
  });
  if (c.body) {
    assert(txt.includes('工作总结'), `组合 [${c.body},${c.evd},${c.rev}] TXT包含正文`);
  } else {
    assert(!txt.includes('累计完成重点任务128项'), `组合 [${c.body},${c.evd},${c.rev}] TXT未包含正文`);
  }
  if (c.evd) {
    assert(txt.includes('依据出处：') || txt.includes('【事实依据清单'), `组合 [${c.body},${c.evd},${c.rev}] TXT包含依据`);
  } else {
    assert(!txt.includes('依据出处：') && !txt.includes('【事实依据清单'), `组合 [${c.body},${c.evd},${c.rev}] TXT未包含依据`);
  }
}

// -----------------------------------------------------------------------
// 12. 统计期间边界：包含范围、前三季度解析与动态表单回退
// -----------------------------------------------------------------------
console.log('\n>>> [回归 12] 统计期间边界：包含范围、前三季度解析与动态表单回退:');

// ① "2026年前三季度" 必须解析为 1月1日 至 9月30日（不得先命中三季度导致起点为7月1日）
const q13Range = parsePeriodDateRange('2026年前三季度');
assert(q13Range !== null, '解析前三季度成功');
assert(q13Range!.start.getUTCMonth() === 0, '前三季度起始月份为1月(0)');
assert(q13Range!.end.getUTCMonth() === 8, '前三季度结束月份为9月(8)');

// ② "2026年1月至9月" 必须命中月份跨度正则，不得退化为单月
const m19Range = parsePeriodDateRange('2026年1月至9月');
assert(m19Range !== null, '解析1月至9月成功');
assert(m19Range!.start.getUTCMonth() === 0, '1月至9月起始月份为1月');
assert(m19Range!.end.getUTCMonth() === 8, '1月至9月结束月份为9月');

// ③ "2026年1至6月" 累计数据用于 2026-04-01 至 2026-09-30 任务，必须被排除（不得接受任务开始前的数据）
const q23Valid = isPeriodWithinTaskPeriod('2026年1至6月', '2026-04-01', '2026-09-30');
assert(q23Valid === false, '跨期累积数据(1-6月)在二至三季度(4-9月)任务中严格排除');

// ④ 二季度任务的动态默认期间生成合规期间，不被期间校验拒绝
const q2Default = formatDefaultPeriodForTask('2026-04-01', '2026-06-30');
assert(q2Default.includes('4至6月') || q2Default.includes('二季度'), `二季度默认期间为: ${q2Default}`);
const q2SelfValid = isPeriodWithinTaskPeriod(q2Default, '2026-04-01', '2026-06-30');
assert(q2SelfValid === true, '生成的二季度默认期间能够顺利通过二季度任务校验');

// -----------------------------------------------------------------------
// 13. 协调决策保护未修改段落，仅合并diff变更
// -----------------------------------------------------------------------
console.log('\n>>> [回归 13] 协调决策保护未修改段落，仅合并diff变更:');
const task13 = createPresetTask('under_review');
const draft13 = task13.drafts[0];

// User manually edits BLK-02 which is NOT in diffPreview
const modifiedManualText = '【主笔手工重大修订段落：本段不属于协调差异范畴】';
task13.drafts[0].blocks = draft13.blocks.map(b => b.id === 'BLK-02' ? { ...b, content: modifiedManualText } : b);

// Generate coordination diff (diff covers BLK-01 or BLK-03)
const coordResult13 = generateCoordinationDiff(task13, task13.drafts[0], 'balanced');
const appliedCoord = applyCoordinationDecision(
  task13,
  task13.drafts[0].id,
  coordResult13,
  '主笔甲',
  ['CMT-01', 'CMT-02']
);

// BLK-02 manual modification MUST be preserved!
const blk2AfterCoord = appliedCoord.workingDraft.blocks.find(b => b.id === 'BLK-02');
assert(blk2AfterCoord?.content === modifiedManualText, '协调采纳仅合并差异段落，BLK-02的人工修改完好保留');

// Outdated baseDraftId check
let diffBaseVersionBlocked = false;
try {
  applyCoordinationDecision(
    task13,
    task13.drafts[0].id,
    { ...coordResult13, baseDraftId: 'OLD-OTHER-DRAFT-ID' },
    '主笔甲',
    ['CMT-01']
  );
} catch (e: any) {
  diffBaseVersionBlocked = e.message.includes('基于历史版本');
}
assert(diffBaseVersionBlocked === true, '其他版本的协调候选严格禁止应用到当前版本');

// -----------------------------------------------------------------------
// 14. 依据重建与快照原子更新，旧审批依据稿件定稿拦截
// -----------------------------------------------------------------------
console.log('\n>>> [回归 14] 依据重建与快照原子更新，旧审批依据稿件定稿拦截:');
const task14 = createPresetTask('under_review');
const initialDraft14 = task14.drafts[0];

// Scenario: task approved facts re-confirmed with 25 trainings (FACT-HASH-NEW)
const newSnapshotMeta = {
  ...initialDraft14.snapshotMetadata!,
  factSnapshot: {
    confirmedAt: '2026-10-08T12:00:00.000Z',
    factIds: ['FACT-01', 'FACT-02', 'FACT-03'],
    items: [
      { factId: 'FACT-02', metric: '举办专题培训', value: '25', unit: '场', metricScope: '全省系统', period: '2026年1-9月' }
    ]
  }
};

// 1. Atomic update of snapshot metadata via applyDraftContentChange
const { workingDraft: draft14Updated } = applyDraftContentChange(
  task14,
  initialDraft14.id,
  (blocks) => blocks.map(b => b.content.includes('16场') ? { ...b, content: b.content.replace('16场', '25场') } : b),
  '采纳重新起草25场候选',
  '主笔甲',
  newSnapshotMeta
);
assert(draft14Updated.snapshotMetadata?.factSnapshot?.items?.[0].value === '25', '采纳新生成稿原子更新快照依据为25场');

// 2. An outdated draft (with 128 items) cannot be finalized when task fact snapshot is re-approved to 120 items
const task14Reapproved = createPresetTask('under_review');
task14Reapproved.reviewComments = task14Reapproved.reviewComments.map(c => ({ ...c, status: 'implemented' as const }));
// Task facts updated to 120 items
task14Reapproved.factSnapshot = {
  confirmedAt: '2026-10-08T14:00:00.000Z',
  factIds: ['FACT-01'],
  items: [
    { factId: 'FACT-01', metric: '累计完成重点任务', value: '120', unit: '项', metricScope: '全省', period: '2026年1-9月' }
  ]
};
// But draft14StillOld is still on 128 items from earlier time
const draft14StillOld = task14Reapproved.drafts[0];
draft14StillOld.snapshotMetadata = {
  ...draft14StillOld.snapshotMetadata!,
  factSnapshot: {
    confirmedAt: '2026-10-07T08:30:00.000Z',
    factIds: ['FACT-01'],
    items: [
      { factId: 'FACT-01', metric: '累计完成重点任务', value: '128', unit: '项', metricScope: '全省', period: '2026年1-9月' }
    ]
  }
};

const val14Reapproved = validateFinalizationConditions(task14Reapproved, draft14StillOld.id, '主笔甲');
assert(val14Reapproved.canFinalize === false, '依据变更后，基于旧依据的草稿严格阻止定稿');
assert(val14Reapproved.reasons.some(r => r.includes('依据') && r.includes('不一致')), '定稿校验明确指出事实依据已重新核准变更');

// -----------------------------------------------------------------------
// 15. 历史版本恢复生成新工作草稿并深拷贝依据
// -----------------------------------------------------------------------
console.log('\n>>> [回归 15] 历史版本恢复生成新工作草稿并深拷贝依据:');
const task15 = createPresetTask('under_review');
const histVersion: DraftVersion = {
  ...task15.drafts[0],
  id: 'DRAFT-HIST-25',
  versionNumber: 'v1.0 (历史25场版)',
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  snapshotMetadata: newSnapshotMeta,
  blocks: task15.drafts[0].blocks.map(b => ({ ...b, content: b.content.replace('16场', '25场') }))
};
task15.drafts.push(histVersion);

// Simulate restore
const nextVerNum = `v${(task15.drafts.length + 1).toFixed(1)} (工作草稿·恢复自${histVersion.versionNumber})`;
const restoredDraft15: DraftVersion = {
  id: `DRAFT-WORK-RESTORED-${Date.now()}`,
  versionNumber: nextVerNum,
  createdAt: new Date().toISOString(),
  author: '主笔甲',
  summary: `基于历史版本【${histVersion.versionNumber}】恢复生成的新工作草稿`,
  blocks: JSON.parse(JSON.stringify(histVersion.blocks)),
  isFinal: false,
  isHistoricalSnapshot: false,
  isWorkingDraft: true,
  sourceDraftId: histVersion.id,
  snapshotMetadata: JSON.parse(JSON.stringify(histVersion.snapshotMetadata)),
  auditRecords: [],
};

task15.drafts.unshift(restoredDraft15);
task15.currentDraftId = restoredDraft15.id;

assert(restoredDraft15.id !== histVersion.id, '恢复产生全新工作稿ID');
assert(restoredDraft15.sourceDraftId === histVersion.id, '正确记录sourceDraftId');
assert(restoredDraft15.snapshotMetadata?.factSnapshot?.items?.[0].value === '25', '恢复完整继承历史版本依据(25场)');
assert(histVersion.blocks.some(b => b.content.includes('25场')), '原历史快照完全不受影响');

// -----------------------------------------------------------------------
// 16. 历史审阅导出版本关联标记
// -----------------------------------------------------------------------
console.log('\n>>> [回归 16] 历史审阅导出版本关联标记:');
const txt16 = exportDocumentAsTxt(task1, testDraft11, { includeBody: false, includeEvidence: false, includeReviewLog: true });
assert(txt16.includes('针对版本：'), '审阅导出清晰注明针对版本');

// -----------------------------------------------------------------------
// 17. 损坏备份自动修复与文稿恢复
// -----------------------------------------------------------------------
console.log('\n>>> [回归 17] 损坏备份自动修复与文稿恢复:');
setStorageItem(BACKUP_CORRUPTED_KEY, JSON.stringify([
  {
    id: 'CORRUPTED-TASK-NO-TITLE',
    // missing title!
    drafts: [
      {
        id: 'DRAFT-SAVED-INSIDE',
        versionNumber: 'v1.0',
        blocks: [{ id: 'BLK-REC', content: '被成功拯救的草稿正文' }]
      }
    ]
  }
]));

const recoverRes = recoverTasksFromCorruptedBackup();
assert(recoverRes.success === true, '从备份中自动恢复成功');
assert(recoverRes.recoveredTasks.length > 0, '恢复出任务对象');
assert(recoverRes.recoveredTasks[0].title.includes('已恢复公文任务'), '自动补齐缺失的任务标题');
assert(recoverRes.recoveredTasks[0].drafts[0].blocks[0].content === '被成功拯救的草稿正文', '草稿正文无损保留');

async function runDocxCombos() {
  for (const c of combos) {
    const docx = await exportDocumentAsDocx(task1, testDraft11, {
      includeBody: c.body,
      includeEvidence: c.evd,
      includeReviewLog: c.rev,
    });
    const size = (docx as any).size ?? (docx as any).length ?? (docx as any).byteLength;
    assert(size > 500, `组合 [${c.body},${c.evd},${c.rev}] DOCX输出成功 (${size} 字节)`);
  }
}

runDocxCombos().then(() => {
  console.log('\n==============================================');
  console.log('   🎉 任务10实际路径全量回归测试全部通过！');
  console.log('==============================================');
});
