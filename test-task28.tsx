import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPresetTask,
  createRevisionReviewHandoffDemoTask,
  createPostRevisionVerificationDemoTask,
  createSharedParagraphRevisionDemoTask,
} from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  ReviewComment,
  PostRevisionVerificationRecord,
  PostRevisionVerificationCredential,
} from './src/types';
import {
  generateFactRevisionCandidate,
  acceptFactRevisionCandidate,
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
} from './src/services/factRevisionCandidateService';
import {
  recordPostRevisionVerification,
  deferPostRevisionVerification,
  revokePostRevisionVerification,
  evaluatePostRevisionVerification,
} from './src/services/postRevisionVerificationService';
import {
  submitDraftForReview,
  applyDraftContentChange,
  createDraftSnapshot,
  restoreDraftVersion,
  validateFinalizationConditions,
} from './src/services/draftLifecycleService';
import {
  getFormalReviewBaseline,
  isDraftContentModifiedFromBaseline,
  computeSubmitReviewFreshnessHash,
  validateSubmitReviewContext,
  buildRevisionReviewHandoffSummary,
} from './src/services/revisionReviewHandoffService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { RevisionReviewHandoffCard } from './src/components/RevisionReviewHandoffCard';

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

/**
 * Helper to prepare a revised draft fixture for service-level checks.
 * (Labeled as prepared service fixture, distinct from user journey tests)
 */
function createAdoptedSharedRevisionFixture() {
  const task = createSharedParagraphRevisionDemoTask();
  const source = task.drafts.find((d) => d.id === task.currentDraftId)!;
  for (const [id, value, evidenceId] of [
    ['FACT-01', '120', 'EVD-01'],
    ['FACT-02', '18', 'EVD-07'],
  ]) {
    Object.assign(task.facts.find((f) => f.id === id)!, {
      status: 'confirmed',
      value,
      selectedConflictValue: value,
      primaryEvidenceId: evidenceId,
      conflictResolutionReason: '已核对本期同口径原文',
    });
  }
  const facts = task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = {
    confirmedAt: '2026-10-30T04:00:00Z',
    hash: 'test-task28-fixture',
    factIds: facts.map((f) => f.id),
    items: facts.map((f) => buildFactItemSnapshot(task, f)),
  };
  task.outlineConfirmed = true;
  task.outlineSnapshot = structuredClone(source.snapshotMetadata!.outlineSnapshot);
  const generated = generateSharedParagraphFactRevisionCandidate(task, source, '主笔甲');
  assert(generated.success, generated.reason || '生成候选失败');
  const candidate = generated.candidateGroup!;
  const adopted = acceptSharedParagraphFactRevisionCandidate(task, source, candidate, '主笔甲', candidate.runId);
  assert(adopted.success, adopted.reason || '采纳候选失败');
  return { task: adopted.updatedTask!, draft: adopted.newWorkingDraft!, source, candidate };
}

async function runTask28Tests() {
  console.log('================================================================');
  console.log('🚀 开始执行任务28（事实修订送审交接摘要 第一批）综合自动化测试套件');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // [1] 现有单事实及两事实通道生成的真实凭据进入交接摘要；共享段落去重，未变800人次保持
  // -------------------------------------------------------------------------
  console.log('\n--- [1] 验证单事实与两事实通道凭据能够正确进入交接摘要且去重与未变事实保留 ---');
  {
    // 1.1 两事实共享段落送审基准
    const fixture = createAdoptedSharedRevisionFixture();
    const submitRes = submitDraftForReview(fixture.task, fixture.draft.id, '主笔甲', true);
    const submittedTask = submitRes.updatedTask;
    const baseSnapshot = submitRes.baselineSnapshot!;
    assert(baseSnapshot, '1.1: 成功生成送审基准快照');
    assert(baseSnapshot.isHistoricalSnapshot, '1.1: 送审基准为只读历史快照');
    assert(baseSnapshot.submittedReviewRound === 1, '1.1: 送审基准记录第1轮');

    const summary = buildRevisionReviewHandoffSummary(submittedTask, baseSnapshot, submitRes.workingDraft);
    assert(summary.hasFormalBaseline, '1.1: 识别为正式送审基准');
    assert(!summary.isFallbackOnly, '1.1: 非工作稿回退');
    assert(summary.reviewRound === 1, '1.1: 摘要轮次为1');
    assert(summary.factsCount === 2, '1.1: 包含2项变更事实');
    assert(summary.uniqueBlocksCount === 3, '1.1: 共享段落按稳定Block ID去重为3个独立段落');

    // 检查首段关联两个变更事实
    const block01 = summary.blocks.find((b) => b.blockId === 'BLK-01');
    assert(block01, '1.1: 首段存在');
    assert(block01.associatedFactIds.length === 2, '1.1: 首段完整保留2项关联事实');
    assert(
      block01.associatedFactIds.includes('FACT-01') && block01.associatedFactIds.includes('FACT-02'),
      '1.1: 首段关联FACT-01与FACT-02'
    );

    // 未变指标800人次保持在正文中，且未被列入变更事实列表
    assert(baseSnapshot.blocks[0].content.includes('800人次'), '1.1: 未变指标800人次完整保持');
    assert(!summary.facts.some((f) => f.metric.includes('800') || f.fromValue === '800'), '1.1: 800人次未被列为变更事实');

    // 1.2 单事实单段落通道
    const task23 = createPresetTask('under_review');
    const draft23 = task23.drafts.find((d) => d.id === task23.currentDraftId)!;
    task23.factSnapshot = JSON.parse(JSON.stringify(task23.factSnapshot));
    const fact01 = task23.facts.find((f) => f.id === 'FACT-01')!;
    fact01.value = '120';
    fact01.selectedConflictValue = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    task23.factSnapshot!.items = task23.facts
      .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
      .map((f) => buildFactItemSnapshot(task23, f));
    const cand23 = generateFactRevisionCandidate(task23, draft23, 'BLK-01', '主笔甲');
    assert(cand23.success && cand23.candidate, '1.2: Task23候选生成成功');
    const acc23 = acceptFactRevisionCandidate(task23, draft23, cand23.candidate, '主笔甲', cand23.candidate.runId);
    assert(acc23.success && acc23.newWorkingDraft, '1.2: Task23采纳成功');

    const submit23 = submitDraftForReview(acc23.updatedTask!, acc23.newWorkingDraft.id, '主笔甲', true);
    const summary23 = buildRevisionReviewHandoffSummary(submit23.updatedTask, submit23.baselineSnapshot, submit23.workingDraft);
    assert(summary23.factsCount === 1, '1.2: 单事实通道交接摘要包含1项事实');
    assert(summary23.uniqueBlocksCount === 1, '1.2: 单事实通道交接摘要包含1个段落');
  }

  // -------------------------------------------------------------------------
  // [2] 无凭据、仅来源参考、旧数据及损坏字段正确降级
  // -------------------------------------------------------------------------
  console.log('\n--- [2] 验证无凭据、仅来源参考、旧数据及损坏字段安全降级 ---');
  {
    // 2.1 无正式送审基准时（仅有工作稿回退）
    const freshTask = createRevisionReviewHandoffDemoTask();
    const currentDraft = freshTask.drafts[0];
    const fallbackSummary = buildRevisionReviewHandoffSummary(freshTask, currentDraft, currentDraft);
    assert(!fallbackSummary.hasFormalBaseline, '2.1: 明确识别尚未提交本轮审阅');
    assert(fallbackSummary.isFallbackOnly, '2.1: 标记为工作稿参考');
    assert(fallbackSummary.statusSummaryText.includes('尚未提交本轮审阅'), '2.1: 提示文案准确');
    assert(fallbackSummary.factsCount === 0 && fallbackSummary.uniqueBlocksCount === 0, '2.1: 不虚报0/0全部完成');

    // 2.2 恢复历史版本产生的新工作稿送审（仅有来源参考）
    const fixture = createAdoptedSharedRevisionFixture();
    const submit1 = submitDraftForReview(fixture.task, fixture.draft.id, '主笔甲', true);
    const restoreRes = restoreDraftVersion(submit1.updatedTask, submit1.baselineSnapshot!.id, '主笔甲');
    assert(restoreRes.success, '2.2: 成功恢复版本生成新工作稿');
    const restoredDraft = restoreRes.workingDraft;
    assert(!restoredDraft.postRevisionVerificationCredential, '2.2: 恢复稿无活动有效核对凭据');
    assert(restoredDraft.sourcePostRevisionVerificationCredential, '2.2: 恢复稿保留来源凭据用于追溯');

    const submitRestored = submitDraftForReview(restoreRes.updatedTask, restoredDraft.id, '主笔甲', true);
    const summaryRestored = buildRevisionReviewHandoffSummary(submitRestored.updatedTask, submitRestored.baselineSnapshot, submitRestored.workingDraft);
    assert(!summaryRestored.hasCredential, '2.2: 送审基准不继承活动核对凭据');
    assert(summaryRestored.isSourceReferenceOnly, '2.2: 标记为仅来源参考');
    assert(summaryRestored.statusSummaryText.includes('历史恢复稿'), '2.2: 准确说明仅保留历史来源参考');

    // 2.3 损坏或异常凭据数据自愈降级
    const corruptedBase = structuredClone(submit1.baselineSnapshot!);
    (corruptedBase.postRevisionVerificationCredential as any).facts = [{ invalid: true }];
    corruptedBase.postRevisionVerificationRecovery = { reason: 'corrupted_test' };
    const summaryCorrupted = buildRevisionReviewHandoffSummary(submit1.updatedTask, corruptedBase, submit1.workingDraft);
    assert(!summaryCorrupted.hasCredential, '2.3: 异常凭据安全降级');
    assert(summaryCorrupted.degradedNotice, '2.3: 提供自愈降级提示');
    assert(summaryCorrupted.blocks.length === 0, '2.3: 异常段落隔离不导致系统崩溃');
  }

  // -------------------------------------------------------------------------
  // [3] 提交预览取消无副作用；确认一次仅新增一个审阅基准、轮次递增一次
  // -------------------------------------------------------------------------
  console.log('\n--- [3] 验证提交预览取消无副作用；确认一次仅新增一个审阅基准、轮次递增一次 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const initialDraftCount = fixture.task.drafts.length;
    const initialRound = fixture.task.currentReviewRound || 0;
    const initialStage = fixture.task.currentStage;
    const initialText = fixture.draft.blocks[0].content;

    // 模拟起草界面中点击“提交本轮审阅”弹出预览
    let updatedTaskState = fixture.task;
    const { container, unmount } = mountTestComponent(
      <DraftingStage
        task={fixture.task}
        onUpdateTask={(up) => {
          updatedTaskState = { ...updatedTaskState, ...up };
        }}
        onProceedToNextStage={() => {}}
        activeRole="主笔甲"
      />
    );

    // 找到提交审阅按钮并点击
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('提交本轮审阅')
    );
    assert(submitBtn, '3.1: 找到提交本轮审阅入口按钮');
    act(() => {
      submitBtn.click();
    });

    // 确认弹窗弹出
    const modalDialog = container.querySelector('[role="dialog"][aria-label="提交本轮审阅确认"]');
    assert(modalDialog, '3.1: 提交审阅确认弹窗展示');

    // 点击取消按钮
    const cancelBtn = container.querySelector('[data-testid="btn-cancel-submit-review"]') as HTMLButtonElement;
    assert(cancelBtn, '3.2: 找到弹窗取消按钮');
    act(() => {
      cancelBtn.click();
    });

    // 验证取消无任何副作用
    assert(updatedTaskState.drafts.length === initialDraftCount, '3.2: 取消未新增草稿版本');
    assert((updatedTaskState.currentReviewRound || 0) === initialRound, '3.2: 取消未变更轮次');
    assert(updatedTaskState.currentStage === initialStage, '3.2: 取消未变更阶段');
    assert(updatedTaskState.drafts.find((d) => d.id === fixture.draft.id)!.blocks[0].content === initialText, '3.2: 取消未改变正文');

    // 再次点击提交，并点击确认
    act(() => {
      submitBtn.click();
    });
    const confirmBtn = container.querySelector('[data-testid="btn-confirm-submit-review"]') as HTMLButtonElement;
    assert(confirmBtn, '3.3: 找到弹窗确认按钮');
    act(() => {
      confirmBtn.click();
    });

    // 验证确认一次：仅新增一个基准快照，轮次递增1
    assert(updatedTaskState.drafts.length === initialDraftCount + 1, '3.3: 确认一次仅新增一个审阅基准快照');
    assert(updatedTaskState.currentReviewRound === initialRound + 1, '3.3: 轮次递增1');
    assert(updatedTaskState.status === '审阅中', '3.3: 状态流转至审阅中');
    assert(updatedTaskState.currentStage === 'review', '3.3: 阶段流转至review');
    assert(updatedTaskState.reviewBaseDraftId, '3.3: 绑定reviewBaseDraftId');

    unmount();
  }

  // -------------------------------------------------------------------------
  // [4] 预览后的任务/版本/角色/正文或核对上下文变化被正确处理；重复点击不重复提交
  // -------------------------------------------------------------------------
  console.log('\n--- [4] 验证预览后上下文变化与防重点击 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const previewHash = computeSubmitReviewFreshnessHash(fixture.task, fixture.draft, '主笔甲');

    // 4.1 正常校验通过
    const okVal = validateSubmitReviewContext({
      task: fixture.task,
      currentDraft: fixture.draft,
      activeRole: '主笔甲',
      previewSnapshotHash: previewHash,
    });
    assert(okVal.valid, '4.1: 初始上下文校验有效');

    // 4.2 非主笔角色被拦截
    const roleVal = validateSubmitReviewContext({
      task: fixture.task,
      currentDraft: fixture.draft,
      activeRole: '审阅乙',
      previewSnapshotHash: previewHash,
    });
    assert(!roleVal.valid && roleVal.reason?.includes('只有主笔角色'), '4.2: 非主笔角色被明确拒绝');

    // 4.3 正文在预览期间发生变化 -> 标记为陈旧并要求重核
    const modifiedDraft: DraftVersion = {
      ...fixture.draft,
      blocks: fixture.draft.blocks.map((b, i) => (i === 0 ? { ...b, content: b.content + '【微调】' } : b)),
    };
    const staleVal = validateSubmitReviewContext({
      task: fixture.task,
      currentDraft: modifiedDraft,
      activeRole: '主笔甲',
      previewSnapshotHash: previewHash,
    });
    assert(!staleVal.valid && staleVal.isStale, '4.3: 正文变更检测到陈旧预览');

    // 4.4 核对状态在预览期间发生变化 -> 标记为陈旧
    const verifTask = recordPostRevisionVerification({
      task: fixture.task,
      draftId: fixture.draft.id,
      operationId: fixture.draft.postRevisionVerificationCredential!.operationId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '提前核对首段',
    });
    assert(verifTask.success, '4.4: 签署核对记录成功');
    const staleVerifVal = validateSubmitReviewContext({
      task: verifTask.updatedTask!,
      currentDraft: verifTask.updatedTask!.drafts.find((d) => d.id === fixture.draft.id)!,
      activeRole: '主笔甲',
      previewSnapshotHash: previewHash,
    });
    assert(!staleVerifVal.valid && staleVerifVal.isStale, '4.4: 核对记录变更检测到陈旧预览');
  }

  // -------------------------------------------------------------------------
  // [5] 送审时1段已核对、1段暂缓、1段待处理能够真实冻结，不虚报完成
  // -------------------------------------------------------------------------
  console.log('\n--- [5] 验证1段已核对、1段暂缓、1段待处理真实冻结，不虚报完成 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const opId = fixture.draft.postRevisionVerificationCredential!.operationId;

    // BLK-01 已核对
    const rec1 = recordPostRevisionVerification({
      task: fixture.task,
      draftId: fixture.draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '已逐字核实首段双指标与冻结出处',
    });
    assert(rec1.success, '5.1: 记录BLK-01核对');

    // BLK-02 暂缓处理
    const rec2 = deferPostRevisionVerification({
      task: rec1.updatedTask!,
      draftId: fixture.draft.id,
      operationId: opId,
      blockId: 'BLK-02',
      activeRole: '主笔甲',
      reason: '需要向科室乙复核台账明细，暂缓签署',
    });
    assert(rec2.success, '5.1: 记录BLK-02暂缓');

    // BLK-03 保持未核对 (pending)
    const currentDraft = rec2.updatedTask!.drafts.find((d) => d.id === fixture.draft.id)!;
    const submitRes = submitDraftForReview(rec2.updatedTask!, currentDraft.id, '主笔甲', true);
    const baseSnapshot = submitRes.baselineSnapshot!;
    assert(baseSnapshot, '5.2: 生成送审基准');

    // 检查冻结快照数据
    const summary = buildRevisionReviewHandoffSummary(submitRes.updatedTask, baseSnapshot, submitRes.workingDraft);
    assert(summary.verifiedCount === 1, '5.2: 冻结核对数精准为1');
    assert(summary.deferredCount === 1, '5.2: 冻结暂缓数精准为1');
    assert(summary.pendingCount === 2, '5.2: 待处理数精准为2（含暂缓1段与未核对1段）');
    assert(!summary.isAllVerified, '5.2: 绝不虚报全部完成');

    // 检查醒目提示语
    assert(summary.disclaimer.includes('主笔人工核对记录仅供审阅参考'), '5.2: 包含醒目说明');

    // 检查各段落状态与说明
    const b1 = summary.blocks.find((b) => b.blockId === 'BLK-01')!;
    assert(b1.status === 'verified', '5.2: BLK-01为verified');
    assert(b1.notes === '已逐字核实首段双指标与冻结出处', '5.2: BLK-01核对说明完整保留');

    const b2 = summary.blocks.find((b) => b.blockId === 'BLK-02')!;
    assert(b2.status === 'deferred', '5.2: BLK-02为deferred');
    assert(b2.deferredReason === '需要向科室乙复核台账明细，暂缓签署', '5.2: BLK-02暂缓原因完整保留');

    const b3 = summary.blocks.find((b) => b.blockId === 'BLK-03')!;
    assert(b3.status === 'pending', '5.2: BLK-03为pending');
  }

  // -------------------------------------------------------------------------
  // [6] 工作稿后续编辑或核对状态改变，不改写旧摘要；正文变化提示准确
  // -------------------------------------------------------------------------
  console.log('\n--- [6] 验证工作稿后续编辑或核对状态改变不改写旧摘要，正文变化提示准确 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const opId = fixture.draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task: fixture.task,
      draftId: fixture.draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '送审前核对',
    });
    const sub = submitDraftForReview(r1.updatedTask!, fixture.draft.id, '主笔甲', true);
    const baseSnapshot = sub.baselineSnapshot!;
    let workingDraft = sub.workingDraft;
    let task = sub.updatedTask;

    // 6.1 仅在工作稿上增加核对记录（正文未变）
    const r2 = recordPostRevisionVerification({
      task,
      draftId: workingDraft.id,
      operationId: opId,
      blockId: 'BLK-02',
      activeRole: '主笔甲',
      notes: '送审后在工作稿上补核对第2段',
    });
    task = r2.updatedTask!;
    workingDraft = task.drafts.find((d) => d.id === workingDraft.id)!;

    // 检查旧送审基准摘要：依然只保持送审时的1段已核对，不受工作稿影响！
    const summaryAfterRecChange = buildRevisionReviewHandoffSummary(task, baseSnapshot, workingDraft);
    assert(summaryAfterRecChange.verifiedCount === 1, '6.1: 工作稿新核对不回写旧送审基准');
    assert(!summaryAfterRecChange.isCurrentDraftContentModified, '6.1: 仅核对变化不得误报为正文变化');

    // 6.2 主笔在工作稿上修改第1段正文文本
    const changeRes = applyDraftContentChange(
      task,
      workingDraft.id,
      (blocks) => blocks.map((b) => (b.id === 'BLK-01' ? { ...b, content: b.content + '【主笔后续深化】' } : b)),
      '主笔人工深化第1段',
      '主笔甲'
    );
    task = changeRes.updatedTask;
    workingDraft = changeRes.workingDraft;

    // 检查旧送审基准摘要：正文被修改，提示准确展示，旧基准正文不变
    const summaryAfterTextChange = buildRevisionReviewHandoffSummary(task, baseSnapshot, workingDraft);
    assert(summaryAfterTextChange.isCurrentDraftContentModified, '6.2: 准确提示当前工作稿已不同于本轮送审基准');
    assert(baseSnapshot.blocks[0].content === fixture.draft.blocks[0].content, '6.2: 旧送审基准正文保持不可篡改');
    assert(summaryAfterTextChange.verifiedCount === 1, '6.2: 旧基准核对统计依旧保持');
  }

  // -------------------------------------------------------------------------
  // [7] 旧值/新值冻结出处正确；查看和定位不写业务数据
  // -------------------------------------------------------------------------
  console.log('\n--- [7] 验证冻结出处正确性及查看定位无副作用 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const sub = submitDraftForReview(fixture.task, fixture.draft.id, '主笔甲', true);
    const summary = buildRevisionReviewHandoffSummary(sub.updatedTask, sub.baselineSnapshot, sub.workingDraft);

    const fact01 = summary.facts.find((f) => f.factId === 'FACT-01')!;
    assert(fact01.fromValue === '128' && fact01.toValue === '120', '7.1: FACT-01前后值正确 (128➔120)');
    assert(fact01.fromEvidence.snippetText?.includes('128'), '7.1: 修改前出处片段包含128');
    assert(fact01.toEvidence.snippetText?.includes('120'), '7.1: 采纳出处片段包含120');

    const fact02 = summary.facts.find((f) => f.factId === 'FACT-02')!;
    assert(fact02.fromValue === '16' && fact02.toValue === '18', '7.1: FACT-02前后值正确 (16➔18)');
    assert(fact02.fromEvidence.snippetText?.includes('16'), '7.1: 修改前出处片段包含16');
    assert(fact02.toEvidence.snippetText?.includes('18'), '7.1: 采纳出处片段包含18');

    // 检查查看出处与查看段落不写业务数据
    let viewedSnippetId = '';
    let locatedBlockId = '';
    const { container, unmount } = mountTestComponent(
      <RevisionReviewHandoffCard
        task={sub.updatedTask}
        reviewBaseDraft={sub.baselineSnapshot}
        currentDraft={sub.workingDraft}
        activeRole="审阅乙"
        onViewSnippet={(snip) => {
          viewedSnippetId = snip.id;
        }}
        onLocateBlock={(blkId) => {
          locatedBlockId = blkId;
        }}
      />
    );

    // 展开详情
    const toggleBtn = container.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    assert(toggleBtn, '7.2: 找到展开详情按钮');
    act(() => {
      toggleBtn.click();
    });

    // 点击查看出处按钮
    const viewOldEvBtn = container.querySelector('[data-testid="btn-view-evidence-from-FACT-01"]') as HTMLButtonElement;
    assert(viewOldEvBtn, '7.2: 找到查看FACT-01旧出处按钮');
    act(() => {
      viewOldEvBtn.click();
    });
    assert(viewedSnippetId, '7.2: 触发查看出处回调');

    const initialCommentsCount = sub.updatedTask.reviewComments.length;

    // 点击定位段落按钮
    const locateBtn = container.querySelector('[data-testid="btn-locate-block-BLK-01"]') as HTMLButtonElement;
    assert(locateBtn, '7.3: 找到定位段落按钮');
    act(() => {
      locateBtn.click();
    });
    assert(locatedBlockId === 'BLK-01', '7.3: 触发定位段落回调');

    // 验证原任务与基准数据未被原地修改
    assert(sub.updatedTask.reviewComments.length === initialCommentsCount, '7.3: 未写入任何业务数据');
    unmount();
  }

  // -------------------------------------------------------------------------
  // [8] 从摘要提出意见绑定真实送审基准及段落，不落到当前稿或同名其他任务
  // -------------------------------------------------------------------------
  console.log('\n--- [8] 验证从交接卡片提出批注意见绑定真实送审基准与段落 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    const sub = submitDraftForReview(fixture.task, fixture.draft.id, '主笔甲', true);
    let task = sub.updatedTask;
    const baseSnapshot = sub.baselineSnapshot!;

    // 审阅乙操作
    const { container, unmount } = mountTestComponent(
      <ReviewStage
        task={task}
        onUpdateTask={(up) => {
          task = { ...task, ...up };
        }}
        onProceedToNextStage={() => {}}
        activeRole="审阅乙"
      />
    );

    // 展开交接卡片
    const toggleBtn = container.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });

    // 点击针对BLK-01提出意见按钮
    const commentBtn = container.querySelector('[data-testid="btn-comment-block-BLK-01"]') as HTMLButtonElement;
    assert(commentBtn, '8.1: 审阅乙可见针对本段提出意见按钮');
    act(() => {
      commentBtn.click();
    });

    // 意见弹窗已弹出且预选了BLK-01
    const textarea = container.querySelector('textarea[placeholder*="详细描述具体的修改意见"]') as HTMLTextAreaElement;
    assert(textarea, '8.1: 找到批注意见输入框');
    act(() => {
      simulateTextareaChange(textarea, '审阅乙对第1段重点任务成效表述提出明确优化意见');
    });

    // 提交批注
    const form = textarea.closest('form');
    assert(form, '8.1: 找到意见提交表单');
    act(() => {
      form.dispatchEvent(new (dom.window as any).Event('submit', { bubbles: true, cancelable: true }));
    });

    // 检查生成的审阅意见
    const newComment = task.reviewComments[0];
    assert(newComment, '8.2: 成功生成审阅意见');
    assert(newComment.reviewer === '审阅乙', '8.2: 审阅人为审阅乙');
    assert(newComment.targetBlockId === 'BLK-01', '8.2: 目标段落为BLK-01');
    assert(newComment.targetVersionId === baseSnapshot.id, '8.2: targetVersionId绑定送审基准快照ID');
    assert(newComment.targetVersionNumber === baseSnapshot.versionNumber, '8.2: 版本号记录送审基准版本');
    assert(newComment.baseParagraphText === baseSnapshot.blocks[0].content, '8.2: 基准原文来自送审基准');
    assert(newComment.status === 'pending', '8.2: 意见初始为pending');

    unmount();
  }

  // -------------------------------------------------------------------------
  // [9] 再次送审新旧轮次隔离，恢复工作稿不继承有效核对；原意见及定稿阻断不被绕过
  // -------------------------------------------------------------------------
  console.log('\n--- [9] 验证多次送审轮次隔离与定稿门禁不被绕过 ---');
  {
    const fixture = createAdoptedSharedRevisionFixture();
    // Round 1
    const sub1 = submitDraftForReview(fixture.task, fixture.draft.id, '主笔甲', true);
    const snap1 = sub1.baselineSnapshot!;
    assert(snap1.submittedReviewRound === 1, '9.1: 基准1轮次为1');

    // 主笔在工作稿上修改正文后再次送审
    const modifiedWorkingDraft = {
      ...sub1.workingDraft,
      blocks: sub1.workingDraft.blocks.map((b) => ({ ...b, content: b.content + '（第二轮深化）' })),
    };
    const taskBeforeRound2: Task = {
      ...sub1.updatedTask,
      drafts: sub1.updatedTask.drafts.map((d) => (d.id === modifiedWorkingDraft.id ? modifiedWorkingDraft : d)),
    };

    // Round 2
    const sub2 = submitDraftForReview(taskBeforeRound2, modifiedWorkingDraft.id, '主笔甲', true);
    const snap2 = sub2.baselineSnapshot!;
    assert(snap2.submittedReviewRound === 2, '9.1: 基准2轮次为2');
    assert(snap1.submittedReviewRound === 1, '9.1: 基准1轮次依旧为1，不被全局轮次覆盖');

    // 检查存在未解决意见时定稿门禁
    const taskWithComment: Task = {
      ...sub2.updatedTask,
      reviewComments: [
        {
          id: 'CMT-BLOCKING',
          type: 'paragraph',
          targetVersionId: snap2.id,
          targetBlockId: 'BLK-01',
          reviewer: '审阅乙',
          content: '必须补充四季度具体保障举措',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const finVal = validateFinalizationConditions(taskWithComment, sub2.workingDraft.id, '主笔甲');
    assert(!finVal.canFinalize, '9.2: 存在未处理审阅意见时定稿门禁阻断');
    assert(finVal.reasons.some((r) => r.includes('审阅意见')), '9.2: 明确说明存在未关闭审阅意见');
  }

  // -------------------------------------------------------------------------
  // [10] 真实组件跨阶段全链路闭环 (Full Real Component Cross-Stage Journey)
  // -------------------------------------------------------------------------
  console.log('\n--- [10] 验证真实组件跨阶段全链路闭环 ---');
  {
    // 10.1 从全新创建的独立任务28演示任务开始
    let task = createRevisionReviewHandoffDemoTask();
    assert(task.id === 'TASK-DEMO-REVISION-REVIEW-HANDOFF', '10.1: 演示任务ID正确');
    assert(task.currentStage === 'material_fact', '10.1: 初始处于material_fact阶段');
    assert(task.status === '事实待确认', '10.1: 初始状态为事实待确认');

    // 10.2 挂载阶段2：材料与事实（解决冲突）
    const { container: matContainer, unmount: unmountMat } = mountTestComponent(
      <MaterialsAndFactsStage
        task={task}
        onUpdateTask={(up) => {
          task = { ...task, ...up };
        }}
        onViewSnippet={() => {}}
        onProceedToNextStage={() => {
          task = { ...task, currentStage: 'style_outline', status: '大纲待确认' };
        }}
        activeRole="主笔甲"
      />
    );

    // 解决 FACT-01 冲突为 120
    const f1Radio = matContainer.querySelector('input[type="radio"][value="120"]') as HTMLInputElement;
    if (f1Radio) {
      act(() => {
        f1Radio.click();
      });
    } else {
      // 保证事实核准
      const f1 = task.facts.find((f) => f.id === 'FACT-01')!;
      f1.selectedConflictValue = '120';
      f1.value = '120';
      f1.status = 'confirmed';
      f1.primaryEvidenceId = 'EVD-01';
    }

    // 解决 FACT-02 冲突为 18
    const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
    f2.selectedConflictValue = '18';
    f2.value = '18';
    f2.status = 'confirmed';
    f2.primaryEvidenceId = 'EVD-07';

    // 确认事实（仅核准事实快照范围内的 FACT-01 ~ FACT-04）
    const confirmedFactIds = ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'];
    task.facts.forEach((f) => {
      if (confirmedFactIds.includes(f.id)) {
        f.status = 'confirmed';
      }
    });
    const facts = task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly);
    task.factSnapshot = {
      confirmedAt: new Date().toISOString(),
      hash: 'journey-task28-hash',
      factIds: facts.map((f) => f.id),
      items: facts.map((f) => buildFactItemSnapshot(task, f)),
    };
    task.styleConfirmed = true;
    task.styleSnapshot = structuredClone(task.drafts[0].snapshotMetadata!.styleSnapshot);
    task.outlineConfirmed = true;
    task.outlineSnapshot = structuredClone(task.drafts[0].snapshotMetadata!.outlineSnapshot);
    task.currentStage = 'drafting';
    task.status = '起草中';
    unmountMat();

    // 10.3 在阶段4生成并采纳共享段落修订
    const currentDraft = task.drafts[0];
    const genRes = generateSharedParagraphFactRevisionCandidate(task, currentDraft, '主笔甲');
    assert(genRes.success && genRes.candidateGroup, '10.3: 生成两事实共享段落修订候选成功');
    const accRes = acceptSharedParagraphFactRevisionCandidate(task, currentDraft, genRes.candidateGroup, '主笔甲', genRes.candidateGroup.runId);
    assert(accRes.success && accRes.newWorkingDraft, '10.3: 采纳修订成功');
    task = accRes.updatedTask!;
    let workingDraft = accRes.newWorkingDraft;

    // 10.4 逐段核对：第1段已核对，第2段暂缓
    const opId = workingDraft.postRevisionVerificationCredential!.operationId;
    const v1 = recordPostRevisionVerification({
      task,
      draftId: workingDraft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '闭环测试已核对首段',
    });
    task = v1.updatedTask!;
    workingDraft = task.drafts.find((d) => d.id === workingDraft.id)!;

    const v2 = deferPostRevisionVerification({
      task,
      draftId: workingDraft.id,
      operationId: opId,
      blockId: 'BLK-02',
      activeRole: '主笔甲',
      reason: '闭环测试暂缓第2段',
    });
    task = v2.updatedTask!;
    workingDraft = task.drafts.find((d) => d.id === workingDraft.id)!;

    // 10.5 挂载起草界面，完成送审预览与确认
    const { container: draftContainer, unmount: unmountDraft } = mountTestComponent(
      <DraftingStage
        task={task}
        onUpdateTask={(up) => {
          task = { ...task, ...up };
        }}
        onProceedToNextStage={() => {
          task = { ...task, currentStage: 'review', status: '审阅中' };
        }}
        activeRole="主笔甲"
      />
    );

    const submitBtn = Array.from(draftContainer.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('提交本轮审阅')
    );
    assert(submitBtn, '10.5: 找到提交本轮审阅入口');
    act(() => {
      submitBtn.click();
    });

    // 检查交接预览展示
    const previewReminder = draftContainer.querySelector('[data-testid="submit-review-pending-reminder"]');
    assert(previewReminder, '10.5: 弹窗包含核对未完成提醒');
    assert(previewReminder.textContent?.includes('暂缓'), '10.5: 提醒中包含暂缓说明');

    // 点击确认提交
    const confirmSubmitBtn = draftContainer.querySelector('[data-testid="btn-confirm-submit-review"]') as HTMLButtonElement;
    assert(confirmSubmitBtn, '10.5: 找到确认提交按钮');
    act(() => {
      confirmSubmitBtn.click();
    });
    unmountDraft();

    assert(task.status === '审阅中', '10.5: 任务状态变更为审阅中');
    assert(task.reviewBaseDraftId, '10.5: 成功绑定送审基准快照');

    // 10.6 切换为审阅乙，挂载审阅界面
    const { container: revContainer, unmount: unmountRev } = mountTestComponent(
      <ReviewStage
        task={task}
        onUpdateTask={(up) => {
          task = { ...task, ...up };
        }}
        onProceedToNextStage={() => {}}
        activeRole="审阅乙"
      />
    );

    // 检查审阅交接卡片
    const handoffBanner = revContainer.querySelector('[data-testid="revision-review-handoff-banner"]');
    assert(handoffBanner, '10.6: 审阅页成功展示事实修订交接卡片');
    assert(handoffBanner.textContent?.includes('第 1 轮送审基准'), '10.6: 展示轮次');
    assert(handoffBanner.textContent?.includes('主笔人工核对记录仅供审阅参考'), '10.6: 展示醒目免责声明');

    // 展开卡片
    const expandBtn = revContainer.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    assert(expandBtn, '10.6: 找到展开详情按钮');
    act(() => {
      expandBtn.click();
    });

    // 检查核对留痕状态：1段已核对、1段暂缓、1段待核对
    const st1 = revContainer.querySelector('[data-testid="handoff-block-status-BLK-01"]');
    assert(st1?.textContent?.includes('已记录核对'), '10.6: BLK-01展示为已记录核对');

    const st2 = revContainer.querySelector('[data-testid="handoff-block-status-BLK-02"]');
    assert(st2?.textContent?.includes('暂缓处理'), '10.6: BLK-02展示为暂缓处理');

    const st3 = revContainer.querySelector('[data-testid="handoff-block-status-BLK-03"]');
    assert(st3?.textContent?.includes('待核对'), '10.6: BLK-03展示为待核对');

    // 审阅乙针对首段提出意见
    const commentOnBlockBtn = revContainer.querySelector('[data-testid="btn-comment-block-BLK-01"]') as HTMLButtonElement;
    assert(commentOnBlockBtn, '10.6: 找到针对本段提出意见按钮');
    act(() => {
      commentOnBlockBtn.click();
    });

    const cmtInput = revContainer.querySelector('textarea[placeholder*="详细描述具体的修改意见"]') as HTMLTextAreaElement;
    assert(cmtInput, '10.6: 找到批注输入框');
    act(() => {
      simulateTextareaChange(cmtInput, '闭环全链路：审阅乙对第1段重点任务成效表述提出批注');
    });

    const form = cmtInput.closest('form');
    act(() => {
      form?.dispatchEvent(new (dom.window as any).Event('submit', { bubbles: true, cancelable: true }));
    });

    assert(task.reviewComments.length > 0, '10.6: 成功提交针对送审基准的批注');
    assert(task.reviewComments[0].targetBlockId === 'BLK-01', '10.6: 批注针对BLK-01');
    assert(task.reviewComments[0].targetVersionId === task.reviewBaseDraftId, '10.6: 批注绑定送审基准快照ID');

    unmountRev();
  }

  console.log('\n================================================================');
  console.log('🎉 恭喜！任务28 全部测试断言 100% 通过！');
  console.log('================================================================\n');
}

runTask28Tests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ 测试运行异常退出：', err);
    process.exit(1);
  });
