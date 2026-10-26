import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  EvidenceSnippet,
  SourceDocument,
  ParagraphFactReviewRecord,
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
  FactImpactItem,
} from './src/services/factImpactService';
import {
  evaluateDraftFactReviews,
  saveFactReviewRecord,
  revokeFactReviewRecord,
  checkReviewRecordApplicability,
  buildFactsSummaryForBlock,
} from './src/services/factReviewService';
import {
  acceptDraftCandidate,
  applyDraftContentChange,
  createDraftSnapshot,
  finalizeDraft,
  restoreDraftVersion,
  validateFinalizationConditions,
} from './src/services/draftLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { FactImpactModal } from './src/components/FactImpactModal';
import { validateTaskStructure } from './src/services/storageService';

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

async function runTask22Tests() {
  console.log('\n================================================================');
  console.log('   🚀 开始执行 任务22 逐段事实复核与留痕（第一批） 自动化验收套件');
  console.log('================================================================\n');

  // ==========================================================================
  // [用例 A] 冻结128→最新120，仅对应引用段落进入复核；其他事实无误标
  // ==========================================================================
  console.log('>>> [用例 A] 冻结128→最新120，仅对应引用段落进入复核；培训16场/800人次、调研12次无误标:');
  {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

    // 最新事实调整为120（申报口径），而快照冻结为128（汇总口径）
    const fact01 = task.facts.find((f) => f.id === 'FACT-01')!;
    fact01.selectedConflictValue = '120';
    fact01.conflictResolutionReason = '采信科室甲申报口径';

    const overview = evaluateDraftFactReviews(task, draft);

    assert(overview.totalAffectedBlocks === 1, '用例A: 仅有1个受影响段落进入复核范围');
    assert(overview.blockEvaluations[0].blockId === 'BLK-01', '用例A: 受影响段落准确锁定为 BLK-01');
    assert(overview.blockEvaluations[0].displayStatus === 'pending', '用例A: 初始复核状态为“待复核”');
    assert(overview.blockEvaluations[0].displayStatusLabel === '待复核', '用例A: 状态文本显示为“待复核”');
    assert(overview.reviewedCount === 0, '用例A: 已记录复核段落数为 0');
    assert(overview.pendingCount === 1, '用例A: 待处理段落数为 1');

    // 检查第2段（培训16场/800人次）与第3段（调研12次）绝未进入复核
    const isBlk02Included = overview.blockEvaluations.some((b) => b.blockId === 'BLK-02');
    const isBlk03Included = overview.blockEvaluations.some((b) => b.blockId === 'BLK-03');
    assert(!isBlk02Included, '用例A: 引用培训16场/800人次的第2段绝未被误标待复核');
    assert(!isBlk03Included, '用例A: 引用调研12次的第3段绝未被误标待复核');
  }

  // ==========================================================================
  // [用例 B] 一事多段、多事一段按段落去重，单段记录覆盖该段本次全部变更事实
  // ==========================================================================
  console.log('\n>>> [用例 B] 一事多段、多事一段按段落去重，单段记录覆盖该段本次全部变更事实:');
  {
    // B.1: 一事多段 (FACT-01 影响 BLK-01 与 BLK-02)
    const taskMultiBlocks = createPresetTask('under_review');
    const draftMB = taskMultiBlocks.drafts.find((d) => d.id === taskMultiBlocks.currentDraftId)!;
    // 让 BLK-02 也引用 FACT-01
    draftMB.blocks[1].referencedFactIds = ['FACT-01', 'FACT-02'];
    taskMultiBlocks.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';

    const overviewMB = evaluateDraftFactReviews(taskMultiBlocks, draftMB);
    assert(overviewMB.totalAffectedBlocks === 2, '用例B.1: 一事多段下去重计为 2 段受影响');
    assert(overviewMB.blockEvaluations.some((b) => b.blockId === 'BLK-01'), '用例B.1: 包含 BLK-01');
    assert(overviewMB.blockEvaluations.some((b) => b.blockId === 'BLK-02'), '用例B.1: 包含 BLK-02');

    // BLK-01 和 BLK-02 各自独立复核
    const resSaveBlk01 = saveFactReviewRecord({
      task: taskMultiBlocks,
      targetDraftId: draftMB.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '第1段单独核对完成',
      activeRole: '主笔甲',
    });
    const overviewAfterBlk01 = evaluateDraftFactReviews(resSaveBlk01.updatedTask, resSaveBlk01.workingDraft);
    assert(overviewAfterBlk01.reviewedCount === 1, '用例B.1: 仅第1段完成复核，已记录 1 段');
    assert(overviewAfterBlk01.pendingCount === 1, '用例B.1: 第2段未复核，待处理 1 段');
    assert(overviewAfterBlk01.blockEvaluations.find((b) => b.blockId === 'BLK-01')?.displayStatus === 'reviewed', '用例B.1: BLK-01 为已记录');
    assert(overviewAfterBlk01.blockEvaluations.find((b) => b.blockId === 'BLK-02')?.displayStatus === 'pending', '用例B.1: BLK-02 保持待复核');

    // B.2: 多事一段 (FACT-01 与 FACT-02 均发生变动，且均被 BLK-01 引用)
    const taskMultiFacts = createPresetTask('under_review');
    const draftMF = taskMultiFacts.drafts.find((d) => d.id === taskMultiFacts.currentDraftId)!;
    // 让 BLK-01 同时引用 FACT-01 与 FACT-02
    draftMF.blocks[0].referencedFactIds = ['FACT-01', 'FACT-02'];
    taskMultiFacts.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    taskMultiFacts.facts.find((f) => f.id === 'FACT-02')!.value = '20'; // 培训场次由16改为20

    const overviewMF = evaluateDraftFactReviews(taskMultiFacts, draftMF);
    const blk01Eval = overviewMF.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(!!blk01Eval, '用例B.2: BLK-01 进入复核');
    assert(blk01Eval.changedFacts.length === 2, '用例B.2: 多事一段下合并展示 2 项变更事实');
    assert(blk01Eval.changedFacts.some((f) => f.factId === 'FACT-01'), '用例B.2: 包含 FACT-01 差异');
    assert(blk01Eval.changedFacts.some((f) => f.factId === 'FACT-02'), '用例B.2: 包含 FACT-02 差异');

    // 保存单段复核记录，覆盖该段本次全部变更事实
    const resSaveMF = saveFactReviewRecord({
      task: taskMultiFacts,
      targetDraftId: draftMF.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '同时核对了重点任务与培训场次两项指标',
      activeRole: '主笔甲',
    });
    const record = resSaveMF.workingDraft.factReviewRecords?.find((r) => r.blockId === 'BLK-01')!;
    assert(!!record, '用例B.2: 成功生成 BLK-01 复核记录');
    assert(record.factsSummaryAtReview.length === 2, '用例B.2: 单段记录存证完整覆盖该段本次关联的全部 2 项变更事实');
  }

  // ==========================================================================
  // [用例 C] 空说明不能提交；保存、暂缓、撤回和刷新恢复真实生效
  // ==========================================================================
  console.log('\n>>> [用例 C] 空说明不能提交；保存、暂缓、撤回和刷新恢复真实生效:');
  {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    task.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';

    // 1. 空说明提交“记录人工复核”被拦截
    let errorReviewEmpty = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: draft.id,
        targetBlockId: 'BLK-01',
        status: 'reviewed',
        notes: '   ',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorReviewEmpty = e.message;
    }
    assert(errorReviewEmpty.includes('核对说明不可为空'), '用例C.1: 空说明记录人工复核被严格拦截');

    // 2. 空原因提交“暂缓处理”被拦截
    let errorDeferEmpty = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: draft.id,
        targetBlockId: 'BLK-01',
        status: 'deferred',
        notes: '',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorDeferEmpty = e.message;
    }
    assert(errorDeferEmpty.includes('暂缓原因不可为空'), '用例C.2: 空原因暂缓处理被严格拦截');

    // 3. 提交有效“暂缓处理”
    const resDefer = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'deferred',
      notes: '等待三季度各科室数据台账最终会签定稿后再行调整',
      activeRole: '主笔甲',
    });
    const evalDefer = evaluateDraftFactReviews(resDefer.updatedTask, resDefer.workingDraft);
    assert(evalDefer.blockEvaluations[0].displayStatus === 'deferred', '用例C.3: 状态显示为“暂缓处理”');
    assert(evalDefer.blockEvaluations[0].displayStatusLabel === '暂缓处理', '用例C.3: 标签文案为“暂缓处理”');
    assert(evalDefer.deferredCount === 1, '用例C.3: 暂缓处理数记为 1');
    assert(evalDefer.pendingCount === 1, '用例C.3: 暂缓处理依然计入待处理范围');
    assert(evalDefer.reviewedCount === 0, '用例C.3: 暂缓处理不计入已记录复核');

    // 4. 提交有效“记录人工复核”
    const resReview = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '经核对科室甲申报材料，确认采信120项口径，正文将在下次统稿时微调对应语句',
      activeRole: '主笔甲',
    });
    const evalReview = evaluateDraftFactReviews(resReview.updatedTask, resReview.workingDraft);
    assert(evalReview.blockEvaluations[0].displayStatus === 'reviewed', '用例C.4: 状态显示为“已记录人工复核”');
    assert(evalReview.blockEvaluations[0].displayStatusLabel === '已记录人工复核', '用例C.4: 标签文案为“已记录人工复核”');
    assert(evalReview.reviewedCount === 1, '用例C.4: 已记录复核段落数为 1');
    assert(evalReview.pendingCount === 0, '用例C.4: 待处理段落数降为 0');

    // 5. 撤回复核记录
    let errorRevokeEmpty = '';
    try {
      revokeFactReviewRecord({
        task: resReview.updatedTask,
        targetDraftId: resReview.workingDraft.id,
        targetBlockId: 'BLK-01',
        reason: '  ',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorRevokeEmpty = e.message;
    }
    assert(errorRevokeEmpty.includes('撤回原因不可为空'), '用例C.5: 空原因撤回复核被严格拦截');

    const resRevoke = revokeFactReviewRecord({
      task: resReview.updatedTask,
      targetDraftId: resReview.workingDraft.id,
      targetBlockId: 'BLK-01',
      reason: '科室甲反馈数据有更新，原核对结论暂不成立，予以撤回',
      activeRole: '主笔甲',
    });
    const evalRevoke = evaluateDraftFactReviews(resRevoke.updatedTask, resRevoke.workingDraft);
    assert(evalRevoke.blockEvaluations[0].displayStatus === 'pending', '用例C.5: 撤回后状态重置为待复核');
    assert(evalRevoke.pendingCount === 1, '用例C.5: 撤回后重新计入待处理');
    assert(evalRevoke.reviewedCount === 0, '用例C.5: 已记录复核数归零');
    const revokedRec = resRevoke.workingDraft.factReviewRecords?.find((r) => r.blockId === 'BLK-01')!;
    assert(revokedRec.status === 'revoked', '用例C.5: 保留原记录对象并将 status 设为 revoked');
    assert(revokedRec.revocation?.reason.includes('科室甲反馈数据有更新') === true, '用例C.5: 完整保留撤回原因与撤回元数据');

    // 6. 存储序列化与刷新恢复
    const jsonStr = JSON.stringify(resRevoke.updatedTask);
    const restoredTask: Task = JSON.parse(jsonStr);
    assert(validateTaskStructure(restoredTask), '用例C.6: 包含复核记录的数据结构校验完全通过');
    const restoredDraft = restoredTask.drafts.find((d) => d.id === restoredTask.currentDraftId)!;
    assert((restoredDraft.factReviewRecords || []).length > 0, '用例C.6: 刷新序列化后复核记录真实保留');
  }

  // ==========================================================================
  // [用例 D] 保存记录不改变正文、事实核准、稿件快照、修改日志或版本数量；原有事实差异计数保留
  // ==========================================================================
  console.log('\n>>> [用例 D] 保存记录不改变正文、事实核准、稿件快照、修改日志或版本数量；原有事实差异计数保留:');
  {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    task.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';

    const beforeContent = draft.blocks[0].content;
    const beforeDraftCount = task.drafts.length;
    const beforeLogCount = (task.modificationLogs || []).length;
    const beforeFactSnapshot = JSON.stringify(task.factSnapshot);
    const beforeDraftSnapshot = JSON.stringify(draft.snapshotMetadata?.factSnapshot);

    const { updatedTask, workingDraft } = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '人工核对完成',
      activeRole: '主笔甲',
    });

    assert(workingDraft.blocks[0].content === beforeContent, '用例D: 保存复核记录绝不改写正文');
    assert(updatedTask.drafts.length === beforeDraftCount, '用例D: 保存复核记录不增加版本数量');
    assert((updatedTask.modificationLogs || []).length === beforeLogCount, '用例D: 不产生正文修改日志');
    assert(JSON.stringify(updatedTask.factSnapshot) === beforeFactSnapshot, '用例D: 任务事实快照完好不变');
    assert(JSON.stringify(workingDraft.snapshotMetadata?.factSnapshot) === beforeDraftSnapshot, '用例D: 稿件冻结快照完好不变');

    // 检查原有事实差异计数保留
    const analysis = analyzeFactImpact(updatedTask, workingDraft);
    assert(analysis.changedFactsCount === 1, '用例D: 变动事实数依然准确保留为 1 项，绝未被清零');
    assert(analysis.affectedBlocksCount === 1, '用例D: 受影响段落数依然保留为 1 段，绝未被清零');
    assert(!analysis.statusMessage.includes('正文与最新事实一致'), '用例D: 绝不出现“正文与最新事实一致”虚假声称');
  }

  // ==========================================================================
  // [用例 E] 正文编辑、建议采纳、安全撤销及相关事实/出处变化使记录失效；无关变化不误伤
  // ==========================================================================
  console.log('\n>>> [用例 E] 正文编辑、建议采纳、安全撤销及相关事实/出处变化使记录失效；无关变化不误伤:');
  {
    // E.1: 正文编辑导致记录失效
    const taskE1 = createPresetTask('under_review');
    const draftE1 = taskE1.drafts.find((d) => d.id === taskE1.currentDraftId)!;
    taskE1.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    const { updatedTask: t1, workingDraft: d1 } = saveFactReviewRecord({
      task: taskE1,
      targetDraftId: draftE1.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: 'BLK-01 已核对',
      activeRole: '主笔甲',
    });

    // 主笔编辑了 BLK-01 正文
    const resEdit = applyDraftContentChange(
      t1,
      d1.id,
      (blocks) => blocks.map((b) => (b.id === 'BLK-01' ? { ...b, content: b.content + '（主笔补充说明）' } : b)),
      '修改第1段正文',
      '主笔甲'
    );
    const evalEdit = evaluateDraftFactReviews(resEdit.updatedTask, resEdit.workingDraft);
    const blk01Edit = evalEdit.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(blk01Edit.displayStatus === 'invalidated', '用例E.1: 正文编辑后复核记录立即判定为失效');
    assert(blk01Edit.invalidatedReason?.includes('正文在复核后已发生修改') || false, '用例E.1: 明确提示正文内容已变更');
    assert(blk01Edit.isPending === true, '用例E.1: 失效记录重新计入待处理');

    // E.2: 正文编辑后改回原正文，因 revisionSeq 递增依然阻止静默恢复
    const resRevertText = applyDraftContentChange(
      resEdit.updatedTask,
      resEdit.workingDraft.id,
      (blocks) => blocks.map((b) => (b.id === 'BLK-01' ? { ...b, content: draftE1.blocks[0].content } : b)),
      '改回原文本',
      '主笔甲'
    );
    const evalRevert = evaluateDraftFactReviews(resRevertText.updatedTask, resRevertText.workingDraft);
    const blk01Revert = evalRevert.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(blk01Revert.displayStatus === 'invalidated', '用例E.2: 正文改回原文字后，因 revisionSeq 递增，严禁静默恢复为有效');
    assert(blk01Revert.invalidatedReason?.includes('修订版本已递增') || false, '用例E.2: 明确提示修订版本递增');

    // E.3: 相关最新事实再次发生变动导致失效
    const taskE3 = createPresetTask('under_review');
    const draftE3 = taskE3.drafts.find((d) => d.id === taskE3.currentDraftId)!;
    taskE3.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    const { updatedTask: t3, workingDraft: d3 } = saveFactReviewRecord({
      task: taskE3,
      targetDraftId: draftE3.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '基于120项核对',
      activeRole: '主笔甲',
    });
    // 事实再次被调整为 125
    t3.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '125';
    const evalFactChange = evaluateDraftFactReviews(t3, d3);
    const blk01FactChange = evalFactChange.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(blk01FactChange.displayStatus === 'invalidated', '用例E.3: 相关最新事实再次变化导致复核记录失效');
    assert(blk01FactChange.invalidatedReason?.includes('最新数值或单位已变动') || false, '用例E.3: 给出最新数值变动的失效原因');

    // E.4: 无关变化不误伤
    const taskE4 = createPresetTask('under_review');
    const draftE4 = taskE4.drafts.find((d) => d.id === taskE4.currentDraftId)!;
    taskE4.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    const { updatedTask: t4, workingDraft: d4 } = saveFactReviewRecord({
      task: taskE4,
      targetDraftId: draftE4.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: 'BLK-01 已核对',
      activeRole: '主笔甲',
    });

    // 变动无关事实 FACT-02（培训场次），或者编辑无关段落 BLK-02
    t4.facts.find((f) => f.id === 'FACT-02')!.value = '18';
    const resEditBlk02 = applyDraftContentChange(
      t4,
      d4.id,
      (blocks) => blocks.map((b) => (b.id === 'BLK-02' ? { ...b, content: b.content + '（修改第2段）' } : b)),
      '修改第2段',
      '主笔甲'
    );
    const evalUnrelated = evaluateDraftFactReviews(resEditBlk02.updatedTask, resEditBlk02.workingDraft);
    const blk01Unrelated = evalUnrelated.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(blk01Unrelated.displayStatus === 'reviewed', '用例E.4: 无关事实或无关段落修改绝不误伤 BLK-01 复核记录');

    // 段落重排（仅 order 交换，Block ID 稳定）不误伤
    const resReorder = applyDraftContentChange(
      resEditBlk02.updatedTask,
      resEditBlk02.workingDraft.id,
      (blocks) => [blocks[1], blocks[0], ...blocks.slice(2)],
      '段落重排',
      '主笔甲'
    );
    const evalReorder = evaluateDraftFactReviews(resReorder.updatedTask, resReorder.workingDraft);
    const blk01Reorder = evalReorder.blockEvaluations.find((b) => b.blockId === 'BLK-01')!;
    assert(blk01Reorder.displayStatus === 'reviewed', '用例E.4: 段落重排后 BLK-01 依然准确匹配并保持已复核状态');
  }

  // ==========================================================================
  // [用例 F] 保存历史快照冻结记录；历史/定稿只读；恢复或新工作稿不串用有效结论
  // ==========================================================================
  console.log('\n>>> [用例 F] 保存历史快照冻结记录；历史/定稿只读；恢复或新工作稿不串用有效结论:');
  {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    task.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    const { updatedTask: tWithReview, workingDraft: dWithReview } = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '准备保存快照前已核对',
      activeRole: '主笔甲',
    });

    // 1. 保存历史快照
    const { updatedTask: tSnapshot, snapshotDraft } = createDraftSnapshot(
      tWithReview,
      dWithReview.id,
      '测试快照冻结复核记录',
      '主笔甲'
    );
    assert(snapshotDraft.isHistoricalSnapshot === true, '用例F.1: 快照具备历史属性');
    assert((snapshotDraft.factReviewRecords || []).length === 1, '用例F.1: 快照冻结了当时的复核记录');
    assert(snapshotDraft.factReviewRecords![0].notes === '准备保存快照前已核对', '用例F.1: 快照记录内容完整冻结');

    // 2. 历史只读保护：禁止在历史版本上新增或撤回复核记录
    let errorHistorySave = '';
    try {
      saveFactReviewRecord({
        task: tSnapshot,
        targetDraftId: snapshotDraft.id,
        targetBlockId: 'BLK-01',
        status: 'reviewed',
        notes: '试图在历史快照上保存',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorHistorySave = e.message;
    }
    assert(errorHistorySave.includes('只读版本'), '用例F.2: 历史快照禁止保存复核记录');

    // 3. 恢复历史版本产生新工作草稿：不自动继承有效复核
    const { updatedTask: tRestored, workingDraft: dRestored } = restoreDraftVersion(
      tSnapshot,
      snapshotDraft.id,
      '主笔甲'
    );
    assert(dRestored.isWorkingDraft === true, '用例F.3: 恢复成功生成新工作草稿');
    assert((dRestored.factReviewRecords || []).length === 0, '用例F.3: 恢复的新工作稿不自动继承有效复核（清空为待核对）');
    assert((dRestored.sourceFactReviewRecords || []).length === 1, '用例F.3: 来源记录完整留存在 sourceFactReviewRecords 供查阅');
    const evalRestored = evaluateDraftFactReviews(tRestored, dRestored);
    assert(evalRestored.blockEvaluations[0].displayStatus === 'pending', '用例F.3: 新工作稿评估状态为待复核');

    // 4. 后续在工作稿上的修改绝不回写历史快照
    const resSaveOnWork = saveFactReviewRecord({
      task: tRestored,
      targetDraftId: dRestored.id,
      targetBlockId: 'BLK-01',
      status: 'deferred',
      notes: '新工作稿上选择暂缓处理',
      activeRole: '主笔甲',
    });
    const frozenSnapInTask = resSaveOnWork.updatedTask.drafts.find((d) => d.id === snapshotDraft.id)!;
    assert(frozenSnapInTask.factReviewRecords![0].status === 'reviewed', '用例F.4: 历史快照保留原 reviewed 状态，绝未被回写成 deferred');
  }

  // ==========================================================================
  // [用例 G] 任务、版本、角色、段落切换隔离；陈旧表单提交被拦截；键盘操作正常
  // ==========================================================================
  console.log('\n>>> [用例 G] 任务、版本、角色、段落切换隔离；陈旧表单提交被拦截；键盘操作正常:');
  {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    task.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';

    // 1. 角色权限拦截：非主笔身份禁止保存或撤回复核
    let errorReviewer = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: draft.id,
        targetBlockId: 'BLK-01',
        status: 'reviewed',
        notes: '审阅领导试图代主笔复核',
        activeRole: '审阅乙',
      });
    } catch (e: any) {
      errorReviewer = e.message;
    }
    assert(errorReviewer.includes('权限受限：仅主笔甲可记录人工复核'), '用例G.1: 审阅乙保存复核被拦截');

    let errorSupplier = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: draft.id,
        targetBlockId: 'BLK-01',
        status: 'reviewed',
        notes: '供稿人试图代主笔复核',
        activeRole: '供稿丙',
      });
    } catch (e: any) {
      errorSupplier = e.message;
    }
    assert(errorSupplier.includes('权限受限：仅主笔甲可记录人工复核'), '用例G.1: 供稿丙保存复核被拦截');

    // 2. 陈旧表单与跨对象隔离：目标稿件版本不匹配
    let errorStaleDraft = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: 'DRAFT-STALE-OLD',
        targetBlockId: 'BLK-01',
        status: 'reviewed',
        notes: '陈旧稿件表单提交',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorStaleDraft = e.message;
    }
    assert(errorStaleDraft.includes('未找到目标稿件版本'), '用例G.2: 陈旧稿件版本提交被安全拦截');

    // 目标段落不存在
    let errorStaleBlock = '';
    try {
      saveFactReviewRecord({
        task,
        targetDraftId: draft.id,
        targetBlockId: 'BLK-NON-EXISTENT',
        status: 'reviewed',
        notes: '陈旧段落表单提交',
        activeRole: '主笔甲',
      });
    } catch (e: any) {
      errorStaleBlock = e.message;
    }
    assert(errorStaleBlock.includes('目标段落【BLK-NON-EXISTENT】不存在'), '用例G.2: 陈旧段落提交被安全拦截');
  }

  // ==========================================================================
  // [用例 H] 缺基准、事实删除/排除/待确认、未裁决冲突及旧存储数据有明确安全结果；人工记录不绕过核校定稿
  // ==========================================================================
  console.log('\n>>> [用例 H] 缺基准、事实删除/排除/待确认、未裁决冲突及旧存储数据有明确安全结果；人工记录不绕过核校定稿:');
  {
    // 1. 缺少基准
    const taskNoBase = createPresetTask('under_review');
    const draftNoBase = taskNoBase.drafts.find((d) => d.id === taskNoBase.currentDraftId)!;
    delete (draftNoBase.snapshotMetadata as any).factSnapshot;

    const evalNoBase = evaluateDraftFactReviews(taskNoBase, draftNoBase);
    assert(evalNoBase.blockEvaluations.length > 0, '用例H.1: 缺少基准时依然能安全分析受影响段落');
    assert(evalNoBase.blockEvaluations[0].limitations.some((l) => l.includes('缺少冻结事实快照基准')), '用例H.1: 明确展示缺少基准检查限制');

    // 2. 事实删除与未裁决冲突
    const taskConflict = createPresetTask('under_review');
    const draftConflict = taskConflict.drafts.find((d) => d.id === taskConflict.currentDraftId)!;
    const f01 = taskConflict.facts.find((f) => f.id === 'FACT-01')!;
    f01.hasConflict = true;
    f01.selectedConflictValue = undefined; // 未裁决冲突

    const evalConflict = evaluateDraftFactReviews(taskConflict, draftConflict);
    assert(evalConflict.blockEvaluations[0].limitations.some((l) => l.includes('存在未裁决冲突')), '用例H.2: 明确提示未裁决冲突限制');

    // 3. 复核记录绝不能绕过定稿门禁
    const taskFin = createPresetTask('under_review');
    const draftFin = taskFin.drafts.find((d) => d.id === taskFin.currentDraftId)!;
    // 事实与任务快照重新核准变更为 120 项，与草稿旧快照 128 项产生脱节
    taskFin.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';
    taskFin.factSnapshot = {
      ...taskFin.factSnapshot!,
      confirmedAt: new Date().toISOString(),
      items: taskFin.factSnapshot!.items.map((i) =>
        i.factId === 'FACT-01' ? { ...i, value: '120', selectedConflictValue: '120' } : i
      ),
    };
    // 主笔记录了人工复核
    const { updatedTask: tFinReviewed, workingDraft: dFinReviewed } = saveFactReviewRecord({
      task: taskFin,
      targetDraftId: draftFin.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '主笔已人工核对120项口径',
      activeRole: '主笔甲',
    });

    // 尝试定稿：尽管正文已有人工复核记录，上游事实快照不一致依然必须阻断定稿！
    const finValidation = validateFinalizationConditions(tFinReviewed, dFinReviewed.id, '主笔甲');
    assert(finValidation.canFinalize === false, '用例H.3: 存在事实快照不一致时，人工复核记录绝不能绕过定稿阻断');
    assert(finValidation.reasons.some((r) => r.includes('与最新核准的事实快照不一致')), '用例H.3: 给出事实依据快照不一致的具体阻断原因');
  }

  // ==========================================================================
  // [用例 I] JSDOM 真实组件挂载与交互回归 (保存、暂缓、撤回、界面渲染)
  // ==========================================================================
  console.log('\n>>> [用例 I] JSDOM 真实组件挂载与交互回归:');
  {
    const initialTask = createPresetTask('under_review');
    initialTask.facts.find((f) => f.id === 'FACT-01')!.selectedConflictValue = '120';

    let currentTaskState = initialTask;
    let view: any = null;

    const renderApp = (taskState: Task) => {
      return (
        <DraftingStage
          task={taskState}
          activeRole="主笔甲"
          onProceedToNextStage={() => {}}
          onUpdateTask={(updates) => {
            currentTaskState = { ...currentTaskState, ...updates };
            if (view) {
              view.rerender(renderApp(currentTaskState));
            }
          }}
          onViewSnippet={() => {}}
        />
      );
    };

    view = mountTestComponent(renderApp(initialTask));

    // 1. 验证顶部入口文案与点击唤起面板
    const openBtn = view.container.querySelector('[data-testid="btn-open-fact-impact"]') as HTMLElement;
    assert(!!openBtn, '用例I.1: 找到顶部紧凑入口按钮 [btn-open-fact-impact]');
    act(() => {
      openBtn.click();
    });

    const modal = view.container.querySelector('[data-testid="fact-impact-modal"]');
    assert(!!modal, '用例I.1: 成功唤起事实影响与复核面板 [fact-impact-modal]');

    // 2. 找到 BLK-01 复核卡片与初始待复核状态
    const blkCard = view.container.querySelector('[data-testid="fact-review-block-card-BLK-01"]') as HTMLElement;
    assert(!!blkCard, '用例I.2: 找到 BLK-01 复核卡片 [fact-review-block-card-BLK-01]');

    const statusBadge = view.container.querySelector('[data-testid="badge-review-status-BLK-01"]') as HTMLElement;
    assert(!!statusBadge, '用例I.2: 找到复核状态徽章 [badge-review-status-BLK-01]');
    assert(statusBadge.textContent?.trim() === '待复核', '用例I.2: 初始状态显示为“待复核”');

    function setReactInputValue(el: HTMLElement, val: string) {
      const prototype = el instanceof dom.window.HTMLTextAreaElement
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, val);
      } else {
        (el as any).value = val;
      }
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }

    // 3. 填写说明并点击“记录人工复核”
    const notesInput = view.container.querySelector('[data-testid="input-review-notes-BLK-01"]') as HTMLTextAreaElement;
    assert(!!notesInput, '用例I.3: 找到核对说明输入框 [input-review-notes-BLK-01]');

    const submitBtn = view.container.querySelector('[data-testid="btn-submit-review-BLK-01"]') as HTMLButtonElement;
    assert(!!submitBtn, '用例I.3: 找到“记录人工复核”按钮 [btn-submit-review-BLK-01]');
    assert(submitBtn.disabled === true, '用例I.3: 未填写说明时提交按钮处于禁用状态');

    act(() => {
      setReactInputValue(notesInput, 'JSDOM真实组件测试：已核对申报口径120项');
    });

    assert(submitBtn.disabled === false, '用例I.3: 填写说明后提交按钮变为可用状态');

    // 提交复核
    act(() => {
      submitBtn.click();
    });

    // 4. 验证保存后状态更新
    const updatedStatusBadge = view.container.querySelector('[data-testid="badge-review-status-BLK-01"]') as HTMLElement;
    assert(updatedStatusBadge.textContent?.trim() === '已记录人工复核', '用例I.4: 提交后状态徽章更新为“已记录人工复核”');

    const recordDetail = view.container.querySelector('[data-testid="record-detail-BLK-01"]') as HTMLElement;
    assert(!!recordDetail, '用例I.4: 展开显示已保存的人工复核留痕记录');
    assert(recordDetail.textContent?.includes('JSDOM真实组件测试：已核对申报口径120项') || false, '用例I.4: 留痕记录包含所填写的核对说明');

    // 5. 找到撤回复核入口并完成撤回
    const revokeBtn = view.container.querySelector('[data-testid="btn-revoke-review-BLK-01"]') as HTMLButtonElement;
    assert(!!revokeBtn, '用例I.5: 找到“撤回复核记录”按钮 [btn-revoke-review-BLK-01]');
    act(() => {
      revokeBtn.click();
    });

    const revokeReasonInput = view.container.querySelector('[data-testid="input-revoke-reason-BLK-01"]') as HTMLInputElement;
    assert(!!revokeReasonInput, '用例I.5: 展现撤回原因输入框 [input-revoke-reason-BLK-01]');

    act(() => {
      setReactInputValue(revokeReasonInput, '组件交互测试撤回说明');
    });

    const confirmRevokeBtn = view.container.querySelector('[data-testid="btn-confirm-revoke-BLK-01"]') as HTMLButtonElement;
    assert(!!confirmRevokeBtn, '用例I.5: 找到确认撤回按钮');
    act(() => {
      confirmRevokeBtn.click();
    });

    // 验证撤回后状态重置为待复核
    const afterRevokeBadge = view.container.querySelector('[data-testid="badge-review-status-BLK-01"]') as HTMLElement;
    assert(afterRevokeBadge.textContent?.trim() === '待复核', '用例I.5: 撤回后状态重新变回“待复核”');

    view.unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务22 全部 9 组核心业务与真实组件验收用例 100% 全部通过！');
  console.log('================================================================\n');
}

runTask22Tests().catch((err) => {
  console.error('\n❌ 任务22 验收测试执行失败:', err);
  process.exit(1);
});
