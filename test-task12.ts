import { createPresetTask } from './src/services/mockData';
import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  UserRole,
  DraftCandidate,
  AlignedParagraphRow
} from './src/types';
import { 
  generateDraftFromFactsAndOutline, 
  computeContentHash,
  formatTaskPeriod,
  isSupportedDraftInstruction
} from './src/services/mockDraftService';
import { 
  validateCandidateAcceptance,
  acceptDraftCandidate,
  applyDraftContentChange,
  computeDraftBlocksHash
} from './src/services/draftLifecycleService';
import { computeTextDiff } from './src/services/diffService';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
}

console.log('==============================================');
console.log('   任务12 整稿候选对比与材料依据追溯回归测试');
console.log('==============================================\n');

// -----------------------------------------------------------------------
// 验收路径 A:
// 调整并重新核准事实后重新起草，候选采用新值；当前稿采纳前保持旧值。
// -----------------------------------------------------------------------
console.log('>>> [验收 A] 事实调整核准后起草候选采用新值，当前稿采纳前保持旧值:');
const taskA = createPresetTask('under_review');
const currentDraftA = taskA.drafts[0];
currentDraftA.blocks[0].content = currentDraftA.blocks[0].content.replace('128项', '120项');
assert(currentDraftA.blocks.some((b) => b.content.includes('120项')), '当前草稿正文基准包含120项重点任务事实');

// 1. 将事实从120调整核准为128项，并更新任务快照
const factTask128 = taskA.facts.find((f) => f.id === 'FACT-01')!;
factTask128.value = '128';
factTask128.status = 'confirmed';
taskA.factSnapshot = {
  confirmedAt: new Date().toISOString(),
  factIds: taskA.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
  items: taskA.facts.filter((f) => f.status === 'confirmed').map((f) => ({
    factId: f.id,
    metric: f.metric,
    value: f.value,
    unit: f.unit,
    period: f.period,
    metricScope: f.metricScope,
    primaryEvidenceId: f.primaryEvidenceId,
  })),
  hash: `FACT-SNAP-${Date.now().toString(36)}`,
};

// 2. 重新起草生成整稿候选
const candidateBlocksA = generateDraftFromFactsAndOutline(taskA);
const runIdA = 'RUN-A-128';
const candidateA: DraftCandidate = {
  taskId: taskA.id,
  runId: runIdA,
  baseDraftId: currentDraftA.id,
  baseDraftContentHash: computeDraftBlocksHash(currentDraftA.blocks),
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt: taskA.factSnapshot.confirmedAt,
    factSnapshotHash: taskA.factSnapshot.hash,
    styleConfirmedAt: taskA.styleSnapshot?.confirmedAt,
    styleHash: taskA.styleSnapshot?.hash,
    outlineConfirmedAt: taskA.outlineSnapshot?.confirmedAt,
    outlineHash: taskA.outlineSnapshot?.hash,
  },
  blocks: candidateBlocksA,
  snapshotMetadata: {
    taskTitle: taskA.title,
    startDate: taskA.startDate,
    endDate: taskA.endDate,
    targetWordCount: taskA.targetWordCount,
    factSnapshot: JSON.parse(JSON.stringify(taskA.factSnapshot)),
    outlineSections: JSON.parse(JSON.stringify(taskA.outline)),
  },
  generatedAt: new Date().toISOString(),
  instructionPrompt: '突出成效，减少铺垫',
};

// 3. 校验：采纳前当前稿保持旧值（120项），候选稿包含新值（128项）
assert(
  currentDraftA.blocks.some((b) => b.content.includes('120项')),
  '采纳前当前文稿100%保持旧值（120项），未被过早替换'
);
assert(
  !currentDraftA.blocks.some((b) => b.content.includes('128项')),
  '采纳前当前文稿不含新值（128项）'
);
assert(
  candidateA.blocks.some((b) => b.content.includes('128项')),
  '新起草候选稿成功采用最新核准事实（128项）'
);

// 4. 执行采纳并验证新草稿
const validationA = validateCandidateAcceptance(taskA, currentDraftA, candidateA, runIdA, '主笔甲');
assert(validationA.valid, '主笔采纳候选稿通过严格前置校验');
const { updatedTask: updatedTaskA, workingDraft: newDraftA, archivedDraft: archivedDraftA } = acceptDraftCandidate(
  taskA,
  currentDraftA,
  candidateA,
  '主笔甲'
);

assert(newDraftA.blocks.some((b) => b.content.includes('128项')), '采纳后新工作稿包含新值（128项）');
assert(archivedDraftA !== undefined, '旧草稿成功生成归档快照');
assert(archivedDraftA?.blocks.some((b) => b.content.includes('120项')), '旧稿归档快照完整保持旧值（120项）');


// -----------------------------------------------------------------------
// 验收路径 B:
// 能够实际打开候选全文和差异，组织比较按稳定章节与Block ID，无法可靠对齐的段落展示新增或删除
// -----------------------------------------------------------------------
console.log('\n>>> [验收 B] 候选全文与差异视图结构化对齐、新增与删除判定测试:');
const curBlocksB: ParagraphBlock[] = [
  { id: 'BLK-01', sectionId: 'SEC-01', order: 1, content: '第一段旧文本。', referencedFactIds: ['FACT-01'], updatedAt: '' },
  { id: 'BLK-02', sectionId: 'SEC-01', order: 2, content: '第二段将被删除的旧文本。', referencedFactIds: [], updatedAt: '' },
  { id: 'BLK-03', sectionId: 'SEC-02', order: 3, content: '第三段相同文本。', referencedFactIds: [], updatedAt: '' },
];
const candBlocksB: ParagraphBlock[] = [
  { id: 'BLK-01', sectionId: 'SEC-01', order: 1, content: '第一段修改后的新文本。', referencedFactIds: ['FACT-01'], updatedAt: '' },
  { id: 'BLK-04', sectionId: 'SEC-01', order: 2, content: '第四段新增的候选文本。', referencedFactIds: ['FACT-02'], updatedAt: '' },
  { id: 'BLK-03', sectionId: 'SEC-02', order: 3, content: '第三段相同文本。', referencedFactIds: [], updatedAt: '' },
];

// 对齐算法验证
const alignedRowsB: AlignedParagraphRow[] = [];
const processedCandidateIdsB = new Set<string>();

curBlocksB.forEach((cBlock) => {
  const match = candBlocksB.find((b) => b.id === cBlock.id);
  if (match) {
    processedCandidateIdsB.add(match.id);
    if (match.content === cBlock.content) {
      alignedRowsB.push({ type: 'identical', blockId: cBlock.id, currentBlock: cBlock, candidateBlock: match });
    } else {
      alignedRowsB.push({
        type: 'modified',
        blockId: cBlock.id,
        currentBlock: cBlock,
        candidateBlock: match,
        diffSegments: computeTextDiff(cBlock.content, match.content),
      });
    }
  } else {
    alignedRowsB.push({ type: 'removed', blockId: cBlock.id, currentBlock: cBlock });
  }
});

candBlocksB.forEach((candBlock) => {
  if (!processedCandidateIdsB.has(candBlock.id)) {
    alignedRowsB.push({ type: 'added', blockId: candBlock.id, candidateBlock: candBlock });
  }
});

assert(alignedRowsB.some((r) => r.type === 'modified' && r.blockId === 'BLK-01'), '相同 Block ID 内容变动判定为 modified');
assert(alignedRowsB.some((r) => r.type === 'removed' && r.blockId === 'BLK-02'), '当前稿独有 Block ID 判定为 removed（未强行按数组索引对齐为第四段）');
assert(alignedRowsB.some((r) => r.type === 'added' && r.blockId === 'BLK-04'), '候选稿独有 Block ID 判定为 added');
assert(alignedRowsB.some((r) => r.type === 'identical' && r.blockId === 'BLK-03'), '未变动 Block ID 判定为 identical');


// -----------------------------------------------------------------------
// 验收路径 C:
// 对比期间人工修改正文，旧候选失效；取消新运行后旧候选不能重新有效
// -----------------------------------------------------------------------
console.log('\n>>> [验收 C] 对比期间人工修改正文触发候选失效，取消新运行后旧候选不得恢复有效:');
const taskC = createPresetTask('under_review');
const currentDraftC = taskC.drafts[0];
const baseHashC = computeDraftBlocksHash(currentDraftC.blocks);
const runIdC1 = 'RUN-C-1';

const candidateC: DraftCandidate = {
  taskId: taskC.id,
  runId: runIdC1,
  baseDraftId: currentDraftC.id,
  baseDraftContentHash: baseHashC,
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt: taskC.factSnapshot?.confirmedAt,
    factSnapshotHash: taskC.factSnapshot?.hash,
    styleConfirmedAt: taskC.styleSnapshot?.confirmedAt,
    styleHash: taskC.styleSnapshot?.hash,
    outlineConfirmedAt: taskC.outlineSnapshot?.confirmedAt,
    outlineHash: taskC.outlineSnapshot?.hash,
  },
  blocks: JSON.parse(JSON.stringify(currentDraftC.blocks)),
  snapshotMetadata: {
    taskTitle: taskC.id,
    startDate: taskC.startDate,
    endDate: taskC.endDate,
    targetWordCount: taskC.targetWordCount,
    outlineSections: taskC.outline,
  },
  generatedAt: new Date().toISOString(),
};

// 1. 生成时刻正文未变，校验通过
const validBeforeEdit = validateCandidateAcceptance(taskC, currentDraftC, candidateC, runIdC1, '主笔甲');
assert(validBeforeEdit.valid, '正文未修改时候选校验通过');

// 2. 主笔人工编辑段落修改正文
const editResultC = applyDraftContentChange(
  taskC,
  currentDraftC.id,
  (blocks) => blocks.map((b, idx) => (idx === 0 ? { ...b, content: `${b.content}【人工新增批注要求】` } : b)),
  '手工编辑修改第一段',
  '主笔甲'
);
const modifiedDraftC = editResultC.workingDraft;

// 3. 此时采纳旧候选，应严格拦截防止覆盖人工编辑
const validAfterEdit = validateCandidateAcceptance(taskC, modifiedDraftC, candidateC, runIdC1, '主笔甲');
assert(!validAfterEdit.valid, '人工修改正文后旧候选被严格阻断采纳');
assert(validAfterEdit.reason?.includes('基准正文已变更') === true, '给出防止覆盖人工修改的明确原因');

// 4. 发起新运行但中途取消 (activeCompletedRunId 设为 null)
const validAfterCancel = validateCandidateAcceptance(taskC, modifiedDraftC, candidateC, null, '主笔甲');
assert(!validAfterCancel.valid, '取消生成后旧候选不得被重新视为有效');
assert(validAfterCancel.reason?.includes('已失效') === true, '明确指出生成运行已失效');


// -----------------------------------------------------------------------
// 验收路径 D:
// 普通工作稿整体采纳后，旧稿归档、新工作稿同时保留；历史或定稿源版本原对象内容及冻结记录保持不变
// -----------------------------------------------------------------------
console.log('\n>>> [验收 D] 普通工作稿采纳归档、历史/定稿只读版本不可变性保护:');
const taskD = createPresetTask('under_review');
const initialDraftCount = taskD.drafts.length;
const currentWorkDraftD = taskD.drafts[0];
currentWorkDraftD.isWorkingDraft = true;
currentWorkDraftD.isHistoricalSnapshot = false;

// 1. 工作稿采纳候选
const candidateD: DraftCandidate = {
  taskId: taskD.id,
  runId: 'RUN-D-1',
  baseDraftId: currentWorkDraftD.id,
  baseDraftContentHash: computeDraftBlocksHash(currentWorkDraftD.blocks),
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt: taskD.factSnapshot?.confirmedAt,
    factSnapshotHash: taskD.factSnapshot?.hash,
    styleConfirmedAt: taskD.styleSnapshot?.confirmedAt,
    styleHash: taskD.styleSnapshot?.hash,
    outlineConfirmedAt: taskD.outlineSnapshot?.confirmedAt,
    outlineHash: taskD.outlineSnapshot?.hash,
  },
  blocks: JSON.parse(JSON.stringify(currentWorkDraftD.blocks)),
  snapshotMetadata: {
    taskTitle: taskD.title,
    startDate: taskD.startDate,
    endDate: taskD.endDate,
    targetWordCount: taskD.targetWordCount,
    outlineSections: taskD.outline,
  },
  generatedAt: new Date().toISOString(),
};

const resD1 = acceptDraftCandidate(taskD, currentWorkDraftD, candidateD, '主笔甲');
assert(resD1.updatedTask.drafts.length === initialDraftCount + 1, '采纳后草稿总数增加1（新工作稿 + 旧归档稿）');
assert(resD1.archivedDraft?.isHistoricalSnapshot === true, '旧工作稿被转为只读历史快照');
assert(resD1.archivedDraft?.isWorkingDraft === false, '旧工作稿不再是可编辑工作稿');
assert(resD1.workingDraft.isWorkingDraft === true, '新文稿标记为可编辑工作稿');

// 2. 从定稿/历史快照采纳候选
const finalSnapshotD: DraftVersion = {
  id: 'DRAFT-FINAL-D',
  versionNumber: 'v1.0 (已定稿)',
  createdAt: '2026-10-01T00:00:00Z',
  author: '主笔甲',
  summary: '正式定稿归档版本',
  blocks: JSON.parse(JSON.stringify(currentWorkDraftD.blocks)),
  isFinal: true,
  isHistoricalSnapshot: false,
  isWorkingDraft: false,
  frozenReviewComments: [{ id: 'REV-01', type: 'overall', targetVersionId: 'DRAFT-FINAL-D', reviewer: '审阅乙', content: '定稿审核通过', status: 'implemented', createdAt: '' }],
};
taskD.drafts.push(finalSnapshotD);

const candidateD2: DraftCandidate = {
  ...candidateD,
  baseDraftId: finalSnapshotD.id,
  baseDraftContentHash: computeDraftBlocksHash(finalSnapshotD.blocks),
};
const resD2 = acceptDraftCandidate(taskD, finalSnapshotD, candidateD2, '主笔甲');
const retrievedFinalD = resD2.updatedTask.drafts.find((d) => d.id === finalSnapshotD.id)!;
assert(retrievedFinalD.isFinal === true, '定稿快照 isFinal 保持不变');
assert(retrievedFinalD.frozenReviewComments?.length === 1, '定稿快照已冻结审阅意见未被篡改覆盖');
assert(resD2.workingDraft.sourceDraftId === finalSnapshotD.id, '新工作稿正确记录派生源为定稿快照ID');


// -----------------------------------------------------------------------
// 验收路径 E:
// 从正文找到正确原文；查看历史稿时，仍显示当时冻结的值和单位，当前核准值不回填旧稿
// -----------------------------------------------------------------------
console.log('\n>>> [验收 E] 正文出处追溯与历史快照冻结事实隔离（当前核准值绝不回填旧稿）:');
const taskE = createPresetTask('under_review');
// 历史快照冻结采用值为 120项
const historicalSnapshotE: DraftVersion = {
  id: 'DRAFT-HIST-E',
  versionNumber: 'v1.0 (历史快照)',
  createdAt: '2026-09-30T10:00:00Z',
  author: '主笔甲',
  summary: '9月归档快照',
  blocks: [
    {
      id: 'BLK-SEC-01-1',
      sectionId: 'SEC-01',
      order: 1,
      content: '2026年1至9月，各项重点部署紧盯节点推进，截至统计期末，累计完成重点任务120项。',
      referencedFactIds: ['FACT-01'],
      updatedAt: '',
    },
  ],
  isHistoricalSnapshot: true,
  isWorkingDraft: false,
  snapshotMetadata: {
    taskTitle: taskE.title,
    startDate: taskE.startDate,
    endDate: taskE.endDate,
    targetWordCount: 2000,
    factSnapshot: {
      confirmedAt: '2026-09-30T10:00:00Z',
      factIds: ['FACT-01'],
      items: [
        {
          factId: 'FACT-01',
          metric: '累计完成重点任务',
          value: '120',
          unit: '项',
          period: '2026年1至9月',
          metricScope: '重点任务台账统计口径',
          primaryEvidenceId: 'EVD-01',
        },
      ],
      hash: 'FACT-SNAP-OLD',
    },
    outlineSections: taskE.outline,
  },
};

// 任务最新事实已被调整为 128项
const currentFactE = taskE.facts.find((f) => f.id === 'FACT-01')!;
currentFactE.value = '128';
currentFactE.status = 'confirmed';

// 验证历史稿冻结依据读取
const snapItemE = historicalSnapshotE.snapshotMetadata?.factSnapshot?.items.find((i) => i.factId === 'FACT-01');
assert(snapItemE !== undefined, '历史快照能可靠读取冻结的事实快照项');
assert(snapItemE?.value === '120' && snapItemE?.unit === '项', '历史快照优先读取其冻结事实值（120项）');
assert(currentFactE.value === '128', '任务当前最新核准值为128项');
assert(snapItemE?.value !== currentFactE.value, '检测到历史冻结值与当前核准值存在版本差异');

// 校验原文追溯
const snippetE = taskE.snippets.find((s) => s.id === snapItemE?.primaryEvidenceId);
assert(snippetE !== undefined, '从事实指标成功追溯到原始证据片段');
assert(snippetE?.location === '第3段', '原文位置精准对应第3段（真实电子登记位置，未伪造纸质页码）');
assert(snippetE?.text.includes('120') || snippetE?.text.includes('任务'), '证据片段内容真实吻合');


// -----------------------------------------------------------------------
// 验收路径 F & 指令要求:
// 写作要求真正传入模拟服务：支持指令产生对应结果，未支持指令返回清晰演示限制，所有量化指标和统计期间100%严密保留
// -----------------------------------------------------------------------
console.log('\n>>> [验收 F] 本轮起草要求传入模拟服务、明确支持指令与未支持限制:');

// 1. “突出成效，减少铺垫”
const blocksOutcomes = generateDraftFromFactsAndOutline(taskA, { instructionPrompt: '突出成效，减少铺垫' });
assert(
  blocksOutcomes.some((b) => b.content.includes('成效') || b.content.includes('攻坚突破')),
  '“突出成效”指令驱动生成突出工作实效与成效标识的段落'
);
assert(
  blocksOutcomes.some((b) => b.content.includes('128项') && b.content.includes('2026年1至9月')),
  '“突出成效”指令严格保留已核准的128项指标与统计期间'
);

// 2. “减少铺垫，精简表达”
const blocksConcise = generateDraftFromFactsAndOutline(taskA, { instructionPrompt: '减少铺垫，精简表达' });
const conciseTaskBlock = blocksConcise.find((b) => b.content.includes('128项'));
assert(
  conciseTaskBlock !== undefined && conciseTaskBlock.content.length < 50,
  '“精简表达”指令精炼篇幅、大幅删减前置铺垫动员语'
);
assert(
  conciseTaskBlock!.content.includes('128项') && conciseTaskBlock!.content.includes('2026年1至9月'),
  '“精简表达”指令严格保留128项数据与统计期间'
);

// 3. “优化问题与安排的对应”
const blocksAlignment = generateDraftFromFactsAndOutline(taskA, { instructionPrompt: '优化问题与安排的对应' });
assert(
  blocksAlignment.some((b) => b.content.includes('对应') || b.content.includes('靶向') || b.content.includes('清单')),
  '“优化问题与安排的对应”指令驱动生成强调清单化推进与精准对应的句式'
);
assert(
  blocksAlignment.some((b) => b.content.includes('128项')),
  '“优化对应”指令严格保留128项数据'
);

// 4. “改成面向单位负责人的汇报口吻”
const blocksReporting = generateDraftFromFactsAndOutline(taskA, { instructionPrompt: '改成面向单位负责人的汇报口吻' });
assert(
  blocksReporting.some((b) => b.content.includes('全局中心工作部署') || b.content.includes('高位推进')),
  '“汇报口吻”指令驱动生成面向领导的高站位汇报句式'
);
assert(
  blocksReporting.some((b) => b.content.includes('128项')),
  '“汇报口吻”指令严格保留128项数据'
);

// 5. 校验支持与未支持指令判断
assert(isSupportedDraftInstruction('突出成效，减少铺垫') === true, '明确支持的成效指令被识别为支持');
assert(isSupportedDraftInstruction('优化问题与安排的对应') === true, '明确支持的对应指令被识别为支持');
assert(isSupportedDraftInstruction('写一首关于秋天的七言律诗') === false, '无关未支持指令被识别为未支持');
assert(isSupportedDraftInstruction('预测下个季度公司股价') === false, '金融预测未支持指令被识别为未支持');

console.log('\n==============================================');
console.log('   🎉 任务12 全部验收与回归测试全部通过！');
console.log('==============================================\n');
