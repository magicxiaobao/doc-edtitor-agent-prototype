import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
import {
  updateReviewCommentDecision,
  implementReviewCommentWithText,
  rebindReviewCommentTargetBlock,
} from './src/services/reviewCoordinationService';
import {
  submitDraftForReview,
  adoptParagraphSuggestion,
  undoSafeParagraphModification,
} from './src/services/draftLifecycleService';
import {
  getCommentAuditTrail,
} from './src/services/reviewCommentAuditService';
import { ReviewCommentAuditTrailModal } from './src/components/ReviewCommentAuditTrailModal';
import { ReviewRoundHistoryView } from './src/components/ReviewRoundHistoryView';
import type { Task, ReviewComment, DraftVersion } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL: ${name}\n${String(e)}`);
  }
}

function mount(el: React.ReactElement) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function prepareFixture(): Task {
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
        conflictResolutionReason: '任务30验收专用',
      });
    }
  }
  return task;
}

async function runReceiptTests() {
  console.log('================================================================');
  console.log('Task 30 审阅意见处理履历与落实凭据 核心验收凭据验证');
  console.log('================================================================\n');

  // 凭据 1：原始意见来自哪个版本、哪个正式轮次、哪个段落完整存证
  await check('凭据 1: 原始归属版本、正式轮次、原始段落与基准文本严格存证不被改写', async () => {
    const task = prepareFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const origVersion = comment.targetVersionId;
    const origBlock = comment.targetBlockId;

    // 执行重绑定到新段落
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const lastBlock = draft.blocks[draft.blocks.length - 1];
    const { updatedTask } = rebindReviewCommentTargetBlock(task, comment.id, lastBlock.id, '主笔甲', '段落重构重绑');
    const reboundCmt = updatedTask.reviewComments.find((c) => c.id === comment.id)!;

    assert.equal(reboundCmt.targetVersionId, origVersion, '原始目标版本ID不可被篡改');
    assert.equal(reboundCmt.targetBlockId, origBlock, '原始提出时的 targetBlockId 保持不变');
    assert.equal(reboundCmt.currentBlockId, lastBlock.id, '当前处理目标段落单独存证');
    assert.equal(reboundCmt.rebindRecord?.toBlockId, lastBlock.id, '重绑记录准确记录新目标');
    assert.equal(reboundCmt.events?.length, 1);
    assert.equal(reboundCmt.events![0].actionType, 'rebind');
    assert.equal(reboundCmt.events![0].originalBlockId, origBlock);
    assert.equal(reboundCmt.events![0].targetBlockId, lastBlock.id);
  });

  // 凭据 2：主笔先后做过哪些研判、沟通、重绑和落实按时序完整记录
  await check('凭据 2: 研判、沟通、重绑和落实完整时序链条及操作说明记录', async () => {
    let task = prepareFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;

    // 1. 沟通
    task = updateReviewCommentDecision(task, comment.id, 'need_discussion', '待与业务部门确认口径：已约谈', '主笔甲').updatedTask;
    // 2. 待落实
    task = updateReviewCommentDecision(task, comment.id, 'accepted_pending_implementation', '业务部门同意采纳建议，待起草时修改', '主笔甲').updatedTask;
    // 3. 落实
    task = implementReviewCommentWithText(task, comment.id, draft.id, `${block.content} 【已根据建议落实】`, '已完成正文修订', '主笔甲').updatedTask;

    const finalCmt = task.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(finalCmt.events?.length, 3);
    assert.equal(finalCmt.events![0].actionType, 'discuss');
    assert.equal(finalCmt.events![1].actionType, 'accept_pending');
    assert.equal(finalCmt.events![2].actionType, 'implement');

    assert.equal(finalCmt.events![0].beforeStatus, 'pending');
    assert.equal(finalCmt.events![0].afterStatus, 'need_discussion');
    assert.equal(finalCmt.events![1].beforeStatus, 'need_discussion');
    assert.equal(finalCmt.events![1].afterStatus, 'accepted_pending_implementation');
    assert.equal(finalCmt.events![2].beforeStatus, 'accepted_pending_implementation');
    assert.equal(finalCmt.events![2].afterStatus, 'implemented');
  });

  // 凭据 3：每次处理当时的说明、操作人、时间及状态前后变化
  await check('凭据 3: 每次事件包含明确操作人、时间戳、前后状态及业务说明', async () => {
    const task = prepareFixture();
    const comment = task.reviewComments[0];
    const { updatedTask } = updateReviewCommentDecision(
      task,
      comment.id,
      'rejected',
      '与最新行业规范不符，予以拒绝：已附规范文号',
      '主笔甲'
    );
    const cmt = updatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt.events?.length, 1);
    const ev = cmt.events![0];
    assert.equal(ev.operatorRole, '主笔甲');
    assert.ok(ev.timestamp);
    assert.equal(ev.beforeStatus, 'pending');
    assert.equal(ev.afterStatus, 'rejected');
    assert.ok(ev.notes.includes('与最新行业规范不符'));
  });

  // 凭据 4：哪次操作真正写入了正文，实际写入了什么（前/后正文真实快照）
  await check('凭据 4: 正文落实事件包含修改日志ID、稳定段落ID、落实前正文与实际写入正文', async () => {
    const task = prepareFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;
    const originalText = block.content;
    const targetText = `${originalText} 【落实凭据4验收文本】`;

    const { updatedTask } = implementReviewCommentWithText(
      task,
      comment.id,
      draft.id,
      targetText,
      '已根据意见改写正文',
      '主笔甲'
    );
    const cmt = updatedTask.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(cmt.events?.length, 1);
    const ev = cmt.events![0];
    assert.equal(ev.actionType, 'implement');
    assert.ok(ev.modificationLogId, '必须生成 modificationLogId');
    assert.equal(ev.blockId, block.id, '必须记录准确的 blockId');
    assert.equal(ev.beforeContent, originalText, '落实前正文完全吻合');
    assert.equal(ev.afterContent, targetText, '实际写入正文完全吻合');
  });

  // 凭据 5：后续安全撤销撤回了哪次落实，为什么意见恢复到相应状态
  await check('凭据 5: 安全撤销保留此前落实记录，准确关联被撤销落实事件与修改日志，状态精准回滚', async () => {
    const task = prepareFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const block = draft.blocks.find((b) => b.id === comment.targetBlockId)!;
    const initialText = block.content;

    const modifiedText = `${initialText} 【安全撤销前修改】`;
    const runId = 'RUN-RECEIPT-5';
    const adoptRes = adoptParagraphSuggestion({
      task,
      currentDraft: draft,
      suggestion: {
        action: 'replace',
        targetParagraphOrder: block.order,
        targetBlockId: block.id,
        suggestedText: modifiedText,
        sourceCommentId: comment.id,
        runId,
        baseContent: initialText,
      },
      pendingTextToAdopt: modifiedText,
      activeCompletedRunId: runId,
      activeRole: '主笔甲',
    });

    const modLog = adoptRes.updatedTask.modificationLogs[0];
    const undoRes = undoSafeParagraphModification(adoptRes.updatedTask, adoptRes.workingDraft, modLog.id, '主笔甲');
    const undoneCmt = undoRes.updatedTask.reviewComments.find((c) => c.id === comment.id)!;

    assert.equal(undoneCmt.status, comment.status, '意见状态精准恢复');
    assert.equal(undoneCmt.events?.length, 2, '历史落实记录完好保留，追加撤销记录');
    const implEv = undoneCmt.events![0];
    const undoEv = undoneCmt.events![1];
    assert.equal(implEv.actionType, 'implement');
    assert.equal(undoEv.actionType, 'undo');
    assert.equal(undoEv.undoneEventId, implEv.eventId, '明确关联被撤销的落实事件ID');
    assert.equal(undoEv.undoneModificationLogId, modLog.id, '明确关联被撤销的修改日志ID');
    assert.equal(undoEv.beforeStatus, 'implemented');
    assert.equal(undoEv.afterStatus, comment.status);
  });

  // 凭据 6：轮次回看明确告知当前处理履历不代表本轮送审时冻结结论；历史稿 frozenReviewComments 深度隔离
  await check('凭据 6: 轮次回看说明提示与历史稿冻结履历不受后续工作稿篡改', async () => {
    let task = prepareFixture();
    const comment = task.reviewComments.find((c) => c.type === 'paragraph' && c.targetBlockId)!;

    // R1 研判
    task = updateReviewCommentDecision(task, comment.id, 'need_discussion', 'R1 待沟通', '主笔甲').updatedTask;
    // 提交送审 R1
    const submitR1 = submitDraftForReview(task, task.currentDraftId, '主笔甲', true);
    task = submitR1.updatedTask;

    const r1Baseline = task.drafts.find((d) => d.id === task.reviewBaseDraftId)!;
    const frozenR1EventsCount = r1Baseline.frozenReviewComments?.find((c) => c.id === comment.id)?.events?.length || 0;
    assert.equal(frozenR1EventsCount, 1, 'R1 送审基准冻结履历数量为1');

    // 在 R2 工作稿中后续处理
    const wipDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetB = wipDraft.blocks.find((b) => b.id === comment.targetBlockId)!;
    task = implementReviewCommentWithText(task, comment.id, wipDraft.id, `${targetB.content} R2落实`, 'R2落实', '主笔甲').updatedTask;

    // 校验工作稿意见已追加至 2 个事件
    const currentCmt = task.reviewComments.find((c) => c.id === comment.id)!;
    assert.equal(currentCmt.events?.length, 2);

    // 校验历史基准依然只有 1 个事件
    const r1BaselineLater = task.drafts.find((d) => d.id === r1Baseline.id)!;
    const frozenR1LaterCount = r1BaselineLater.frozenReviewComments?.find((c) => c.id === comment.id)?.events?.length || 0;
    assert.equal(frozenR1LaterCount, 1, '历史基准 frozenReviewComments 绝对保持深度冻结');

    // 挂载弹窗并检查轮次回看提示语
    const { container, unmount } = mount(
      <ReviewCommentAuditTrailModal
        isOpen={true}
        onClose={() => {}}
        comment={currentCmt}
        task={task}
        isHistoricalContext={true}
        historicalRoundNumber={1}
      />
    );
    assert.ok(container.textContent?.includes('展示该意见当前处理履历，可能包含本轮送审后的处理，不代表本轮结束时的冻结结论'));
    unmount();
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} 项凭据验证失败:`, failures);
    process.exit(1);
  }
  console.log('\n================================================================');
  console.log('✅ 所有 Task 30 核心验收凭据全部通过验证！');
  console.log('================================================================');
}

runReceiptTests().catch((e) => {
  console.error('Fatal in receipt tests:', e);
  process.exit(1);
});
