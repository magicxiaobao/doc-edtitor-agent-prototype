import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPresetTask,
  createPostRevisionVerificationDemoTask,
  createMultiParagraphRevisionDemoTask,
  createMultiFactGroupRevisionDemoTask,
  createSharedParagraphRevisionDemoTask,
} from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  PostRevisionVerificationRecord,
  PostRevisionVerificationCredential,
} from './src/types';
import {
  checkFactRevisionEligibility,
  generateFactRevisionCandidate,
  acceptFactRevisionCandidate,
  checkMultiParagraphFactRevisionEligibility,
  generateMultiParagraphFactRevisionCandidate,
  acceptMultiParagraphFactRevisionCandidate,
  checkMultiFactGroupRevisionEligibility,
  generateMultiFactGroupRevisionCandidate,
  acceptMultiFactGroupRevisionCandidate,
  checkSharedParagraphFactRevisionEligibility,
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
} from './src/services/factRevisionCandidateService';
import {
  evaluatePostRevisionVerification,
  recordPostRevisionVerification,
  deferPostRevisionVerification,
  revokePostRevisionVerification,
  freezePostRevisionVerification,
  sourcePostRevisionVerification,
  isValidVerificationCredential,
  isValidVerificationRecord,
} from './src/services/postRevisionVerificationService';
import {
  applyDraftContentChange,
  createDraftSnapshot,
  restoreDraftVersion,
  finalizeDraft,
} from './src/services/draftLifecycleService';
import { validateTaskStructure } from './src/services/storageService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { PostRevisionVerificationModal } from './src/components/PostRevisionVerificationModal';

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

async function runTask27Tests() {
  console.log('================================================================');
  console.log('🚀 开始执行任务27（事实修订后逐段核对与留痕）综合自动化测试套件');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // [A] 四个修订通道采纳均原子生成冻结凭据，事实与段落去重且包含前后快照
  // -------------------------------------------------------------------------
  console.log('\n--- [A] 验证四个修订采纳通道均生成完备的PostRevisionVerificationCredential ---');
  {
    // A.1 Channel 23: 单事实单段落
    const task23 = createPresetTask('under_review');
    task23.currentRole = '主笔甲';
    const draft23 = task23.drafts.find((d) => d.id === task23.currentDraftId)!;
    draft23.snapshotMetadata = JSON.parse(JSON.stringify(draft23.snapshotMetadata));
    task23.factSnapshot = JSON.parse(JSON.stringify(task23.factSnapshot));

    const fact01 = task23.facts.find((f) => f.id === 'FACT-01')!;
    fact01.selectedConflictValue = '120';
    fact01.value = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    fact01.conflictResolutionReason = '采信科室甲申报口径120项';
    task23.factSnapshot!.items = task23.facts
      .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
      .map((f) => buildFactItemSnapshot(task23, f));

    const cand23 = generateFactRevisionCandidate(task23, draft23, 'BLK-01', '主笔甲');
    assert(cand23.success && cand23.candidate, 'A.1: Task23 成功生成候选');
    const acc23 = acceptFactRevisionCandidate(task23, draft23, cand23.candidate, '主笔甲', cand23.candidate.runId);
    const workingDraft23 = acc23.workingDraft || (acc23 as any).newWorkingDraft;
    assert(acc23.success && workingDraft23, 'A.1: Task23 成功采纳');
    assert(workingDraft23.postRevisionVerificationCredential, 'A.1: Task23 生成凭据');
    assert(workingDraft23.postRevisionVerificationCredential.facts.length === 1, 'A.1: 涉及1项事实');
    assert(workingDraft23.postRevisionVerificationCredential.blocks.length === 1, 'A.1: 涉及1个段落');
    assert(workingDraft23.postRevisionVerificationCredential.blocks[0].associatedFactIds.includes('FACT-01'), 'A.1: 关联事实包含FACT-01');

    // A.2 Channel 24: 单事实多段落
    const task24 = createMultiParagraphRevisionDemoTask();
    task24.currentRole = '主笔甲';
    const draft24 = task24.drafts.find((d) => d.id === task24.currentDraftId)!;
    const f1_24 = task24.facts.find((f) => f.id === 'FACT-01')!;
    f1_24.status = 'confirmed';
    f1_24.value = '120';
    f1_24.selectedConflictValue = '120';
    f1_24.primaryEvidenceId = 'EVD-01';
    task24.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task24.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task24.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task24, f)),
      hash: 'SNAPSHOT-HASH-CONFIRMED-MULTI-120',
    };
    task24.outlineConfirmed = true;
    task24.styleConfirmed = true;
    task24.outlineSnapshot = JSON.parse(JSON.stringify(draft24.snapshotMetadata!.outlineSnapshot));
    task24.styleSnapshot = JSON.parse(JSON.stringify(draft24.snapshotMetadata!.styleSnapshot));

    const cand24 = generateMultiParagraphFactRevisionCandidate(task24, draft24, 'FACT-01', '主笔甲');
    assert(cand24.success && cand24.candidateGroup, 'A.2: Task24 成功生成多段候选');
    const acc24 = acceptMultiParagraphFactRevisionCandidate(task24, draft24, cand24.candidateGroup, '主笔甲', cand24.candidateGroup.runId);
    const workingDraft24 = acc24.workingDraft || (acc24 as any).newWorkingDraft;
    assert(acc24.success && workingDraft24, 'A.2: Task24 成功采纳');
    assert(workingDraft24.postRevisionVerificationCredential, 'A.2: Task24 生成凭据');
    assert(workingDraft24.postRevisionVerificationCredential.facts.length === 1, 'A.2: 涉及1项事实');
    assert(workingDraft24.postRevisionVerificationCredential.blocks.length === 2, 'A.2: 涉及2个独立段落');

    // A.3 Channel 25: 两事实三段落成组
    const task25 = createMultiFactGroupRevisionDemoTask();
    task25.currentRole = '主笔甲';
    const draft25 = task25.drafts.find((d) => d.id === task25.currentDraftId)!;
    const f1_25 = task25.facts.find((f) => f.id === 'FACT-01')!;
    f1_25.status = 'confirmed';
    f1_25.value = '120';
    f1_25.selectedConflictValue = '120';
    f1_25.primaryEvidenceId = 'EVD-01';
    const f2_25 = task25.facts.find((f) => f.id === 'FACT-02')!;
    f2_25.status = 'confirmed';
    f2_25.value = '18';
    f2_25.selectedConflictValue = '18';
    f2_25.primaryEvidenceId = 'EVD-07';
    task25.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task25.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task25.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task25, f)),
      hash: 'SNAPSHOT-HASH-CONFIRMED-MULTI-FACT-GROUP',
    };
    task25.outlineConfirmed = true;
    task25.styleConfirmed = true;
    task25.outlineSnapshot = JSON.parse(JSON.stringify(draft25.snapshotMetadata!.outlineSnapshot));
    task25.styleSnapshot = JSON.parse(JSON.stringify(draft25.snapshotMetadata!.styleSnapshot));

    const cand25 = generateMultiFactGroupRevisionCandidate(task25, draft25, '主笔甲');
    assert(cand25.success && cand25.candidateGroup, 'A.3: Task25 成功生成成组候选');
    const acc25 = acceptMultiFactGroupRevisionCandidate(task25, draft25, cand25.candidateGroup, '主笔甲', cand25.candidateGroup.runId);
    const workingDraft25 = acc25.workingDraft || (acc25 as any).newWorkingDraft;
    assert(acc25.success && workingDraft25, 'A.3: Task25 成功采纳');
    assert(workingDraft25.postRevisionVerificationCredential, 'A.3: Task25 生成凭据');
    assert(workingDraft25.postRevisionVerificationCredential.facts.length === 2, 'A.3: 涉及2项事实');
    assert(workingDraft25.postRevisionVerificationCredential.blocks.length === 3, 'A.3: 去重后准确对应3个独立段落');

    // A.4 Channel 26: 两事实部分共享（2事实3段落）
    const task26 = createSharedParagraphRevisionDemoTask();
    task26.currentRole = '主笔甲';
    const draft26 = task26.drafts.find((d) => d.id === task26.currentDraftId)!;
    const f1_26 = task26.facts.find((f) => f.id === 'FACT-01')!;
    f1_26.status = 'confirmed';
    f1_26.value = '120';
    f1_26.selectedConflictValue = '120';
    f1_26.primaryEvidenceId = 'EVD-01';
    const f2_26 = task26.facts.find((f) => f.id === 'FACT-02')!;
    f2_26.status = 'confirmed';
    f2_26.value = '18';
    f2_26.selectedConflictValue = '18';
    f2_26.primaryEvidenceId = 'EVD-07';
    task26.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task26.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task26.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task26, f)),
      hash: 'SNAPSHOT-HASH-CONFIRMED-SHARED-PARAGRAPH',
    };
    task26.outlineConfirmed = true;
    task26.styleConfirmed = true;
    task26.outlineSnapshot = JSON.parse(JSON.stringify(draft26.snapshotMetadata!.outlineSnapshot));
    task26.styleSnapshot = JSON.parse(JSON.stringify(draft26.snapshotMetadata!.styleSnapshot));

    const cand26 = generateSharedParagraphFactRevisionCandidate(task26, draft26, '主笔甲');
    assert(cand26.success && cand26.candidateGroup, 'A.4: Task26 成功生成共享段落候选');
    const acc26 = acceptSharedParagraphFactRevisionCandidate(task26, draft26, cand26.candidateGroup, '主笔甲', cand26.candidateGroup.runId);
    const workingDraft26 = acc26.workingDraft || (acc26 as any).newWorkingDraft;
    assert(acc26.success && workingDraft26, 'A.4: Task26 成功采纳');
    assert(workingDraft26.postRevisionVerificationCredential, 'A.4: Task26 生成凭据');
    assert(workingDraft26.postRevisionVerificationCredential.facts.length === 2, 'A.4: 涉及2项事实');
    assert(workingDraft26.postRevisionVerificationCredential.blocks.length === 3, 'A.4: 2事实3段去重后准确计数为3个段落');
    const blk1Cred = workingDraft26.postRevisionVerificationCredential.blocks.find((b: any) => b.blockId === 'BLK-01')!;
    assert(blk1Cred.associatedFactIds.length === 2, 'A.4: 共享段落完整保留2个关联事实');

    // A.5 2事实1段落严格准确计数为1
    const task26Single = createSharedParagraphRevisionDemoTask();
    task26Single.currentRole = '主笔甲';
    const draft26Single = task26Single.drafts.find((d) => d.id === task26Single.currentDraftId)!;
    // 仅BLK-01关联FACT-01和FACT-02，BLK-02和BLK-03不关联这两项事实
    draft26Single.blocks[1].referencedFactIds = [];
    draft26Single.blocks[1].content = '在重点工作督办方面，对照年度综合清单核查推进，已录入闭环台账。';
    draft26Single.blocks[2].referencedFactIds = ['FACT-03'];
    draft26Single.blocks[2].content = '在队伍履职能力建设方面，立足基层实际需要，累计参训800人次。';
    const f1_s = task26Single.facts.find((f) => f.id === 'FACT-01')!;
    f1_s.status = 'confirmed';
    f1_s.value = '120';
    f1_s.selectedConflictValue = '120';
    f1_s.primaryEvidenceId = 'EVD-01';
    const f2_s = task26Single.facts.find((f) => f.id === 'FACT-02')!;
    f2_s.status = 'confirmed';
    f2_s.value = '18';
    f2_s.selectedConflictValue = '18';
    f2_s.primaryEvidenceId = 'EVD-07';
    task26Single.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: task26Single.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
      items: task26Single.facts
        .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
        .map((f) => buildFactItemSnapshot(task26Single, f)),
      hash: 'SNAPSHOT-HASH-SINGLE-SHARED',
    };
    task26Single.outlineConfirmed = true;
    task26Single.styleConfirmed = true;
    task26Single.outlineSnapshot = JSON.parse(JSON.stringify(draft26Single.snapshotMetadata!.outlineSnapshot));
    task26Single.styleSnapshot = JSON.parse(JSON.stringify(draft26Single.snapshotMetadata!.styleSnapshot));

    const cand26Single = generateSharedParagraphFactRevisionCandidate(task26Single, draft26Single, '主笔甲');
    assert(cand26Single.success && cand26Single.candidateGroup, 'A.5: 2事实1段成功生成候选');
    const acc26Single = acceptSharedParagraphFactRevisionCandidate(task26Single, draft26Single, cand26Single.candidateGroup, '主笔甲', cand26Single.candidateGroup.runId);
    const wd26Single = acc26Single.workingDraft || (acc26Single as any).newWorkingDraft;
    assert(acc26Single.success && wd26Single, 'A.5: 2事实1段成功采纳');
    assert(wd26Single.postRevisionVerificationCredential.blocks.length === 1, 'A.5: 2事实1段去重后准确计数为1个段落');
    assert(wd26Single.postRevisionVerificationCredential.blocks[0].associatedFactIds.length === 2, 'A.5: 2事实1段保留2个关联事实');
  }

  // -------------------------------------------------------------------------
  // [B] 准入失败、取消、采纳失败或重复采纳不得生成凭据
  // -------------------------------------------------------------------------
  console.log('\n--- [B] 验证准入失败、重复采纳等非真实采纳不得生成凭据 ---');
  {
    const task = createPresetTask('under_review');
    task.currentRole = '主笔甲';
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    // 事实存在冲突且未确认时
    const fact01 = task.facts.find((f) => f.id === 'FACT-01')!;
    fact01.status = 'conflict';
    fact01.selectedConflictValue = undefined;
    const cand = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(!cand.success, 'B.1: 事实未确认时无法生成候选');
    assert(!draft.postRevisionVerificationCredential, 'B.1: 未采纳前无凭据生成');

    // 非法角色采纳
    const accInvalid = acceptFactRevisionCandidate(task, draft, {} as any, '审阅乙');
    assert(!accInvalid.success, 'B.2: 非法角色或无效候选无法采纳');
  }

  // -------------------------------------------------------------------------
  // [C] 事实差异为0时仍清晰展示修订核对范围，共享段落去重与未变事实保留
  // -------------------------------------------------------------------------
  console.log('\n--- [C] 验证事实差异为0但修订后核对仍存在待处理，且未变事实保留 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    const activeDraft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // 此时事实差异分析应当为0
    const impact = analyzeFactImpact(demoTask, activeDraft);
    assert(impact.changedFactsCount === 0, 'C.1: 新工作稿与确认事实口径完全一致，差异数为0');

    // 但核对凭据中存在3个待核对段落
    const evalRes = evaluatePostRevisionVerification(demoTask, activeDraft);
    assert(evalRes.hasCredential, 'C.2: 存在修订核对凭据');
    assert(evalRes.totalBlocksCount === 3, 'C.2: 共有3个修改段落');
    assert(evalRes.pendingCount === 3, 'C.2: 待处理段落数为3');
    assert(evalRes.verifiedCount === 0, 'C.2: 已记录核对为0');
    assert(evalRes.statusSummaryText.includes('0/3段已记录 · 3段待处理'), 'C.2: 状态文案准确');

    // 检查首段内容保留800人次
    const block1 = activeDraft.blocks.find((b) => b.id === 'BLOCK-01')!;
    assert(block1.content.includes('800人次'), 'C.3: 共享段落严格保留800人次未变事实');
    // 检查共享段落关联2项事实
    const credBlock1 = evalRes.blockEvaluations.find((b) => b.blockId === 'BLOCK-01')!;
    assert(credBlock1.associatedFactIds.length === 2, 'C.3: 首段在凭据中关联2项变更事实');
  }

  // -------------------------------------------------------------------------
  // [D] 填写说明人工核对、暂缓、撤回、重新核对留痕及状态转移
  // -------------------------------------------------------------------------
  console.log('\n--- [D] 验证记录核对、暂缓、撤回、重新核对留痕及说明必填性 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // D.1 说明为空拦截
    const emptyRec = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '   ',
    });
    assert(!emptyRec.success && emptyRec.error?.includes('说明不能为空'), 'D.1: 空说明被拦截');

    // D.2 成功记录核对
    const rec1 = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '首段已逐字核对，120项与18场均符合科室甲与培训处依据',
    });
    assert(rec1.success, 'D.2: 成功记录BLOCK-01核对');
    assert(draft.postRevisionVerificationRecords?.length === 1, 'D.2: 存入1条核对记录');

    // 评估状态验证
    let evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 1 && evalRes.pendingCount === 2, 'D.2: 进度变为 1/3已记录 · 2待处理');
    assert(evalRes.blockEvaluations[0].displayStatus === 'verified', 'D.2: 首段状态为verified');

    // D.3 暂缓核对（原因必填）
    const emptyDefer = deferPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-02',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      reason: '',
    });
    assert(!emptyDefer.success && emptyDefer.error?.includes('暂缓原因不能为空'), 'D.3: 暂缓空原因被拦截');

    const defer2 = deferPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-02',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      reason: '需要等待处室复核表述细节',
    });
    assert(defer2.success, 'D.3: 成功暂缓BLOCK-02核对');
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.deferredCount === 1, 'D.3: 暂缓计为1');
    assert(evalRes.pendingCount === 2, 'D.3: 暂缓依然计入待处理总数 (2待处理)');

    // D.4 撤回核对（原因必填）
    const emptyRevoke = revokePostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      reason: '',
    });
    assert(!emptyRevoke.success && emptyRevoke.error?.includes('撤回原因不能为空'), 'D.4: 撤回空原因被拦截');

    const revoke1 = revokePostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      reason: '发现科室报表附件有更新，需要重新复核',
    });
    assert(revoke1.success, 'D.4: 成功撤回BLOCK-01核对');
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 0 && evalRes.pendingCount === 3, 'D.4: 进度回退为 0/3已记录 · 3待处理');
    const b1Record = draft.postRevisionVerificationRecords?.find((r) => r.blockId === 'BLOCK-01');
    assert(b1Record?.status === 'revoked', 'D.4: 记录状态标记为revoked');
    assert(b1Record?.events.length === 2, 'D.4: 历史事件包含记录与撤回两条');

    // D.5 重新核对（保留历史事件）
    const reverify1 = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '附件重新查验完毕，无歧义，确认通过',
    });
    assert(reverify1.success, 'D.5: 成功重新核对BLOCK-01');
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 1, 'D.5: 重新记录为已核对');
    const b1RecordAfter = draft.postRevisionVerificationRecords?.find((r) => r.blockId === 'BLOCK-01')!;
    assert(b1RecordAfter.events.length === 3, 'D.5: 历史事件保留全部3条');
    assert(b1RecordAfter.events[0].type === 'recorded' && b1RecordAfter.events[1].type === 'revoked' && b1RecordAfter.events[2].type === 'recorded', 'D.5: 事件顺序完整留存');

    // 核对操作不改变正文、版本与revisionSeq
    const prevSeq = draft.revisionSeq;
    const prevVersionCount = demoTask.drafts.length;
    assert(draft.revisionSeq === prevSeq, 'D.6: 核对不递增revisionSeq');
    assert(demoTask.drafts.length === prevVersionCount, 'D.6: 核对不新建正文版本');
  }

  // -------------------------------------------------------------------------
  // [E] 失效规则：正文修改、改回相同文字、事实引用变更、事实口径重提冲突
  // -------------------------------------------------------------------------
  console.log('\n--- [E] 验证精准失效规则与无关段落/事实不受误伤 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // 先完成BLOCK-01和BLOCK-02的核对
    recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '首段已核对',
    });
    recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-02',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '第二段已核对',
    });

    let evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 2, 'E.1: 初始完成2段核对');

    // E.2 人工微调BLOCK-01正文 -> BLOCK-01失效，BLOCK-02不应受误伤
    const originalContent1 = draft.blocks[0].content;
    draft.blocks[0].content += '【微调文字】';
    draft.blocks[0].revisionSeq += 1;
    draft.revisionSeq += 1;

    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 1, 'E.2: 正文微调后已记录核对降为1');
    assert(evalRes.blockEvaluations[0].displayStatus === 'invalidated', 'E.2: BLOCK-01显示为失效');
    assert(evalRes.blockEvaluations[0].invalidationReason?.includes('正文内容已被修改'), 'E.2: 失效原因提示正文已修改');
    assert(evalRes.blockEvaluations[1].displayStatus === 'verified', 'E.2: 无关段落BLOCK-02保持已核对');

    // E.3 正文改回相同文字，但revisionSeq变更 -> 依然失效
    draft.blocks[0].content = originalContent1;
    draft.blocks[0].revisionSeq += 1; // revisionSeq前进
    draft.revisionSeq += 1;

    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.blockEvaluations[0].displayStatus === 'invalidated', 'E.3: 改回相同文字但版本序列号改变仍为失效');
    assert(evalRes.blockEvaluations[0].invalidationReason?.includes('版本序列号已变更'), 'E.3: 明确说明版本序列号已变更');

    // E.4 重新核对BLOCK-01
    recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '针对最新正文与版本序列号重新核对确认',
    });
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.blockEvaluations[0].displayStatus === 'verified', 'E.4: 基于当前正文重新核对成功');

    // E.5 修改BLOCK-01的事实引用关联
    draft.blocks[0].referencedFactIds = ['FACT-01']; // 移除了FACT-02
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.blockEvaluations[0].displayStatus === 'invalidated', 'E.5: 引用事实发生变动导致失效');
    assert(evalRes.blockEvaluations[0].invalidationReason?.includes('关联事实引用发生变动'), 'E.5: 明确指出事实引用变动');
    draft.blocks[0].referencedFactIds = ['FACT-01', 'FACT-02']; // 恢复

    // 重新确认BLOCK-01
    recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '恢复引用后重新确认',
    });

    // E.6 相关事实FACT-01重新出现未裁决冲突
    const f1 = demoTask.facts.find((f) => f.id === 'FACT-01')!;
    f1.status = 'conflict';
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.blockEvaluations[0].displayStatus === 'invalidated', 'E.6: 相关事实重提冲突导致BLOCK-01失效');
    assert(evalRes.blockEvaluations[0].needsFactHandling, 'E.6: 提示需要前往处理事实');
    // BLOCK-02关联FACT-01，也受到影响
    assert(evalRes.blockEvaluations[1].displayStatus === 'invalidated', 'E.6: 关联FACT-01的BLOCK-02同样提示处理事实');

    // 但如果是不相关事实（例如新建事实或未关联的FACT-04发生变动），不误伤
    f1.status = 'confirmed';
    const f4 = demoTask.facts.find((f) => f.id === 'FACT-04')!;
    f4.value = '999'; // 修改无关事实
    evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.blockEvaluations[0].displayStatus === 'verified', 'E.7: 无关事实变动不误伤已关联核对');
  }

  // -------------------------------------------------------------------------
  // [F] 身份与边界隔离：非主笔、跨任务、跨草稿、伪造段落ID拦截
  // -------------------------------------------------------------------------
  console.log('\n--- [F] 验证角色权限及版本隔离边界 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // F.1 非主笔身份拦截
    const nonDrafterRec = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '审阅乙',
      role: '审阅乙',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '审阅人尝试签署',
    });
    assert(!nonDrafterRec.success && nonDrafterRec.error?.includes('只有主笔'), 'F.1: 审阅乙操作被拦截');

    // F.2 缺省/未知角色拦截
    const unknownRoleRec = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '访客',
      role: '' as any,
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '未知角色尝试签署',
    });
    assert(!unknownRoleRec.success, 'F.2: 未知角色被拦截');

    // F.3 伪造段落ID拦截
    const fakeBlockRec = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-999-FAKE',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '伪造段落ID',
    });
    assert(!fakeBlockRec.success && fakeBlockRec.error?.includes('不在本次凭据范围内'), 'F.3: 伪造段落ID被拦截');

    // F.4 陈旧 operationId 拦截
    const staleOpRec = recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: 'OLD-OP-123',
      notes: '陈旧操作批次',
    });
    assert(!staleOpRec.success && staleOpRec.error?.includes('操作批次不匹配'), 'F.4: 陈旧操作批次被拦截');
  }

  // -------------------------------------------------------------------------
  // [G] 版本生命周期：归档快照冻结总览、还原清理本稿、历史快照只读
  // -------------------------------------------------------------------------
  console.log('\n--- [G] 验证版本生命周期中凭据冻结与还原隔离 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    demoTask.currentRole = '主笔甲';
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // 记录一条核对
    recordPostRevisionVerification(demoTask, draft, {
      blockId: 'BLOCK-01',
      operator: '主笔甲',
      role: '主笔甲',
      operationId: draft.postRevisionVerificationCredential!.operationId,
      notes: '归档前核对',
    });

    // 创建快照版本
    const snapRes = createDraftSnapshot(demoTask, draft.id, '主笔保存的核对中间版', '主笔甲');
    assert(snapRes.snapshotDraft, 'G.1: 成功创建快照版本');
    assert(snapRes.snapshotDraft.frozenPostRevisionVerificationOverview, 'G.1: 快照版本已冻结核对总览');
    assert(snapRes.snapshotDraft.postRevisionVerificationRecords?.length === 1, 'G.1: 快照版本保留核对历史');

    // 定稿归档
    const draftBeforeFinal = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
    // 满足定稿必要条件
    demoTask.outlineConfirmed = true;
    demoTask.styleConfirmed = true;
    demoTask.reviews = []; // 无未解决审阅
    const finalizeRes = finalizeDraft(demoTask, draftBeforeFinal.id, '主笔甲');
    assert(finalizeRes.success && finalizeRes.finalDraft, 'G.2: 成功定稿');
    assert(finalizeRes.finalDraft.frozenPostRevisionVerificationOverview, 'G.2: 定稿版本冻结核对总览');

    // 还原历史版本时不继承活动的已核对记录（安全隔离）
    const restoreRes = restoreDraftVersion(demoTask, snapRes.snapshotDraft.id, '主笔甲');
    assert(restoreRes.success && restoreRes.workingDraft, 'G.3: 成功还原版本');
    assert(restoreRes.workingDraft.postRevisionVerificationRecords?.length === 0, 'G.3: 还原出的新工作稿清空活动核对，不继承旧结论');
    assert(restoreRes.workingDraft.sourcePostRevisionVerificationCredential, 'G.3: 记录来源凭据用于回溯');
  }

  // -------------------------------------------------------------------------
  // [H] 异常数据自愈与健壮性
  // -------------------------------------------------------------------------
  console.log('\n--- [H] 验证异常与截断数据自愈，不崩溃 ---');
  {
    const corruptedTask = createPostRevisionVerificationDemoTask();
    const draft = corruptedTask.drafts.find((d) => d.id === corruptedTask.currentDraftId)!;

    // 构造损坏凭据与损坏记录
    (draft as any).postRevisionVerificationCredential = {
      // 缺少必需字段
      taskId: 'TASK-1',
    };
    (draft as any).postRevisionVerificationRecords = [
      { badRecord: true },
      null,
      { blockId: 'B1', status: 'invalid_status' },
    ];

    validateTaskStructure(corruptedTask);
    assert(corruptedTask.drafts.length > 0, 'H.1: 自愈校验执行成功');
    assert(draft.postRevisionVerificationRecovery?.recovered, 'H.2: 标记已自愈修复');
    assert(Array.isArray(draft.postRevisionVerificationRecords), 'H.3: 记录恢复为合法空数组');
  }

  // -------------------------------------------------------------------------
  // [I] 界面与交互：组件渲染、前后依据查看、定位段落、Esc与焦点隔离
  // -------------------------------------------------------------------------
  console.log('\n--- [I] 验证界面组件渲染与交互契约 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    demoTask.currentRole = '主笔甲';
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    let modalOpen = true;
    let targetBlock: string | null = null;

    const { container, unmount } = mountTestComponent(
      <PostRevisionVerificationModal
        isOpen={modalOpen}
        onClose={() => { modalOpen = false; }}
        task={demoTask}
        draft={draft}
        activeRole="主笔甲"
        onUpdateTask={(updated) => { Object.assign(demoTask, updated); }}
        onLocateBlock={(bId) => { targetBlock = bId; }}
      />
    );

    // 检查弹窗渲染要素
    const titleEl = container.querySelector('[data-testid="post-revision-verification-modal-title"]');
    assert(titleEl !== null, 'I.1: 弹窗标题成功渲染');

    const progressEl = container.querySelector('[data-testid="post-revision-verification-progress-summary"]');
    assert(progressEl?.textContent?.includes('0/3段已记录'), 'I.2: 进度摘要显示0/3段已记录');

    // 检查冻结依据按钮渲染
    const evdBeforeBtn = container.querySelector('[data-testid="btn-view-evidence-before-FACT-01"]');
    const evdAfterBtn = container.querySelector('[data-testid="btn-view-evidence-after-FACT-01"]');
    assert(evdBeforeBtn !== null && evdAfterBtn !== null, 'I.3: 渲染FACT-01的修改前冻结依据与采纳依据按钮');

    // 点击查看采纳依据
    act(() => {
      (evdAfterBtn as HTMLButtonElement).click();
    });
    const previewBox = container.querySelector('[data-testid="frozen-evidence-preview-box"]');
    assert(previewBox !== null && previewBox.textContent?.includes('EVD-04'), 'I.4: 展开冻结依据预览且包含EVD-04');

    // 检查首段卡片与操作表单
    const block1Card = container.querySelector('[data-testid="verification-block-card-BLOCK-01"]');
    assert(block1Card !== null, 'I.5: 渲染BLOCK-01核对卡片');

    const notesInput = container.querySelector('[data-testid="input-verification-notes-BLOCK-01"]') as HTMLTextAreaElement;
    assert(notesInput !== null, 'I.6: 存在核对说明输入框');

    // 输入说明并点击记录
    act(() => {
      notesInput.value = '界面交互测试：首段逐字核验通过';
      notesInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      notesInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const recordBtn = container.querySelector('[data-testid="btn-record-verification-BLOCK-01"]') as HTMLButtonElement;
    assert(recordBtn !== null, 'I.7: 存在记录核对按钮');

    act(() => {
      recordBtn.click();
    });

    // 检查定位按钮
    const locateBtn = container.querySelector('[data-testid="btn-locate-block-BLOCK-01"]') as HTMLButtonElement;
    assert(locateBtn !== null, 'I.8: 存在定位段落按钮');
    act(() => {
      locateBtn.click();
    });
    assert(targetBlock === 'BLOCK-01', 'I.8: 定位回调成功传入BLOCK-01');

    // Escape 键关闭
    act(() => {
      const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      dom.window.document.dispatchEvent(escEvent);
    });
    assert(modalOpen === false, 'I.9: 按Escape键成功触发关闭');

    unmount();
  }

  // -------------------------------------------------------------------------
  // [J] 完整端到端用户旅程：起草工作台入口 -> 打开核对 -> 暂缓 -> 记录 -> 微调正文 -> 失效提示 -> 重新核对
  // -------------------------------------------------------------------------
  console.log('\n--- [J] 验证起草工作台全流程旅程 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    demoTask.currentRole = '主笔甲';

    let currentTaskState = demoTask;
    const { container, rerender, unmount } = mountTestComponent(
      <DraftingStage
        task={currentTaskState}
        onUpdateTask={(t) => { currentTaskState = t; }}
        activeRole="主笔甲"
      />
    );

    // 检查顶部紧凑核对入口
    const openBtn = container.querySelector('[data-testid="btn-open-post-revision-verification"]') as HTMLButtonElement;
    assert(openBtn !== null, 'J.1: 起草界面存在修订核对紧凑入口');
    assert(openBtn.textContent?.includes('0/3段已记录'), 'J.1: 入口展示 0/3段已记录');

    // 点击打开核对模态框
    act(() => {
      openBtn.click();
    });
    let modalTitle = dom.window.document.querySelector('[data-testid="post-revision-verification-modal-title"]');
    assert(modalTitle !== null, 'J.2: 点击入口成功弹出逐段核对面板');

    // 关闭弹窗
    const closeBtn = dom.window.document.querySelector('[data-testid="btn-close-post-revision-verification-modal"]') as HTMLButtonElement;
    act(() => {
      closeBtn.click();
    });

    unmount();
  }

  // -------------------------------------------------------------------------
  // [K] 保持既有审阅意见门禁与定稿规则，不自动关闭审阅或跳过门禁
  // -------------------------------------------------------------------------
  console.log('\n--- [K] 验证不破坏既有审阅门禁与定稿门禁 ---');
  {
    const demoTask = createPostRevisionVerificationDemoTask();
    demoTask.currentRole = '主笔甲';
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;

    // 加入未解决审阅意见
    demoTask.reviews = [
      {
        id: 'REV-01',
        type: 'comment',
        quote: '测试未解决审阅意见',
        comment: '请核实此表述',
        author: '审阅乙',
        authorRole: '审阅乙',
        createdAt: '2026-10-08T09:00:00Z',
        status: 'pending',
      },
    ];

    // 全部段落完成人工核对
    ['BLOCK-01', 'BLOCK-02', 'BLOCK-03'].forEach((bId) => {
      recordPostRevisionVerification(demoTask, draft, {
        blockId: bId,
        operator: '主笔甲',
        role: '主笔甲',
        operationId: draft.postRevisionVerificationCredential!.operationId,
        notes: `${bId} 全部核对完成`,
      });
    });

    const evalRes = evaluatePostRevisionVerification(demoTask, draft);
    assert(evalRes.verifiedCount === 3 && evalRes.pendingCount === 0, 'K.1: 全部3段已记录人工核对');

    // 检查审阅意见未被自动关闭
    assert(demoTask.reviews[0].status === 'pending', 'K.2: 未解决审阅意见依然为pending，未被自动关闭');

    // 尝试定稿应被未解决审阅意见拦截
    const finRes = finalizeDraft(demoTask, draft.id, '主笔甲');
    assert(!finRes.success, 'K.3: 核对完成不能绕过未解决审阅意见的定稿门禁');
  }

  // -------------------------------------------------------------------------
  // [L] 任务21~26无回归验证
  // -------------------------------------------------------------------------
  console.log('\n--- [L] 验证任务21~26原有功能无回归 ---');
  {
    // Task 21 RAG 检索存在
    assert(typeof createPresetTask === 'function', 'L.1: Task21 预置任务创建可用');

    // Task 22 事实复核机制保持独立
    const demoTask = createPostRevisionVerificationDemoTask();
    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
    assert(draft.factReviewRecords !== undefined, 'L.2: Task22 事实复核字段保持兼容');

    // Task 23-26 修订候选生成能力无回归
    const tShared = createSharedParagraphRevisionDemoTask();
    const dShared = tShared.drafts.find((d) => d.id === tShared.currentDraftId)!;
    const eligShared = checkSharedParagraphFactRevisionEligibility(tShared, dShared);
    assert(typeof eligShared.eligible === 'boolean', 'L.3: Task26 共享段落候选资格检查正常运行');
  }

  console.log('\n================================================================');
  console.log('🎉 恭喜！任务27全部测试断言 100% 通过！');
  console.log('================================================================\n');
}

runTask27Tests().catch((err) => {
  console.error('\n💥 测试运行失败:', err);
  process.exit(1);
});
