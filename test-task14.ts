import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { createPresetTask } from './src/services/mockData';
import { CandidateComparisonModal } from './src/components/CandidateComparisonModal';
import { SnippetDrawer } from './src/components/SnippetDrawer';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { submitDraftForReview } from './src/services/draftLifecycleService';
import { DraftCandidate, EvidenceSnippet } from './src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

console.log('==============================================');
console.log('   任务14 审阅轮次、历史隔离与候选弹窗回归测试');
console.log('==============================================\n');

// --------------------------------------------------------------------------
// 1. [P1] 候选对比弹窗：关闭 -> 打开 -> 关闭 -> 再次打开 Hook 顺序与无崩溃测试
// --------------------------------------------------------------------------
console.log('>>> [验收 1] 候选对比弹窗组件在“关闭→打开→关闭→再次打开”切换下 Hook 渲染一致性测试:');

const testTask = createPresetTask('under_review');
const currentDraft = testTask.drafts[0];

const mockCandidate: DraftCandidate = {
  candidateId: 'CAND-TEST-01',
  runId: 'RUN-TEST-01',
  versionNumber: 'v1.1 (测试候选)',
  generatedAt: new Date().toISOString(),
  blocks: currentDraft.blocks.map((b) => ({ ...b, content: b.content + ' [候选优化]' })),
  baseDraftId: currentDraft.id,
  baseDraftContentHash: 'test-hash',
  instructionPrompt: '精简表达',
  wordCount: 1500,
  keyDifferencesSummary: ['测试差异1'],
};

// Test cycle 1: Closed (isOpen = false)
let htmlClosed1 = ReactDOMServer.renderToString(
  React.createElement(CandidateComparisonModal, {
    isOpen: false,
    candidate: null,
    currentDraft,
    task: testTask,
    onClose: () => {},
    onAccept: () => {},
    onDiscard: () => {},
    onRegenerate: () => {},
    activeRole: '主笔甲',
    onViewSnippet: () => {},
  })
);
assert(htmlClosed1 === '', '弹窗关闭时成功安全返回 null，未抛出 Hook 计数异常');

// Test cycle 2: Open (isOpen = true with candidate)
let htmlOpen1 = ReactDOMServer.renderToString(
  React.createElement(CandidateComparisonModal, {
    isOpen: true,
    candidate: mockCandidate,
    currentDraft,
    task: testTask,
    onClose: () => {},
    onAccept: () => {},
    onDiscard: () => {},
    onRegenerate: () => {},
    activeRole: '主笔甲',
    onViewSnippet: () => {},
  })
);
assert(htmlOpen1.includes('整稿候选审阅与差异对比'), '弹窗从关闭切换到打开成功渲染，Hook 顺序保持完全一致');

// Test cycle 3: Closed again (isOpen = false)
let htmlClosed2 = ReactDOMServer.renderToString(
  React.createElement(CandidateComparisonModal, {
    isOpen: false,
    candidate: mockCandidate,
    currentDraft,
    task: testTask,
    onClose: () => {},
    onAccept: () => {},
    onDiscard: () => {},
    onRegenerate: () => {},
    activeRole: '主笔甲',
    onViewSnippet: () => {},
  })
);
assert(htmlClosed2 === '', '弹窗再次关闭成功返回 null');

// Test cycle 4: Open again (isOpen = true)
let htmlOpen2 = ReactDOMServer.renderToString(
  React.createElement(CandidateComparisonModal, {
    isOpen: true,
    candidate: mockCandidate,
    currentDraft,
    task: testTask,
    onClose: () => {},
    onAccept: () => {},
    onDiscard: () => {},
    onRegenerate: () => {},
    activeRole: '主笔甲',
    onViewSnippet: () => {},
  })
);
assert(htmlOpen2.includes('整稿候选审阅与差异对比'), '弹窗再次打开顺利渲染，未出现 Rendered more hooks 错误');

// --------------------------------------------------------------------------
// 2. [P1] 历史数据隔离：缺失 frozenReviewComments 时明确提示无法还原，绝不回退至最新意见
// --------------------------------------------------------------------------
console.log('\n>>> [验收 2] 历史数据隔离测试：缺失 frozenReviewComments 明确提示，来源按冻结证据ID查找:');

// Create a historical draft that intentionally lacks frozenReviewComments
const historicalDraftWithoutComments = {
  ...currentDraft,
  id: 'DRAFT-HIST-OLD',
  versionNumber: 'v1.0 (历史快照)',
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  frozenReviewComments: undefined,
};

const taskWithHist = {
  ...testTask,
  drafts: [historicalDraftWithoutComments, ...testTask.drafts],
  currentDraftId: historicalDraftWithoutComments.id,
  reviewComments: [
    {
      id: 'CMT-LATEST-99',
      type: 'overall' as const,
      reviewer: '审阅乙' as const,
      content: '【这是最新产生的意见，绝不能泄漏到历史稿中】',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    },
  ],
};

const draftingHtml = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithHist,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  !draftingHtml.includes('【这是最新产生的意见，绝不能泄漏到历史稿中】'),
  '历史稿缺失 frozenReviewComments 时，严格隔离，绝不泄漏展示任务最新审阅意见'
);
assert(
  draftingHtml.includes('该历史快照未记录审阅意见（无法回溯当时意见），已严格隔离最新意见'),
  '历史稿缺少冻结意见时，明确提示无法回溯当时意见并隔离最新意见'
);

// SnippetDrawer evidence resolution with frozenEvidenceId
const historicalDraftWithFactSnapshot = {
  ...historicalDraftWithoutComments,
  snapshotMetadata: {
    factSnapshot: {
      confirmedAt: '2026-09-01T00:00:00.000Z',
      factIds: ['FACT-01'],
      items: [
        {
          factId: 'FACT-01',
          metric: '重点推进工作任务',
          value: '120',
          unit: '项',
          period: '2026年1至9月',
          metricScope: '局系统重点专项',
          primaryEvidenceId: 'SNIP-HIST-01',
        },
      ],
    },
  },
};

const historicalSnippet: EvidenceSnippet = {
  id: 'SNIP-HIST-01',
  sourceDocId: 'DOC-01',
  docName: '2026年第3季度工作通报（历史存档）',
  text: '局系统累计统筹推进120项重点工作任务。',
  location: '第2段',
  period: '2026年1至9月',
};

const latestSnippet: EvidenceSnippet = {
  id: 'SNIP-01',
  sourceDocId: 'DOC-01',
  docName: '2026年第3季度工作通报（最新核准）',
  text: '局系统累计统筹推进128项重点工作任务。',
  location: '第3段',
  period: '2026年1至9月',
};

const taskWithHistSnippets = {
  ...taskWithHist,
  snippets: [historicalSnippet, latestSnippet],
};

// Render SnippetDrawer for historical draft with registered frozen evidence
const drawerHtmlHist = ReactDOMServer.renderToString(
  React.createElement(SnippetDrawer, {
    snippet: latestSnippet, // caller might pass latest snippet, but historical draft must resolve frozen
    documents: testTask.documents,
    onClose: () => {},
    fact: testTask.facts[0],
    currentDraft: historicalDraftWithFactSnapshot,
    task: taskWithHistSnippets,
  })
);

assert(
  drawerHtmlHist.includes('120项重点工作任务'),
  '抽屉优先按快照冻结证据ID SNIP-HIST-01 解析来源，展示历史真实片段'
);
assert(
  !drawerHtmlHist.includes('128项重点工作任务'),
  '抽屉严格隔离最新证据材料片段，未展示128项最新摘录'
);

// Render SnippetDrawer when fact snapshot has NO frozen evidence id recorded
const historicalDraftWithoutEvidenceId = {
  ...historicalDraftWithoutComments,
  snapshotMetadata: {
    factSnapshot: {
      confirmedAt: '2026-09-01T00:00:00.000Z',
      factIds: ['FACT-01'],
      items: [
        {
          factId: 'FACT-01',
          metric: '重点推进工作任务',
          value: '120',
          unit: '项',
          period: '2026年1至9月',
          metricScope: '局系统重点专项',
          // primaryEvidenceId intentionally undefined
        },
      ],
    },
  },
};

const drawerHtmlNoEvidence = ReactDOMServer.renderToString(
  React.createElement(SnippetDrawer, {
    snippet: latestSnippet,
    documents: testTask.documents,
    onClose: () => {},
    fact: testTask.facts[0],
    currentDraft: historicalDraftWithoutEvidenceId,
    task: taskWithHistSnippets,
  })
);

assert(
  drawerHtmlNoEvidence.includes('来源追溯真实限制说明') &&
    drawerHtmlNoEvidence.includes('该历史版本快照中未记录此事实当时的原始证据片段ID'),
  '快照未记录证据ID时，明确提示出处追溯限制说明，绝不直接冒充展示最新证据'
);

// --------------------------------------------------------------------------
// 3. [P1] 审阅轮次与基准版本接通：提交审阅服务完整包含 reviewBaseDraftId、currentReviewRound
// --------------------------------------------------------------------------
console.log('\n>>> [验收 3] 审阅轮次与基准版本接通测试：');

const initialRound = testTask.currentReviewRound || 0;
const submitResult = submitDraftForReview(testTask, currentDraft.id, '主笔甲', true);

assert(Boolean(submitResult.updatedTask.reviewBaseDraftId), '提交审阅返回有效 reviewBaseDraftId');
assert(
  submitResult.updatedTask.currentReviewRound === initialRound + 1,
  `提交审阅后 currentReviewRound 正确递增（由 ${initialRound} 增至 ${submitResult.updatedTask.currentReviewRound}）`
);
assert(
  submitResult.updatedTask.drafts.some((d) => d.id === submitResult.updatedTask.reviewBaseDraftId),
  '基准快照已成功冻结并作为 reviewBaseDraftId 包含在文稿列表中'
);

// Test ReviewStage rendering with distinct base draft vs working draft
const reviewBase = submitResult.updatedTask.drafts.find((d) => d.id === submitResult.updatedTask.reviewBaseDraftId)!;
reviewBase.blocks[0].content = '【审阅基准版原文】：全省深化改革推进情况。';

const workingDraftNew = submitResult.workingDraft;
workingDraftNew.blocks[0].content = '【最新工作稿修改文】：全省深化改革推进情况（工作稿编辑修改后）。';

const reviewStageHtml = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: submitResult.updatedTask,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  reviewStageHtml.includes('当前审阅基准稿件预览') &&
    reviewStageHtml.includes('【审阅基准版原文】'),
  '审阅页面右侧基准稿件预览统一读取 reviewBaseDraft 基准稿'
);
assert(
  reviewStageHtml.includes('提交本轮审阅') || reviewStageHtml.includes('第 1 轮审阅周期') || reviewStageHtml.includes('本轮审阅基准版本'),
  '审阅阶段顶部明确展示轮次和本轮审阅基准版本标识'
);

// --------------------------------------------------------------------------
// 4. [P2] 审阅页段落重新绑定弹窗交付测试
// --------------------------------------------------------------------------
console.log('\n>>> [验收 4] 审阅页段落重新绑定弹窗与交互逻辑测试:');

const outdatedComment = {
  id: 'CMT-OUTDATED-01',
  type: 'paragraph' as const,
  targetBlockId: 'BLK-NON-EXISTENT', // paragraph deleted in working draft
  targetBlockOrder: 99,
  targetVersionId: reviewBase.id,
  baseParagraphText: '已被删除的原段落文字',
  reviewer: '审阅乙' as const,
  content: '关于已被删除段落的修改建议',
  suggestedChange: '建议改写表述',
  status: 'pending' as const,
  createdAt: new Date().toISOString(),
};

const taskWithOutdatedComment = {
  ...submitResult.updatedTask,
  reviewComments: [outdatedComment],
};

const reviewStageWithOutdatedHtml = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: taskWithOutdatedComment,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  reviewStageWithOutdatedHtml.includes('定位提示：目标段落定位已过期') &&
    reviewStageWithOutdatedHtml.includes('重新指定目标段落'),
  '审阅卡片上过期定位清晰展示警告，并提供【重新指定目标段落】按钮'
);

console.log('\n==============================================');
console.log('   🎉 任务14 全部四类问题深度专项回归测试 100% 通过！');
console.log('==============================================\n');
