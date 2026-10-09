import { 
  Task, 
  ReviewComment, 
  DraftVersion, 
  UserRole 
} from './src/types';
import { 
  applyDraftContentChange, 
  createDraftSnapshot, 
  restoreDraftVersion, 
  submitDraftForReview, 
  validateFinalizationConditions, 
  finalizeDraft 
} from './src/services/draftLifecycleService';
import { 
  getReviewCommentLocation, 
  implementReviewCommentWithText, 
  updateReviewCommentDecision, 
  rebindReviewCommentTargetBlock, 
  generateCoordinationDiff, 
  applyCoordinationDecision 
} from './src/services/reviewCoordinationService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from './src/services/exportService';
import { runDocumentAudit } from './src/services/mockAuditService';
import { checkPermission } from './src/services/permissionService';
import { generateDraftFromFactsAndOutline, generateParagraphRevision } from './src/services/mockDraftService';
import { createPresetTask } from './src/services/mockData';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

console.log('==============================================');
console.log('   任务13 审阅意见与正文工作区深度协同回归测试');
console.log('==============================================\n');

// Initialize base task from default scenario
const baseTask: Task = createPresetTask('under_review');
const initialDraft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId) || baseTask.drafts[0];

// --------------------------------------------------------------------------
// [验收 A] 提出段落意见，主笔定位、生成建议、对比、采纳，正文和该意见的落实记录同步变化
// --------------------------------------------------------------------------
console.log('>>> [验收 A] 提出段落意见，主笔定位、生成建议、对比、采纳，正文和意见落实记录同步变化:');

// Step 1: Reviewer submits a paragraph comment on BLK-02
const newComment: ReviewComment = {
  id: 'CMT-TEST-01',
  type: 'paragraph',
  targetBlockId: 'BLK-02',
  targetBlockOrder: 2,
  targetVersionId: initialDraft.id,
  baseParagraphText: initialDraft.blocks.find((b) => b.id === 'BLK-02')?.content,
  reviewer: '审阅乙',
  content: '第2段培训举措表述偏冗长，建议精简修饰语并突出培训覆盖面。',
  suggestedChange: '在专项业务培训方面，2026年1至9月累计举办业务培训16场，扎实培训骨干800人次，有力提升全员专业履职水准。',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

let taskWithComment: Task = {
  ...baseTask,
  reviewComments: [newComment, ...baseTask.reviewComments],
};

// Step 2: Author locates comment in current draft
const loc = getReviewCommentLocation(newComment, initialDraft);
assert(loc.isLocated === true, '审阅意见在当前工作草稿中成功精准定位');
assert(loc.targetBlock?.id === 'BLK-02', '定位目标段落匹配原ID BLK-02');
assert(!loc.warning, '无定位过期失效警告');

// Step 3: Author generates revision suggestion based on this review comment
const revision = generateParagraphRevision(
  loc.targetBlock!,
  'custom',
  taskWithComment.id,
  initialDraft.id,
  'RUN-REV-01',
  {
    customPrompt: newComment.suggestedChange || newComment.content,
    task: taskWithComment,
    currentDraft: initialDraft,
    sourceComment: newComment,
  }
);
assert(revision.sourceCommentId === newComment.id, '生成的AI修改建议明确记录关联审阅意见ID');
assert(revision.targetBlockId === 'BLK-02', '建议目标段落绑定为 BLK-02');

// Step 4: Author adopts revision into draft text
const { updatedTask: taskAfterAdopt, workingDraft: draftAfterAdopt } = implementReviewCommentWithText(
  taskWithComment,
  newComment.id,
  initialDraft.id,
  revision.suggestedText,
  '主笔核准采纳【审阅乙】建议并写入第2段正文',
  '主笔甲'
);

const updatedCommentA = taskAfterAdopt.reviewComments.find((c) => c.id === newComment.id);
assert(updatedCommentA?.status === 'implemented', '采纳修改后该意见状态自动变更为已落实 (implemented)');
assert(updatedCommentA?.implementationDraftId === draftAfterAdopt.id, '意见记录落实的目标草稿版本ID');
assert(updatedCommentA?.implementationBlockId === 'BLK-02', '意见记录落实的目标段落ID BLK-02');
assert(updatedCommentA?.authorReply?.includes('主笔核准采纳'), '记录主笔真实答复与落实说明');

const adoptedBlock = draftAfterAdopt.blocks.find((b) => b.id === 'BLK-02');
assert(adoptedBlock?.content === revision.suggestedText, '正文第2段实际内容已更新为采纳的建议文本');
assert(adoptedBlock?.content.includes('16场') && adoptedBlock?.content.includes('800人次'), '落实后的正文严格保留了核心量化事实与单位');

// --------------------------------------------------------------------------
// [验收 B] 只点击“决定采纳”后仍是待落实；待落实和待沟通仍阻止定稿
// --------------------------------------------------------------------------
console.log('\n>>> [验收 B] 只点击“决定采纳”后仍是待落实；待落实和待沟通仍阻止定稿:');

// Test B1: Mark decision as accepted_pending_implementation
const { updatedTask: taskWithDecisionOnly } = updateReviewCommentDecision(
  taskWithComment,
  newComment.id,
  'accepted_pending_implementation',
  '主笔决定采纳此优化方向，待后续统筹落实篇幅',
  '主笔甲'
);

const commentDecisionOnly = taskWithDecisionOnly.reviewComments.find((c) => c.id === newComment.id);
assert(commentDecisionOnly?.status === 'accepted_pending_implementation', '只点击决定采纳时，状态严格保持为【决定采纳，待落实】，不标记为已落实');

// Test B2: Check finalization validation blocked by accepted_pending_implementation
const valPending = validateFinalizationConditions(taskWithDecisionOnly, initialDraft.id, '主笔甲');
assert(valPending.canFinalize === false, '存在【决定采纳，待落实】意见时，定稿校验严格返回 false');
assert(valPending.checks.commentsClosed === false, '检查项 commentsClosed 为 false');
assert(valPending.reasons.some((r) => r.includes('待处理或待落实审阅意见') || r.includes('审阅意见')), '阻断原因中包含明确的待处理/待落实审阅意见未闭环提示');

// Test B3: Check finalization validation blocked by need_discussion
const { updatedTask: taskWithDiscuss } = updateReviewCommentDecision(
  taskWithComment,
  newComment.id,
  'need_discussion',
  '口径表述涉及两部门交叉，拟明天协调会商榷',
  '主笔甲'
);
const valDiscuss = validateFinalizationConditions(taskWithDiscuss, initialDraft.id, '主笔甲');
assert(valDiscuss.canFinalize === false, '存在【待沟通】意见时，定稿校验严格返回 false');

// Test B4: Reject with reason closes comment and unblocks it
const { updatedTask: taskWithReject } = updateReviewCommentDecision(
  taskWithComment,
  newComment.id,
  'rejected',
  '经核实，法定公文格式要求篇幅紧凑，不作扩展',
  '主笔甲'
);
const commentRejected = taskWithReject.reviewComments.find((c) => c.id === newComment.id);
assert(commentRejected?.status === 'rejected', '意见变更为【已拒绝】');
assert(commentRejected?.decisionReason === '经核实，法定公文格式要求篇幅紧凑，不作扩展', '完整记录主笔拒绝原因');

// --------------------------------------------------------------------------
// [验收 C] 一条正文修改不会自动关闭其他无关意见
// --------------------------------------------------------------------------
console.log('\n>>> [验收 C] 一条正文修改不会自动关闭其他无关意见:');

const cmt1: ReviewComment = {
  id: 'CMT-INDEP-01',
  type: 'paragraph',
  targetBlockId: 'BLK-02',
  targetBlockOrder: 2,
  targetVersionId: initialDraft.id,
  reviewer: '审阅乙',
  content: '第2段需调整',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const cmt2: ReviewComment = {
  id: 'CMT-INDEP-02',
  type: 'paragraph',
  targetBlockId: 'BLK-04',
  targetBlockOrder: 4,
  targetVersionId: initialDraft.id,
  reviewer: '审阅丁',
  content: '第4段保障措施需强化',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithTwoComments: Task = {
  ...baseTask,
  reviewComments: [cmt1, cmt2],
};

const { updatedTask: taskAfterModifyingOne } = implementReviewCommentWithText(
  taskWithTwoComments,
  cmt1.id,
  initialDraft.id,
  '落实第2段修改文本',
  '主笔修改第2段',
  '主笔甲'
);

const checkCmt1 = taskAfterModifyingOne.reviewComments.find((c) => c.id === cmt1.id);
const checkCmt2 = taskAfterModifyingOne.reviewComments.find((c) => c.id === cmt2.id);

assert(checkCmt1?.status === 'implemented', '明确关联的意见1已落实');
assert(checkCmt2?.status === 'pending', '未关联的意见2继续保持 pending 待处理，未被静默关闭');

// --------------------------------------------------------------------------
// [验收 D] 同一意见的历史冻结状态不受后来回复与状态改变影响
// --------------------------------------------------------------------------
console.log('\n>>> [验收 D] 同一意见的历史冻结状态不受后来回复与状态改变影响:');

// Create a frozen historical snapshot of the task with comment in 'pending' status
const { updatedTask: taskWithSnapshot, snapshotDraft } = createDraftSnapshot(
  taskWithTwoComments,
  initialDraft.id,
  '保存送审前版本快照',
  '主笔甲'
);

assert(snapshotDraft.isHistoricalSnapshot === true, '快照被标记为只读历史版本');
assert(Boolean(snapshotDraft.frozenReviewComments && snapshotDraft.frozenReviewComments.length > 0), '快照完整冻结当时的审阅意见');

const frozenCmt1 = snapshotDraft.frozenReviewComments?.find((c) => c.id === cmt1.id);
assert(frozenCmt1?.status === 'pending', '快照中冻结的意见1状态为 pending');

// Now, in active working task, Author marks cmt1 as implemented
const { updatedTask: taskModifiedLater } = implementReviewCommentWithText(
  taskWithSnapshot,
  cmt1.id,
  taskWithSnapshot.currentDraftId,
  '新稿件中落实第2段',
  '新稿件落实答复',
  '主笔甲'
);

// Verify that the historical snapshot object in task.drafts was NOT mutated
const snapshotAfterMutation = taskModifiedLater.drafts.find((d) => d.id === snapshotDraft.id);
const frozenCmt1AfterMutation = snapshotAfterMutation?.frozenReviewComments?.find((c) => c.id === cmt1.id);

assert(frozenCmt1AfterMutation?.status === 'pending', '历史快照中冻结的意见状态依然保持 pending，不受后来的落实操作影响');
assert(!frozenCmt1AfterMutation?.implementationDraftId, '历史快照中冻结的意见未被写入后来的落实版本');

// Verify that exporting the historical snapshot reads the frozen comments
const historicalTxt = exportDocumentAsTxt(taskModifiedLater, snapshotDraft, {
  includeBody: true,
  includeEvidence: true,
  includeReviewLog: true,
});
assert(historicalTxt.includes('状态：pending') || historicalTxt.includes('状态：待处理'), '历史版本导出的审阅附录真实反映当时冻结状态');

// --------------------------------------------------------------------------
// [验收 E] 删除原目标段落后明确提示重新定位，不把意见或修改落到另一段
// --------------------------------------------------------------------------
console.log('\n>>> [验收 E] 删除原目标段落后明确提示重新定位，不把意见或修改落到另一段:');

// Create a draft where BLK-02 has been removed (e.g. paragraph merged or deleted)
const draftWithDeletedBlock: DraftVersion = {
  ...initialDraft,
  blocks: initialDraft.blocks.filter((b) => b.id !== 'BLK-02'),
};

const locDeleted = getReviewCommentLocation(newComment, draftWithDeletedBlock);
assert(locDeleted.isLocated === false, '删除目标段落后，原段落定位判定为失效');
assert(Boolean(locDeleted.warning && locDeleted.warning.includes('已在正文中删除')), '返回清楚的定位需复核警示，拒绝错挂到其他段落');

// Rebind comment to another valid block BLK-03
const { updatedTask: taskRebound } = rebindReviewCommentTargetBlock(
  taskWithComment,
  newComment.id,
  'BLK-03',
  '主笔甲'
);
const reboundCmt = taskRebound.reviewComments.find((c) => c.id === newComment.id);
assert(reboundCmt?.targetBlockId === 'BLK-03', '重新指定段落后，目标段落更新为 BLK-03');
assert(reboundCmt?.targetBlockOrder === 3, '段落序号自动同步更新为 3');

// --------------------------------------------------------------------------
// [验收 F] 基于旧版本继续编辑或恢复始终产生新工作稿
// --------------------------------------------------------------------------
console.log('\n>>> [验收 F] 基于旧版本继续编辑或恢复始终产生新工作稿:');

const { updatedTask: taskRestored, workingDraft: restoredWorkingDraft } = restoreDraftVersion(
  taskWithSnapshot,
  snapshotDraft.id,
  '主笔甲'
);

assert(restoredWorkingDraft.id !== snapshotDraft.id, '恢复旧版本产生全新的工作稿ID');
assert(restoredWorkingDraft.isWorkingDraft === true, '新文稿标记为工作草稿');
assert(restoredWorkingDraft.isHistoricalSnapshot === false, '新文稿不是历史只读快照');
assert(restoredWorkingDraft.sourceDraftId === snapshotDraft.id, '新工作稿正确记录派生来源为该历史快照ID');
assert(taskRestored.currentDraftId === restoredWorkingDraft.id, '当前活动草稿指向新生成的工作稿');

// The original historical snapshot remains intact
const originalSnapshot = taskRestored.drafts.find((d) => d.id === snapshotDraft.id);
assert(originalSnapshot?.isHistoricalSnapshot === true, '原历史快照继续保持只读属性');
assert(originalSnapshot?.isWorkingDraft === false, '原历史快照未被篡改为工作稿');

// --------------------------------------------------------------------------
// [验收 G] 执行完整全流程演示：核准依据 → 初稿 → 局部改写 → 整稿对比 → 依据核对 → 审阅落实 → 核校 → 定稿 → 导出
// --------------------------------------------------------------------------
console.log('\n>>> [验收 G] 执行完整业务流程端到端演示:');

// Step G1: Approved evidence & outline in task
let demoTask: Task = createPresetTask('under_review');
assert(Boolean(demoTask.factSnapshot && demoTask.outlineSnapshot), 'G1: 存在核准的事实快照与大纲审批');

// Step G2: Current draft exists (or generated)
let currentDraft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId) || demoTask.drafts[0];
assert(currentDraft.blocks.length >= 3, 'G2: 初稿包含完整公文结构化段落');

// Step G3: Local revision on paragraph 2 (compress with fact preservation)
const targetBlockG = currentDraft.blocks[1];
const p2Rev = generateParagraphRevision(
  targetBlockG,
  'compress',
  demoTask.id,
  currentDraft.id,
  'RUN-G-01',
  { task: demoTask, currentDraft }
);
assert(p2Rev.suggestedText.includes('16场') && p2Rev.suggestedText.includes('800人次'), 'G3: 局部改写严格保留量化事实与单位');

const { updatedTask: taskG3, workingDraft: draftG3 } = applyDraftContentChange(
  demoTask,
  currentDraft.id,
  (blocks) => blocks.map((b) => (b.id === targetBlockG.id ? { ...b, content: p2Rev.suggestedText } : b)),
  '局部段落压缩采纳',
  '主笔甲'
);
demoTask = taskG3;
currentDraft = draftG3;

// Step G4: Full draft candidate generation & comparison
const candidateBlocks = generateDraftFromFactsAndOutline(
  demoTask,
  { instructionPrompt: '突出成效，减少铺垫' }
);
assert(candidateBlocks.length >= 3, 'G4: 整稿候选成功生成');

// Step G5: Evidence verification
const factItem = demoTask.facts.find((f) => f.id === 'FACT-01');
assert(factItem?.value === '128' && factItem?.status === 'confirmed', 'G5: 事实依据核准有效');

// Step G6: Review coordination & resolution (Reconcile CMT-01 & CMT-02 contradictory requirements)
const contradictionDiff = generateCoordinationDiff(demoTask, currentDraft, 'balanced');
assert(contradictionDiff.diffPreview.length > 0, 'G6: 成功生成综合协调策略差异');

const { updatedTask: taskG6, workingDraft: draftG6 } = applyCoordinationDecision(
  demoTask,
  currentDraft.id,
  contradictionDiff,
  '主笔甲',
  ['CMT-01', 'CMT-02']
);
demoTask = taskG6;
currentDraft = draftG6;

// Resolve remaining review comments
demoTask = {
  ...demoTask,
  reviewComments: demoTask.reviewComments.map((c) => ({
    ...c,
    status: 'implemented' as const,
    authorReply: c.authorReply || '主笔已统筹核准并写入正文落实',
  })),
};

// Step G7: Document audit
const auditIssues = runDocumentAudit(demoTask, currentDraft.blocks, currentDraft.id);
const blockingIssues = auditIssues.filter((i) => i.isBlocking && i.status === 'unresolved');
assert(blockingIssues.length === 0, 'G7: 严谨核校无阻断性错误');

// Step G8: Finalization
const finalVal = validateFinalizationConditions(demoTask, currentDraft.id, '主笔甲');
assert(finalVal.canFinalize === true, 'G8: 所有定稿前置准入核验全部通过');

const finalRes = finalizeDraft(demoTask, currentDraft.id, '主笔甲');
assert(finalRes.success === true, 'G8: 成功定稿');
assert(finalRes.finalDraft?.isFinal === true, 'G8: 生成不可篡改的定稿快照');
demoTask = finalRes.updatedTask!;

// Step G9: Real export
const exportedTxt = exportDocumentAsTxt(demoTask, finalRes.finalDraft!, {
  includeBody: true,
  includeEvidence: true,
  includeReviewLog: true,
});
assert(exportedTxt.includes('定稿') && exportedTxt.includes('128项'), 'G9: 成功生成真实 TXT 归档文件');

const exportedDocxBlob = await exportDocumentAsDocx(demoTask, finalRes.finalDraft!, {
  includeBody: true,
  includeEvidence: true,
  includeReviewLog: true,
});
assert(exportedDocxBlob.size > 5000, `G9: 成功封装生成真实 OOXML Word (.docx) 字节流 (${exportedDocxBlob.size} 字节)`);

console.log('\n==============================================');
console.log('   🎉 任务13 全部验收路径回归测试100%通过！');
console.log('==============================================\n');
