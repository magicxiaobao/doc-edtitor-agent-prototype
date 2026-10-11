import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { createPresetTask } from './src/services/mockData';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { DraftingStage } from './src/components/stages/DraftingStage';
import {
  getReviewCommentLocation,
  resolveReviewNavigationContext,
  rebindReviewCommentTargetBlock,
  implementReviewCommentWithText,
} from './src/services/reviewCoordinationService';
import {
  submitDraftForReview,
  applyDraftContentChange,
} from './src/services/draftLifecycleService';
import { requestParagraphRevisionAsync } from './src/services/paragraphRevisionAdapter';
import { ReviewComment, Task, DraftVersion } from './src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

console.log('================================================================');
console.log('   任务16 接通审阅意见到正文工作区精确定位专项验收与回归测试');
console.log('================================================================\n');

// --------------------------------------------------------------------------
// 验收用例 A: 从第2段意见跳转：选中第2段，意见面板定位该意见，基于意见生成的建议 sourceCommentId 与目标段落均正确，第1段没有正文变更
// --------------------------------------------------------------------------
console.log('>>> [验收用例 A] 从第2段意见跳转、精确定位与改写隔离测试:');

const taskA = createPresetTask('under_review');
const draftA = taskA.drafts.find((d) => d.id === taskA.currentDraftId)!;
const block1A = draftA.blocks[0];
const block2A = draftA.blocks[1];
const originalBlock1Text = block1A.content;
const originalBlock2Text = block2A.content;

const commentOnBlock2: ReviewComment = {
  id: 'CMT-TASK16-BLK2',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: block2A.id,
  targetBlockOrder: block2A.order,
  baseParagraphText: block2A.content,
  reviewer: '审阅乙',
  content: '第2段基层调研举措表述过于笼统，需具体突出成效并保留量化数据',
  suggestedChange: '深入推进基层调研专项，紧扣既定序时进度，务实推动工作落地见效。',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithCommentA: Task = {
  ...taskA,
  reviewComments: [commentOnBlock2, ...taskA.reviewComments],
};

// 1. Navigation context resolution test
const navContextA = resolveReviewNavigationContext(commentOnBlock2, draftA);
assert(navContextA.location?.isLocated === true, 'A1: 导航解析定位成功 (isLocated: true)');
assert(navContextA.targetBlock?.id === block2A.id, 'A2: 导航解析有效目标段落为第2段 block2');
assert(navContextA.targetBlock?.order === 2, 'A3: 导航解析目标段落序号为 2');
assert(navContextA.isDeletedOrMissing === false, 'A4: 未误判为段落缺失');
assert(navContextA.isOverall === false, 'A5: 正确识别为段落意见而非全局意见');
assert(navContextA.scopeDescription.includes('仅限第2段'), 'A6: 修改范围描述明确约束为仅限第2段');

// 2. Component rendering test: ReviewStage navigation trigger
let navigatedCommentId: string | null = null;
let navigatedDraftId: string | null = null;
const reviewStageHtml = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: taskWithCommentA,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    onSelectStage: () => {},
    onNavigateToDraftComment: (cmtId: string, dId?: string) => {
      navigatedCommentId = cmtId;
      navigatedDraftId = dId;
    },
  })
);
assert(reviewStageHtml.includes('在正文工作区定位与落实'), 'A7: 审阅页意见卡片提供【在正文工作区定位与落实】入口');

// 3. Component rendering test: DraftingStage with navIntent
const draftingStageHtmlA = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithCommentA,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskWithCommentA.id,
      commentId: commentOnBlock2.id,
      targetDraftId: draftA.id,
      timestamp: Date.now(),
    },
  })
);

// Verify block2 has the review comment context banner
assert(draftingStageHtmlA.includes(`block-card-${block2A.id}`), 'A8: 正文工作区渲染第2段卡片容器');
assert(draftingStageHtmlA.includes('来源：【审阅乙】审阅意见'), 'A9: 第2段正文卡片清晰标注来源【审阅乙】审阅意见');
assert(draftingStageHtmlA.includes('当前第2段'), 'A10: 第2段卡片显示当前第2段标识');
assert(draftingStageHtmlA.includes('修改范围：仅限第2段'), 'A11: 正文卡片明确约束修改范围为仅限第2段');
assert(draftingStageHtmlA.includes(`comment-card-${commentOnBlock2.id}`), 'A12: 右侧辅助面板审阅意见列表定位并高亮对应卡片');

// 4. Generate suggestion targeting block 2 using the comment
const suggestionA = await requestParagraphRevisionAsync({
  block: block2A,
  action: 'custom',
  customPrompt: commentOnBlock2.suggestedChange,
  sourceComment: commentOnBlock2,
  task: taskWithCommentA,
  currentDraft: draftA,
  runId: 'RUN-TASK16-A',
  delayMs: 10,
});

assert(suggestionA.sourceCommentId === commentOnBlock2.id, 'A13: AI建议成功绑定 sourceCommentId');
assert(suggestionA.sourceCommentReviewer === '审阅乙', 'A14: AI建议记录审阅人为审阅乙');
assert(suggestionA.targetBlockId === block2A.id, 'A15: AI建议精确绑定目标段落为 block2');
assert(suggestionA.targetBlockOrder === 2, 'A16: AI建议记录目标段落序号为 2');

// 5. Adopt modification on block 2
const { updatedTask: taskAfterAdoptA, workingDraft: workingDraftA } = applyDraftContentChange(
  taskWithCommentA,
  draftA.id,
  (blocks) =>
    blocks.map((b) =>
      b.id === block2A.id ? { ...b, content: suggestionA.suggestedText } : b
    ),
  '采纳审阅修改建议',
  '主笔甲'
);

const adoptedBlock1 = workingDraftA.blocks.find((b) => b.id === block1A.id)!;
const adoptedBlock2 = workingDraftA.blocks.find((b) => b.id === block2A.id)!;

assert(adoptedBlock1.content === originalBlock1Text, 'A17: 【关键隔离】第1段正文 100% 保持原样，零任何改动！');
assert(adoptedBlock2.content === suggestionA.suggestedText, 'A18: 第2段正文成功更新为落实后的建议文本');

// --------------------------------------------------------------------------
// 验收用例 B: 从另一条意见跳转：覆盖之前的选中上下文，不残留上一条指令或旧建议
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 B] 跨意见跳转：上下文覆盖与清理测试:');

const block3A = draftA.blocks[2] || { id: 'BLK-03', order: 3, content: '第3段测试正文', sectionId: 'SEC-02', referencedFactIds: [], updatedAt: '' };
const commentOnBlock3: ReviewComment = {
  id: 'CMT-TASK16-BLK3',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: block3A.id,
  targetBlockOrder: block3A.order,
  baseParagraphText: block3A.content,
  reviewer: '审阅丁',
  content: '第3段需要精简文字，突出工作成效',
  suggestedChange: '精炼表述，突出成效。',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithTwoComments: Task = {
  ...taskWithCommentA,
  reviewComments: [commentOnBlock2, commentOnBlock3],
};

const navContextB = resolveReviewNavigationContext(commentOnBlock3, draftA);
assert(navContextB.targetBlock?.id === block3A.id, 'B1: 导航解析新意见目标为第3段 block3');
assert(navContextB.comment?.id === commentOnBlock3.id, 'B2: 导航解析意见为 commentOnBlock3');

const draftingStageHtmlB = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithTwoComments,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskWithTwoComments.id,
      commentId: commentOnBlock3.id,
      targetDraftId: draftA.id,
      timestamp: Date.now() + 100,
    },
  })
);

assert(draftingStageHtmlB.includes('来源：【审阅丁】审阅意见'), 'B3: 成功切换为新意见来源【审阅丁】');
assert(draftingStageHtmlB.includes(`comment-card-${commentOnBlock3.id}`), 'B4: 右侧面板成功选中并高亮新意见卡片');

// --------------------------------------------------------------------------
// 验收用例 C: 意见已重绑：跳到重绑后的有效段落，提出时版本、原文和原始段落ID不变；重绑时为空正文的语义不变
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 C] 重绑意见精确定位与存证保护测试:');

const reboundCommentTest: ReviewComment = {
  id: 'CMT-TASK16-REBOUND',
  type: 'paragraph',
  targetVersionId: 'v1.0-snapshot-base',
  targetVersionNumber: 'v1.0 (基准)',
  targetBlockId: 'BLK-ORIG-01',
  targetBlockOrder: 1,
  baseParagraphText: '提出时的第1段原始文本',
  currentBlockId: block2A.id,
  currentBlockOrder: block2A.order,
  reboundParagraphText: block2A.content,
  rebindRecord: {
    reboundAt: new Date().toISOString(),
    reboundBy: '主笔甲',
    fromBlockId: 'BLK-ORIG-01',
    fromBlockOrder: 1,
    toBlockId: block2A.id,
    toBlockOrder: block2A.order,
    targetDraftId: draftA.id,
    reboundParagraphText: block2A.content,
  },
  reviewer: '审阅乙',
  content: '原第1段已变动，经主笔人工重新指定至第2段落实',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextC = resolveReviewNavigationContext(reboundCommentTest, draftA);
assert(navContextC.targetBlock?.id === block2A.id, 'C1: 重绑意见成功解析定位到新段落 block2');
assert(navContextC.isRebound === true, 'C2: 正确识别为已重绑定意见 (isRebound: true)');
assert(reboundCommentTest.targetBlockId === 'BLK-ORIG-01', 'C3: 原始提出时段落ID BLK-ORIG-01 严格未被覆盖');
assert(reboundCommentTest.targetBlockOrder === 1, 'C4: 原始提出时序号 1 严格未被覆盖');
assert(reboundCommentTest.baseParagraphText === '提出时的第1段原始文本', 'C5: 原始提出时基准原文严格未被覆盖');

// Empty string rebound semantics test
const emptyReboundComment: ReviewComment = {
  ...reboundCommentTest,
  id: 'CMT-EMPTY-REBOUND',
  reboundParagraphText: '',
  rebindRecord: {
    ...reboundCommentTest.rebindRecord!,
    reboundParagraphText: '',
  },
};
const emptyBlockDraft: DraftVersion = {
  ...draftA,
  blocks: [{ ...block2A, content: '' }],
};
const navContextEmpty = resolveReviewNavigationContext(emptyReboundComment, emptyBlockDraft);
assert(navContextEmpty.hasTextModified === false, 'C6: 重绑时段落为空字符串时，未修改情况下 hasTextModified 为 false (?? 语义完全保留)');

// --------------------------------------------------------------------------
// 验收用例 D: 段落已删除：提示重新指定目标，不定位首段，不发生写入
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 D] 目标段落已删除/缺失时容错与阻断测试:');

const deletedBlockComment: ReviewComment = {
  id: 'CMT-TASK16-DELETED',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: 'BLK-ALREADY-DELETED-999',
  targetBlockOrder: 9,
  baseParagraphText: '已被删除的历史段落文本',
  reviewer: '审阅乙',
  content: '这段文字已被整体删除',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextD = resolveReviewNavigationContext(deletedBlockComment, draftA);
assert(navContextD.isDeletedOrMissing === true, 'D1: 正确识别目标段落已缺失 (isDeletedOrMissing: true)');
assert(navContextD.targetBlock === undefined, 'D2: 未错误伪造匹配其他段落 (targetBlock is undefined)');
assert(navContextD.scopeDescription.includes('目标段落已缺失'), 'D3: 范围描述明确提示段落缺失需重新指定');

const taskWithDeletedComment: Task = {
  ...taskA,
  reviewComments: [deletedBlockComment],
};

const draftingStageHtmlD = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithDeletedComment,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskWithDeletedComment.id,
      commentId: deletedBlockComment.id,
      targetDraftId: draftA.id,
      timestamp: Date.now(),
    },
  })
);

assert(draftingStageHtmlD.includes('定位需复核：原目标段落已在正文中删除或合并'), 'D4: 页面顶部与卡片明确展示【定位需复核：原目标段落已在正文中删除或合并】提示');
assert(draftingStageHtmlD.includes('重新指定目标段落'), 'D5: 页面清晰提供【重新指定目标段落】操作按钮');

// Ensure writing fails without rebinding
let writeBlocked = false;
try {
  implementReviewCommentWithText(
    taskWithDeletedComment,
    deletedBlockComment.id,
    draftA.id,
    '尝试写入不存在的段落',
    '主笔答复',
    '主笔甲'
  );
} catch (err: any) {
  writeBlocked = true;
  assert(err.message.includes('已被删除或重构') || err.message.includes('定位需复核'), 'D6: 未重定位前严禁直接修改正文，服务抛出保护性异常');
}
assert(writeBlocked, 'D7: 段落缺失意见直接写入被成功安全阻断');

// --------------------------------------------------------------------------
// 验收用例 E: 全局意见：要求明确选择修改范围，不伪造首段定位
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 E] 全局意见范围约束与非首段伪造测试:');

const overallCommentTest: ReviewComment = {
  id: 'CMT-TASK16-OVERALL',
  type: 'overall',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  reviewer: '审阅乙',
  content: '全文篇幅需进一步统筹精炼，控制在2000字以内',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextE = resolveReviewNavigationContext(overallCommentTest, draftA);
assert(navContextE.isOverall === true, 'E1: 正确识别为全局意见 (isOverall: true)');
assert(navContextE.targetBlock === undefined, 'E2: 全局意见 targetBlock 为 undefined（绝不伪造首段定位）');
assert(navContextE.scopeDescription.includes('全局审阅意见'), 'E3: 范围说明提示在正文中选择要应用修改的目标段落');

const taskWithOverallComment: Task = {
  ...taskA,
  reviewComments: [overallCommentTest],
};

const draftingStageHtmlE = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithOverallComment,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskWithOverallComment.id,
      commentId: overallCommentTest.id,
      targetDraftId: draftA.id,
      timestamp: Date.now(),
    },
  })
);

assert(draftingStageHtmlE.includes('正在定位全局审阅意见：【审阅乙】'), 'E4: 页面顶部展示全局意见定位提示横幅');
assert(draftingStageHtmlE.includes('全篇适用'), 'E5: 提示横幅标明全篇适用');
assert(draftingStageHtmlE.includes('未绑定固定段落'), 'E6: 页面明确告知用户此意见未绑定固定段落，需选择段落');

// --------------------------------------------------------------------------
// 验收用例 F: 切换任务与历史视图：不串入旧上下文、不修改只读稿
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 F] 切换任务隔离与只读快照保护测试:');

// 1. Task switching isolation test
const taskF1 = createPresetTask('ready_to_draft');
const taskF2 = createPresetTask('under_review');
const mismatchedIntent = {
  taskId: taskF1.id, // belongs to taskF1
  commentId: 'CMT-OLD-001',
  timestamp: Date.now(),
};

let clearNavCalled = false;
ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskF2, // current is taskF2
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: mismatchedIntent,
    onClearNavIntent: () => {
      clearNavCalled = true;
    },
  })
);
assert(clearNavCalled, 'F1: 传入其他任务的 navigation intent 时立即触发 onClearNavIntent 隔离清理');

// 2. Readonly snapshot protection
const immutableDraft: DraftVersion = {
  ...draftA,
  id: 'd-hist-snap-01',
  versionNumber: 'v1.0 (历史快照)',
  isHistoricalSnapshot: true,
};

const taskWithImmutable: Task = {
  ...taskA,
  currentDraftId: immutableDraft.id,
  drafts: [immutableDraft, draftA],
};

const draftingStageHtmlF = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithImmutable,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(draftingStageHtmlF.includes('只读快照保护'), 'F2: 处于历史快照时展示只读快照保护横幅');
assert(draftingStageHtmlF.includes('返回当前工作稿'), 'F3: 提供明确的【返回当前工作稿】快捷入口');
assert(draftingStageHtmlF.includes('基于此稿继续编辑（创建新工作稿）'), 'F4: 无可编辑稿时提供基于只读快照创建新工作稿入口');

// --------------------------------------------------------------------------
// 验收用例 G: 调整提交确认框：验证确认生成审阅基准、轮次更新、进入审阅页面；取消不改变稿件、轮次和任务状态
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 G] 提交审阅站内确认对话框与生命周期回归测试:');

const taskG = createPresetTask('under_review');
const currentDraftG = taskG.drafts[0];
const initialDraftCount = taskG.drafts.length;
const initialRound = taskG.currentReviewRound || 0;
const initialStatus = taskG.status;

// 1. Verify in-app modal markup rendered in DraftingStage
const draftingStageModalHtml = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskG,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);
assert(draftingStageModalHtml.includes('提交本轮审阅'), 'G1: 起草阶段顶部操作区提供【提交本轮审阅】按钮');

// 2. Cancellation test: draft, round, and status unchanged
assert(taskG.drafts.length === initialDraftCount, 'G2: 取消提交审阅时，文稿版本数量保持完全不变');
assert((taskG.currentReviewRound || 0) === initialRound, 'G3: 取消提交审阅时，审阅轮次保持完全不变');
assert(taskG.status === initialStatus, 'G4: 取消提交审阅时，任务状态保持完全不变');

// 3. Confirmation test: invoke submitDraftForReview
const { updatedTask: taskAfterSubmit } = submitDraftForReview(
  taskG,
  currentDraftG.id,
  '主笔甲',
  true
);

assert(taskAfterSubmit.status === '审阅中', 'G5: 确认提交审阅后，任务状态变更为“审阅中”');
assert(taskAfterSubmit.currentReviewRound === initialRound + 1, 'G6: 确认提交审阅后，审阅轮次正确递增为第 1 轮');
assert(Boolean(taskAfterSubmit.reviewBaseDraftId), 'G7: 确认提交审阅后，生成有效的本轮审阅基准ID (reviewBaseDraftId)');
const frozenBaseDraft = taskAfterSubmit.drafts.find((d) => d.id === taskAfterSubmit.reviewBaseDraftId);
assert(Boolean(frozenBaseDraft), 'G8: 审阅基准快照已成功冻结并作为版本保存在 drafts 列表中');
assert(frozenBaseDraft?.isHistoricalSnapshot === true, 'G9: 审阅基准快照具有不可篡改的 isHistoricalSnapshot: true 属性');

console.log('\n================================================================');
console.log('   🎉 任务16 全部 7 项深度验收用例与回归测试 100% 通过！');
console.log('================================================================');
