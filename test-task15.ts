import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { createPresetTask } from './src/services/mockData';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { SnippetDrawer } from './src/components/SnippetDrawer';
import {
  rebindReviewCommentTargetBlock,
  getEffectiveTargetBlockId,
  getReviewCommentLocation,
  implementReviewCommentWithText,
} from './src/services/reviewCoordinationService';
import { submitDraftForReview } from './src/services/draftLifecycleService';
import { resolveDraftFactEvidence } from './src/services/factLifecycleService';
import { ReviewComment, EvidenceSnippet, Task, DraftVersion } from './src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

console.log('================================================================');
console.log('   任务15 P1重新绑定存证与定位有效性、P2历史依据侧栏统一专项验收');
console.log('================================================================\n');

// --------------------------------------------------------------------------
// 1. [P1] 重新绑定存证保护：保持原始 targetVersionId, targetBlockId, baseParagraphText
// --------------------------------------------------------------------------
console.log('>>> [验收 1] P1 重新绑定存证保护测试：');

const task = createPresetTask('under_review');
const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
const block1 = currentDraft.blocks[0];
const block2 = currentDraft.blocks[1];

const originalComment: ReviewComment = {
  id: 'CMT-EVID-TEST',
  type: 'paragraph',
  targetVersionId: 'd-v1.0-snapshot-base',
  targetVersionNumber: 'v1.0 (基准快照)',
  targetBlockId: block1.id,
  targetBlockOrder: block1.order,
  baseParagraphText: block1.content,
  reviewer: '审阅乙',
  content: '第1段表述需调整为重点突破',
  suggestedChange: '精炼语言',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithComment: Task = {
  ...task,
  reviewComments: [originalComment],
};

// Perform rebind to block 2
const rebindResult = rebindReviewCommentTargetBlock(
  taskWithComment,
  originalComment.id,
  block2.id,
  '主笔甲'
);

const updatedComment = rebindResult.updatedComment;

assert(
  updatedComment.targetVersionId === 'd-v1.0-snapshot-base',
  '重新绑定后 targetVersionId 严格保留原始基准快照ID'
);
assert(
  updatedComment.targetBlockId === block1.id,
  '重新绑定后 targetBlockId 严格保留原始提出时的目标段落ID（原始存证未被覆盖）'
);
assert(
  updatedComment.targetBlockOrder === block1.order,
  '重新绑定后 targetBlockOrder 严格保留原始提出时的段落序号'
);
assert(
  updatedComment.baseParagraphText === block1.content,
  '重新绑定后 baseParagraphText 严格保留提出时原文（原始存证未被覆盖为新段落文本）'
);
assert(
  updatedComment.currentBlockId === block2.id && updatedComment.currentBlockOrder === block2.order,
  '重新绑定后另存当前落实位置 currentBlockId 与 currentBlockOrder 为新段落'
);
assert(
  Boolean(updatedComment.rebindRecord) &&
    updatedComment.rebindRecord?.fromBlockId === block1.id &&
    updatedComment.rebindRecord?.toBlockId === block2.id &&
    updatedComment.rebindRecord?.reboundBy === '主笔甲',
  '重新绑定后成功记录 rebindRecord 审计记录（包含来源段落、目标段落、操作人）'
);
assert(
  getEffectiveTargetBlockId(updatedComment) === block2.id,
  'getEffectiveTargetBlockId 正确解析当前有效段落为新段落 block2'
);

// Implement comment on rebound target block
const implementResult = implementReviewCommentWithText(
  rebindResult.updatedTask,
  updatedComment.id,
  currentDraft.id,
  block2.content + ' [已落实调整]',
  '已根据审阅意见调整重定位后的第2段。',
  '主笔甲'
);

assert(
  implementResult.implementedComment.status === 'implemented',
  '落实意见成功标记为 implemented'
);
assert(
  implementResult.implementedComment.implementationBlockId === block2.id,
  '落实段落 implementationBlockId 正确指向重新指定的 block2'
);
assert(
  implementResult.workingDraft.blocks.find((b) => b.id === block2.id)?.content.includes('[已落实调整]'),
  '落实修改精确作用于重新指定的 block2 段落正文'
);

// --------------------------------------------------------------------------
// 2. [P1] 定位有效性判断：解耦版本差异与正文变动，刚提出的意见不应被标为“定位已过期”
// --------------------------------------------------------------------------
console.log('\n>>> [验收 2] P1 定位有效性判断与版本提示解耦测试：');

// Case A: Newly proposed comment against review base draft, working draft has identical paragraph and text
const submitRes = submitDraftForReview(task, currentDraft.id, '主笔甲', true);
const baseDraftId = submitRes.updatedTask.reviewBaseDraftId!;
const workingDraft = submitRes.workingDraft;

const freshComment: ReviewComment = {
  id: 'CMT-FRESH-01',
  type: 'paragraph',
  targetVersionId: baseDraftId,
  targetVersionNumber: 'v1.0 (审阅基准快照)',
  targetBlockId: workingDraft.blocks[0].id,
  targetBlockOrder: workingDraft.blocks[0].order,
  baseParagraphText: workingDraft.blocks[0].content, // exactly matches working draft content!
  reviewer: '审阅乙',
  content: '请进一步优化第一段文字节奏',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithFreshComment: Task = {
  ...submitRes.updatedTask,
  reviewComments: [freshComment],
};

const locFresh = getReviewCommentLocation(freshComment, workingDraft);
assert(
  locFresh.isLocated === true && !locFresh.hasTextModified && !locFresh.warning,
  '刚提出且正文未变动的意见，getReviewCommentLocation 评估 isLocated: true 无警告'
);
assert(
  locFresh.isOutdatedVersion === true,
  '版本不同（基准快照 vs 工作稿）被正确识别为 isOutdatedVersion'
);

const reviewHtmlFresh = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: taskWithFreshComment,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  !reviewHtmlFresh.includes('定位提示：目标段落定位已过期'),
  '正文未变动的新意见绝对不会被错误标为【定位提示：目标段落定位已过期】'
);
assert(
  reviewHtmlFresh.includes('版本提示：意见针对审阅基准快照') &&
    reviewHtmlFresh.includes('当前工作稿段落映射完整、正文一致'),
  '版本不同时单独显示友好提示【版本提示：意见针对审阅基准快照...当前工作稿段落映射完整、正文一致】'
);

// Case B: Paragraph deleted in working draft -> MUST be marked as outdated with rebind button
const deletedBlockComment: ReviewComment = {
  id: 'CMT-DELETED-BLOCK',
  type: 'paragraph',
  targetVersionId: baseDraftId,
  targetBlockId: 'BLK-NON-EXISTENT-XYZ',
  targetBlockOrder: 9,
  baseParagraphText: '被删除的段落原文',
  reviewer: '审阅丁',
  content: '该段落论述不够充分',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithDeletedComment: Task = {
  ...submitRes.updatedTask,
  reviewComments: [deletedBlockComment],
};

const reviewHtmlDeleted = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: taskWithDeletedComment,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  reviewHtmlDeleted.includes('定位提示：目标段落定位已过期') &&
    reviewHtmlDeleted.includes('原目标段落已在正文中删除或合并') &&
    reviewHtmlDeleted.includes('重新指定目标段落'),
  '目标段落缺失时正确标识【目标段落定位已过期（原目标段落已在正文中删除或合并）】并提供重定位按钮'
);

// Case C: Paragraph text modified in working draft -> MUST be marked as modified
const modifiedTextComment: ReviewComment = {
  id: 'CMT-MODIFIED-TEXT',
  type: 'paragraph',
  targetVersionId: baseDraftId,
  targetBlockId: workingDraft.blocks[0].id,
  targetBlockOrder: workingDraft.blocks[0].order,
  baseParagraphText: '提出意见时的旧正文内容，已与当前工作稿不同',
  reviewer: '审阅乙',
  content: '建议修正',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const taskWithModifiedComment: Task = {
  ...submitRes.updatedTask,
  reviewComments: [modifiedTextComment],
};

const reviewHtmlModified = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: taskWithModifiedComment,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  reviewHtmlModified.includes('定位提示：目标段落定位已过期') &&
    reviewHtmlModified.includes('正文自意见提出后已有修改'),
  '正文改动时正确提示【目标段落定位已过期（正文自意见提出后已有修改）】'
);

// --------------------------------------------------------------------------
// 3. [P2] 历史依据侧栏元信息与抽屉来源统一：统一使用冻结期间、口径和证据ID
// --------------------------------------------------------------------------
console.log('\n>>> [验收 3] P2 历史依据侧栏与抽屉来源统一测试：');

const historicalSnippet: EvidenceSnippet = {
  id: 'SNIP-HIST-01',
  docName: '2026年三季度局党组工作汇报材料(历史存证).pdf',
  sourceDocId: 'DOC-HIST-01',
  text: '前三季度累计推进局系统重点专项120项。',
  period: '2026年1至9月',
  location: '第2页第3段',
};

const latestSnippet: EvidenceSnippet = {
  id: 'SNIP-LATEST-01',
  docName: '2026年10月最新统筹推进督办通报(最新核准).pdf',
  sourceDocId: 'DOC-LATEST-01',
  text: '截至10月底累计推进全局重点工作128项。',
  period: '2026年1至10月',
  location: '第1页第2段',
};

const taskForP2: Task = {
  ...task,
  facts: [
    {
      id: 'FACT-01',
      metric: '重点推进工作任务',
      value: '128',
      unit: '项',
      period: '2026年1至10月',
      metricScope: '全局重点工作',
      primaryEvidenceId: 'SNIP-LATEST-01',
      evidenceIds: ['SNIP-LATEST-01'],
      status: 'confirmed',
      sourceDocId: 'DOC-LATEST-01',
    },
  ],
  snippets: [historicalSnippet, latestSnippet],
};

const historicalDraftWithFrozenSnapshot: DraftVersion = {
  id: 'd-hist-v1.0-snapshot',
  versionNumber: 'v1.0 (历史基准快照)',
  createdAt: '2026-09-30T10:00:00.000Z',
  author: '主笔甲',
  summary: '历史审阅只读快照',
  isHistoricalSnapshot: true,
  blocks: [
    {
      id: 'BLK-01',
      order: 1,
      content: '深入推进改革工作，前三季度累计推进重点专项120项。',
      referencedFactIds: ['FACT-01'],
      updatedAt: '2026-09-30T10:00:00.000Z',
    },
  ],
  snapshotMetadata: {
    taskTitle: task.title,
    startDate: '2026-01-01',
    endDate: '2026-09-30',
    targetWordCount: 2000,
    outlineSections: [],
    factSnapshot: {
      confirmedAt: '2026-09-30T10:00:00.000Z',
      factIds: ['FACT-01'],
      hash: 'hash-hist-snap',
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

const taskWithHistDraft: Task = {
  ...taskForP2,
  currentDraftId: historicalDraftWithFrozenSnapshot.id,
  drafts: [historicalDraftWithFrozenSnapshot],
};

// 1. Shared logic function check
const resolvedFactEvidence = resolveDraftFactEvidence(
  taskForP2.facts[0],
  historicalDraftWithFrozenSnapshot,
  taskWithHistDraft
);

assert(
  resolvedFactEvidence.adoptedValue === '120 项',
  'resolveDraftFactEvidence 返回冻结采用值 120 项'
);
assert(
  resolvedFactEvidence.effectivePeriod === '2026年1至9月',
  'resolveDraftFactEvidence 返回冻结期间 2026年1至9月（非当前1至10月）'
);
assert(
  resolvedFactEvidence.effectiveMetricScope === '局系统重点专项',
  'resolveDraftFactEvidence 返回冻结口径 局系统重点专项（非当前全局重点工作）'
);
assert(
  resolvedFactEvidence.effectiveEvidenceId === 'SNIP-HIST-01',
  'resolveDraftFactEvidence 返回冻结证据ID SNIP-HIST-01'
);
assert(
  resolvedFactEvidence.effectiveSnippet?.id === 'SNIP-HIST-01',
  'resolveDraftFactEvidence 返回冻结片段为 SNIP-HIST-01'
);
assert(
  resolvedFactEvidence.currentConfirmedValue === '128 项' &&
    resolvedFactEvidence.currentPeriod === '2026年1至10月' &&
    resolvedFactEvidence.currentMetricScope === '全局重点工作',
  'resolveDraftFactEvidence 明确提供当前核准信息（128项、2026年1至10月、全局重点工作）'
);

// 2. Render DraftingStage evidence sidebar for historical draft
const draftingSidebarHtml = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithHistDraft,
    onUpdateTask: () => {},
    onViewSnippet: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    initialInspectorTab: 'material_evidence',
  })
);

assert(
  draftingSidebarHtml.includes('统计期间：<strong class="text-slate-800 font-medium">2026年1至9月</strong>') ||
    draftingSidebarHtml.includes('2026年1至9月'),
  '历史稿依据侧栏严格展示冻结统计期间 2026年1至9月'
);
assert(
  draftingSidebarHtml.includes('局系统重点专项'),
  '历史稿依据侧栏严格展示冻结统计口径 局系统重点专项'
);
assert(
  draftingSidebarHtml.includes('冻结出处') &&
    draftingSidebarHtml.includes('2026年三季度局党组工作汇报材料(历史存证).pdf') &&
    draftingSidebarHtml.includes('第2页第3段'),
  '历史稿依据侧栏出处严格读取冻结证据片段 SNIP-HIST-01 的文档名称与位置'
);
assert(
  draftingSidebarHtml.includes('任务当前最新核准信息') &&
    draftingSidebarHtml.includes('128 项') &&
    draftingSidebarHtml.includes('2026年1至10月') &&
    draftingSidebarHtml.includes('全局重点工作'),
  '历史稿依据侧栏明确将最新指标标注为【任务当前最新核准信息】（128项，2026年1至10月，全局重点工作）'
);

// 3. Render SnippetDrawer for this historical draft
const drawerHtml = ReactDOMServer.renderToString(
  React.createElement(SnippetDrawer, {
    snippet: resolvedFactEvidence.effectiveSnippet,
    documents: taskWithHistDraft.documents,
    onClose: () => {},
    fact: taskForP2.facts[0],
    currentDraft: historicalDraftWithFrozenSnapshot,
    task: taskWithHistDraft,
  })
);

assert(
  drawerHtml.includes('120项重点工作任务') || drawerHtml.includes('120项'),
  '抽屉内展示冻结出处证据中的 120项'
);
assert(
  drawerHtml.includes('2026年1至9月') && drawerHtml.includes('局系统重点专项'),
  '抽屉内的冻结采用值期间与口径（2026年1至9月 · 局系统重点专项）与侧栏 100% 保持完全一致'
);
assert(
  drawerHtml.includes('任务最新核准值') &&
    drawerHtml.includes('2026年1至10月') &&
    drawerHtml.includes('全局重点工作'),
  '抽屉内同样明确标注任务最新核准值期间与口径'
);

// --------------------------------------------------------------------------
// 4. [P2 回归] 重绑后再次人工改写目标段落，两页共用定位服务准确提示正文变动复核且绝不误报“正文一致”
// --------------------------------------------------------------------------
console.log('\n>>> [验收 4] 重绑后再次人工改写目标段落，两页定位与警告联动测试：');

assert(
  Boolean(rebindResult.updatedComment.reboundParagraphText),
  '重绑时成功另存目标段落基准文本 reboundParagraphText'
);
assert(
  rebindResult.updatedComment.reboundParagraphText === block2.content,
  '重绑保存的基准文本与重绑时的 block2 内容完全一致'
);
assert(
  rebindResult.updatedComment.baseParagraphText === block1.content,
  '重绑后提出时的原始存证 baseParagraphText 严格保持不变（与 block1 内容一致）'
);

// Simulate author manually revising block2 text in working draft
const modifiedDraft: DraftVersion = {
  ...currentDraft,
  blocks: currentDraft.blocks.map((b) =>
    b.id === block2.id ? { ...b, content: '【已人工大幅修改】第二段全面贯彻落实重点专项任务规划部署。' } : b
  ),
};

const locAfterEdit = getReviewCommentLocation(rebindResult.updatedComment, modifiedDraft);
assert(locAfterEdit.isLocated === true, '改动正文后目标段落仍可定位');
assert(locAfterEdit.hasTextModified === true, '重绑后人工改写目标段落，getReviewCommentLocation 准确检测到正文变化');
assert(
  Boolean(locAfterEdit.warning && locAfterEdit.warning.includes('重定位段落正文自重新指定后已有修改')),
  '定位服务返回明确的重定位段落正文改动警告'
);

const reviewStageHtmlAfterEdit = ReactDOMServer.renderToString(
  React.createElement(ReviewStage, {
    task: {
      ...taskWithComment,
      drafts: [modifiedDraft],
      currentDraftId: modifiedDraft.id,
      reviewComments: [rebindResult.updatedComment],
    },
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
  })
);

assert(
  !reviewStageHtmlAfterEdit.includes('正文一致'),
  '重绑段落正文被修改后，审阅页绝对不显示“正文一致”'
);
assert(
  reviewStageHtmlAfterEdit.includes('定位提示：目标段落定位需复核（当前重定位段落正文自重新指定后已有修改）') ||
    reviewStageHtmlAfterEdit.includes('重定位段落正文已有变动'),
  '审阅页展示准确的重定位段落变动需复核提示'
);

const draftingStageHtmlAfterEdit = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: {
      ...taskWithComment,
      drafts: [modifiedDraft],
      currentDraftId: modifiedDraft.id,
      reviewComments: [rebindResult.updatedComment],
    },
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    initialInspectorTab: 'review_comments',
  })
);

assert(
  draftingStageHtmlAfterEdit.includes('定位需复核：当前重定位段落正文自重新指定后已有修改'),
  '起草页审阅意见列表展示“定位需复核：当前重定位段落正文自重新指定后已有修改”'
);
assert(
  draftingStageHtmlAfterEdit.includes('重指定时基准句'),
  '起草页明确展示重指定时的基准原句供比对'
);

// --------------------------------------------------------------------------
// 5. [P2 回归] 历史证据已清理时，区分三种出处状态，侧栏显示真实原因并保留查看说明入口，抽屉展示真实追溯说明
// --------------------------------------------------------------------------
console.log('\n>>> [验收 5] 历史证据已清理时的出处状态区分与抽屉追溯测试：');

// Create a historical draft where primaryEvidenceId is recorded as 'SNIP-PRUNED-88',
// but 'SNIP-PRUNED-88' is deleted/pruned from task.snippets.
const prunedFactId = 'FACT-PRUNED-01';
const draftWithPrunedEvidence: DraftVersion = {
  id: 'd-hist-pruned',
  versionNumber: 'v0.9 (归档快照)',
  blocks: [{ ...block1, referencedFactIds: [prunedFactId] }],
  createdAt: '2026-09-30T10:00:00Z',
  isHistoricalSnapshot: true,
  snapshotMetadata: {
    factSnapshot: {
      snapshotTime: '2026-09-30T10:00:00Z',
      items: [
        {
          factId: prunedFactId,
          metric: '完成清理整改事项',
          value: '88',
          unit: '项',
          period: '2026年1至8月',
          metricScope: '专项清理行动',
          primaryEvidenceId: 'SNIP-PRUNED-88',
          selected: true,
        },
      ],
    },
  },
};

const prunedFact = {
  id: prunedFactId,
  metric: '完成清理整改事项',
  value: '95',
  unit: '项',
  period: '2026年1至10月',
  metricScope: '全局整改行动',
  primaryEvidenceId: 'SNIP-LATEST-95',
  status: 'confirmed' as const,
};

const taskWithPrunedEvidence: Task = {
  ...task,
  facts: [prunedFact],
  drafts: [draftWithPrunedEvidence],
  currentDraftId: draftWithPrunedEvidence.id,
  snippets: [], // Materials pruned!
};

const resolvedPruned = resolveDraftFactEvidence(prunedFact, draftWithPrunedEvidence, taskWithPrunedEvidence);

assert(resolvedPruned.isSnapshotMissingFact === false, '快照包含该事实项，isSnapshotMissingFact 为 false');
assert(resolvedPruned.isEvidenceMissingInSnapshot === false, '快照已记录证据ID，isEvidenceMissingInSnapshot 为 false');
assert(resolvedPruned.isEvidencePrunedOrUnavailable === true, '片段在材料库中不存在，isEvidencePrunedOrUnavailable 为 true');
assert(resolvedPruned.effectiveEvidenceId === 'SNIP-PRUNED-88', '正确读取快照记录的证据ID SNIP-PRUNED-88');
assert(resolvedPruned.effectiveSnippet === null, '材料库无对应片段，effectiveSnippet 为 null');

const draftingSidebarPrunedHtml = ReactDOMServer.renderToString(
  React.createElement(DraftingStage, {
    task: taskWithPrunedEvidence,
    onUpdateTask: () => {},
    onProceedToNextStage: () => {},
    activeRole: '主笔甲',
    initialInspectorTab: 'material_evidence',
  })
);

assert(
  draftingSidebarPrunedHtml.includes('出处说明：已记录证据ID(SNIP-PRUNED-88)，原文已清理'),
  '侧栏真实展示原因：出处说明：已记录证据ID(SNIP-PRUNED-88)，原文已清理'
);
assert(
  !draftingSidebarPrunedHtml.includes('历史快照未收录此事实出处') &&
    !draftingSidebarPrunedHtml.includes('历史快照未收录此事实依据'),
  '侧栏不再错误显示“历史快照未收录此事实出处”'
);
assert(
  draftingSidebarPrunedHtml.includes('查看说明'),
  '侧栏成功保留【查看说明】入口'
);

const drawerPrunedHtml = ReactDOMServer.renderToString(
  React.createElement(SnippetDrawer, {
    snippet: null,
    documents: [],
    onClose: () => {},
    fact: prunedFact,
    currentDraft: draftWithPrunedEvidence,
    task: taskWithPrunedEvidence,
  })
);

assert(
  drawerPrunedHtml.includes('来源追溯真实限制说明'),
  '抽屉展示来源追溯真实限制说明'
);
assert(
  drawerPrunedHtml.includes('该历史快照已完整记录原始证据ID【SNIP-PRUNED-88】') &&
    drawerPrunedHtml.includes('材料库中该证据原文已清理或归档不可用'),
  '抽屉内明确提示已记录原始证据ID且材料库中证据原文已清理或归档，绝不冒充最新证据'
);

console.log('\n================================================================');
console.log('   🎉 任务15 P1重新绑定存证与定位有效性、P2历史依据侧栏统一全部通过！');
console.log('================================================================\n');
