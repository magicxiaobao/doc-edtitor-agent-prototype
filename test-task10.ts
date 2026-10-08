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
  parsePeriodDateRange
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
  console.log('   🎉 任务10实际路径回归测试全部通过！');
  console.log('==============================================');
});
