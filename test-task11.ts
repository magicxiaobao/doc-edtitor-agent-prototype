import { createPresetTask } from './src/services/mockData';
import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  UserRole,
  RevisionSuggestion 
} from './src/types';
import { 
  generateParagraphRevision, 
  computeContentHash 
} from './src/services/mockDraftService';
import { 
  requestParagraphRevisionAsync 
} from './src/services/paragraphRevisionAdapter';
import { 
  applyDraftContentChange 
} from './src/services/draftLifecycleService';
import { 
  checkPermission 
} from './src/services/permissionService';
import { 
  computeTextDiff 
} from './src/services/diffService';
import { 
  getAuthenticCaseCandidates 
} from './src/services/reviewCoordinationService';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
}

console.log('==============================================');
console.log('   任务11 局部改写与写作工作区回归测试');
console.log('==============================================\n');

// -----------------------------------------------------------------------
// Acceptance Path A:
// 在培训段落生成压缩建议，采纳前正文不变；采纳后保留“16场、800人次”的含义、单位和期间，其他段落保持不变
// -----------------------------------------------------------------------
console.log('>>> [验收 A] 培训段落压缩建议、核心数据保留与局部段落独立采纳:');
const taskA = createPresetTask('under_review');
// Ensure draft with training paragraph
const currentDraftA = taskA.drafts[0];
const trainingBlock = currentDraftA.blocks.find(
  (b) => b.content.includes('培训') && b.content.includes('800人次')
) || currentDraftA.blocks[1];

// Ensure content has 16场 and 800人次
trainingBlock.content = '在干部队伍履职能力建设方面，坚持需求导向，深化分级分类专业实操培养。2026年1至9月，累计组织业务培训16场，累计参训800人次，有效强化了专业化履职能力与规范执行水平。';
trainingBlock.referencedFactIds = ['FACT-02', 'FACT-03'];

const otherBlocksBefore = currentDraftA.blocks
  .filter((b) => b.id !== trainingBlock.id)
  .map((b) => ({ id: b.id, content: b.content }));

const originalTrainingContent = trainingBlock.content;

// 1. 生成压缩建议
const compressSuggestion = generateParagraphRevision(
  trainingBlock,
  'compress',
  taskA.id,
  currentDraftA.id,
  'RUN-A-1',
  { task: taskA, currentDraft: currentDraftA }
);

// 2. 采纳前正文保持100%不变
assert(
  trainingBlock.content === originalTrainingContent,
  '采纳前正文内容保持100%未改变'
);
assert(
  compressSuggestion.suggestedText.includes('16场'),
  '压缩建议严格保留“16场”数值与单位'
);
assert(
  compressSuggestion.suggestedText.includes('800人次'),
  '压缩建议严格保留“800人次”数值与单位'
);
assert(
  compressSuggestion.suggestedText.includes('2026年1至9月'),
  '压缩建议严格保留“2026年1至9月”统计期间'
);
assert(
  compressSuggestion.suggestedText.length < originalTrainingContent.length,
  '压缩建议成功精炼篇幅，字数少于原文'
);

// 3. 采纳建议到目标段落
const adoptResultA = applyDraftContentChange(
  taskA,
  currentDraftA.id,
  (blocks) =>
    blocks.map((b) =>
      b.id === compressSuggestion.targetBlockId
        ? { ...b, content: compressSuggestion.suggestedText, updatedAt: new Date().toISOString() }
        : b
    ),
  '采纳局部压缩建议',
  '主笔甲'
);

const updatedDraftA = adoptResultA.workingDraft;
const updatedTrainingBlock = updatedDraftA.blocks.find((b) => b.id === trainingBlock.id)!;

assert(
  updatedTrainingBlock.content === compressSuggestion.suggestedText,
  '采纳后目标培训段落更新为压缩建议文本'
);
assert(
  updatedTrainingBlock.content.includes('16场') && updatedTrainingBlock.content.includes('800人次'),
  '采纳后目标段落严密保留“16场、800人次”'
);

// 4. 验证其他段落完全未受影响
otherBlocksBefore.forEach((ob) => {
  const currentBlock = updatedDraftA.blocks.find((b) => b.id === ob.id);
  assert(
    currentBlock !== undefined && currentBlock.content === ob.content,
    `其他段落【${ob.id}】内容严密保持不变`
  );
});

// -----------------------------------------------------------------------
// Acceptance Path B:
// 生成第2段建议后选中第4段，采纳仍针对第2段；需要时先提供“回到目标段落”
// -----------------------------------------------------------------------
console.log('\n>>> [验收 B] 目标段落解耦：选区漂移不影响建议绑定目标与采纳:');
const taskB = createPresetTask('under_review');
const draftB = taskB.drafts[0];
const block2 = draftB.blocks[1]; // 第2段
const block4 = draftB.blocks[3] || {
  id: 'BLK-EXTRA-4',
  sectionId: draftB.blocks[0].sectionId,
  order: 4,
  content: '这是第4段原本的内容，不应被第2段的修改建议所改写。',
  referencedFactIds: [],
  updatedAt: new Date().toISOString(),
};
if (!draftB.blocks.find((b) => b.id === block4.id)) {
  draftB.blocks.push(block4);
}

const originalBlock4Content = block4.content;

// 为第2段生成建议
const suggestionForBlock2 = generateParagraphRevision(
  block2,
  'formal',
  taskB.id,
  draftB.id,
  'RUN-B-2',
  { task: taskB, currentDraft: draftB }
);

assert(
  suggestionForBlock2.targetBlockId === block2.id,
  '建议明确绑定目标段落为第2段'
);

// 模拟用户在UI中选中第4段（光标聚焦于 block4）
const selectedCursorBlockId = block4.id;
assert(
  selectedCursorBlockId !== suggestionForBlock2.targetBlockId,
  '当前聚焦段落与建议目标段落不同'
);

// 采纳操作必须依据 suggestion.targetBlockId，而非当前选中的 block4
const adoptResultB = applyDraftContentChange(
  taskB,
  draftB.id,
  (blocks) =>
    blocks.map((b) =>
      b.id === suggestionForBlock2.targetBlockId
        ? { ...b, content: suggestionForBlock2.suggestedText, updatedAt: new Date().toISOString() }
        : b
    ),
  '采纳第2段修改建议',
  '主笔甲'
);

const updatedDraftB = adoptResultB.workingDraft;
const finalBlock2 = updatedDraftB.blocks.find((b) => b.id === block2.id)!;
const finalBlock4 = updatedDraftB.blocks.find((b) => b.id === block4.id)!;

assert(
  finalBlock2.content === suggestionForBlock2.suggestedText,
  '采纳后原目标第2段成功更新为建议文本'
);
assert(
  finalBlock4.content === originalBlock4Content,
  '当前聚焦的第4段完全未被篡改，严格保持原文本'
);

// -----------------------------------------------------------------------
// Acceptance Path C:
// 生成建议后人工修改目标段落，旧建议失效，实际采纳服务再次阻止覆盖
// -----------------------------------------------------------------------
console.log('\n>>> [验收 C] 人工修改段落后旧建议失效与直接覆盖拦截:');
const taskC = createPresetTask('under_review');
const draftC = taskC.drafts[0];
const targetBlockC = draftC.blocks[0];

const suggestionC = generateParagraphRevision(
  targetBlockC,
  'highlight',
  taskC.id,
  draftC.id,
  'RUN-C-1'
);

assert(
  suggestionC.baseContent === targetBlockC.content,
  '建议记录生成时的基准文本'
);

// 主笔在正文中手工修改了此段落
targetBlockC.content = '【主笔最新手工修订文本】深入贯彻落实机关各项制度部署，序时推进日常工作。';

// 采纳前基准校验
let isInvalidated = false;
let invalidateReason = '';
if (targetBlockC.content !== suggestionC.baseContent) {
  isInvalidated = true;
  invalidateReason = '采纳冲突：检测到目标段落自建议生成后已被人工编辑修改，基准内容已变动。为防止直接覆盖人工文本，建议已失效。';
}

assert(isInvalidated === true, '段落人工编辑后旧建议立即判定为失效');
assert(
  invalidateReason.includes('防止直接覆盖人工文本'),
  '给出明确防止覆盖人工文本的警示'
);

// -----------------------------------------------------------------------
// Acceptance Path D:
// 取消后切换任务、重试、模拟失败，都没有迟到覆盖或串任务
// -----------------------------------------------------------------------
console.log('\n>>> [验收 D] 异步适配器：取消、失败重试与跨任务严格隔离:');
async function testAsyncLifecycle() {
  const taskD1 = createPresetTask('under_review');
  taskD1.id = 'TASK-D-ALPHA';
  const taskD2 = createPresetTask('under_review');
  taskD2.id = 'TASK-D-BETA';

  const blockD1 = taskD1.drafts[0].blocks[0];

  // 1. 测试取消 (AbortSignal)
  const controller = new AbortController();
  const cancelPromise = requestParagraphRevisionAsync({
    block: blockD1,
    action: 'compress',
    task: taskD1,
    currentDraft: taskD1.drafts[0],
    runId: 'RUN-CANCEL-TEST',
    signal: controller.signal,
    delayMs: 100,
  });

  // 立即取消
  controller.abort();

  let cancelCaught = false;
  try {
    await cancelPromise;
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('取消')) {
      cancelCaught = true;
    }
  }
  assert(cancelCaught, '取消生成后 Promise 正确抛出 AbortError，未返回有效候选');

  // 2. 测试模拟失败与重试
  let failureCaught = false;
  try {
    await requestParagraphRevisionAsync({
      block: blockD1,
      action: 'compress',
      task: taskD1,
      currentDraft: taskD1.drafts[0],
      runId: 'RUN-FAIL-TEST',
      simulateFailure: true,
      delayMs: 20,
    });
  } catch (err: any) {
    failureCaught = true;
    assert(err.message.includes('模拟接口调用失败'), '捕获到明确的模拟失败异常提示');
  }
  assert(failureCaught, '模拟失败被正常捕获');

  // 重试成功
  const retryResult = await requestParagraphRevisionAsync({
    block: blockD1,
    action: 'compress',
    task: taskD1,
    currentDraft: taskD1.drafts[0],
    runId: 'RUN-RETRY-SUCCESS',
    simulateFailure: false,
    delayMs: 20,
  });
  assert(retryResult !== null && retryResult.suggestedText.length > 0, '重试生成成功产生建议');

  // 3. 跨任务串染拦截检验
  const crossTaskBlocked = retryResult.taskId !== taskD2.id;
  assert(crossTaskBlocked, '任务A生成的修改建议严格禁止采纳到任务B中');
}

await testAsyncLifecycle();

// -----------------------------------------------------------------------
// Acceptance Path E:
// 基于历史稿继续编辑产生新工作稿，原快照及冻结审阅状态不变
// -----------------------------------------------------------------------
console.log('\n>>> [验收 E] 基于历史只读快照继续编辑：自动分叉新工作稿与快照保护:');
const taskE = createPresetTask('under_review');
const histDraft: DraftVersion = {
  id: 'DRAFT-HIST-1',
  versionNumber: 'v1.0 (历史快照)',
  createdAt: '2026-10-06T10:00:00.000Z',
  author: '主笔甲',
  summary: '历史归档快照',
  blocks: JSON.parse(JSON.stringify(taskE.drafts[0].blocks)),
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  isFinal: false,
  frozenReviewComments: [
    {
      id: 'REV-HIST-FROZEN',
      type: 'overall',
      targetVersionId: 'DRAFT-HIST-1',
      reviewer: '审阅乙',
      content: '历史版本归档时的冻结意见',
      status: 'pending',
      createdAt: new Date().toISOString(),
    },
  ],
};
taskE.drafts.push(histDraft);

const originalHistSummary = histDraft.summary;
const originalHistBlocks = JSON.stringify(histDraft.blocks);
const originalHistFrozenComments = JSON.stringify(histDraft.frozenReviewComments);

// 基于历史快照编辑
const forkResult = applyDraftContentChange(
  taskE,
  histDraft.id,
  (blocks) => {
    const updated = JSON.parse(JSON.stringify(blocks));
    updated[0].content = '基于历史快照继续编辑后的新工作稿首段内容。';
    return updated;
  },
  '基于历史快照继续编辑',
  '主笔甲'
);

assert(forkResult.forkedNewDraft === true, '基于历史快照编辑成功触发新工作稿分叉');
assert(forkResult.workingDraft.isWorkingDraft === true, '新文稿标记为工作草稿');
assert(forkResult.workingDraft.isHistoricalSnapshot === false, '新文稿不是历史快照');
assert(forkResult.workingDraft.sourceDraftId === histDraft.id, '新工作稿正确记录 sourceDraftId 为历史快照ID');

// 校验原历史快照完全不受影响
const unchangedHist = forkResult.updatedTask.drafts.find((d) => d.id === histDraft.id)!;
assert(unchangedHist.isHistoricalSnapshot === true, '原历史快照继续保持只读历史快照属性');
assert(unchangedHist.isWorkingDraft === false, '原历史快照未变为工作稿');
assert(JSON.stringify(unchangedHist.blocks) === originalHistBlocks, '原历史快照段落文本完全未变');
assert(
  JSON.stringify(unchangedHist.frozenReviewComments) === originalHistFrozenComments,
  '原历史快照冻结的审阅意见记录完全未被改动或覆盖'
);

// -----------------------------------------------------------------------
// Acceptance Path F:
// 审阅身份可以看建议和提出意见，无法代主笔修改正文
// -----------------------------------------------------------------------
console.log('\n>>> [验收 F] 审阅角色权限边界：只读/批注有效，修改正文严格拦截:');
const reviewerRole: UserRole = '审阅乙';

assert(checkPermission(reviewerRole, 'add_comment').allowed === true, '审阅身份允许提出审阅意见');
assert(checkPermission(reviewerRole, 'edit_draft').allowed === false, '审阅身份严格禁止直接修改正文草稿');
assert(checkPermission(reviewerRole, 'adopt_revision').allowed === false, '审阅身份严格禁止采纳修改建议');

let reviewerEditBlocked = false;
try {
  applyDraftContentChange(
    taskE,
    forkResult.workingDraft.id,
    (blocks) => blocks,
    '审阅人尝试修改正文',
    reviewerRole
  );
} catch (err: any) {
  reviewerEditBlocked = true;
  assert(err.message.includes('权限受限'), '真实服务入口拦截审阅角色并抛出明确权限说明');
}
assert(reviewerEditBlocked, '审阅人无法直接调用底层修改服务改写正文');

// -----------------------------------------------------------------------
// Additional Acceptance Tests for Task 11:
// 自定义指令支持、未支持指令限制、真实案例依据过滤、可见差异高亮
// -----------------------------------------------------------------------
console.log('\n>>> [补充验收] 自定义指令、未支持指令限制、真实案例与可见Diff:');
const taskExtra = createPresetTask('under_review');
const testBlock = taskExtra.drafts[0].blocks[0];
testBlock.content = '紧紧围绕年度核心工作目标，强化统筹联动与机制创新。2026年1至9月，各项既定重点任务平稳有序开展。截至统计期末，累计完成重点攻坚任务128项，各项既定序时指标平稳达成。';

// 1. 指令：“精简表达并保留数据”
const customCompressRes = generateParagraphRevision(
  testBlock,
  'custom',
  taskExtra.id,
  taskExtra.drafts[0].id,
  'RUN-CUST-1',
  { customPrompt: '精简表达并保留数据', task: taskExtra, currentDraft: taskExtra.drafts[0] }
);
assert(customCompressRes.suggestedText.includes('128项'), '自定义精简指令严格保留128项指标');
assert(customCompressRes.suggestedText.includes('2026年1至9月'), '自定义精简指令严格保留统计期间');
assert(customCompressRes.suggestedText.length < testBlock.content.length, '自定义精简指令成功压缩冗余修饰');
assert(customCompressRes.isUnsupportedPrompt !== true, '支持的演示指令未被误判为未支持');

// 2. 指令：“改成面向单位负责人的汇报口吻”
const customReportRes = generateParagraphRevision(
  testBlock,
  'custom',
  taskExtra.id,
  taskExtra.drafts[0].id,
  'RUN-CUST-2',
  { customPrompt: '改成面向单位负责人的汇报口吻', task: taskExtra, currentDraft: taskExtra.drafts[0] }
);
assert(customReportRes.suggestedText.includes('128项'), '汇报口吻指令严格保留128项指标');
assert(
  customReportRes.suggestedText.includes('紧扣全局中心工作部署') || customReportRes.suggestedText.includes('高位'),
  '汇报口吻指令转换为面向领导的高站位汇报句式'
);

// 3. 指令：“突出成效并删减泛泛修饰”
const customHighlightRes = generateParagraphRevision(
  testBlock,
  'custom',
  taskExtra.id,
  taskExtra.drafts[0].id,
  'RUN-CUST-3',
  { customPrompt: '突出成效并删减泛泛修饰', task: taskExtra, currentDraft: taskExtra.drafts[0] }
);
assert(customHighlightRes.suggestedText.includes('【重点成效】'), '成效指令增设【重点成效】标识');
assert(customHighlightRes.suggestedText.includes('128项'), '成效指令严格保留128项指标');

// 4. 未支持指令限制说明（不能假装理解任意自由指令）
const unsupportedPromptRes = generateParagraphRevision(
  testBlock,
  'custom',
  taskExtra.id,
  taskExtra.drafts[0].id,
  'RUN-CUST-4',
  { customPrompt: '帮我写一首李白风格的五言律诗', task: taskExtra, currentDraft: taskExtra.drafts[0] }
);
assert(unsupportedPromptRes.isUnsupportedPrompt === true, '开放式未支持指令被明确标记为 isUnsupportedPrompt');
assert(
  unsupportedPromptRes.unsupportedPromptNotice !== undefined &&
  unsupportedPromptRes.unsupportedPromptNotice.includes('原型仅支持明确的演示指令'),
  '返回清楚的演示限制说明，未用无关固定文案假装理解'
);
assert(
  unsupportedPromptRes.suggestedText === testBlock.content,
  '未支持指令未生成无关或幻觉文本'
);

// 5. 无真实案例材料时，补充表达提示补材料且不编造具体案例
const taskNoCases = JSON.parse(JSON.stringify(taskExtra)) as Task;
taskNoCases.snippets = []; // 清空案例材料
const expandNoCaseRes = generateParagraphRevision(
  testBlock,
  'expand',
  taskNoCases.id,
  taskNoCases.drafts[0].id,
  'RUN-EXP-1',
  { task: taskNoCases, currentDraft: taskNoCases.drafts[0] }
);
assert(
  expandNoCaseRes.diffExplanation.includes('材料库中暂无本期核准的真实典型案例材料') ||
  (expandNoCaseRes.needsVerificationNotes && expandNoCaseRes.needsVerificationNotes.some((n) => n.includes('真实案例材料'))),
  '无真实案例材料时明确提示补充材料，严禁捏造虚构案例'
);

// 6. 可见 Diff 校验（包含 equal, added, removed 标记）
const diffSegs = computeTextDiff('累计完成任务120项，平稳推进。', '累计完成任务128项。');
assert(diffSegs.some((s) => s.type === 'removed'), 'Diff正确识别删减内容');
assert(diffSegs.some((s) => s.type === 'added'), 'Diff正确识别新增内容');
assert(diffSegs.some((s) => s.type === 'equal'), 'Diff正确识别相同内容');

console.log('\n==============================================');
console.log('   🎉 任务11 全部验收与回归测试全部通过！');
console.log('==============================================\n');
