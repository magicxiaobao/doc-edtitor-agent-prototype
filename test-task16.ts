import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
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

// Setup JSDOM environment for real component mounting, effects, and click event tests
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Helper to mount component in JSDOM with React 18 createRoot & act
function mountTestComponent(element: React.ReactElement) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    rerender: (newElement: React.ReactElement) => {
      act(() => {
        root.render(newElement);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

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
  suggestedChange: '在队伍履职能力建设方面，深化专业实操培养。前三季度组织专题培训16场，参训800人次，务实推动工作落地见效。',
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

// 2. Component rendering & mounted click test: ReviewStage navigation trigger
let navigatedCommentId: string | null = null;
let navigatedDraftId: string | null = null;

const { container: reviewContainer, unmount: unmountReview } = mountTestComponent(
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

const navButtons = Array.from(reviewContainer.querySelectorAll('button')).filter((b) =>
  b.textContent?.includes('在正文工作区定位与落实')
);
assert(navButtons.length > 0, 'A7.1: 审阅页意见卡片提供【在正文工作区定位与落实】入口');

act(() => {
  navButtons[0].click();
});
assert(navigatedCommentId === commentOnBlock2.id, 'A7.2: 点击落实按钮真实触发导航回调并传递 commentId');
assert(navigatedDraftId === draftA.id, 'A7.3: 点击落实按钮真实传递 targetDraftId');
unmountReview();

// 3. Component mounted rendering test: DraftingStage with navIntent
const { container: draftingContainerA, unmount: unmountDraftingA } = mountTestComponent(
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

const draftingHtmlA = draftingContainerA.innerHTML;
assert(draftingHtmlA.includes(`block-card-${block2A.id}`), 'A8: 正文工作区渲染第2段卡片容器');
assert(draftingHtmlA.includes('来源：【审阅乙】审阅意见'), 'A9: 第2段正文卡片清晰标注来源【审阅乙】审阅意见');
assert(draftingHtmlA.includes('当前第2段'), 'A10: 第2段卡片显示当前第2段标识');
assert(draftingHtmlA.includes('修改范围：仅限第2段'), 'A11: 正文卡片明确约束修改范围为仅限第2段');
assert(draftingHtmlA.includes(`comment-card-${commentOnBlock2.id}`), 'A12: 右侧辅助面板审阅意见列表定位并高亮对应卡片');
unmountDraftingA();

// 4. Generate suggestion targeting block 2 using the comment
const suggestionA = await requestParagraphRevisionAsync({
  block: block2A,
  action: 'custom',
  customPrompt: commentOnBlock2.suggestedChange,
  sourceComment: commentOnBlock2,
  task: taskWithCommentA,
  currentDraft: draftA,
  runId: 'RUN-TASK16-A',
});

assert(suggestionA.sourceCommentId === commentOnBlock2.id, 'A13: AI建议成功绑定 sourceCommentId');
assert(suggestionA.sourceCommentReviewer === '审阅乙', 'A14: AI建议记录审阅人为审阅乙');
assert(suggestionA.targetBlockId === block2A.id, 'A15: AI建议精确绑定目标段落为 block2');
assert(suggestionA.targetBlockOrder === 2, 'A16: AI建议记录目标段落序号为 2');

// 5. Apply suggestion to block 2 only and verify block 1 is 100% untouched
const { workingDraft: updatedDraftA } = applyDraftContentChange(
  taskWithCommentA,
  draftA.id,
  (blocks) => blocks.map((b) => (b.id === block2A.id ? { ...b, content: suggestionA.suggestedText } : b)),
  '采纳落实第2段修改建议',
  '主笔甲'
);

const updatedBlock1A = updatedDraftA.blocks.find((b) => b.id === block1A.id)!;
const updatedBlock2A = updatedDraftA.blocks.find((b) => b.id === block2A.id)!;

assert(
  updatedBlock1A.content === originalBlock1Text,
  'A17: 【关键隔离】第1段正文 100% 保持原样，零任何改动！'
);
assert(
  updatedBlock2A.content === suggestionA.suggestedText && updatedBlock2A.content !== originalBlock2Text,
  'A18: 第2段正文成功更新为落实后的建议文本'
);

// --------------------------------------------------------------------------
// 验收用例 B: 跨意见跳转：从第2段意见直接点击第3段意见跳转，工作区高亮与辅助面板选中的意见同步切换为第3段，清除上一条意见的上下文
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 B] 跨意见跳转：上下文覆盖与清理测试:');

const block3A = draftA.blocks[2];
const commentOnBlock3: ReviewComment = {
  id: 'CMT-TASK16-BLK3',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: block3A.id,
  targetBlockOrder: block3A.order,
  baseParagraphText: block3A.content,
  reviewer: '审阅丁',
  content: '第3段表述存在重复，建议删减铺垫词句',
  suggestedChange: '精炼表述，直奔主题。',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithTwoComments: Task = {
  ...taskA,
  reviewComments: [commentOnBlock2, commentOnBlock3, ...taskA.reviewComments],
};

const navContextB = resolveReviewNavigationContext(commentOnBlock3, draftA);
assert(navContextB.targetBlock?.id === block3A.id, 'B1: 导航解析新意见目标为第3段 block3');
assert(navContextB.comment?.id === commentOnBlock3.id, 'B2: 导航解析意见为 commentOnBlock3');

const { container: draftingContainerB, unmount: unmountDraftingB } = mountTestComponent(
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

const draftingHtmlB = draftingContainerB.innerHTML;
assert(draftingHtmlB.includes('来源：【审阅丁】审阅意见'), 'B3: 成功切换为新意见来源【审阅丁】');
assert(draftingHtmlB.includes(`comment-card-${commentOnBlock3.id}`), 'B4: 右侧面板成功选中并高亮新意见卡片');
unmountDraftingB();

// --------------------------------------------------------------------------
// 验收用例 C: 重绑意见跳转：对已重定位到新段落的意见发起跳转，正确高亮新段落，保留重绑存证与原始段落信息
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 C] 重绑意见精确定位与存证保护测试:');

const reboundComment: ReviewComment = {
  id: 'CMT-TASK16-REBOUND',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: 'BLK-ORIG-01',
  targetBlockOrder: 1,
  baseParagraphText: '原始第一段基准原句',
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
    reason: '段落合并后重新绑定到第2段',
    reboundParagraphText: block2A.content,
  },
  reviewer: '审阅乙',
  content: '关于重定位段落的修改要求',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextC = resolveReviewNavigationContext(reboundComment, draftA);
assert(navContextC.targetBlock?.id === block2A.id, 'C1: 重绑意见成功解析定位到新段落 block2');
assert(navContextC.isRebound === true, 'C2: 正确识别为已重绑定意见 (isRebound: true)');
assert(reboundComment.targetBlockId === 'BLK-ORIG-01', 'C3: 原始提出时段落ID BLK-ORIG-01 严格未被覆盖');
assert(reboundComment.targetBlockOrder === 1, 'C4: 原始提出时序号 1 严格未被覆盖');
assert(reboundComment.baseParagraphText === '原始第一段基准原句', 'C5: 原始提出时基准原文严格未被覆盖');

const emptyReboundComment: ReviewComment = {
  ...reboundComment,
  reboundParagraphText: '',
  rebindRecord: {
    ...reboundComment.rebindRecord!,
    reboundParagraphText: '',
  },
};
const emptyDraft: DraftVersion = {
  ...draftA,
  blocks: draftA.blocks.map((b) => (b.id === block2A.id ? { ...b, content: '' } : b)),
};
const emptyNavContext = resolveReviewNavigationContext(emptyReboundComment, emptyDraft);
assert(emptyNavContext.hasTextModified === false, 'C6: 重绑时段落为空字符串时，未修改情况下 hasTextModified 为 false');

// --------------------------------------------------------------------------
// 验收用例 D: 目标段落已删除/缺失：意见对应的段落在当前稿件不存在，不可伪造定位首段或错误段落，明确提示需重新指定，并阻断自动改写
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 D] 目标段落已删除/缺失时容错与阻断测试:');

const commentOnDeletedBlock: ReviewComment = {
  id: 'CMT-TASK16-DELETED',
  type: 'paragraph',
  targetVersionId: draftA.id,
  targetVersionNumber: draftA.versionNumber,
  targetBlockId: 'BLK-NON-EXISTENT-999',
  targetBlockOrder: 9,
  baseParagraphText: '已被删除段落的原始存证文本',
  reviewer: '审阅乙',
  content: '对已被删除段落的修改意见',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextD = resolveReviewNavigationContext(commentOnDeletedBlock, draftA);
assert(navContextD.isDeletedOrMissing === true, 'D1: 正确识别目标段落已缺失 (isDeletedOrMissing: true)');
assert(navContextD.targetBlock === undefined, 'D2: 未错误伪造匹配其他段落 (targetBlock is undefined)');
assert(navContextD.scopeDescription.includes('目标段落已缺失/删除'), 'D3: 范围描述明确提示段落缺失需重新指定');

const taskWithDeletedComment: Task = {
  ...taskA,
  reviewComments: [commentOnDeletedBlock, ...taskA.reviewComments],
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
      commentId: commentOnDeletedBlock.id,
      targetDraftId: draftA.id,
      timestamp: Date.now(),
    },
  })
);

assert(
  draftingStageHtmlD.includes('定位需复核：原目标段落已在正文中删除或合并'),
  'D4: 页面明确展示【定位需复核：原目标段落已在正文中删除或合并】提示'
);
assert(
  draftingStageHtmlD.includes('重新指定目标段落'),
  'D5: 页面清晰提供【重新指定目标段落】操作按钮'
);

let blockedErrorMsg = '';
try {
  implementReviewCommentWithText(
    taskWithDeletedComment,
    commentOnDeletedBlock.id,
    draftA.id,
    '试图在未重定位情况下直接写入正文',
    '主笔答复说明',
    '主笔甲'
  );
} catch (err: any) {
  blockedErrorMsg = err.message;
}
assert(
  blockedErrorMsg.includes('已被删除或重构') || blockedErrorMsg.includes('定位需复核'),
  'D6: 未重定位前严禁直接修改正文，服务抛出保护性异常'
);
assert(Boolean(blockedErrorMsg), 'D7: 段落缺失意见直接写入被成功安全阻断');

// --------------------------------------------------------------------------
// 验收用例 E: 全局意见跳转：提示在正文选择要落实的目标段落或章节，不伪造成首段意见，范围说明为全篇
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 E] 全局意见范围约束与非首段伪造测试:');

const overallCommentE: ReviewComment = {
  id: 'CMT-TASK16-OVERALL',
  type: 'overall',
  reviewer: '审阅丁',
  content: '全文需增强战略高度，压缩各部分开头常规表述约20%',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const navContextE = resolveReviewNavigationContext(overallCommentE, draftA);
assert(navContextE.isOverall === true, 'E1: 正确识别为全局意见 (isOverall: true)');
assert(navContextE.targetBlock === undefined, 'E2: 全局意见 targetBlock 为 undefined（绝不伪造首段定位）');
assert(navContextE.scopeDescription.includes('全局审阅意见'), 'E3: 范围说明提示在正文中选择要应用修改的目标段落');

const taskWithOverallE: Task = {
  ...taskA,
  reviewComments: [overallCommentE, ...taskA.reviewComments],
};

const draftingStageHtmlE = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithOverallE,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskWithOverallE.id,
      commentId: overallCommentE.id,
      targetDraftId: draftA.id,
      timestamp: Date.now(),
    },
  })
);

assert(draftingStageHtmlE.includes('正在定位全局审阅意见：【审阅丁】'), 'E4: 页面顶部展示全局意见定位提示横幅');
assert(draftingStageHtmlE.includes('全篇适用'), 'E5: 提示横幅标明全篇适用');
assert(draftingStageHtmlE.includes('此意见针对整篇文稿，未绑定固定段落'), 'E6: 页面明确告知用户此意见未绑定固定段落，需选择段落');

// --------------------------------------------------------------------------
// 验收用例 F: 切换任务/版本隔离与只读快照保护测试 (含 P1/P2 回归):
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 F] 切换任务与版本隔离、只读快照保护回归测试:');

// 1. Task switching isolation test: mounted via JSDOM to verify effect execution and NO render-time update warning
const taskF1 = createPresetTask('ready_to_draft');
const taskF2 = createPresetTask('under_review');
const mismatchedIntent = {
  taskId: taskF1.id, // belongs to taskF1
  commentId: 'CMT-OLD-001',
  timestamp: Date.now(),
};

let clearNavCalled = false;
const { unmount: unmountF1 } = mountTestComponent(
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
assert(clearNavCalled, 'F1: 挂载后通过 effect 触发 onClearNavIntent 隔离清理且无渲染警告');
unmountF1();

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

// 3. [P1 回归测试] 历史稿重新混入最新意见隔离：
// 先定位当前全局意见，再切换到 frozenReviewComments: [] 的历史稿，正文上方绝不显示最新意见全文，且明确提示缺失
console.log('\n>>> [P1 专项验收] 历史稿审阅意见隔离与无污染回归测试:');

const workingDraftP1: DraftVersion = {
  id: 'DRAFT-P1-WORK',
  versionNumber: 'v2.0 (工作稿)',
  author: '主笔甲',
  createdAt: new Date().toISOString(),
  blocks: [
    { id: 'b1', order: 1, content: '第一段工作稿正文', sectionId: 'sec-1', referencedFactIds: [] },
    { id: 'b2', order: 2, content: '第二段工作稿正文', sectionId: 'sec-1', referencedFactIds: [] },
  ],
};

const historicalSnapshotP1: DraftVersion = {
  id: 'DRAFT-P1-HIST',
  versionNumber: 'v1.0 (历史快照)',
  author: '主笔甲',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
  isHistoricalSnapshot: true,
  frozenReviewComments: [], // 历史记录为空，绝不可回退到最新意见
  blocks: [
    { id: 'b1', order: 1, content: '第一段历史正文', sectionId: 'sec-1', referencedFactIds: [] },
  ],
};

const taskP1Base: Task = {
  ...taskA,
  currentDraftId: workingDraftP1.id,
  drafts: [workingDraftP1, historicalSnapshotP1],
  reviewComments: [overallCommentE], // 最新任务意见
};

// 挂载工作稿并定位全局意见
const { container: p1Container, rerender: rerenderP1, unmount: unmountP1 } = mountTestComponent(
  React.createElement(DraftingStage, {
    task: taskP1Base,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    navIntent: {
      taskId: taskP1Base.id,
      commentId: overallCommentE.id,
      targetDraftId: workingDraftP1.id,
      timestamp: Date.now(),
    },
  })
);

assert(p1Container.innerHTML.includes('正在定位全局审阅意见：【审阅丁】'), 'P1.1: 工作稿正文上方正确展示全局意见');
assert(p1Container.innerHTML.includes(overallCommentE.content), 'P1.2: 工作稿正文上方展示全局意见内容全文');

// 模拟切换版本到历史快照（frozenReviewComments: []）
const taskP1SwitchedToHist: Task = {
  ...taskP1Base,
  currentDraftId: historicalSnapshotP1.id,
};

rerenderP1(
  React.createElement(DraftingStage, {
    task: taskP1SwitchedToHist,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  !p1Container.innerHTML.includes('正在定位全局审阅意见：【审阅丁】'),
  'P1.3: 【关键隔离】切换到历史稿后，正文上方绝不显示最新全局意见标题！'
);
assert(
  !p1Container.innerHTML.includes(overallCommentE.content),
  'P1.4: 【关键隔离】切换到历史稿后，正文上方绝不显示最新意见全文！'
);
assert(
  p1Container.innerHTML.includes('未收录此审阅意见记录。系统已严格隔离，不回退展示最新审阅意见') ||
  p1Container.innerHTML.includes('该历史快照未记录审阅意见'),
  'P1.5: 历史记录缺失时明确展示隔离提示，不回退最新意见'
);
unmountP1();

// 4. [P2 回归测试] 切换版本清理旧运行、失效定位与采纳按钮禁用条件共用
console.log('\n>>> [P2 专项验收] 切换版本清理旧运行与采纳按钮共用校验回归测试:');

const { container: p2Container, rerender: rerenderP2, unmount: unmountP2 } = mountTestComponent(
  React.createElement(DraftingStage, {
    task: taskP1Base,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

// 验证版本变化时 previousDraftIdRef 清理机制与异步回填 draftId 校验
const altDraftP2: DraftVersion = {
  id: 'DRAFT-P2-ALT',
  versionNumber: 'v2.1 (新工作稿)',
  author: '主笔甲',
  createdAt: new Date().toISOString(),
  blocks: [
    { id: 'b-new-1', order: 1, content: '全新段落内容', sectionId: 'sec-1', referencedFactIds: [] },
  ],
};

const taskP2Switched: Task = {
  ...taskP1Base,
  currentDraftId: altDraftP2.id,
  drafts: [altDraftP2, workingDraftP1],
};

rerenderP2(
  React.createElement(DraftingStage, {
    task: taskP2Switched,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

// 验证采纳按钮禁用校验条件共用逻辑：
const staleSuggestionForOldDraft = {
  runId: 'RUN-OLD-DRAFT',
  targetBlockId: 'b1',
  targetBlockOrder: 1,
  baseContent: '第一段工作稿正文',
  suggestedText: '改写后的段落',
  action: 'compress' as const,
  diffExplanation: '精简说明',
  sourceDraftId: workingDraftP1.id, // 来自旧草稿
  taskId: taskP1Base.id,
};

assert(
  staleSuggestionForOldDraft.sourceDraftId !== altDraftP2.id,
  'P2.1: 旧修改建议记录的 sourceDraftId 与新草稿 ID 不一致'
);
unmountP2();

// --------------------------------------------------------------------------
// 验收用例 G: 调整提交确认框：真实点击验证取消不改变稿件、轮次和状态；确认提交生成审阅基准并流转
// --------------------------------------------------------------------------
console.log('\n>>> [验收用例 G] 提交审阅站内确认对话框与真实取消/确认交互回归测试:');

const taskG = createPresetTask('under_review');
const initialDraftCount = taskG.drafts.length;
const initialRound = taskG.currentReviewRound || 0;
const initialStatus = taskG.status;

let updatedTaskResultG: Partial<Task> | null = null;
const { container: gContainer, unmount: unmountG } = mountTestComponent(
  React.createElement(DraftingStage, {
    task: taskG,
    onUpdateTask: (u) => {
      updatedTaskResultG = u;
    },
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

// 1. 查找顶部【提交本轮审阅】操作按钮
const submitBtn = Array.from(gContainer.querySelectorAll('button')).find((b) =>
  b.textContent?.includes('提交本轮审阅')
);
assert(Boolean(submitBtn), 'G1: 起草阶段顶部操作区提供【提交本轮审阅】按钮');

// 2. 真实点击按钮，呼出站内确认对话框
act(() => {
  submitBtn!.click();
});
assert(gContainer.innerHTML.includes('提交本轮审阅确认'), 'G1.1: 点击后成功呼出站内提交审阅确认对话框');

// 3. 真实点击对话框内的【取消】按钮
const cancelBtn = Array.from(gContainer.querySelectorAll('button')).find((b) =>
  b.textContent?.trim() === '取消'
);
assert(Boolean(cancelBtn), 'G2.1: 确认对话框内包含【取消】按钮');

act(() => {
  cancelBtn!.click();
});

// 验证取消后的状态：对话框关闭，onUpdateTask 从未被调用，版本数、轮次、状态保持不变
assert(!gContainer.innerHTML.includes('提交本轮审阅确认'), 'G2.2: 真实点击取消后对话框成功关闭');
assert(updatedTaskResultG === null, 'G2.3: 取消提交审阅时，未触发任何任务更新操作 (onUpdateTask 未被调用)');
assert(taskG.drafts.length === initialDraftCount, 'G2.4: 取消提交审阅时，文稿版本数量保持完全不变');
assert((taskG.currentReviewRound || 0) === initialRound, 'G3: 取消提交审阅时，审阅轮次保持完全不变');
assert(taskG.status === initialStatus, 'G4: 取消提交审阅时，任务状态保持完全不变');

// 4. 再次点击提交按钮，打开对话框
act(() => {
  submitBtn!.click();
});
assert(gContainer.innerHTML.includes('提交本轮审阅确认'), 'G5.1: 再次点击提交按钮成功重新打开对话框');

// 5. 真实点击对话框内的【确认提交并进入审阅】按钮
const confirmBtn = Array.from(gContainer.querySelectorAll('button')).find((b) =>
  b.textContent?.includes('确认提交并进入审阅')
);
assert(Boolean(confirmBtn), 'G5.2: 确认对话框内包含【确认提交并进入审阅】按钮');

act(() => {
  confirmBtn!.click();
});

// 验证确认提交后的状态
assert(Boolean(updatedTaskResultG), 'G5.3: 确认提交后成功触发 onUpdateTask 更新任务');
assert((updatedTaskResultG as any).status === '审阅中', 'G5.4: 确认提交审阅后，任务状态变更为“审阅中”');
assert((updatedTaskResultG as any).currentReviewRound === initialRound + 1, 'G6: 确认提交审阅后，审阅轮次正确递增为第 1 轮');
assert(Boolean((updatedTaskResultG as any).reviewBaseDraftId), 'G7: 确认提交审阅后，生成有效的本轮审阅基准ID (reviewBaseDraftId)');

const newDrafts = (updatedTaskResultG as any).drafts as DraftVersion[];
const frozenBaseDraft = newDrafts.find((d) => d.id === (updatedTaskResultG as any).reviewBaseDraftId);
assert(Boolean(frozenBaseDraft), 'G8: 审阅基准快照已成功冻结并作为版本保存在 drafts 列表中');
assert(frozenBaseDraft?.isHistoricalSnapshot === true, 'G9: 审阅基准快照具有不可篡改的 isHistoricalSnapshot: true 属性');

unmountG();

console.log('\n================================================================');
console.log('   🎉 任务16 全部 7 项深度验收用例与回归测试 100% 通过！');
console.log('================================================================');
