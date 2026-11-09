import { dom, simulateTextareaChange } from './test-jsdom-env';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ReviewRoundHistoryView } from './src/components/ReviewRoundHistoryView';
import { ReviewCommentAuditTrailModal } from './src/components/ReviewCommentAuditTrailModal';
import {
  getCommentAuditTrail,
  appendCommentAuditEvent,
  recordCommentDecisionAuditEvent,
  recordCommentRebindAuditEvent,
  recordCommentImplementationAuditEvent,
  recordCommentUndoAuditEvent,
} from './src/services/reviewCommentAuditService';
import {
  submitDraftForReview,
  applyDraftContentChange,
  adoptParagraphSuggestion,
  undoSafeParagraphModification,
  validateFinalizationConditions,
} from './src/services/draftLifecycleService';
import {
  implementReviewCommentWithText,
  updateReviewCommentDecision,
  rebindReviewCommentTargetBlock,
  applyCoordinationDecision,
  recordCoordinationStrategyDecision,
} from './src/services/reviewCoordinationService';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
import { loadPersistedState, savePersistedState, resetStorageWithBackup } from './src/services/storageService';
import type { Task, DraftVersion, ReviewComment, UserRole } from './src/types';

function mount(element: React.ReactElement) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    host,
    render(next: React.ReactElement) {
      act(() => {
        root.render(next);
      });
    },
    close() {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function clickText(host: HTMLElement, text: string) {
  const button = Array.from(host.querySelectorAll('button')).find((b) =>
    (b.textContent || '').trim().includes(text)
  );
  assert.ok(button, `Button with text "${text}" not found`);
  act(() => {
    button.click();
  });
}

function prepareTaskFixture(): Task {
  const task = createRevisionReviewHandoffDemoTask();
  for (const [id, value, evidence] of [
    ['FACT-01', '120', 'EVD-01'],
    ['FACT-02', '18', 'EVD-07'],
  ]) {
    const f = task.facts.find((fact) => fact.id === id);
    if (f) {
      Object.assign(f, {
        status: 'confirmed',
        value,
        selectedConflictValue: value,
        primaryEvidenceId: evidence,
        conflictResolutionReason: '任务30测试专用夹具',
      });
    }
  }
  return task;
}

async function runTests() {
  console.log('--- 开始执行 Task 30 审阅意见处理履历与落实凭据综合测试 ---');

  // =========================================================================
  // Group A: 多次研判与沟通记录前后状态、理由和操作人
  // =========================================================================
  console.log('Group A: 研判流转与说明记录...');
  {
    const task = prepareTaskFixture();
    const comment = task.reviewComments[0];
    assert.ok(comment, '应当有测试意见');

    // 1. 标记待沟通
    const { updatedTask: taskAfterDiscuss } = updateReviewCommentDecision(
      task,
      comment.id,
      'need_discussion',
      '需与法务确认免责条款范围：已预约明天上午会商',
      '主笔甲'
    );
    const cmt1 = taskAfterDiscuss.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt1.status, 'need_discussion');
    assert.equal(cmt1.events?.length, 1);
    const ev1 = cmt1.events![0];
    assert.equal(ev1.actionType, 'discuss');
    assert.equal(ev1.operatorRole, '主笔甲');
    assert.equal(ev1.beforeStatus, 'pending');
    assert.equal(ev1.afterStatus, 'need_discussion');
    assert.ok(ev1.notes.includes('需与法务确认免责条款范围'));

    // 2. 拒绝并说明理由
    const { updatedTask: taskAfterReject } = updateReviewCommentDecision(
      taskAfterDiscuss,
      comment.id,
      'rejected',
      '业务口径与最新政策不符，不予采纳：已向审阅人反馈政策依据',
      '主笔甲'
    );
    const cmt2 = taskAfterReject.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt2.status, 'rejected');
    assert.equal(cmt2.events?.length, 2);
    const ev2 = cmt2.events![1];
    assert.equal(ev2.actionType, 'reject');
    assert.equal(ev2.beforeStatus, 'need_discussion');
    assert.equal(ev2.afterStatus, 'rejected');
    assert.ok(ev2.notes.includes('业务口径与最新政策不符'));
  }

  // =========================================================================
  // Group B: 决定采纳但待落实——不记录正文修改，状态为 accepted_pending_implementation
  // =========================================================================
  console.log('Group B: 决定采纳·待落实通道...');
  {
    const task = prepareTaskFixture();
    const comment = task.reviewComments[0];

    const { updatedTask } = updateReviewCommentDecision(
      task,
      comment.id,
      'accepted_pending_implementation',
      '同意建议方向，待起草时综合微调（已采纳待落实）',
      '主笔甲'
    );
    const cmt = updatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt.status, 'accepted_pending_implementation');
    assert.equal(cmt.events?.length, 1);
    const ev = cmt.events![0];
    assert.equal(ev.actionType, 'accept_pending');
    assert.equal(ev.beforeStatus, 'pending');
    assert.equal(ev.afterStatus, 'accepted_pending_implementation');
    assert.equal(ev.modificationLogId, undefined, '待落实不应生成正文修改日志ID');
    assert.equal(ev.beforeContent, undefined, '待落实不应记录正文前后内容');
    assert.equal(ev.afterContent, undefined);
  }

  // =========================================================================
  // Group C: 真实写入通道与防伪造验证 (直接落实 / 建议采纳 / 协调处理)
  // =========================================================================
  console.log('Group C: 真实写入通道与前/后正文真实存证...');
  {
    // C1: 阶段05 直接落实
    const task1 = prepareTaskFixture();
    const draft1 = task1.drafts.find((d) => d.id === task1.currentDraftId)!;
    // CMT-03 targets BLK-02
    const comment1 = task1.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const targetBlock1 = draft1.blocks.find((b) => b.id === comment1.targetBlockId)!;
    const originalText1 = targetBlock1.content;

    const newText1 = `${originalText1} 【阶段05审阅直接补充口径】`;
    const { updatedTask: taskAfterDirectImpl } = implementReviewCommentWithText(
      task1,
      comment1.id,
      draft1.id,
      newText1,
      '直接修改正文：已按审阅意见补充说明',
      '主笔甲'
    );

    const cmtDirect = taskAfterDirectImpl.reviewComments.find((c) => c.id === comment1.id)!;
    assert.equal(cmtDirect.status, 'implemented');
    assert.equal(cmtDirect.events?.length, 1);
    const evDirect = cmtDirect.events![0];
    assert.equal(evDirect.actionType, 'implement');
    assert.equal(evDirect.beforeContent, originalText1);
    assert.equal(evDirect.afterContent, newText1);
    assert.ok(evDirect.modificationLogId, '落实事件必须包含真实修改日志ID');
    assert.equal(evDirect.targetBlockId, targetBlock1.id);

    // C2: 阶段04 采纳审阅人替换稿 / AI建议稿
    const task2 = prepareTaskFixture();
    const draft2 = task2.drafts.find((d) => d.id === task2.currentDraftId)!;
    const targetBlock2 = draft2.blocks[1];
    const originalText2 = targetBlock2.content;
    const comment2 = task2.reviewComments.find((c) => c.targetBlockId === targetBlock2.id) || task2.reviewComments[0];

    const suggestionText = `${originalText2} （根据审阅人替换稿微调落地）`;
    const runId2 = 'RUN-C2-SUGGESTION';
    const adoptResC2 = adoptParagraphSuggestion({
      task: task2,
      currentDraft: draft2,
      suggestion: {
        action: 'replace',
        targetParagraphOrder: targetBlock2.order,
        targetBlockId: targetBlock2.id,
        suggestedText: suggestionText,
        sourceCommentId: comment2.id,
        sourceCommentType: 'replacement',
        runId: runId2,
        baseContent: originalText2,
        isReviewerReplacement: true,
      },
      pendingTextToAdopt: suggestionText,
      activeCompletedRunId: runId2,
      activeRole: '主笔甲',
    });

    const taskAfterSuggestion = adoptResC2.updatedTask;
    const cmtSug = taskAfterSuggestion.reviewComments.find((c) => c.id === comment2.id)!;
    assert.equal(cmtSug.status, 'implemented');
    assert.equal(cmtSug.events?.length, 1);
    const evSug = cmtSug.events![0];
    assert.equal(evSug.actionType, 'implement');
    assert.equal(evSug.beforeContent, originalText2);
    assert.equal(evSug.afterContent, suggestionText);
    assert.ok(evSug.modificationLogId);
    assert.ok(evSug.notes.includes('采纳审阅替换稿'));

    // C3: 协调决策应用
    const task3 = prepareTaskFixture();
    const draft3 = task3.drafts.find((d) => d.id === task3.currentDraftId)!;
    const c1 = task3.reviewComments[0];
    const c2 = task3.reviewComments[1];
    const targetB = draft3.blocks.find((b) => b.id === c1.targetBlockId) || draft3.blocks[0];

    // 假设 c1 提供了精确替换文本，协调落地改写该段
    const coordinationText = `${targetB.content} （协调落地合并修改）`;
    const commentWithReplacement: ReviewComment = {
      ...c1,
      type: 'paragraph',
      suggestionType: 'replacement',
      targetBlockId: targetB.id,
      suggestedChange: coordinationText,
    };
    const taskWithC1: Task = {
      ...task3,
      reviewComments: task3.reviewComments.map((c) => c.id === c1.id ? commentWithReplacement : c),
    };

    const coordinationResult = {
      strategy: 'compromise' as const,
      baseDraftId: draft3.id,
      baseContentHash: `HASH-${draft3.id}`,
      createdAt: new Date().toISOString(),
      originalWordCount: 500,
      targetWordCount: 520,
      strategyExplanation: '采纳协调意见：综合审阅双方意见进行表述平衡',
      candidateBlocks: draft3.blocks.map((b) => b.id === targetB.id ? { ...b, content: coordinationText } : b),
      diffPreview: [
        {
          blockId: targetB.id,
          originalText: targetB.content,
          proposedText: coordinationText,
        },
      ],
      hasRealCaseMaterial: false,
    };

    const { updatedTask: taskAfterCoord } = applyCoordinationDecision(
      taskWithC1,
      draft3.id,
      coordinationResult,
      '主笔甲',
      [c1.id, c2.id]
    );

    const cmtCoord1 = taskAfterCoord.reviewComments.find((c) => c.id === c1.id)!;
    const cmtCoord2 = taskAfterCoord.reviewComments.find((c) => c.id === c2.id)!;

    // c1 产生 implement 事件
    const evCoord1 = cmtCoord1.events?.find((e) => e.actionType === 'implement');
    assert.ok(evCoord1, 'c1 应该记录 implement 事件');
    assert.equal(evCoord1?.afterContent, coordinationText);

    // c2 不在 targetB 上做直接文本替换，记录 accept_pending
    const evCoord2 = cmtCoord2.events?.find((e) => e.actionType === 'accept_pending');
    assert.ok(evCoord2, 'c2 应该记录 accept_pending 事件，不伪造正文改写');
    assert.equal(evCoord1?.operationId, evCoord2?.operationId, '协调同一批操作应当共用 operationId');
  }

  // =========================================================================
  // Group D: 人工重绑定目标段落
  // =========================================================================
  console.log('Group D: 人工重指定目标段落保留原始归属与新目标...');
  {
    const task = prepareTaskFixture();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const comment = task.reviewComments[0];
    const originalBlockId = comment.targetBlockId;
    const newBlock = draft.blocks[draft.blocks.length - 1];
    assert.notEqual(originalBlockId, newBlock.id);

    const { updatedTask: taskAfterRebind } = rebindReviewCommentTargetBlock(
      task,
      comment.id,
      newBlock.id,
      '主笔甲',
      '原第1段已拆分，现将意见转移至末段继续跟踪落实'
    );

    const cmt = taskAfterRebind.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt.currentBlockId, newBlock.id, '当前有效目标段落应当更新为新段落');
    assert.equal(cmt.targetBlockId, originalBlockId, '原始提出时的 targetBlockId 保持不变（存证不篡改）');
    assert.equal(cmt.rebindRecord?.toBlockId, newBlock.id);
    assert.equal(cmt.events?.length, 1);
    const ev = cmt.events![0];
    assert.equal(ev.actionType, 'rebind');
    assert.equal(ev.originalBlockId, originalBlockId);
    assert.equal(ev.targetBlockId, newBlock.id);
    assert.ok(ev.notes.includes('原第1段已拆分'));
  }

  // =========================================================================
  // Group E: 安全撤销与重新落实
  // =========================================================================
  console.log('Group E: 安全撤销后正文恢复、意见恢复、履历追加撤销凭据并支持重新落实...');
  {
    const task = prepareTaskFixture();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    // 使用有明确关联的第2段和CMT-03
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;
    const initialText = block.content;

    // 1. 采纳落实
    const adoptedText = `${initialText} 【任务30安全撤销测试】`;
    const runIdE = 'RUN-GROUP-E-TEST';
    const adoptResE = adoptParagraphSuggestion({
      task,
      currentDraft: draft,
      suggestion: {
        action: 'replace',
        targetParagraphOrder: block.order,
        targetBlockId: block.id,
        suggestedText: adoptedText,
        sourceCommentId: comment.id,
        runId: runIdE,
        baseContent: initialText,
        isReviewerReplacement: true,
      },
      pendingTextToAdopt: adoptedText,
      activeCompletedRunId: runIdE,
      activeRole: '主笔甲',
    });

    const taskAfterAdopt = adoptResE.updatedTask;
    const cmtAdopted = taskAfterAdopt.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmtAdopted.status, 'implemented');
    assert.equal(cmtAdopted.events?.length, 1);
    const implEv = cmtAdopted.events![0];

    // 2. 执行安全撤销
    const modLog = taskAfterAdopt.modificationLogs[0];
    assert.ok(modLog, '应当存在修改日志');
    const undoRes = undoSafeParagraphModification(taskAfterAdopt, adoptResE.workingDraft, modLog.id, '主笔甲');
    assert.ok(undoRes.updatedTask);

    const revertedDraft = undoRes.updatedTask.drafts.find((d) => d.id === undoRes.updatedTask.currentDraftId)!;
    const revertedBlock = revertedDraft.blocks.find((b) => b.id === block.id)!;
    assert.equal(revertedBlock.content, initialText, '正文内容应当安全恢复至初版');

    const cmtUndone = undoRes.updatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmtUndone.status, comment.status, '意见状态应当恢复');
    assert.equal(cmtUndone.events?.length, 2, '应当保留原落实事件并追加撤销事件');
    const undoEv = cmtUndone.events![1];
    assert.equal(undoEv.actionType, 'undo');
    assert.equal(undoEv.undoneEventId, implEv.eventId);
    assert.equal(undoEv.undoneModificationLogId, modLog.id);
    assert.equal(undoEv.beforeStatus, 'implemented');
    assert.equal(undoEv.afterStatus, comment.status);

    // 3. 再次重新落实
    const reAdoptedText = `${initialText} 【二次微调终稿落实】`;
    const runIdE2 = 'RUN-GROUP-E2-TEST';
    const adoptResE2 = adoptParagraphSuggestion({
      task: undoRes.updatedTask,
      currentDraft: revertedDraft,
      suggestion: {
        action: 'replace',
        targetParagraphOrder: revertedBlock.order,
        targetBlockId: revertedBlock.id,
        suggestedText: reAdoptedText,
        sourceCommentId: comment.id,
        runId: runIdE2,
        baseContent: revertedBlock.content,
      },
      pendingTextToAdopt: reAdoptedText,
      activeCompletedRunId: runIdE2,
      activeRole: '主笔甲',
    });
    const cmtReAdopted = adoptResE2.updatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmtReAdopted.status, 'implemented');
    assert.equal(cmtReAdopted.events?.length, 3, '应当追加第三个事件');
    assert.equal(cmtReAdopted.events![2].actionType, 'implement');
    assert.equal(cmtReAdopted.events![2].afterContent, reAdoptedText);
  }

  // =========================================================================
  // Group F: 轮次回看与历史稿深度冻结（frozenReviewComments 隔离）
  // =========================================================================
  console.log('Group F: 历史稿 frozenReviewComments 深度隔离与轮次回看说明...');
  {
    const task = prepareTaskFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;

    // R1 研判
    const { updatedTask: task1 } = updateReviewCommentDecision(
      task,
      comment.id,
      'need_discussion',
      'R1 阶段沟通：待沟通',
      '主笔甲'
    );

    // 提交送审 R1（生成送审基准）
    const submitRes = submitDraftForReview(task1, task1.currentDraftId, '主笔甲', true);
    const taskR1Submitted = submitRes.updatedTask;

    // 取得历史基准稿中的冻结意见
    const r1Draft = taskR1Submitted.drafts.find((d) => d.id === taskR1Submitted.reviewBaseDraftId)!;
    assert.ok(r1Draft.frozenReviewComments, '送审基准应当包含 frozenReviewComments');
    const frozenCmtR1 = r1Draft.frozenReviewComments.find((c) => c.id === comment.id)!;
    assert.equal(frozenCmtR1.events?.length, 1);
    assert.equal(frozenCmtR1.events![0].actionType, 'discuss');

    // 在 R2 工作稿中后续处理该意见：决定采纳并落实
    const draftWIP = taskR1Submitted.drafts.find((d) => d.id === taskR1Submitted.currentDraftId)!;
    const targetB = draftWIP.blocks[0];
    const { updatedTask: taskR2Impl } = implementReviewCommentWithText(
      taskR1Submitted,
      comment.id,
      draftWIP.id,
      `${targetB.content} R2落实`,
      'R2 实际写入',
      '主笔甲'
    );

    // 校验：当前工作稿上的意见有 2 个事件
    const currentCmt = taskR2Impl.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(currentCmt.events?.length, 2);

    // 校验：历史稿 r1Draft.frozenReviewComments 中的事件仍然只有 1 个，绝不被 R2 回写篡改
    const r1DraftAgain = taskR2Impl.drafts.find((d) => d.id === r1Draft.id)!;
    const frozenAgain = r1DraftAgain.frozenReviewComments?.find((c) => c.id === comment.id)!;
    assert.equal(frozenAgain.events?.length, 1, '历史送审基准中的冻结履历绝不回写新事件');
    assert.equal(frozenAgain.events![0].actionType, 'discuss');
  }

  // =========================================================================
  // Group G: 旧数据与破损数据防御（不伪造历史）
  // =========================================================================
  console.log('Group G: 旧数据无履历安全加载、损坏事件容错...');
  {
    // 1. 无 events 的旧意见
    const legacyComment: ReviewComment = {
      id: 'CMT-LEGACY-001',
      targetVersionId: 'DRAFT-V1',
      targetVersionNumber: 'v1.0',
      reviewer: '审阅乙',
      type: 'paragraph',
      targetBlockId: 'BLK-01',
      content: '旧意见内容',
      status: 'implemented',
      authorReply: '此前已落实',
      createdAt: '2026-10-01T10:00:00.000Z',
    };

    const trail = getCommentAuditTrail(legacyComment);
    assert.deepEqual(trail, [], '无事件时应安全返回空数组，不反推伪造历史');

    // 2. 含有损坏字段的事件安全容错
    const corruptedComment: ReviewComment = {
      ...legacyComment,
      events: [
        null as any,
        undefined as any,
        {
          eventId: 'EVT-CORRUPT-1',
          actionType: 'implement',
          // 缺失部分字段
        } as any,
      ],
    };
    const sanitizedTrail = getCommentAuditTrail(corruptedComment);
    assert.equal(sanitizedTrail.length, 1, '损坏与空元素应被安全过滤');
    assert.equal(sanitizedTrail[0].eventId, 'EVT-CORRUPT-1');
  }

  // =========================================================================
  // Group H: 角色权限与重复操作防抖
  // =========================================================================
  console.log('Group H: 重复提交防抖与幂等性保护...');
  {
    const task = prepareTaskFixture();
    const comment = task.reviewComments[0];

    // 快速重复触发 decision
    const { updatedTask: task1 } = updateReviewCommentDecision(
      task,
      comment.id,
      'need_discussion',
      '讨论理由A：回复A',
      '主笔甲'
    );
    const cmt1 = task1.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt1.events?.length, 1);

    // 模拟完全相同的重放操作
    const duplicateEvent = { ...cmt1.events![0] };
    const deduplicatedComment = appendCommentAuditEvent(cmt1, duplicateEvent);
    assert.equal(deduplicatedComment.events?.length, 1, '相同 eventId 不应重复追加');
  }

  // =========================================================================
  // Group I: 只读与取消操作零副作用
  // =========================================================================
  console.log('Group I: 查看与交互零副作用...');
  {
    const task = prepareTaskFixture();
    const initialEvents = task.reviewComments[0].events || [];

    // 仅查询履历
    const trail = getCommentAuditTrail(task.reviewComments[0]);
    assert.deepEqual(task.reviewComments[0].events || [], initialEvents);
  }

  // =========================================================================
  // Group J: 修改日志超过20条后凭据依然完整可查
  // =========================================================================
  console.log('Group J: 修改日志超20条后凭据依然完整保留正文快照...');
  {
    const task = prepareTaskFixture();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;

    // 落实并记录
    const { updatedTask: taskAfterImpl } = implementReviewCommentWithText(
      task,
      comment.id,
      draft.id,
      `${block.content} 【凭据持久性测试】`,
      '已改写',
      '主笔甲'
    );

    // 人工灌入 25 条其他修改日志，使 task.modificationLogs > 20
    const bloatedTask: Task = {
      ...taskAfterImpl,
      modificationLogs: Array.from({ length: 30 }, (_, idx) => ({
        id: `DUMMY-LOG-${idx}`,
        targetBlockId: `BLK-${idx}`,
        targetParagraphOrder: idx + 1,
        beforeContent: `旧内容 ${idx}`,
        afterContent: `新内容 ${idx}`,
        source: 'ai_suggestion' as const,
        operatorRole: '主笔甲' as const,
        appliedAt: new Date(Date.now() - (30 - idx) * 1000).toISOString(),
        revisionSeq: idx + 1,
      })),
    };

    const cmt = bloatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt.events?.length, 1);
    const ev = cmt.events![0];
    assert.ok(ev.beforeContent, '正文前快照保存在事件中，不受日志截断影响');
    assert.ok(ev.afterContent, '正文后快照保存在事件中，不受日志截断影响');
  }

  // =========================================================================
  // Group K: 真实组件挂载与交互完整旅程 (ReviewCommentAuditTrailModal)
  // =========================================================================
  console.log('Group K: 真实组件挂载与交互履历弹窗展示...');
  {
    const task = prepareTaskFixture();
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;
    const initialText = block.content;

    // 经历：研判 -> 落实 -> 安全撤销 -> 重新采纳
    let currentTask = updateReviewCommentDecision(
      task,
      comment.id,
      'need_discussion',
      '先与审阅人沟通表述口径：预约明天沟通',
      '主笔甲'
    ).updatedTask;

    const implementedText = `${initialText} 【组件渲染落实文本】`;
    currentTask = implementReviewCommentWithText(
      currentTask,
      comment.id,
      draft.id,
      implementedText,
      '已沟通一致并直接落实',
      '主笔甲'
    ).updatedTask;

    const cmtToRender = currentTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmtToRender.events?.length, 2);

    let modalClosed = false;
    const ui = mount(
      <ReviewCommentAuditTrailModal
        isOpen={true}
        onClose={() => { modalClosed = true; }}
        comment={cmtToRender}
        task={currentTask}
        currentDraft={draft}
        activeRole="主笔甲"
      />
    );

    // 验证弹窗渲染内容
    assert.ok(ui.host.querySelector('[data-testid="review-comment-audit-trail-modal"]'), '弹窗主体应当正确渲染');
    assert.ok(ui.host.textContent?.includes('单条审阅意见处理履历与落实凭据'));
    assert.ok(ui.host.textContent?.includes('原始提出归属'));
    assert.ok(ui.host.textContent?.includes('当前处理目标'));
    assert.ok(ui.host.textContent?.includes('当前处理状态'));

    // 验证事件时间线
    assert.ok(ui.host.textContent?.includes('先与审阅人沟通表述口径'));
    assert.ok(ui.host.textContent?.includes('已沟通一致并直接落实'));
    assert.ok(ui.host.textContent?.includes('落实前正文'));
    assert.ok(ui.host.textContent?.includes('实际落实正文'));

    // 点击关闭按钮
    clickText(ui.host, '关闭');
    assert.equal(modalClosed, true, '关闭按钮应当触发回调');
    ui.close();

    // 测试在轮次回看上下文中渲染
    const historyUi = mount(
      <ReviewCommentAuditTrailModal
        isOpen={true}
        onClose={() => {}}
        comment={cmtToRender}
        task={currentTask}
        isHistoricalContext={true}
        historicalRoundNumber={1}
      />
    );
    assert.ok(historyUi.host.textContent?.includes('展示该意见当前处理履历，可能包含本轮送审后的处理，不代表本轮结束时的冻结结论'));
    historyUi.close();
  }

  // =========================================================================
  // Group L: 综合回归与定稿规则保持（待落实/待沟通继续阻断定稿）
  // =========================================================================
  console.log('Group L: 定稿规则无回归（待落实与待沟通继续阻断定稿）...');
  {
    const task = prepareTaskFixture();
    const comment = task.reviewComments[0];

    // 设置为 accepted_pending_implementation
    const { updatedTask: pendingTask } = updateReviewCommentDecision(
      task,
      comment.id,
      'accepted_pending_implementation',
      '已采纳待落实',
      '主笔甲'
    );
    const valPending = validateFinalizationConditions(pendingTask);
    assert.equal(valPending.canFinalize, false, '存在待落实意见必须阻断定稿');
    assert.equal(valPending.checks.commentsClosed, false, 'commentsClosed 检查必须为 false');
    assert.ok(valPending.reasons.some((r) => r.includes('决定采纳待落实')));

    // 设置为 need_discussion
    const { updatedTask: discussTask } = updateReviewCommentDecision(
      task,
      comment.id,
      'need_discussion',
      '待沟通商榷',
      '主笔甲'
    );
    const valDiscuss = validateFinalizationConditions(discussTask);
    assert.equal(valDiscuss.canFinalize, false, '存在待沟通意见必须阻断定稿');
    assert.equal(valDiscuss.checks.commentsClosed, false, 'commentsClosed 检查必须为 false');
    assert.ok(valDiscuss.reasons.some((r) => r.includes('待沟通')));
  }

  console.log('--- Task 30 所有综合测试通过！ ---');
}

runTests().catch((err) => {
  console.error('Task 30 测试失败：', err);
  process.exit(1);
});
