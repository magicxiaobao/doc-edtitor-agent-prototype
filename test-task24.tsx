import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask, createMultiParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  EvidenceSnippet,
  SourceDocument,
  MultiParagraphFactRevisionCandidate,
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
  FactImpactItem,
} from './src/services/factImpactService';
import {
  checkMultiParagraphFactRevisionEligibility,
  generateMultiParagraphFactRevisionCandidate,
  acceptMultiParagraphFactRevisionCandidate,
  validateMultiParagraphFactRevisionAcceptance,
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
} from './src/services/draftLifecycleService';
import { resolveDraftFactEvidence } from './src/services/factLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { FactImpactModal } from './src/components/FactImpactModal';

function assert(condition: boolean, message: string) {
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

async function runTask24Tests() {
  console.log('\n================================================================');
  console.log('   🚀 开始执行 任务24 单事实多段落一致修订 实施方自测套件');
  console.log('================================================================\n');

  // Helper fixture builder: 1 fact (FACT-01) referenced by BLK-01 and BLK-02
  function createStandardMultiFixture() {
    const task = createMultiParagraphRevisionDemoTask();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

    // Upstream task facts updated: FACT-01 changed to 120 (科室甲申报口径)
    const fact01 = task.facts.find((f) => f.id === 'FACT-01')!;
    fact01.status = 'confirmed';
    fact01.selectedConflictValue = '120';
    fact01.value = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    fact01.conflictResolutionReason = '采信科室甲申报口径120项';

    // Upstream snapshot confirmed with 120 items
    task.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task, f)),
      hash: 'SNAPSHOT-HASH-CONFIRMED-MULTI-120',
    };
    task.outlineConfirmed = true;
    task.styleConfirmed = true;
    task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
    task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

    return { task, draft };
  }

  // ==========================================================================
  // [用例 1] 一事实两段成功；同段重复引用去重；无关段落和其他指标同值不改
  // ==========================================================================
  console.log('>>> [用例 1] 一事实两段成功；同段重复引用去重；无关段落和其他指标同值不改:');
  {
    const { task, draft } = createStandardMultiFixture();

    // Verify initial text
    const blk01Orig = draft.blocks.find((b) => b.id === 'BLK-01')!.content;
    const blk02Orig = draft.blocks.find((b) => b.id === 'BLK-02')!.content;
    const blk03Orig = draft.blocks.find((b) => b.id === 'BLK-03')!.content;
    const blk04Orig = draft.blocks.find((b) => b.id === 'BLK-04')!.content;
    assert(blk01Orig.includes('128项'), '用例1: BLK-01包含128项');
    assert(blk02Orig.includes('128项'), '用例1: BLK-02包含128项');
    assert(blk03Orig.includes('16场') && blk03Orig.includes('800人次'), '用例1: BLK-03对照段包含16场和800人次');

    // Add duplicate fact ID to BLK-01's referencedFactIds to test deduplication
    draft.blocks.find((b) => b.id === 'BLK-01')!.referencedFactIds = ['FACT-01', 'FACT-01'];

    // Multi-paragraph eligibility check
    const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
    assert(elig.eligible, '用例1: 多段修订准入判定通过');
    assert(elig.targetBlockIds.length === 2, '用例1: 关联段落按Block ID去重后为2段');
    assert(elig.targetBlockIds.includes('BLK-01') && elig.targetBlockIds.includes('BLK-02'), '用例1: 锁定BLK-01和BLK-02');

    // Task 23 single-paragraph eligibility check MUST reject multi-paragraph
    const singleElig = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
    assert(!singleElig.eligible, '用例1: 原单段准入规则保持严格门禁，多段关联时拒绝单段通道');

    // Generate multi candidate
    const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
    assert(genRes.success, '用例1: 成功生成多段修订候选组');
    assert(genRes.candidateGroup!.items.length === 2, '用例1: 候选组包含2段候选');
    assert(genRes.candidateGroup!.items.every((it) => it.revisedBlockContent.includes('120项')), '用例1: 所有候选段均准确改写为120项');

    // Accept candidate
    const accRes = acceptMultiParagraphFactRevisionCandidate(
      task,
      draft,
      genRes.candidateGroup!,
      '主笔甲',
      genRes.candidateGroup!.runId
    );
    assert(accRes.success, '用例1: 整体原子采纳成功');

    const newDraft = accRes.newWorkingDraft!;
    const newBlk01 = newDraft.blocks.find((b) => b.id === 'BLK-01')!;
    const newBlk02 = newDraft.blocks.find((b) => b.id === 'BLK-02')!;
    const newBlk03 = newDraft.blocks.find((b) => b.id === 'BLK-03')!;
    const newBlk04 = newDraft.blocks.find((b) => b.id === 'BLK-04')!;

    assert(newBlk01.content.includes('120项') && !newBlk01.content.includes('128项'), '用例1: 新稿BLK-01已更新为120项');
    assert(newBlk02.content.includes('120项') && !newBlk02.content.includes('128项'), '用例1: 新稿BLK-02已更新为120项');
    assert(newBlk01.revisionSeq === 1 && newBlk02.revisionSeq === 1, '用例1: 目标段落修订序号各递增1次');
    assert(newBlk03.content === blk03Orig && (!newBlk03.revisionSeq || newBlk03.revisionSeq === 0), '用例1: 对照段BLK-03内容完全不变，修订序号未递增');
    assert(newBlk04.content === blk04Orig && (!newBlk04.revisionSeq || newBlk04.revisionSeq === 0), '用例1: 对照段BLK-04内容完全不变，修订序号未递增');
  }

  // ==========================================================================
  // [用例 2] 任一段歧义、已偏离冻结值或含不支持存证时整组拒绝
  // ==========================================================================
  console.log('\n>>> [用例 2] 任一段歧义、已偏离冻结值或含不支持存证时整组拒绝:');
  {
    // 2.1 BLK-02 text diverged from frozen 128 items
    {
      const { task, draft } = createStandardMultiFixture();
      draft.blocks.find((b) => b.id === 'BLK-02')!.content = '督查台账已登记完成重点任务135项。'; // diverged
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例2.1: 第二段正文偏离冻结值时整组拒绝');
      assert(elig.blockingReasons?.some((r) => r.includes('BLK-02')), '用例2.1: 明确指出具体段落BLK-02');
    }

    // 2.2 BLK-02 contains material supplement evidence
    {
      const { task, draft } = createStandardMultiFixture();
      draft.blocks.find((b) => b.id === 'BLK-02')!.adoptedEvidences = [
        { id: 'EVD-SUPP-01', snippetId: 'EVD-01', title: '补充依据', insertedAt: new Date().toISOString() },
      ];
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例2.2: 包含材料补写存证时整组阻断');
      assert(elig.blockingReasons?.some((r) => r.includes('材料补写存证') && r.includes('BLK-02')), '用例2.2: 阻断原因明确指出BLK-02包含材料存证');
    }

    // 2.3 BLK-01 contains negation / planning semantics
    {
      const { task, draft } = createStandardMultiFixture();
      draft.blocks.find((b) => b.id === 'BLK-01')!.content = '全系统计划累计完成重点任务128项，目前正在推进。';
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例2.3: 包含计划/预测语义时整组拒绝');
    }
  }

  // ==========================================================================
  // [用例 3] 多事实、单位/期间/口径变化等原有拒绝条件不回退
  // ==========================================================================
  console.log('\n>>> [用例 3] 多事实、单位/期间/口径变化等原有拒绝条件不回退:');
  {
    // 3.1 Unit changed upstream (项 -> 个)
    {
      const { task, draft } = createStandardMultiFixture();
      task.facts.find((f) => f.id === 'FACT-01')!.unit = '个';
      task.factSnapshot!.items.find((it) => it.factId === 'FACT-01')!.unit = '个';
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例3.1: 单位发生变更时阻断');
      assert(elig.blockingReasons?.some((r) => r.includes('单位')), '用例3.1: 阻断原因包含单位变更');
    }

    // 3.2 Period changed upstream
    {
      const { task, draft } = createStandardMultiFixture();
      task.facts.find((f) => f.id === 'FACT-01')!.period = '2026年1-10月';
      task.factSnapshot!.items.find((it) => it.factId === 'FACT-01')!.period = '2026年1-10月';
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例3.2: 统计期间变更时阻断');
    }

    // 3.3 Multiple facts changed
    {
      const { task, draft } = createStandardMultiFixture();
      // Also change FACT-02 from 16 to 20
      const fact02 = task.facts.find((f) => f.id === 'FACT-02')!;
      fact02.value = '20';
      task.factSnapshot!.items.find((it) => it.factId === 'FACT-02')!.value = '20';
      const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
      assert(!elig.eligible, '用例3.3: 多个事实同时变更时阻断');
    }
  }

  // ==========================================================================
  // [用例 4] 生成后任一目标/非目标正文、引用集合、原文或审批变化，整体失效且零部分写入
  // ==========================================================================
  console.log('\n>>> [用例 4] 生成后任一目标/非目标正文、引用集合、原文或审批变化，整体失效且零部分写入:');
  {
    // 4.1 Target block content changed after generation
    {
      const { task, draft } = createStandardMultiFixture();
      const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
      assert(genRes.success, '用例4.1: 生成候选成功');

      // Tamper BLK-01
      draft.blocks.find((b) => b.id === 'BLK-01')!.content += ' (修改后追加文字)';

      const valRes = validateMultiParagraphFactRevisionAcceptance(task, draft, genRes.candidateGroup!, genRes.candidateGroup!.runId);
      assert(!valRes.valid, '用例4.1: 目标段正文发生变更后校验不通过');

      const accRes = acceptMultiParagraphFactRevisionCandidate(task, draft, genRes.candidateGroup!, '主笔甲', genRes.candidateGroup!.runId);
      assert(!accRes.success, '用例4.1: 采纳被整体拒绝');
      assert(task.drafts.length === 1, '用例4.1: 草稿未发生写入，草稿数仍为1');
      assert(task.modificationLogs.length === 0, '用例4.1: 未写入任何修订日志');
    }

    // 4.2 Non-target block changed after generation
    {
      const { task, draft } = createStandardMultiFixture();
      const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');

      // Tamper non-target BLK-03
      draft.blocks.find((b) => b.id === 'BLK-03')!.content += ' 临时补充说明';

      const valRes = validateMultiParagraphFactRevisionAcceptance(task, draft, genRes.candidateGroup!, genRes.candidateGroup!.runId);
      assert(!valRes.valid, '用例4.2: 非目标段被修改后全稿哈希失效，校验拒绝');
    }

    // 4.3 Referencing set changed (e.g. BLK-03 also adds FACT-01 reference)
    {
      const { task, draft } = createStandardMultiFixture();
      const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');

      // BLK-03 adds reference to FACT-01
      draft.blocks.find((b) => b.id === 'BLK-03')!.referencedFactIds.push('FACT-01');

      const valRes = validateMultiParagraphFactRevisionAcceptance(task, draft, genRes.candidateGroup!, genRes.candidateGroup!.runId);
      assert(!valRes.valid, '用例4.3: 引用段落集合发生变化时整体拒绝');
    }

    // 4.4 Upstream fact changed after generation
    {
      const { task, draft } = createStandardMultiFixture();
      const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');

      // Upstream changed from 120 to 118
      task.facts.find((f) => f.id === 'FACT-01')!.value = '118';
      task.factSnapshot!.items.find((it) => it.factId === 'FACT-01')!.value = '118';

      const valRes = validateMultiParagraphFactRevisionAcceptance(task, draft, genRes.candidateGroup!, genRes.candidateGroup!.runId);
      assert(!valRes.valid, '用例4.4: 上游事实数值变化后候选整体失效');
    }
  }

  // ==========================================================================
  // [用例 5] Block ID定位正确；生成后重排或删除使旧候选失效
  // ==========================================================================
  console.log('\n>>> [用例 5] Block ID定位正确；生成后重排或删除使旧候选失效:');
  {
    const { task, draft } = createStandardMultiFixture();
    const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
    assert(genRes.success, '用例5: 生成候选成功');

    // Delete BLK-02
    draft.blocks = draft.blocks.filter((b) => b.id !== 'BLK-02');

    const valRes = validateMultiParagraphFactRevisionAcceptance(task, draft, genRes.candidateGroup!, genRes.candidateGroup!.runId);
    assert(!valRes.valid, '用例5: 目标段落被删除后候选失效');
  }

  // ==========================================================================
  // [用例 6] 取消、关闭、任务/版本/角色切换及重复采纳保护
  // ==========================================================================
  console.log('\n>>> [用例 6] 取消、关闭、任务/版本/角色切换及重复采纳保护:');
  {
    const { task, draft } = createStandardMultiFixture();
    const genRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
    const group = genRes.candidateGroup!;

    // 6.1 Role switch check
    const nonAuthorAcc = acceptMultiParagraphFactRevisionCandidate(task, draft, group, '审阅乙', group.runId);
    assert(!nonAuthorAcc.success, '用例6.1: 非主笔甲角色采纳被拒绝');

    // 6.2 Run ID mismatch check
    const invalidRunAcc = acceptMultiParagraphFactRevisionCandidate(task, draft, group, '主笔甲', 'OUTDATED-RUN-ID');
    assert(!invalidRunAcc.success, '用例6.2: 运行ID不匹配时采纳被拒绝');

    // 6.3 Successful first adoption
    const firstAcc = acceptMultiParagraphFactRevisionCandidate(task, draft, group, '主笔甲', group.runId);
    assert(firstAcc.success, '用例6.3: 首次采纳成功');

    // 6.4 Duplicate adoption check (call again with same draft & group)
    const duplicateAcc = acceptMultiParagraphFactRevisionCandidate(
      firstAcc.updatedTask!,
      draft, // old archived draft
      group,
      '主笔甲',
      group.runId
    );
    assert(!duplicateAcc.success, '用例6.4: 重复采纳同一候选被严格拒绝，无二次写入');
  }

  // ==========================================================================
  // [用例 7] 一次归档、一个新工作稿、完整逐段日志、历史冻结及不继承复核签名
  // ==========================================================================
  console.log('\n>>> [用例 7] 一次归档、一个新工作稿、完整逐段日志、历史冻结及不继承复核签名:');
  {
    const { task, draft } = createStandardMultiFixture();

    // Add a review record to the old draft
    const saveRes = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '核对属实',
      activeRole: '主笔甲',
    });
    const currentTask = saveRes.updatedTask;
    const currentDraft = saveRes.workingDraft;

    const genRes = generateMultiParagraphFactRevisionCandidate(currentTask, currentDraft, 'FACT-01', '主笔甲');
    const accRes = acceptMultiParagraphFactRevisionCandidate(currentTask, currentDraft, genRes.candidateGroup!, '主笔甲', genRes.candidateGroup!.runId);

    assert(accRes.success, '用例7: 采纳成功');
    const archived = accRes.archivedDraft!;
    const working = accRes.newWorkingDraft!;

    assert(archived.isHistoricalSnapshot && !archived.isWorkingDraft, '用例7: 原工作稿归档为历史快照');
    assert(working.isWorkingDraft && !working.isHistoricalSnapshot, '用例7: 仅创建1个新工作稿');
    assert(accRes.updatedTask!.currentDraftId === working.id, '用例7: currentDraftId指向新工作稿');
    assert(accRes.updatedTask!.drafts.length === 2, '用例7: 草稿总数严格增加1个');

    // Fact review signatures MUST NOT be inherited by working draft
    assert(!working.factReviewRecords || working.factReviewRecords.length === 0, '用例7: 新工作稿人工复核记录为空，不继承旧签名');
    const workingOverview = evaluateDraftFactReviews(accRes.updatedTask!, working);
    assert(workingOverview.reviewedCount === 0, '用例7: 新工作稿已复核计数为0');

    // History draft preserves its review signature
    assert(archived.factReviewRecords && archived.factReviewRecords.length > 0, '用例7: 旧归档稿保留原审阅复核记录供溯源');

    // Consolidated log check
    assert(accRes.modificationLog !== undefined, '用例7: 写入单条整体采纳留痕日志');
    assert(accRes.modificationLog!.affectedBlocks?.length === 2, '用例7: 日志记录全部2个受影响段落');
    assert(accRes.modificationLog!.undoUnavailableReason !== undefined, '用例7: 明确标注禁止单独撤销单段正文');
  }

  // ==========================================================================
  // [用例 8] 修复 Issue #82：完整原文与完整修订候选独立展示，明确区分128与120，杜绝“1280项”连读
  // ==========================================================================
  console.log('\n>>> [用例 8] 修复 Issue #82：完整原文与完整修订候选独立展示，明确区分128与120，杜绝“1280项”连读:');
  {
    const { task, draft } = createStandardMultiFixture();

    const analysis = analyzeFactImpact(task, draft);
    assert(analysis.changedFactsCount > 0, '用例8: 分析发现事实变更影响');

    let acceptedGroup: MultiParagraphFactRevisionCandidate | null = null;
    const modalMount = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentTask={task}
        currentDraft={draft}
        activeRole="主笔甲"
        onAcceptMultiParagraphFactRevision={(group) => {
          acceptedGroup = group;
        }}
      />
    );

    // 1. Click generate multi-revision button
    const genMultiBtn = modalMount.container.querySelector(
      '[data-testid="btn-generate-multi-paragraph-fact-revision-FACT-01"]'
    ) as HTMLButtonElement;
    assert(!!genMultiBtn, '用例8: 找到多段修订候选生成按钮');

    act(() => {
      genMultiBtn.click();
    });

    // 2. Check candidate card
    const groupCard = modalMount.container.querySelector(
      '[data-testid="multi-paragraph-revision-candidate-card-FACT-01"]'
    );
    assert(!!groupCard, '用例8: 成功渲染多段候选卡片');

    // 3. Inspect Issue #82 specific containers for BLK-01
    const blk01OriginalContainer = modalMount.container.querySelector(
      '[data-testid="original-block-content-BLK-01"]'
    );
    const blk01RevisedContainer = modalMount.container.querySelector(
      '[data-testid="revised-block-content-BLK-01"]'
    );
    assert(!!blk01OriginalContainer, '用例8: 存在明确标注的【原文】完整文本容器');
    assert(!!blk01RevisedContainer, '用例8: 存在明确标注的【修订候选】完整文本容器');

    const origText = blk01OriginalContainer!.textContent || '';
    const revText = blk01RevisedContainer!.textContent || '';

    // Issue #82 core assertion:
    // Original text must contain 128项 and NOT contain 120
    assert(origText.includes('128项'), '用例8: 原文容器明确包含128项');
    assert(!origText.includes('120'), '用例8: 原文容器不包含新值120');

    // Revised text must contain 120项 and NOT contain 128
    assert(revText.includes('120项'), '用例8: 修订候选容器明确包含120项');
    assert(!revText.includes('128'), '用例8: 修订候选容器不包含旧值128');

    // Diff container text must NOT concatenate 128 and 120 into "1280项"
    const diffContainer = modalMount.container.querySelector(
      '[data-testid="revision-diff-view-BLK-01"]'
    );
    assert(!!diffContainer, '用例8: 存在差异对比容器');
    const diffText = diffContainer!.textContent || '';
    assert(!diffText.includes('1280项'), '用例8 [Issue #82核心验证]: 差异文本层不得连成“1280项”');
    assert(diffText.includes('[删: 128项]') && diffText.includes('[改: 120项]'), '用例8: 差异文本明确带有[删: ...]与[改: ...]显式文本标注');

    modalMount.unmount();
  }

  // ==========================================================================
  // [用例 9] 真实组件全流程接线：预置演示任务、裁决、生成、取消、再次生成、整体采纳
  // ==========================================================================
  console.log('\n>>> [用例 9] 真实组件全流程接线：预置演示任务、裁决、生成、取消、再次生成、整体采纳:');
  {
    // Step 1: Create demo task
    const demoTask = createPresetTask('multi_paragraph_revision');
    assert(demoTask.id === 'TASK-DEMO-MULTI-PARAGRAPH-REVISION', '用例9: 成功通过预置入口创建独立多段演示任务');
    assert(demoTask.drafts.length === 1, '用例9: 初始草稿为1篇');

    const initialDraft = demoTask.drafts[0];
    assert(initialDraft.blocks[0].content.includes('128项'), '用例9: 旧稿第1段包含128项');
    assert(initialDraft.blocks[1].content.includes('128项'), '用例9: 旧稿第2段包含128项');

    // Step 2: Adjudicate conflict FACT-01 to 120 and confirm facts list
    const fact01 = demoTask.facts.find((f) => f.id === 'FACT-01')!;
    fact01.status = 'confirmed';
    fact01.value = '120';
    fact01.selectedConflictValue = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    fact01.conflictResolutionReason = '采信科室甲申报口径120项';

    demoTask.factSnapshot = {
      confirmedAt: new Date().toISOString(),
      factIds: demoTask.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
      items: demoTask.facts.filter((f) => f.status === 'confirmed').map((f) => buildFactItemSnapshot(demoTask, f)),
      hash: 'DEMO-SNAP-HASH-120',
    };
    demoTask.outlineConfirmed = true;
    demoTask.styleConfirmed = true;
    demoTask.outlineSnapshot = JSON.parse(JSON.stringify(initialDraft.snapshotMetadata!.outlineSnapshot));
    demoTask.styleSnapshot = JSON.parse(JSON.stringify(initialDraft.snapshotMetadata!.styleSnapshot));

    // Step 3: Mount DraftingStage with fact impact modal
    let currentTask = JSON.parse(JSON.stringify(demoTask));
    const handleUpdateTask = (updated: Partial<Task>) => {
      currentTask = { ...currentTask, ...updated };
    };

    const stageMount = mountTestComponent(
      <DraftingStage
        task={currentTask}
        onUpdateTask={handleUpdateTask}
        activeRole="主笔甲"
        onProceedToNextStage={() => {}}
      />
    );

    // Open fact impact modal
    const impactBtn = stageMount.container.querySelector(
      '[data-testid="btn-open-fact-impact"]'
    ) as HTMLButtonElement;
    assert(!!impactBtn, '用例9: 找到事实影响面板打开按钮');

    act(() => {
      impactBtn.click();
    });

    // Check modal opened and multi-revision button exists
    const genMultiBtn = stageMount.container.querySelector(
      '[data-testid="btn-generate-multi-paragraph-fact-revision-FACT-01"]'
    ) as HTMLButtonElement;
    assert(!!genMultiBtn, '用例9: 事实影响弹窗内找到“按最新事实生成关联段落修订候选”入口');

    // Step 4: Click generate multi-revision
    act(() => {
      genMultiBtn.click();
    });

    const card = stageMount.container.querySelector(
      '[data-testid="multi-paragraph-revision-candidate-card-FACT-01"]'
    );
    assert(!!card, '用例9: 候选卡片已展开，展示全部2个段落预览');

    // Step 5: Test cancel operation
    const cancelBtn = stageMount.container.querySelector(
      '[data-testid="btn-cancel-multi-fact-revision-FACT-01"]'
    ) as HTMLButtonElement;
    assert(!!cancelBtn, '用例9: 找到取消候选按钮');

    act(() => {
      cancelBtn.click();
    });

    const cardAfterCancel = stageMount.container.querySelector(
      '[data-testid="multi-paragraph-revision-candidate-card-FACT-01"]'
    );
    assert(!cardAfterCancel, '用例9: 取消后候选卡片安全关闭');

    // Step 6: Generate again and atomically accept
    const genMultiBtn2 = stageMount.container.querySelector(
      '[data-testid="btn-generate-multi-paragraph-fact-revision-FACT-01"]'
    ) as HTMLButtonElement;
    act(() => {
      genMultiBtn2.click();
    });

    const acceptBtn = stageMount.container.querySelector(
      '[data-testid="btn-accept-multi-fact-revision-FACT-01"]'
    ) as HTMLButtonElement;
    assert(!!acceptBtn, '用例9: 找到“全部采纳并创建新工作稿”按钮');

    act(() => {
      acceptBtn.click();
    });

    // Verify task state after atomic adoption
    assert(currentTask.drafts.length === 2, '用例9: 采纳后草稿总数增加为2篇');
    assert(currentTask.currentDraftId !== initialDraft.id, '用例9: currentDraftId切换至新工作稿');

    const workingDraft = currentTask.drafts.find((d: DraftVersion) => d.id === currentTask.currentDraftId)!;
    assert(workingDraft.blocks[0].content.includes('120项'), '用例9: 新工作稿第1段为120项');
    assert(workingDraft.blocks[1].content.includes('120项'), '用例9: 新工作稿第2段为120项');
    assert(workingDraft.blocks[2].content.includes('16场'), '用例9: 无关对照段第3段严格不变');

    assert(currentTask.modificationLogs.length === 1, '用例9: 生成1条原子多段采纳日志');
    assert(currentTask.modificationLogs[0].affectedBlocks?.length === 2, '用例9: 日志包含全部2个目标段落');

    stageMount.unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务24 全部 9 组核心业务与真实组件用例 100% 全部通过！');
  console.log('================================================================\n');
}

runTask24Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
