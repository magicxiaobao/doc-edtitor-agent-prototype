import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask, createMultiFactGroupRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  EvidenceSnippet,
  SourceDocument,
  MultiFactGroupRevisionCandidate,
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
} from './src/services/factImpactService';
import {
  checkMultiFactGroupRevisionEligibility,
  generateMultiFactGroupRevisionCandidate,
  acceptMultiFactGroupRevisionCandidate,
  validateMultiFactGroupRevisionAcceptance,
  checkMultiParagraphFactRevisionEligibility,
  checkFactRevisionEligibility,
} from './src/services/factRevisionCandidateService';
import {
  evaluateDraftFactReviews,
  saveFactReviewRecord,
} from './src/services/factReviewService';
import {
  applyDraftContentChange,
  createDraftSnapshot,
  restoreDraftVersion,
  validateUndoEligibility,
} from './src/services/draftLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

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

async function runTask25Tests() {
  console.log('\n================================================================');
  console.log('   🚀 开始执行 任务25 多事实成组定向修订 实施方自测套件');
  console.log('================================================================\n');

  // Helper fixture builder: 2 facts changed
  // FACT-01: 重点任务 128项 -> 120项 (referencing BLK-01, BLK-02)
  // FACT-02: 专题培训 16场 -> 18场 (referencing BLK-03)
  // Non-changed: FACT-03 800人次 (referencing BLK-03), FACT-04 12次 (referencing BLK-04)
  function createStandardTwoFactFixture() {
    const task = createMultiFactGroupRevisionDemoTask();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

    // Upstream task facts updated:
    // 1. FACT-01 resolved to 120
    const fact01 = task.facts.find((f) => f.id === 'FACT-01')!;
    fact01.status = 'confirmed';
    fact01.selectedConflictValue = '120';
    fact01.value = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    fact01.conflictResolutionReason = '采信科室甲申报口径120项';

    // 2. FACT-02 resolved to 18
    const fact02 = task.facts.find((f) => f.id === 'FACT-02')!;
    fact02.status = 'confirmed';
    fact02.selectedConflictValue = '18';
    fact02.value = '18';
    fact02.primaryEvidenceId = 'EVD-07';
    fact02.conflictResolutionReason = '采信最新培训办通报18场';

    // Upstream snapshot confirmed with 120 items and 18 sessions
    task.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task, f)),
      hash: 'SNAPSHOT-HASH-CONFIRMED-MULTI-FACT-GROUP',
    };
    task.outlineConfirmed = true;
    task.styleConfirmed = true;
    task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
    task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

    return { task, draft };
  }

  // ==========================================================================
  // [A] 两事实分别关联1段、以及一项关联多段的成功场景；事实和段落计数正确
  // ==========================================================================
  console.log('>>> [A] 两事实分别关联1段、以及一项关联多段的成功场景；事实和段落计数正确:');
  {
    const { task, draft } = createStandardTwoFactFixture();

    const analysis = analyzeFactImpact(task, draft);
    assert(analysis.changedFactsCount === 2, 'A: 分析显示正好有2项事实发生数值变化');
    assert(analysis.affectedBlocksCount === 3, 'A: 去重后的受影响段落数为3段（BLK-01, BLK-02, BLK-03）');

    // Check eligibility
    const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
    assert(elig.eligible, 'A: 两事实成组定向修订准入判定通过');
    assert(elig.targetFactIds?.length === 2, 'A: 返回2项事实ID');
    assert(elig.allReferencingBlocks?.length === 3, 'A: 返回全部3个受影响段落');

    // Generate candidate group
    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    assert(genRes.success && !!genRes.candidateGroup, 'A: 成功生成多事实成组修订候选组');
    const group = genRes.candidateGroup!;
    assert(group.facts.length === 2, 'A: 候选组包含2项事实');
    assert(group.items.length === 3, 'A: 候选组包含3个段落');
    assert(group.targetBlockIds.join(',') === 'BLK-01,BLK-02,BLK-03', 'A: 目标段落按顺序包含BLK-01, BLK-02, BLK-03');

    // Verify candidate text transformations
    const item1 = group.items.find((i) => i.targetBlockId === 'BLK-01')!;
    const item2 = group.items.find((i) => i.targetBlockId === 'BLK-02')!;
    const item3 = group.items.find((i) => i.targetBlockId === 'BLK-03')!;

    assert(item1.revisedBlockContent.includes('120项') && !item1.revisedBlockContent.includes('128项'), 'A: BLK-01改写为120项');
    assert(item2.revisedBlockContent.includes('120项') && !item2.revisedBlockContent.includes('128项'), 'A: BLK-02改写为120项');
    assert(item3.revisedBlockContent.includes('18场') && !item3.revisedBlockContent.includes('16场'), 'A: BLK-03改写为18场');

    // Validate acceptance
    const val = validateMultiFactGroupRevisionAcceptance(task, draft, group, '主笔甲', group.runId);
    assert(val.valid, 'A: 候选组通过采纳前校验');
  }

  // ==========================================================================
  // [B] 两项变更事实共享段落、三项事实变化、只有一项事实变化，安全阻断并提示原因
  // ==========================================================================
  console.log('\n>>> [B] 两项变更事实共享段落、三项事实变化、只有一项事实变化，安全阻断并提示原因:');
  {
    // B.1 Overlapping paragraphs: both FACT-01 and FACT-02 reference BLK-01
    {
      const { task, draft } = createStandardTwoFactFixture();
      draft.blocks.find((b) => b.id === 'BLK-01')!.referencedFactIds = ['FACT-01', 'FACT-02'];
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'B.1: 两项事实共同关联同一段落时整组阻断');
      assert(elig.reason?.includes('互不重叠') || elig.reason?.includes('同一段落'), 'B.1: 提示两项事实段落集合存在重叠');
    }

    // B.2 Three facts changed
    {
      const { task, draft } = createStandardTwoFactFixture();
      // Introduce 3rd fact change: FACT-04 (12次 -> 15次)
      const fact04 = task.facts.find((f) => f.id === 'FACT-04')!;
      fact04.value = '15';
      task.factSnapshot!.items.find((i) => i.factId === 'FACT-04')!.value = '15';
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'B.2: 三项事实变化时安全阻断');
      assert(elig.reason?.includes('3') || elig.reason?.includes('两项事实'), 'B.2: 明确说明超出两项事实范围');
    }

    // B.3 Only one fact changed
    {
      const { task, draft } = createStandardTwoFactFixture();
      // Revert FACT-02 back to 16
      const fact02 = task.facts.find((f) => f.id === 'FACT-02')!;
      fact02.value = '16';
      fact02.selectedConflictValue = '16';
      fact02.primaryEvidenceId = 'EVD-03';
      const snapF2 = task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!;
      snapF2.value = '16';
      snapF2.selectedConflictValue = '16';
      snapF2.primaryEvidenceId = 'EVD-03';
      snapF2.provenance = {
        evidenceId: 'EVD-03',
        sourceDocId: 'SRC-03',
        sourceDocName: '培训工作台账',
        location: '第5段',
        text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
        period: '2026年1至9月',
        capturedAt: '2026-10-07T09:00:00.000Z',
      };
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'B.3: 仅单项事实变化时两事实成组通道安全拒绝');
      assert(elig.reason?.includes('1 项') || elig.reason?.includes('单事实'), 'B.3: 提示使用单事实通道');
    }
  }

  // ==========================================================================
  // [C] 包含未变更事实引用的段落（如800人次）其未变数值、引用和依据严格保持不变
  // ==========================================================================
  console.log('\n>>> [C] 包含未变更事实引用的段落（如800人次）其未变数值、引用和依据严格保持不变:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const blk03Before = draft.blocks.find((b) => b.id === 'BLK-03')!.content;
    assert(blk03Before.includes('800人次'), 'C: BLK-03原正文包含800人次');

    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    const group = genRes.candidateGroup!;
    const blk03Item = group.items.find((i) => i.targetBlockId === 'BLK-03')!;

    assert(blk03Item.revisedBlockContent.includes('800人次'), 'C: 修订候选中的800人次严格保留');
    assert(blk03Item.originalReferencedFactIds.includes('FACT-03'), 'C: 原始引用的FACT-03依据关系保留');

    const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, group, '主笔甲', group.runId);
    const newDraft = accRes.newWorkingDraft!;
    const newBlk03 = newDraft.blocks.find((b) => b.id === 'BLK-03')!;

    assert(newBlk03.content.includes('800人次'), 'C: 采纳后新稿BLK-03中的800人次严格保留未变');
    assert(newBlk03.referencedFactIds.includes('FACT-03'), 'C: 新稿引用的FACT-03未被篡改');
    assert(newDraft.snapshotMetadata!.factSnapshot.items.find((i: any) => i.factId === 'FACT-03')!.value === '800', 'C: FACT-03依据基准依然是800');
  }

  // ==========================================================================
  // [D] 单位、期间、口径不符，缺少冻结出处，篡改基准事实ID/值，或目标段落含补写存证，整组阻断
  // ==========================================================================
  console.log('\n>>> [D] 单位、期间、口径不符，缺少冻结出处，篡改基准事实ID/值，或目标段落含补写存证，整组阻断:');
  {
    // D.1 Unit mismatch on FACT-02
    {
      const { task, draft } = createStandardTwoFactFixture();
      task.facts.find((f) => f.id === 'FACT-02')!.unit = '期';
      task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.unit = '期';
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'D.1: 事实单位变动整组阻断');
      assert(elig.blockingReasons?.some((r) => r.includes('单位')), 'D.1: 提示单位变动');
    }

    // D.2 Missing frozen evidence on draft
    {
      const { task, draft } = createStandardTwoFactFixture();
      delete draft.snapshotMetadata!.factSnapshot.items.find((i: any) => i.factId === 'FACT-01')!.provenance;
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'D.2: 缺少冻结出处时整组阻断');
    }

    // D.3 Target block BLK-02 contains material supplement evidence
    {
      const { task, draft } = createStandardTwoFactFixture();
      draft.blocks.find((b) => b.id === 'BLK-02')!.adoptedEvidences = [
        { evidenceId: 'EVD-01', sourceDocId: 'DOC-01', sourceDocName: '文档1', snippetText: '文字', snippetLocation: '第1段', period: '2026年前三季度', usage: 'current_fact', associatedFactId: 'FACT-01', contentFingerprint: 'adopted', capturedAt: new Date().toISOString() },
      ];
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'D.3: 目标段落含材料补写存证时整组阻断');
      assert(elig.blockingReasons?.some((r) => r.includes('材料补写存证')), 'D.3: 明确说明含材料补写存证');
    }
  }

  // ==========================================================================
  // [E] 确定性改写失败（非目标同值、计划预测、否定条件、小数子串、复合单位），整组阻断
  // ==========================================================================
  console.log('\n>>> [E] 确定性改写失败（非目标同值、计划预测、否定条件、小数子串、复合单位），整组阻断:');
  {
    // E.1 Planning / condition semantics in BLK-01
    {
      const { task, draft } = createStandardTwoFactFixture();
      draft.blocks.find((b) => b.id === 'BLK-01')!.content = '计划前三季度累计推进重点任务128项。';
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'E.1: 段落含计划限定时整组阻断');
    }

    // E.2 Negation semantics in BLK-03
    {
      const { task, draft } = createStandardTwoFactFixture();
      draft.blocks.find((b) => b.id === 'BLK-03')!.content = '累计举办专题培训尚未达到16场。';
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'E.2: 段落含否定语义时整组阻断');
    }

    // E.3 Value diverged in BLK-02
    {
      const { task, draft } = createStandardTwoFactFixture();
      draft.blocks.find((b) => b.id === 'BLK-02')!.content = '立项任务已完成130项。';
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'E.3: 正文数值偏离冻结值时整组阻断');
    }
  }

  // ==========================================================================
  // [F] 审批失效、出处缺少原文位置、存在未裁决冲突或未核准事实，整组阻断
  // ==========================================================================
  console.log('\n>>> [F] 审批失效、出处缺少原文位置、存在未裁决冲突或未核准事实，整组阻断:');
  {
    // F.1 Task outline unconfirmed
    {
      const { task, draft } = createStandardTwoFactFixture();
      task.outlineConfirmed = false;
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible && elig.unconfirmedUpstream === 'outline', 'F.1: 大纲未核准时整组阻断并返回unconfirmedUpstream');
    }

    // F.2 Unresolved conflict on FACT-02
    {
      const { task, draft } = createStandardTwoFactFixture();
      const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
      f2.hasConflict = true;
      f2.selectedConflictValue = undefined;
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
      assert(!elig.eligible, 'F.2: 存在未裁决冲突时整组阻断');
    }

    // F.3 Role is not primary author
    {
      const { task, draft } = createStandardTwoFactFixture();
      const elig = checkMultiFactGroupRevisionEligibility(task, draft, '审阅乙');
      assert(!elig.eligible, 'F.3: 非主笔角色整组阻断');
    }
  }

  // ==========================================================================
  // [G] 整体采纳一次性完成：只建一个新工作稿，仅目标段落 revisionSeq 增加，历史稿完整冻结，未变段落完全一致
  // ==========================================================================
  console.log('\n>>> [G] 整体采纳一次性完成：只建一个新工作稿，仅目标段落 revisionSeq 增加，历史稿完整冻结，未变段落完全一致:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const initialDraftsCount = task.drafts.length;
    const blk04Orig = draft.blocks.find((b) => b.id === 'BLK-04')!.content;
    const blk05Orig = draft.blocks.find((b) => b.id === 'BLK-05')!.content;

    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    const group = genRes.candidateGroup!;

    const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, group, '主笔甲', group.runId);
    assert(accRes.success, 'G: 采纳成功');

    const updatedTask = accRes.updatedTask!;
    assert(updatedTask.drafts.length === initialDraftsCount + 1, 'G: 仅创建了1个新稿');
    assert(updatedTask.currentDraftId === accRes.newWorkingDraft!.id, 'G: currentDraftId切换到新工作稿');

    const newDraft = accRes.newWorkingDraft!;
    const oldArchived = accRes.archivedDraft!;

    assert(oldArchived.isHistoricalSnapshot && !oldArchived.isWorkingDraft, 'G: 旧工作稿已归档为历史快照');
    assert(newDraft.isWorkingDraft && !newDraft.isHistoricalSnapshot, 'G: 新稿为当前可编辑工作稿');

    // revisionSeq check
    const newB1 = newDraft.blocks.find((b) => b.id === 'BLK-01')!;
    const newB2 = newDraft.blocks.find((b) => b.id === 'BLK-02')!;
    const newB3 = newDraft.blocks.find((b) => b.id === 'BLK-03')!;
    const newB4 = newDraft.blocks.find((b) => b.id === 'BLK-04')!;
    const newB5 = newDraft.blocks.find((b) => b.id === 'BLK-05')!;

    assert(newB1.revisionSeq === 1, 'G: BLK-01 revisionSeq 递增为1');
    assert(newB2.revisionSeq === 1, 'G: BLK-02 revisionSeq 递增为1');
    assert(newB3.revisionSeq === 1, 'G: BLK-03 revisionSeq 递增为1');
    assert(!newB4.revisionSeq || newB4.revisionSeq === 0, 'G: BLK-04 revisionSeq 未递增');
    assert(!newB5.revisionSeq || newB5.revisionSeq === 0, 'G: BLK-05 revisionSeq 未递增');

    assert(newB4.content === blk04Orig, 'G: BLK-04 正文严格保持原样');
    assert(newB5.content === blk05Orig, 'G: BLK-05 正文严格保持原样');
  }

  // ==========================================================================
  // [H] 新稿正确绑定最新快照，历史复核记录不作为有效留痕继承，核校门禁按新事实生效
  // ==========================================================================
  console.log('\n>>> [H] 新稿正确绑定最新快照，历史复核记录不作为有效留痕继承，核校门禁按新事实生效:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const { workingDraft } = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '旧记录确认128项',
      activeRole: '主笔甲',
    });
    draft.factReviewRecords = workingDraft.factReviewRecords;

    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    const group = genRes.candidateGroup!;
    const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, group, '主笔甲', group.runId);

    const newDraft = accRes.newWorkingDraft!;
    assert(newDraft.factReviewRecords?.length === 0, 'H: 新稿人工复核记录初始化为空，不自动继承“已复核”签名');
    assert(newDraft.sourceFactReviewRecords?.length === 1, 'H: 旧复核记录移入sourceFactReviewRecords供追溯');

    const snapF1 = newDraft.snapshotMetadata!.factSnapshot.items.find((i: any) => i.factId === 'FACT-01')!;
    const snapF2 = newDraft.snapshotMetadata!.factSnapshot.items.find((i: any) => i.factId === 'FACT-02')!;
    assert(snapF1.value === '120', 'H: 新稿快照绑定最新FACT-01为120项');
    assert(snapF2.value === '18', 'H: 新稿快照绑定最新FACT-02为18场');

    // Audit evaluations on new draft
    const newImpact = analyzeFactImpact(accRes.updatedTask!, newDraft);
    assert(newImpact.changedFactsCount === 0, 'H: 新稿与任务最新事实对比无差异');
  }

  // ==========================================================================
  // [I] 修改日志结构化记录全部两项事实与全部关联段落，最近修改记录完整展示两项事实与段落明细
  // ==========================================================================
  console.log('\n>>> [I] 修改日志结构化记录全部两项事实与全部关联段落，最近修改记录完整展示两项事实与段落明细:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    const group = genRes.candidateGroup!;
    const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, group, '主笔甲', group.runId);

    const log = accRes.modificationLog!;
    assert(!!log, 'I: 生成了修改日志');
    assert(Array.isArray(log.affectedFacts) && log.affectedFacts.length === 2, 'I: log.affectedFacts结构化记录了2项事实');
    assert(log.affectedFacts.some((f) => f.factId === 'FACT-01' && f.toValue === '120'), 'I: 包含FACT-01详细数据');
    assert(log.affectedFacts.some((f) => f.factId === 'FACT-02' && f.toValue === '18'), 'I: 包含FACT-02详细数据');
    assert(Array.isArray(log.affectedBlocks) && log.affectedBlocks.length === 3, 'I: log.affectedBlocks记录了3个段落明细');

    // Test RecentModificationsModal rendering
    const modalMount = mountTestComponent(
      <RecentModificationsModal
        isOpen={true}
        onClose={() => {}}
        task={accRes.updatedTask!}
        currentDraft={accRes.newWorkingDraft!}
        activeRole="主笔甲"
        onUndo={() => {}}
      />
    );

    // Verify modal elements
    const fact1Card = modalMount.container.querySelector('[data-testid="log-affected-fact-FACT-01"]');
    const fact2Card = modalMount.container.querySelector('[data-testid="log-affected-fact-FACT-02"]');
    assert(!!fact1Card, 'I: 最近修改记录弹窗展示了FACT-01明细卡片');
    assert(!!fact2Card, 'I: 最近修改记录弹窗展示了FACT-02明细卡片');
    assert(fact1Card.textContent?.includes('120项'), 'I: FACT-01卡片展示新值120项');
    assert(fact2Card.textContent?.includes('18场'), 'I: FACT-02卡片展示新值18场');

    modalMount.unmount();
  }

  // ==========================================================================
  // [J] 禁止单段撤销；版本恢复后正文与依据完整回退，重新进行事实差异比较
  // ==========================================================================
  console.log('\n>>> [J] 禁止单段撤销；版本恢复后正文与依据完整回退，重新进行事实差异比较:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const genRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
    const group = genRes.candidateGroup!;
    const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, group, '主笔甲', group.runId);

    const log = accRes.modificationLog!;
    const undoVal = validateUndoEligibility(accRes.updatedTask!, accRes.newWorkingDraft!, log.id, '主笔甲');
    assert(!undoVal.canUndo, 'J: 修改日志禁止单段/局部撤销');
    assert(undoVal.reason?.includes('版本历史') || undoVal.reason?.includes('恢复完整正文与依据'), 'J: 撤销提示引导使用版本历史恢复');

    // Restore old version
    const restored = restoreDraftVersion(accRes.updatedTask!, draft.id, '主笔甲');
    assert(!!restored.workingDraft, 'J: 通过版本历史恢复成功');

    const restoredDraft = restored.updatedTask!.drafts.find((d) => d.id === restored.updatedTask!.currentDraftId)!;
    assert(restoredDraft.blocks.find((b) => b.id === 'BLK-01')!.content.includes('128项'), 'J: 恢复后正文回退到128项');
    assert(restoredDraft.snapshotMetadata!.factSnapshot.items.find((i: any) => i.factId === 'FACT-01')!.value === '128', 'J: 恢复后依据基准也回退到128');

    // Fact impact re-evaluated on restored draft
    const reAnalysis = analyzeFactImpact(restored.updatedTask!, restoredDraft);
    assert(reAnalysis.changedFactsCount === 2, 'J: 恢复后重新核对再次检出2项事实差异');
  }

  // ==========================================================================
  // [K] 真实组件测试：事实影响面板展示两事实统一入口、两项事实卡片、全部段落比较与删改标记、出处查看、定位正文、整体采纳、切换与取消清理
  // ==========================================================================
  console.log('\n>>> [K] 真实组件测试：事实影响面板展示两事实统一入口、两项事实卡片、全部段落比较与删改标记、出处查看、定位正文、整体采纳、切换与取消清理:');
  {
    const { task, draft } = createStandardTwoFactFixture();
    const analysis = analyzeFactImpact(task, draft);

    let acceptedCandidate: MultiFactGroupRevisionCandidate | null = null;
    let locatedBlockId: string | null = null;

    const modalMount = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentTask={task}
        currentDraft={draft}
        activeRole="主笔甲"
        onLocateBlock={(bId) => {
          locatedBlockId = bId;
        }}
        onAcceptMultiFactGroupRevision={(c) => {
          acceptedCandidate = c;
          return { success: true };
        }}
      />
    );

    // 1. Unified button
    const genBtn = modalMount.container.querySelector(
      '[data-testid="btn-generate-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    assert(!!genBtn, 'K: 存在两项事实成组修订统一入口按钮');

    // 2. Click generate
    act(() => {
      genBtn.click();
    });

    // 3. Inspect candidate card
    const card = modalMount.container.querySelector(
      '[data-testid="multi-fact-group-revision-candidate-card"]'
    );
    assert(!!card, 'K: 渲染了两事实成组定向修订候选卡片');

    // 4. Fact cards
    const fact1 = modalMount.container.querySelector('[data-testid="candidate-fact-item-FACT-01"]');
    const fact2 = modalMount.container.querySelector('[data-testid="candidate-fact-item-FACT-02"]');
    assert(!!fact1 && !!fact2, 'K: 展示了两项事实独立卡片');

    // 5. Paragraph cards & Issue #82 demarcation
    const itemBlk01 = modalMount.container.querySelector('[data-testid="candidate-item-BLK-01"]');
    const itemBlk02 = modalMount.container.querySelector('[data-testid="candidate-item-BLK-02"]');
    const itemBlk03 = modalMount.container.querySelector('[data-testid="candidate-item-BLK-03"]');
    assert(!!itemBlk01 && !!itemBlk02 && !!itemBlk03, 'K: 展示了全部3个段落候选卡片');

    const orig1 = modalMount.container.querySelector('[data-testid="original-block-content-BLK-01"]')?.textContent || '';
    const rev1 = modalMount.container.querySelector('[data-testid="revised-block-content-BLK-01"]')?.textContent || '';
    const diff1 = modalMount.container.querySelector('[data-testid="revision-diff-view-BLK-01"]')?.textContent || '';

    assert(orig1.includes('128项') && !orig1.includes('120'), 'K [Issue #82]: 原文完整文本只含128项');
    assert(rev1.includes('120项') && !rev1.includes('128'), 'K [Issue #82]: 修订候选完整文本只含120项');
    assert(!diff1.includes('1280项'), 'K [Issue #82]: 删改标记文本未连成“1280项”');
    assert(diff1.includes('[删: 128项]') && diff1.includes('[改: 120项]'), 'K: 删改标记带有[删: ...]与[改: ...]');

    // 6. Locate block button
    const locateBtn = modalMount.container.querySelector(
      '[data-testid="btn-locate-candidate-block-BLK-03"]'
    ) as HTMLButtonElement;
    assert(!!locateBtn, 'K: 存在定位正文按钮');
    act(() => {
      locateBtn.click();
    });
    assert(locatedBlockId === 'BLK-03', 'K: 正确触发定位正文至BLK-03');

    // 7. Test cancel
    const cancelBtn = modalMount.container.querySelector(
      '[data-testid="btn-cancel-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    assert(!!cancelBtn, 'K: 存在取消按钮');
    act(() => {
      cancelBtn.click();
    });
    assert(
      !modalMount.container.querySelector('[data-testid="multi-fact-group-revision-candidate-card"]'),
      'K: 取消后候选卡片成功关闭'
    );

    // 8. Regenerate and accept
    act(() => {
      genBtn.click();
    });
    const acceptBtn = modalMount.container.querySelector(
      '[data-testid="btn-accept-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    assert(!!acceptBtn, 'K: 存在“全部采纳并创建新工作稿”按钮');
    act(() => {
      acceptBtn.click();
    });
    assert(!!acceptedCandidate, 'K: 整体采纳成功触发回调');

    modalMount.unmount();
  }

  // ==========================================================================
  // [L] 独立演示任务真实交互：从两项事实材料核对、确认/裁决、确认事实大纲、进入正文生成候选、取消后重新生成、整体采纳到查看完整日志
  // ==========================================================================
  console.log('\n>>> [L] 独立演示任务真实交互：从两项事实材料核对、确认/裁决、确认事实大纲、进入正文生成候选、取消后重新生成、整体采纳到查看完整日志:');
  {
    // Step 1: Create independent demo task
    const demoTask = createPresetTask('multi_fact_group_revision');
    assert(demoTask.id === 'TASK-DEMO-MULTI-FACT-GROUP-REVISION', 'L: 成功创建独立演示任务');

    // Initial check: FACT-01 is pending conflict, FACT-02 is pending conflict
    const f1 = demoTask.facts.find((f) => f.id === 'FACT-01')!;
    const f2 = demoTask.facts.find((f) => f.id === 'FACT-02')!;
    assert(f1.status === 'pending' && f1.hasConflict, 'L: 初始FACT-01存在冲突待裁决');
    assert(f2.status === 'pending' && f2.hasConflict, 'L: 初始FACT-02存在冲突待裁决');

    // Step 2: Adjudicate both facts
    f1.status = 'confirmed';
    f1.selectedConflictValue = '120';
    f1.value = '120';
    f1.primaryEvidenceId = 'EVD-01';
    f1.conflictResolutionReason = '采信科室甲申报口径120项';

    f2.status = 'confirmed';
    f2.selectedConflictValue = '18';
    f2.value = '18';
    f2.primaryEvidenceId = 'EVD-07';
    f2.conflictResolutionReason = '采信最新培训办通报18场';

    // Confirm snapshots
    demoTask.factSnapshot = {
      confirmedAt: new Date().toISOString(),
      factIds: demoTask.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
      items: demoTask.facts.filter((f) => f.status === 'confirmed').map((f) => buildFactItemSnapshot(demoTask, f)),
      hash: 'DEMO-GROUP-SNAP-120-18',
    };
    demoTask.outlineConfirmed = true;
    demoTask.styleConfirmed = true;
    demoTask.outlineSnapshot = JSON.parse(JSON.stringify(demoTask.drafts[0].snapshotMetadata!.outlineSnapshot));
    demoTask.styleSnapshot = JSON.parse(JSON.stringify(demoTask.drafts[0].snapshotMetadata!.styleSnapshot));

    // Step 3: Mount DraftingStage with fact impact modal
    let stateTask = JSON.parse(JSON.stringify(demoTask));
    const handleUpdateTask = (updated: Partial<Task>) => {
      stateTask = { ...stateTask, ...updated };
    };

    const stageMount = mountTestComponent(
      <DraftingStage
        task={stateTask}
        onUpdateTask={handleUpdateTask}
        activeRole="主笔甲"
        onProceedToNextStage={() => {}}
        onViewSnippet={() => {}}
      />
    );

    // Open fact impact modal
    const impactBtn = stageMount.container.querySelector(
      '[data-testid="btn-open-fact-impact"]'
    ) as HTMLButtonElement;
    assert(!!impactBtn, 'L: 找到事实影响面板打开按钮');

    act(() => {
      impactBtn.click();
    });

    // Check unified button exists
    const genBtn = stageMount.container.querySelector(
      '[data-testid="btn-generate-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    assert(!!genBtn, 'L: 弹窗内出现“生成两项事实成组修订候选”按钮');

    // Click generate
    act(() => {
      genBtn.click();
    });

    const card = stageMount.container.querySelector(
      '[data-testid="multi-fact-group-revision-candidate-card"]'
    );
    assert(!!card, 'L: 候选卡片已展开展示2项事实与3个段落');

    // Cancel and re-generate
    const cancelBtn = stageMount.container.querySelector(
      '[data-testid="btn-cancel-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    act(() => {
      cancelBtn.click();
    });
    assert(!stageMount.container.querySelector('[data-testid="multi-fact-group-revision-candidate-card"]'), 'L: 取消成功');

    act(() => {
      genBtn.click();
    });
    assert(!!stageMount.container.querySelector('[data-testid="multi-fact-group-revision-candidate-card"]'), 'L: 重新生成成功');

    // Accept candidate
    const acceptBtn = stageMount.container.querySelector(
      '[data-testid="btn-accept-multi-fact-group-revision"]'
    ) as HTMLButtonElement;
    act(() => {
      acceptBtn.click();
    });

    // Verify task updated
    assert(stateTask.drafts.length === 2, 'L: 成功创建新工作稿');
    const newWorking = stateTask.drafts.find((d: any) => d.id === stateTask.currentDraftId)!;
    assert(newWorking.blocks[0].content.includes('120项'), 'L: 新稿第1段已更新为120项');
    assert(newWorking.blocks[1].content.includes('120项'), 'L: 新稿第2段已更新为120项');
    assert(newWorking.blocks[2].content.includes('18场'), 'L: 新稿第3段已更新为18场');
    assert(newWorking.blocks[2].content.includes('800人次'), 'L: 新稿第3段800人次保持未变');

    stageMount.unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务25 多事实成组定向修订 所有专项测试 全部通过！');
  console.log('================================================================\n');
}

runTask25Tests().catch((err) => {
  console.error('\n❌ 任务25 测试执行失败:', err);
  process.exit(1);
});
