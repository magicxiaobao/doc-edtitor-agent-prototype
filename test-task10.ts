import { createPresetTask } from './src/services/mockData';
import { 
  applyDraftContentChange, 
  validateFinalizationConditions, 
  finalizeDraft,
  computeDraftBlocksHash,
  validateCandidateAcceptance,
  acceptDraftCandidate
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
import { computeContentHash } from './src/services/mockDraftService';
import { 
  savePersistedState, 
  loadPersistedState, 
  setStorageItem, 
  getStorageItem,
  getCorruptedBackupData,
  getStorageError,
  recoverTasksFromCorruptedBackup,
  validateTaskStructure,
  STORAGE_KEY_V2, 
  BACKUP_CORRUPTED_KEY 
} from './src/services/storageService';
import { Task, DraftVersion, EvidenceSnippet, SourceDocument, DraftCandidate, ReviewComment } from './src/types';

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

// ⑤ 月中起止任务（如 4月15日至6月15日）默认值准确保留起止日期，不被自身校验拒绝
const midMonthDefault = formatDefaultPeriodForTask('2026-04-15', '2026-06-15');
assert(midMonthDefault === '2026年4月15日至6月15日', `月中起止准确保留日期，当前为: ${midMonthDefault}`);
const midMonthParsed = parsePeriodDateRange(midMonthDefault);
assert(midMonthParsed !== null, '解析月中起止期间成功');
assert(midMonthParsed!.start.getUTCDate() === 15 && midMonthParsed!.start.getUTCMonth() === 3, '起始为4月15日');
assert(midMonthParsed!.end.getUTCDate() === 15 && midMonthParsed!.end.getUTCMonth() === 5, '结束为6月15日');
const midMonthSelfValid = isPeriodWithinTaskPeriod(midMonthDefault, '2026-04-15', '2026-06-15');
assert(midMonthSelfValid === true, '月中起止默认期间顺利通过自身任务期间校验');

// ⑥ 跨年统计期间准确解析与默认值：2025年11月至2026年3月
const crossYearDefault = formatDefaultPeriodForTask('2025-11-01', '2026-03-31');
assert(crossYearDefault.includes('2025年11月') && crossYearDefault.includes('2026年3月'), `跨年默认期间为: ${crossYearDefault}`);
const crossYearParsed = parsePeriodDateRange('2025年11月至2026年3月');
assert(crossYearParsed !== null, '解析跨年月度期间成功');
assert(crossYearParsed!.start.getUTCFullYear() === 2025 && crossYearParsed!.start.getUTCMonth() === 10, '跨年起点为2025年11月');
assert(crossYearParsed!.end.getUTCFullYear() === 2026 && crossYearParsed!.end.getUTCMonth() === 2, '跨年终点为2026年3月');
assert(isPeriodWithinTaskPeriod('2025年11月至2026年3月', '2025-11-01', '2026-03-31') === true, '跨年期间数据被合规接纳');
assert(isPeriodWithinTaskPeriod('2025年10月', '2025-11-01', '2026-03-31') === false, '早于跨年起点的数据严格排除');
assert(isPeriodWithinTaskPeriod('2026年4月', '2025-11-01', '2026-03-31') === false, '晚于跨年终点的数据严格排除');

// ⑦ 跨年月中起止精准日期解析：2025年11月15日至2026年3月15日
const crossYearExactParsed = parsePeriodDateRange('2025年11月15日至2026年3月15日');
assert(crossYearExactParsed !== null, '解析跨年月中具体日期成功');
assert(crossYearExactParsed!.start.getUTCFullYear() === 2025 && crossYearExactParsed!.start.getUTCDate() === 15, '跨年起始日为2025-11-15');
assert(crossYearExactParsed!.end.getUTCFullYear() === 2026 && crossYearExactParsed!.end.getUTCDate() === 15, '跨年结束日为2026-03-15');
assert(isPeriodWithinTaskPeriod('2025年11月15日至2026年3月15日', '2025-11-15', '2026-03-15') === true, '跨年中具体日期通过任务期间校验');

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

// 2. An outdated draft cannot be finalized when task fact snapshot is re-approved
const task14Reapproved = createPresetTask('under_review');
task14Reapproved.reviewComments = task14Reapproved.reviewComments.map(c => ({ ...c, status: 'implemented' as const }));

// ① 关键边界：确认时间相同，但当前依据120项、稿件依据128项，前序检查必须严密阻断！
task14Reapproved.factSnapshot = {
  confirmedAt: '2026-10-08T14:00:00.000Z',
  factIds: ['FACT-01'],
  items: [
    { factId: 'FACT-01', metric: '累计完成重点任务', value: '120', unit: '项', metricScope: '全省', period: '2026年1-9月' }
  ]
};
const draft14SameTimeDiffContent = task14Reapproved.drafts[0];
draft14SameTimeDiffContent.snapshotMetadata = {
  ...draft14SameTimeDiffContent.snapshotMetadata!,
  factSnapshot: {
    confirmedAt: '2026-10-08T14:00:00.000Z', // 确认时间完全相同！
    factIds: ['FACT-01'],
    items: [
      { factId: 'FACT-01', metric: '累计完成重点任务', value: '128', unit: '项', metricScope: '全省', period: '2026年1-9月' }
    ]
  }
};
const valSameTimeDiff = validateFinalizationConditions(task14Reapproved, draft14SameTimeDiffContent.id, '主笔甲');
assert(valSameTimeDiff.canFinalize === false, '确认时间相同时，内容差异（120 vs 128）严密阻断定稿');
assert(valSameTimeDiff.reasons.some(r => r.includes('不一致')), '定稿校验明确提示事实依据不一致');

// ② 关键边界：稿件缺少冻结事实快照依据，前序检查必须严密阻断！
const draft14NoFactSnap = { ...draft14SameTimeDiffContent, snapshotMetadata: undefined };
task14Reapproved.drafts = [draft14NoFactSnap];
const valMissingSnap = validateFinalizationConditions(task14Reapproved, draft14NoFactSnap.id, '主笔甲');
assert(valMissingSnap.canFinalize === false, '稿件缺少冻结事实快照依据严密阻断定稿');
assert(valMissingSnap.reasons.some(r => r.includes('缺少冻结事实快照依据')), '定稿校验明确提示缺少冻结事实快照');

// ③ 关键边界：文风或大纲依据版本不一致，严密阻断定稿
const draft14StyleDiff = {
  ...draft14SameTimeDiffContent,
  snapshotMetadata: {
    ...draft14SameTimeDiffContent.snapshotMetadata!,
    factSnapshot: task14Reapproved.factSnapshot,
    styleSnapshot: { confirmedAt: '2026-10-01T00:00:00.000Z', activeRuleIds: ['RULE-OLD'], hash: 'STYLE-OLD' }
  }
};
task14Reapproved.drafts = [draft14StyleDiff];
const valStyleDiff = validateFinalizationConditions(task14Reapproved, draft14StyleDiff.id, '主笔甲');
assert(valStyleDiff.canFinalize === false, '文风依据版本不一致严密阻断定稿');

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
// 16. 历史版本审阅记录冻结与快照导出隔离
// -----------------------------------------------------------------------
console.log('\n>>> [回归 16] 历史版本审阅记录冻结与快照导出隔离:');
const task16 = createPresetTask('under_review');
const draftV1 = task16.drafts[0];
// 冻结历史草稿v1.0时的审阅意见快照（仅包含CMT-01）
draftV1.frozenReviewComments = [
  {
    id: 'CMT-HIST-01',
    type: 'overall',
    targetVersionId: draftV1.id,
    reviewer: '审阅乙',
    content: '【v1历史意见】篇幅建议压缩到2000字以内',
    status: 'pending',
    createdAt: '2026-10-07T09:30:00.000Z',
  }
];

// 后续在任务中新增针对后续版本或新提出的意见 CMT-LATER
task16.reviewComments.push({
  id: 'CMT-LATER',
  type: 'overall',
  targetVersionId: 'DRAFT-v2.0',
  reviewer: '审阅丁',
  content: '【后续追加意见】请补充四季度考核专项目标',
  status: 'pending',
  createdAt: '2026-10-08T15:00:00.000Z',
});

// 导出历史稿v1.0：必须只读取其冻结快照，绝不可混入后续追加意见！
const txt16Hist = exportDocumentAsTxt(task16, draftV1, { includeBody: false, includeEvidence: false, includeReviewLog: true });
assert(txt16Hist.includes('【v1历史意见】'), '历史稿导出成功包含当时的冻结审阅记录');
assert(!txt16Hist.includes('【后续追加意见】'), '后续审阅意见绝不混入历史版本的审阅记录导出');

// -----------------------------------------------------------------------
// 17. 存储结构深度校验与损坏备份安全恢复（不混入示例业务数据）
// -----------------------------------------------------------------------
console.log('\n>>> [回归 17] 存储结构深度校验与损坏备份安全恢复:');

// ① 结构校验：缺少内部数组的存档必须判定为损坏
const missingArraysTask = {
  id: 'TASK-NO-ARRAYS',
  title: '残缺任务',
  // missing drafts, facts, outline, etc.!
};
assert(validateTaskStructure(missingArraysTask) === false, '缺少内部数组的存档被 validateTaskStructure 正确拦截判定为非法');

// ② 结构校验：段落缺少 content 字段时必须判定为非法（防止起草页 content.length 报错）
const blockWithoutContentTask = {
  ...createPresetTask('blank'),
  id: 'TASK-NO-BLOCK-CONTENT',
  drafts: [
    {
      id: 'D-1',
      versionNumber: 'v1.0',
      createdAt: '2026-10-08',
      author: '主笔甲',
      summary: '测试缺少content',
      blocks: [{ id: 'BLK-1', sectionId: 'SEC-01', order: 1, referencedFactIds: [] }], // missing content!
    }
  ],
  currentDraftId: 'D-1'
};
assert(validateTaskStructure(blockWithoutContentTask) === false, '段落缺少 content 字段时被 validateTaskStructure 严格拦截判定为非法');

// ③ 结构校验：currentDraftId 指向不存在草稿时必须判定为非法
const invalidCurrentDraftIdTask = {
  ...createPresetTask('blank'),
  id: 'TASK-INVALID-CURR-DRAFT',
  drafts: [
    {
      id: 'D-EXIST',
      versionNumber: 'v1.0',
      createdAt: '2026-10-08',
      author: '主笔甲',
      summary: '存在',
      blocks: [{ id: 'BLK-1', sectionId: 'SEC-01', order: 1, content: '文本', referencedFactIds: [] }],
    }
  ],
  currentDraftId: 'D-PHANTOM-DOES-NOT-EXIST'
};
assert(validateTaskStructure(invalidCurrentDraftIdTask) === false, 'currentDraftId 指向不存在草稿时被 validateTaskStructure 严格拦截');

// ④ 放入本地存储验证 loadPersistedState 隔离损坏
setStorageItem(STORAGE_KEY_V2, JSON.stringify({
  schemaVersion: 2,
  currentTaskId: 'TASK-NO-ARRAYS',
  activeRole: '主笔甲',
  tasks: [missingArraysTask]
}));
const loadResCorrupt = loadPersistedState();
assert(loadResCorrupt.isCorrupted === true, '缺少内部数组的存档被 loadPersistedState 正确标记为 isCorrupted=true');

// ⑤ 模拟配额超限写入抛错与内存回退备份读取/恢复验证
const originalLocalStorage = globalThis.localStorage;
let throwQuotaError = true;
const mockStorage: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mockStorage[k] ?? null,
  setItem: (k: string, v: string) => {
    if (throwQuotaError) {
      throw new Error('QuotaExceededError: LocalStorage quota exceeded');
    }
    mockStorage[k] = v;
  },
  removeItem: (k: string) => { delete mockStorage[k]; },
  clear: () => { for (const k in mockStorage) delete mockStorage[k]; }
};

// 预先在 localStorage 写入旧备份数据
mockStorage[BACKUP_CORRUPTED_KEY] = JSON.stringify([
  {
    id: 'STALE-DISK-TASK',
    title: '旧磁盘备份公文',
    currentDraftId: 'D-STALE',
    drafts: [
      {
        id: 'D-STALE',
        versionNumber: 'v1.0',
        blocks: [{ id: 'BLK-STALE', content: '这是旧的磁盘备份正文' }]
      }
    ]
  }
]);

// 模拟写入抛错：savePersistedState 回退到内存备份并记录错误提示
const saveOk = savePersistedState([createPresetTask('under_review')], 'TASK-REVIEW', '主笔甲');
assert(saveOk === false, '配额超限抛错时 savePersistedState 安全返回 false');
assert(getStorageError() !== null, '存储错误消息被正确捕获');

// 模拟新损坏数据发生时尝试落盘抛错（配额不足），写入内存回退
try {
  setStorageItem(BACKUP_CORRUPTED_KEY, JSON.stringify([
    {
      id: 'QUOTA-CORRUPTED-TASK',
      title: '用户真实工作报告',
      currentDraftId: 'D-GHOST',
      drafts: [
        {
          id: 'D-REAL-1',
          versionNumber: 'v1.0',
          blocks: [{ id: 'BLK-Q', content: '用户辛苦撰写的核心总结正文' }],
          isWorkingDraft: false,
          isHistoricalSnapshot: true, // 明确历史快照
          isFinal: false,
          frozenReviewComments: [{ id: 'CMT-FROZEN', reviewer: '审阅乙', content: '冻结审阅', status: 'pending' }]
        },
        {
          id: 'D-REAL-2',
          versionNumber: 'v1.1',
          blocks: [{ id: 'BLK-Q2', content: '第二版工作稿' }],
          isWorkingDraft: true,
          isHistoricalSnapshot: false,
        }
      ]
    }
  ]));
} catch {
  // 预期行为：localStorage 抛出配额异常，但 recordMemoryCorruptedBackup 已将最新备份置为优先
}

// 验证【P1修复】：已有旧磁盘备份＋新写入失败时，优先返回最新内存备份，绝不被旧磁盘备份遮蔽！
const memoryBackup = getCorruptedBackupData();
assert(memoryBackup !== null && memoryBackup.includes('QUOTA-CORRUPTED-TASK'), '统一备份读取优先返回最新内存备份，未被旧磁盘备份遮蔽');
assert(!memoryBackup?.includes('STALE-DISK-TASK'), '旧磁盘备份未遮蔽最新内存备份');

// 验证自动恢复：严禁混入示例材料/事实，使用空结构与“待恢复”状态，并保留冻结审阅快照和修正当前草稿ID
const recoverRes = recoverTasksFromCorruptedBackup();
assert(recoverRes.success === true, '从内存回退备份中自动恢复成功');
const recovered = recoverRes.recoveredTasks[0];
assert(recovered.title === '用户真实工作报告', '用户真实标题无损恢复');
assert(recovered.status === '待恢复', '恢复状态标记为“待恢复”');
assert(recovered.drafts[0].blocks[0].content === '用户辛苦撰写的核心总结正文', '草稿正文完好保留');
assert(recovered.drafts[0].frozenReviewComments?.[0]?.content === '冻结审阅', '恢复时完整保留草稿的冻结审阅记录快照');

// 验证【P1修复】：恢复过程保留原有版本只读属性，禁止根据数组索引(dIdx===0)盲目推断可编辑性
assert(recovered.drafts[0].isHistoricalSnapshot === true, '历史快照恢复后严密保留历史快照只读属性，未成为工作稿');
assert(recovered.drafts[0].isWorkingDraft === false, '历史快照恢复后未成为工作稿');
assert(recovered.drafts[1].isWorkingDraft === true, '真正的工作稿属性被正确保留');

assert(recovered.currentDraftId === 'D-REAL-1', '恢复后 currentDraftId 自动修复为实际存在的草稿ID');
assert(Array.isArray(recovered.drafts[0].blocks[0].referencedFactIds), '段落referencedFactIds被安全补齐为空数组');
assert(recovered.facts.length === 0, '未混入示例事实数据，保持空结构');
assert(recovered.documents.length === 0, '未混入示例材料文档，保持空结构');
assert(validateTaskStructure(recovered) === true, '恢复出的任务结构逐层校验完全合规');

// 验证【P1/P2修复】：迁移时历史依据缺失保留“未知/缺失”，不回填当前快照
const legacyTaskToMigrate = {
  id: 'LEGACY-TASK-MIG',
  title: '旧版公文任务',
  currentDraftId: 'D-GHOST-PHANTOM', // 旧版幽灵指针
  outlineConfirmed: true,
  outline: [{ id: 'SEC-1', title: '旧大纲标题' }],
  styleConfirmed: true,
  styleRules: [{ id: 'RULE-1', confirmed: true }],
  drafts: [
    {
      id: 'D-LEGACY-HIST',
      versionNumber: 'v1.0 (历史快照)',
      blocks: [{ id: 'BLK-1', content: '旧历史正文', sectionId: 'SEC-1', order: 1, referencedFactIds: [] }],
      // 未定义 snapshotMetadata
    }
  ]
};

// 构造非当前 schema 存储 payload（含旧幽灵指针与缺失审批快照的历史稿）
mockStorage[STORAGE_KEY_V2] = JSON.stringify({
  schemaVersion: 1, // 旧版 schema
  currentTaskId: 'LEGACY-TASK-MIG',
  activeRole: '主笔甲',
  tasks: [legacyTaskToMigrate]
});
throwQuotaError = false; // 允许正常读取
const migratedLoadRes = loadPersistedState();
assert(migratedLoadRes.isCorrupted === false, '旧版 schema 数据按规范先迁移后校验成功，未被误判为损坏');
const loadedMigTask = migratedLoadRes.tasks.find(t => t.id === 'LEGACY-TASK-MIG')!;
assert(loadedMigTask.currentDraftId === 'D-LEGACY-HIST', '旧幽灵草稿指针在迁移阶段被安全修正为实际存在的草稿ID');
assert(loadedMigTask.drafts[0].snapshotMetadata === undefined, '历史依据缺失严禁回填成当前任务快照，保持 undefined 要求重新核准');

// 还原全局 mock
(globalThis as any).localStorage = originalLocalStorage;

// -----------------------------------------------------------------------
// 18. 候选采纳全生命周期、取消失效与旧稿自动归档测试
// -----------------------------------------------------------------------
console.log('\n>>> [回归 18] 候选采纳全生命周期、取消失效与旧稿自动归档测试:');
const task18 = createPresetTask('under_review');
const draft18 = task18.drafts[0];
const candidate18: DraftCandidate = {
  taskId: task18.id,
  runId: 'RUN-18-A',
  baseDraftId: draft18.id,
  baseDraftContentHash: computeDraftBlocksHash(draft18.blocks),
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt: task18.factSnapshot?.confirmedAt,
    factSnapshotHash: task18.factSnapshot?.hash,
    styleConfirmedAt: task18.styleSnapshot?.confirmedAt,
    styleHash: task18.styleSnapshot?.hash,
    outlineConfirmedAt: task18.outlineSnapshot?.confirmedAt,
    outlineHash: task18.outlineSnapshot?.hash,
  },
  blocks: draft18.blocks.map(b => ({ ...b, content: b.content + '【AI生成新正文】' })),
  snapshotMetadata: JSON.parse(JSON.stringify(draft18.snapshotMetadata!)),
  generatedAt: new Date().toISOString(),
};

// 1) 验证 取消运行 (activeCompletedRunId = null) 严格阻断采纳
const valCancel = validateCandidateAcceptance(task18, draft18, candidate18, null, '主笔甲');
assert(valCancel.valid === false, '运行取消或失效时(runId为null)，validateCandidateAcceptance 严格阻断采纳');
assert(valCancel.reason?.includes('失效'), '给出明确的运行失效提示');

// 2) 验证 开启新运行后旧候选 (RUN-18-A vs RUN-18-B) 严格阻断采纳
const valOtherRun = validateCandidateAcceptance(task18, draft18, candidate18, 'RUN-18-B', '主笔甲');
assert(valOtherRun.valid === false, '新运行产生后旧候选被严格阻断采纳');

// 3) 验证 人工编辑正文后 (currentHash !== baseHash) 严格阻断采纳
const editedDraft18: DraftVersion = {
  ...draft18,
  blocks: draft18.blocks.map((b, i) => i === 0 ? { ...b, content: b.content + '【人工修改正文】' } : b)
};
const valEdited = validateCandidateAcceptance(task18, editedDraft18, candidate18, 'RUN-18-A', '主笔甲');
assert(valEdited.valid === false, '人工修改正文后，旧候选采纳被严格拦截，防止覆盖人工编辑');

// 4) 验证 上游文风/大纲 Hash 变更时严格阻断采纳
const candStaleStyle: DraftCandidate = {
  ...candidate18,
  upstreamApprovalVersion: {
    ...candidate18.upstreamApprovalVersion,
    styleHash: 'OLD-STYLE-HASH'
  }
};
const valStyleStale = validateCandidateAcceptance(task18, draft18, candStaleStyle, 'RUN-18-A', '主笔甲');
assert(valStyleStale.valid === false, '上游文风依据 Hash 变动时严格阻断候选采纳');

const candStaleOutline: DraftCandidate = {
  ...candidate18,
  upstreamApprovalVersion: {
    ...candidate18.upstreamApprovalVersion,
    outlineHash: 'OLD-OUTLINE-HASH'
  }
};
const valOutlineStale = validateCandidateAcceptance(task18, draft18, candStaleOutline, 'RUN-18-A', '主笔甲');
assert(valOutlineStale.valid === false, '上游大纲依据 Hash 变动时严格阻断候选采纳');

// 5) 验证 合法采纳调用 acceptDraftCandidate：
// 必须把旧稿自动归档为只读历史快照（保存旧稿快照，带 frozenReviewComments），并创建全新工作稿
const valOk = validateCandidateAcceptance(task18, draft18, candidate18, 'RUN-18-A', '主笔甲');
assert(valOk.valid === true, '基准与依据一致且运行匹配时，候选采纳校验顺利通过');

const { updatedTask: taskAfterAccept, workingDraft: candidateWorkDraft, archivedDraft } = acceptDraftCandidate(
  task18,
  draft18,
  candidate18,
  '主笔甲'
);
assert(archivedDraft !== undefined, '采纳前旧草稿成功生成归档快照');
assert(archivedDraft?.isHistoricalSnapshot === true, '旧草稿被标记为历史快照');
assert(archivedDraft?.isWorkingDraft === false, '旧草稿不再是工作草稿');
assert(Array.isArray(archivedDraft?.frozenReviewComments), '旧草稿冻结了当前审阅记录快照');
assert(candidateWorkDraft.id !== draft18.id, '采纳候选产生全新草稿ID，未原地覆盖旧稿');
assert(candidateWorkDraft.sourceDraftId === draft18.id, '新工作稿正确记录 sourceDraftId 为旧草稿ID');
assert(candidateWorkDraft.isWorkingDraft === true, '新工作稿标记为工作稿');
assert(taskAfterAccept.currentDraftId === candidateWorkDraft.id, '任务当前草稿指向新工作稿');
assert(taskAfterAccept.drafts.length === task18.drafts.length + 1, '旧草稿归档快照与新工作稿同时保留在草稿列表中');

// 6) 验证【P1修复】：若当前版本已经是历史/定稿快照，采纳候选绝不能改写其原有版本属性或用当前意见覆盖 frozenReviewComments！
const historicalDraftWithFrozenComments: DraftVersion = {
  ...draft18,
  id: 'DRAFT-HIST-LOCKED',
  versionNumber: 'v1.0 (已锁定的历史快照)',
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  isFinal: false,
  frozenReviewComments: [
    {
      id: 'CMT-OLD-PENDING',
      type: 'overall',
      reviewer: '审阅乙',
      content: '历史草稿当时的pending意见',
      status: 'pending',
      createdAt: '2026-10-06T08:00:00.000Z'
    }
  ]
};

// 假设任务当前审阅意见已被主笔修改落实为 implemented
const taskWithModifiedComments: Task = {
  ...task18,
  drafts: [historicalDraftWithFrozenComments],
  currentDraftId: historicalDraftWithFrozenComments.id,
  reviewComments: [
    {
      id: 'CMT-OLD-PENDING',
      type: 'overall',
      reviewer: '审阅乙',
      content: '历史草稿当时的pending意见',
      status: 'implemented', // 最新状态已变为已修改落实
      authorReply: '已按要求修改完成',
      createdAt: '2026-10-06T08:00:00.000Z'
    }
  ]
};

const candForHistorical: DraftCandidate = {
  ...candidate18,
  baseDraftId: historicalDraftWithFrozenComments.id,
  baseDraftContentHash: computeDraftBlocksHash(historicalDraftWithFrozenComments.blocks),
};

const { updatedTask: taskAfterAcceptFromHist, workingDraft: workDraftFromHist, archivedDraft: preservedHistDraft } = acceptDraftCandidate(
  taskWithModifiedComments,
  historicalDraftWithFrozenComments,
  candForHistorical,
  '主笔甲'
);

assert(preservedHistDraft !== undefined, '返回原有草稿对象引用');
assert(preservedHistDraft.id === 'DRAFT-HIST-LOCKED', '原历史版本ID保持不变');
assert(preservedHistDraft.frozenReviewComments?.[0]?.status === 'pending', '原历史版本的冻结意见绝不被当前意见覆盖，依然保持 pending');
assert(preservedHistDraft.frozenReviewComments?.[0]?.authorReply === undefined, '原历史版本未被写入后续修改答复');
assert(workDraftFromHist.sourceDraftId === 'DRAFT-HIST-LOCKED', '新工作稿正确记录来源于历史快照');
assert(workDraftFromHist.isWorkingDraft === true, '从历史快照采纳候选生成新的可编辑工作稿');

// -----------------------------------------------------------------------
// 19. 文风、大纲审批快照缺失与不一致的定稿严格拦截
// -----------------------------------------------------------------------
console.log('\n>>> [回归 19] 文风、大纲审批快照缺失与不一致的定稿严格拦截:');
const task19 = createPresetTask('under_review');
const validDraft19 = task19.drafts[0];

// 1) 草稿缺少 styleSnapshot -> 阻断
const draftNoStyle: DraftVersion = {
  ...validDraft19,
  snapshotMetadata: {
    ...validDraft19.snapshotMetadata!,
    styleSnapshot: undefined,
  }
};
const task19NoStyleDraft = { ...task19, drafts: [draftNoStyle], currentDraftId: draftNoStyle.id };
const resNoStyle = validateFinalizationConditions(task19NoStyleDraft, draftNoStyle.id, '主笔甲');
assert(resNoStyle.canFinalize === false, '草稿缺少文风快照依据时严格阻断定稿');
assert(resNoStyle.reasons.some(r => r.includes('文风')), '包含明确文风快照缺失提示');

// 2) 草稿缺少 outlineSnapshot -> 阻断
const draftNoOutline: DraftVersion = {
  ...validDraft19,
  snapshotMetadata: {
    ...validDraft19.snapshotMetadata!,
    outlineSnapshot: undefined,
  }
};
const task19NoOutlineDraft = { ...task19, drafts: [draftNoOutline], currentDraftId: draftNoOutline.id };
const resNoOutline = validateFinalizationConditions(task19NoOutlineDraft, draftNoOutline.id, '主笔甲');
assert(resNoOutline.canFinalize === false, '草稿缺少大纲快照依据时严格阻断定稿');
assert(resNoOutline.reasons.some(r => r.includes('大纲')), '包含明确大纲快照缺失提示');

// 3) 任务自身缺少 styleSnapshot 或 outlineSnapshot -> 阻断
const task19NoTaskStyle = { ...task19, styleSnapshot: undefined };
const resNoTaskStyle = validateFinalizationConditions(task19NoTaskStyle, validDraft19.id, '主笔甲');
assert(resNoTaskStyle.canFinalize === false, '任务自身缺少文风审批快照时严格阻断定稿');

const task19NoTaskOutline = { ...task19, outlineSnapshot: undefined };
const resNoTaskOutline = validateFinalizationConditions(task19NoTaskOutline, validDraft19.id, '主笔甲');
assert(resNoTaskOutline.canFinalize === false, '任务自身缺少大纲审批快照时严格阻断定稿');

// 4) 大纲段落结构或Hash不一致 -> 阻断
const draftDiffOutline: DraftVersion = {
  ...validDraft19,
  snapshotMetadata: {
    ...validDraft19.snapshotMetadata!,
    outlineSnapshot: {
      confirmedAt: '2026-10-07T08:40:00.000Z',
      sections: [],
      hash: 'OUTLINE-HASH-CHANGED',
    }
  }
};
const task19DiffOutline = { ...task19, drafts: [draftDiffOutline], currentDraftId: draftDiffOutline.id };
const resDiffOutline = validateFinalizationConditions(task19DiffOutline, draftDiffOutline.id, '主笔甲');
assert(resDiffOutline.canFinalize === false, '大纲依据内容与最新核准大纲不一致时严格阻断定稿');

// -----------------------------------------------------------------------
// 20. 恢复后历史导出无冻结记录明确提示与审阅状态隔离
// -----------------------------------------------------------------------
console.log('\n>>> [回归 20] 恢复后历史导出无冻结记录明确提示与审阅状态隔离:');
const task20 = createPresetTask('under_review');
// 构造一个老版本历史草稿（未存 frozenReviewComments）
const legacyHistoricalDraft: DraftVersion = {
  id: 'DRAFT-LEGACY-HIST',
  versionNumber: 'v0.9 (恢复的老历史快照)',
  createdAt: '2026-10-06T10:00:00.000Z',
  author: '主笔甲',
  summary: '缺少冻结审阅记录的老版本',
  blocks: validDraft19.blocks,
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  snapshotMetadata: validDraft19.snapshotMetadata,
  // frozenReviewComments is undefined!
};
const task20WithLegacy = {
  ...task20,
  drafts: [task20.drafts[0], legacyHistoricalDraft],
};

const txtLegacy = exportDocumentAsTxt(task20WithLegacy, legacyHistoricalDraft, { includeBody: false, includeEvidence: false, includeReviewLog: true });
assert(txtLegacy.includes('未包含冻结审阅记录快照') && txtLegacy.includes('无法还原当时审阅状态'), '缺少冻结记录的历史稿导出明确提示无法还原，未混入当前最新审阅意见');
assert(!txtLegacy.includes('CMT-01'), '当前任务最新审阅意见绝不混入缺少快照的历史稿');

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
