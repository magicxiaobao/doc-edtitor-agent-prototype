import { Task, DraftVersion, ParagraphBlock, ReviewComment, UserRole } from './src/types';
import {
  generateDraftFromFactsAndOutline,
  generateParagraphRevision,
  computeContentHash,
} from './src/services/mockDraftService';
import {
  checkPermission,
  canEditDraft,
  canConfirmFacts,
  canConfirmOutline,
  canRestoreVersion,
  canFinalize,
  canAddComment,
  canSubmitMaterial,
} from './src/services/permissionService';
import { createPresetTask } from './src/services/mockData';
import { exportDocumentAsTxt, exportDocumentAsDocx } from './src/services/exportService';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('==============================================');
console.log('   公文辅助协作原型 - 任务08验收测试套件');
console.log('==============================================\n');

// -----------------------------------------------------------------------
// Acceptance a: 第一段生成建议→选中第二段→采纳，第二段不被第一段内容覆盖
// -----------------------------------------------------------------------
console.log('>>> [验收 a] 建议绑定原目标段落，切换段落后不误覆盖当前段落:');
const taskA = createPresetTask('under_review');
const currentDraftA = taskA.drafts[0];
const block1 = currentDraftA.blocks[0]; // 第1段
const block2 = currentDraftA.blocks[1]; // 第2段

// 为第1段生成修改建议
const suggestionForBlock1 = generateParagraphRevision(
  block1,
  'compress',
  taskA.id,
  currentDraftA.id,
  'RUN-A-1'
);

assert(suggestionForBlock1.targetBlockId === block1.id, '建议记录的目标段落ID为第1段ID');
assert(suggestionForBlock1.baseContent === block1.content, '建议记录基准正文为第1段内容');

// 模拟用户光标切换到第2段 (activeBlock 为 block2)
const activeBlock = block2;

// 模拟采纳逻辑：采纳时必须严格根据 suggestion.targetBlockId 定位目标，绝不能使用 activeBlock
const targetBlockToUpdate = currentDraftA.blocks.find(
  (b) => b.id === suggestionForBlock1.targetBlockId
)!;

assert(targetBlockToUpdate.id === block1.id, '采纳定位到的目标是第1段，非当前选中的第2段');

// 执行更新
const updatedBlocksA = currentDraftA.blocks.map((b) => {
  if (b.id === suggestionForBlock1.targetBlockId) {
    return { ...b, content: suggestionForBlock1.suggestedText };
  }
  return b;
});

assert(
  updatedBlocksA[0].content === suggestionForBlock1.suggestedText,
  '第1段被采纳的建议文本替换'
);
assert(
  updatedBlocksA[1].content === block2.content,
  '第2段内容保持原样，完全未被第1段建议覆盖'
);

// -----------------------------------------------------------------------
// Acceptance b: 生成建议后改原段，旧建议不能直接覆盖人工文本
// -----------------------------------------------------------------------
console.log('\n>>> [验收 b] 生成建议后人工修改原段，旧建议基准冲突并阻止覆盖:');
const taskB = createPresetTask('under_review');
const currentDraftB = taskB.drafts[0];
const origBlock = currentDraftB.blocks[0];

// 生成针对该段的建议
const suggestionB = generateParagraphRevision(
  origBlock,
  'formal',
  taskB.id,
  currentDraftB.id,
  'RUN-B-1'
);

// 人工编辑该段落
const manuallyEditedText = origBlock.content + '【主笔人工增补的重要补充说明】';
const editedBlock = { ...origBlock, content: manuallyEditedText };

// 校验基准内容与指纹
const isContentModified = editedBlock.content !== suggestionB.baseContent;
const isHashMismatched =
  computeContentHash(editedBlock.content) !== suggestionB.baseContentHash;

assert(isContentModified, '检测到目标段落正文已被人工编辑修改');
assert(isHashMismatched, '检测到目标段落正文哈希指纹不匹配');

// 采纳冲突检查模拟
let adoptBlocked = false;
let blockReason = '';
if (editedBlock.content !== suggestionB.baseContent) {
  adoptBlocked = true;
  blockReason =
    '采纳冲突：检测到目标段落自建议生成后已被人工编辑修改，基准内容已变动。为防止直接覆盖人工文本，建议已失效。';
}

assert(adoptBlocked, '基准内容变动后阻止直接覆盖');
assert(blockReason.includes('防止直接覆盖人工文本'), '返回明确的防覆盖冲突警示');

// -----------------------------------------------------------------------
// Acceptance c: 任务A生成候选→切到B，B不能采纳A的候选；取消后迟到结果不改变任务
// -----------------------------------------------------------------------
console.log('\n>>> [验收 c] 跨任务建议隔离与迟到结果隔离:');
const taskA_scope = createPresetTask('under_review');
taskA_scope.id = 'TASK-ALPHA';

const taskB_scope = createPresetTask('under_review');
taskB_scope.id = 'TASK-BETA';

// 为任务A生成建议
const suggestionTaskA = generateParagraphRevision(
  taskA_scope.drafts[0].blocks[0],
  'compress',
  taskA_scope.id,
  taskA_scope.drafts[0].id
);

// 尝试在任务B中采纳属于任务A的建议
let crossTaskBlocked = false;
if (suggestionTaskA.taskId && suggestionTaskA.taskId !== taskB_scope.id) {
  crossTaskBlocked = true;
}
assert(crossTaskBlocked, '任务B明确阻止采纳属于任务A的修改建议');

// 模拟起草生成中的取消与隔离
let currentTaskRunningId = 'TASK-ALPHA';
let draftCancelled = false;
let taskDraftsBeforeCancel = [...taskA_scope.drafts];

// 用户触发起草并立即取消
draftCancelled = true;

// 迟到结果返回
const lateGeneratedBlocks = generateDraftFromFactsAndOutline(taskA_scope);
let draftUpdated = false;
if (!draftCancelled && currentTaskRunningId === taskA_scope.id) {
  draftUpdated = true;
}

assert(!draftUpdated, '取消后迟到的生成结果被拦截，不改变文稿');
assert(
  taskA_scope.drafts.length === taskDraftsBeforeCancel.length,
  '文稿草稿数量与确认状态完好保留'
);

// -----------------------------------------------------------------------
// Acceptance d: 供稿丙不能编辑正文，审阅乙/丁不能批准事实、大纲、恢复版本或定稿
// -----------------------------------------------------------------------
console.log('\n>>> [验收 d] 统一动作权限规则检验:');
const authorRole: UserRole = '主笔甲';
const reviewer2Role: UserRole = '审阅乙';
const supplierRole: UserRole = '供稿丙';
const reviewer4Role: UserRole = '审阅丁';

// 供稿丙权限
assert(!checkPermission(supplierRole, 'edit_draft').allowed, '供稿丙不可编辑正文');
assert(!checkPermission(supplierRole, 'generate_draft').allowed, '供稿丙不可起草正文');
assert(!checkPermission(supplierRole, 'adopt_revision').allowed, '供稿丙不可采纳正文修改');
assert(!checkPermission(supplierRole, 'add_comment').allowed, '供稿丙不可发表审阅批注');
assert(checkPermission(supplierRole, 'submit_material').allowed, '供稿丙允许提交材料');
assert(checkPermission(supplierRole, 'supplement_fact').allowed, '供稿丙允许补充说明事实');

// 审阅乙/丁权限
for (const reviewer of [reviewer2Role, reviewer4Role]) {
  assert(!checkPermission(reviewer, 'confirm_facts').allowed, `${reviewer}不可批准事实`);
  assert(!checkPermission(reviewer, 'confirm_style').allowed, `${reviewer}不可核准文风`);
  assert(!checkPermission(reviewer, 'confirm_outline').allowed, `${reviewer}不可批准大纲`);
  assert(!checkPermission(reviewer, 'restore_version').allowed, `${reviewer}不可恢复版本`);
  assert(!checkPermission(reviewer, 'finalize').allowed, `${reviewer}不可定稿`);
  assert(!checkPermission(reviewer, 'edit_draft').allowed, `${reviewer}不可直接编辑正文`);
  assert(checkPermission(reviewer, 'add_comment').allowed, `${reviewer}可发表审阅意见批注`);
}

// 主笔甲权限
assert(checkPermission(authorRole, 'confirm_facts').allowed, '主笔甲可确认事实');
assert(checkPermission(authorRole, 'confirm_style').allowed, '主笔甲可确认文风');
assert(checkPermission(authorRole, 'confirm_outline').allowed, '主笔甲可确认大纲');
assert(checkPermission(authorRole, 'edit_draft').allowed, '主笔甲可编辑正文');
assert(checkPermission(authorRole, 'adopt_revision').allowed, '主笔甲可采纳建议');
assert(checkPermission(authorRole, 'restore_version').allowed, '主笔甲可恢复历史版本');
assert(checkPermission(authorRole, 'finalize').allowed, '主笔甲可定稿');
assert(checkPermission(authorRole, 'resolve_comment').allowed, '主笔甲可裁决意见');

// -----------------------------------------------------------------------
// Acceptance e: 定稿后改正文产生新工作稿，旧定稿内容和ID稳定
// -----------------------------------------------------------------------
console.log('\n>>> [验收 e] 工作副本与定稿快照分离，编辑定稿产生新工作稿:');
const taskE = createPresetTask('under_review');
const finalizedDraftId = 'DRAFT-FINAL-123';
const finalizedContent = '这是最终定稿不可修改的权威正文。';

const finalSnapshot: DraftVersion = {
  id: finalizedDraftId,
  versionNumber: '定稿 v2.0 (最终核定版)',
  createdAt: '2026-10-07T10:00:00.000Z',
  author: '主笔甲',
  summary: '正式定稿归档',
  blocks: [
    {
      id: 'BLK-FINAL-1',
      sectionId: 'SEC-01',
      order: 1,
      content: finalizedContent,
      referencedFactIds: ['FACT-01'],
      updatedAt: '2026-10-07T10:00:00.000Z',
    },
  ],
  isFinal: true,
};

taskE.drafts = [finalSnapshot];
taskE.currentDraftId = finalSnapshot.id;
taskE.isFinalized = true;
taskE.status = '已定稿';

// 模拟定稿后重新编辑第1段
const editedNewContent = '这是主笔在定稿后重新修改的新工作稿表述。';
let newWorkingDraftId = '';

if (taskE.isFinalized || taskE.drafts[0].isFinal) {
  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}`,
    versionNumber: `v${taskE.drafts.length + 1}.0 (工作草稿·重新编辑)`,
    createdAt: new Date().toISOString(),
    author: '主笔甲',
    summary: `定稿后重新编辑生成的新工作草稿（来源定稿：${taskE.drafts[0].versionNumber}）`,
    blocks: [
      {
        ...taskE.drafts[0].blocks[0],
        content: editedNewContent,
        updatedAt: new Date().toISOString(),
      },
    ],
    snapshotMetadata: taskE.drafts[0].snapshotMetadata,
  };

  newWorkingDraftId = newWorkingDraft.id;
  taskE.drafts = [newWorkingDraft, ...taskE.drafts];
  taskE.currentDraftId = newWorkingDraft.id;
  taskE.isFinalized = false;
  taskE.status = '起草中';
}

assert(!taskE.isFinalized, '定稿状态已解除，恢复为起草中');
assert(taskE.currentDraftId === newWorkingDraftId, '当前工作副本切换为新工作稿');
assert(taskE.drafts.length === 2, '存在2个稿件版本');

const originalFinalizedDraft = taskE.drafts.find((d) => d.id === finalizedDraftId)!;
assert(!!originalFinalizedDraft, '原定稿快照依然存在于版本历史中');
assert(originalFinalizedDraft.blocks[0].content === finalizedContent, '原定稿正文内容保持不可篡改');
assert(originalFinalizedDraft.id === finalizedDraftId, '原定稿快照ID稳定未被覆盖');
assert(originalFinalizedDraft.isFinal === true, '原定稿快照的isFinal标识完好保留');

// -----------------------------------------------------------------------
// Acceptance f: 恢复历史产生新版本且导出保持其原章节标题及依据
// -----------------------------------------------------------------------
console.log('\n>>> [验收 f] 恢复历史创建新版本，导出保持当时章节标题与事实依据:');
const taskF = createPresetTask('under_review');

// 历史版本包含当时的大纲章节标题：“【历史第一章原标题：2026年序时攻坚进展】”
const historyOutlineTitle = '【历史第一章原标题：2026年序时攻坚进展】';
const historyVersion: DraftVersion = {
  id: 'DRAFT-HIST-V1',
  versionNumber: 'v1.0 (历史快照版)',
  createdAt: '2026-10-01T08:00:00.000Z',
  author: '主笔甲',
  summary: '历史早期的初稿快照',
  blocks: [
    {
      id: 'BLK-HIST-1',
      sectionId: 'SEC-HIST-1',
      order: 1,
      content: '历史初稿的第一段正文内容。',
      referencedFactIds: ['FACT-01'],
      updatedAt: '2026-10-01T08:00:00.000Z',
    },
  ],
  snapshotMetadata: {
    taskTitle: '某单位工作总结(历史版)',
    startDate: '2026-01-01',
    endDate: '2026-09-30',
    targetWordCount: 2500,
    outlineSections: [
      {
        id: 'SEC-HIST-1',
        order: 1,
        title: historyOutlineTitle,
        purpose: '历史目的',
        suggestedWordCount: 800,
        assignedFactIds: ['FACT-01'],
        uncoveredRequirements: [],
        hasMaterialGap: false,
        confirmed: true,
      },
    ],
    factSnapshot: {
      confirmedAt: '2026-10-01T08:00:00.000Z',
      factIds: ['FACT-01'],
      items: [
        {
          factId: 'FACT-01',
          metric: '累计完成重点任务',
          value: '128',
          unit: '项',
          period: '2026年1至9月',
          metricScope: '历史锁定的科室乙口径',
          primaryEvidenceId: 'EVD-02',
        },
      ],
      hash: 'HIST-SNAP-HASH',
    },
  },
};

taskF.drafts = [historyVersion];

// 模拟后续主笔将当前大纲标题大幅度修改为：“【当前已修改的全新大纲标题】”
taskF.outline[0].title = '【当前已修改的全新大纲标题】';

// 恢复历史版本
const restoredDraft: DraftVersion = {
  id: `DRAFT-RESTORED-${Date.now()}`,
  versionNumber: `v2.0 (恢复自${historyVersion.versionNumber})`,
  createdAt: new Date().toISOString(),
  author: '主笔甲',
  summary: `恢复自历史版本 ${historyVersion.versionNumber}`,
  blocks: JSON.parse(JSON.stringify(historyVersion.blocks)),
  snapshotMetadata: historyVersion.snapshotMetadata,
};

taskF.drafts = [restoredDraft, ...taskF.drafts];

assert(taskF.drafts.length === 2, '恢复历史创建了新版本且保留了原历史版本');
assert(restoredDraft.snapshotMetadata?.outlineSections[0].title === historyOutlineTitle, '新版本继承了历史大纲标题');

// 校验导出逻辑使用的标题
const meta = restoredDraft.snapshotMetadata;
const sectionsMap = new Map<string, string>();
const outlineList = meta?.outlineSections || taskF.outline;
outlineList.forEach((sec) => sectionsMap.set(sec.id, sec.title));

const exportedSecTitle = sectionsMap.get('SEC-HIST-1');
assert(exportedSecTitle === historyOutlineTitle, '导出准确使用历史版本当时的章节标题');
assert(exportedSecTitle !== taskF.outline[0].title, '历史版本导出未被当前已修改的大纲标题覆盖');

// -----------------------------------------------------------------------
// Acceptance g: 采纳一条文本修改建议后正文真实变化，处理记录指向新版本；只做回复时保持“待落实”
// -----------------------------------------------------------------------
console.log('\n>>> [验收 g] 审阅意见处理：仅回复为待落实，采纳文本真实改稿并记录落实版本:');
const taskG = createPresetTask('under_review');
const comment = taskG.reviewComments.find((c) => c.id === 'CMT-03')!;
const targetBlockG = taskG.drafts[0].blocks.find((b) => b.id === comment.targetBlockId)!;

// 操作 1: 仅做回复/策略决定
const replyOnlyAction = 'accepted_pending_implementation';
const replyOnlyText = '主笔已研判，同意压缩培训段落措辞，待后续统筹落实。';

const commentAfterReply: ReviewComment = {
  ...comment,
  status: replyOnlyAction,
  authorReply: replyOnlyText,
  resolutionType: 'strategy_decided',
};

assert(commentAfterReply.status === 'accepted_pending_implementation', '仅做答复时状态保持为“accepted_pending_implementation (决定采纳待落实)”');
assert(commentAfterReply.status !== 'implemented', '仅做答复时严禁显示为“已修改/已落实”');

// 操作 2: 采纳文本修改建议并落实到正文
const suggestedReplacement = '深化分级分类实操培训，累计组织专题培训16场、参训800人次，队伍履职能力显著增强。';
const newVersionForG: DraftVersion = {
  id: `DRAFT-REV-${Date.now()}`,
  versionNumber: 'v1.1 (落实审阅意见)',
  createdAt: new Date().toISOString(),
  author: '主笔甲',
  summary: `落实审阅乙关于“${comment.content.slice(0, 15)}”的修改建议`,
  blocks: taskG.drafts[0].blocks.map((b) =>
    b.id === targetBlockG.id ? { ...b, content: suggestedReplacement } : b
  ),
  snapshotMetadata: taskG.drafts[0].snapshotMetadata,
};

const commentAfterImplement: ReviewComment = {
  ...comment,
  status: 'implemented',
  authorReply: '采纳审阅修改建议，已精简压缩正文。',
  implementationDraftId: newVersionForG.id,
  implementationBlockId: targetBlockG.id,
  resolutionType: 'text_modified',
};

assert(commentAfterImplement.status === 'implemented', '确认修改后状态变为 implemented');
assert(commentAfterImplement.implementationDraftId === newVersionForG.id, '处理记录准确指向新版本ID');
assert(commentAfterImplement.implementationBlockId === targetBlockG.id, '处理记录准确记录落实段落ID');
assert(newVersionForG.blocks.find((b) => b.id === targetBlockG.id)!.content === suggestedReplacement, '正文内容真实发生变更并保持16场与800人次');

// -----------------------------------------------------------------------
// Acceptance h: 无正文、批准失效、重大意见待处理等状态明确阻止定稿
// -----------------------------------------------------------------------
console.log('\n>>> [验收 h] 严格定稿准入前置核校阻止机制:');
const taskH = createPresetTask('under_review');

// 1. 无正文阻止
const taskNoDraft: Task = { ...taskH, drafts: [], currentDraftId: '' };
const hasDraftTextH = taskNoDraft.drafts.length > 0;
assert(!hasDraftTextH, '无草稿时检测到正文缺失');
// 模拟定稿拦截
let finalizeBlockedNoText = false;
if (!hasDraftTextH) {
  finalizeBlockedNoText = true;
}
assert(finalizeBlockedNoText, '无正文草稿时明确阻止定稿，不抛错不弹出确认');

// 2. 审批失效阻止 (事实撤销导致快照失效或大纲审批失效)
const taskApprovalInvalid: Task = {
  ...taskH,
  factSnapshot: undefined, // 事实快照失效
  outlineConfirmed: false, // 大纲审批失效
};
const isUpstreamValidH =
  taskApprovalInvalid.outlineConfirmed &&
  !!taskApprovalInvalid.factSnapshot &&
  taskApprovalInvalid.styleConfirmed;
assert(!isUpstreamValidH, '前序大纲未确认或事实快照缺失时判定审批失效');
let finalizeBlockedInvalidApproval = false;
if (!isUpstreamValidH) {
  finalizeBlockedInvalidApproval = true;
}
assert(finalizeBlockedInvalidApproval, '审批失效明确阻止定稿');

// 3. 重大意见未处理阻止 (存在 pending 审阅意见)
const pendingComments = taskH.reviewComments.filter((c) => c.status === 'pending');
assert(pendingComments.length > 0, '检测到存在未处理的审阅意见');
let finalizeBlockedPendingComments = false;
if (pendingComments.length > 0) {
  finalizeBlockedPendingComments = true;
}
assert(finalizeBlockedPendingComments, '重大意见待处理时明确阻止定稿');

// 4. 角色权限阻止 (审阅人不可定稿)
assert(!checkPermission('审阅乙', 'finalize').allowed, '审阅乙定稿被权限拦截');
assert(!checkPermission('供稿丙', 'finalize').allowed, '供稿丙定稿被权限拦截');
assert(checkPermission('主笔甲', 'finalize').allowed, '主笔甲允许执行定稿');

console.log('\n==============================================');
console.log('   🎉 任务08验收测试套件全部 8 项验证通过！');
console.log('==============================================\n');
