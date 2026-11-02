import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import {
  createPresetTask,
  createRevisionReviewHandoffDemoTask,
  createSharedParagraphRevisionDemoTask,
} from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
} from './src/services/factRevisionCandidateService';
import {
  recordPostRevisionVerification,
  deferPostRevisionVerification,
} from './src/services/postRevisionVerificationService';
import {
  submitDraftForReview,
  applyDraftContentChange,
  restoreDraftVersion,
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
import type { Task, DraftVersion } from './src/types';

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

function createFixture() {
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
    hash: 'task28-receipt-fixture',
    factIds: facts.map((f) => f.id),
    items: facts.map((f) => buildFactItemSnapshot(task, f)),
  };
  task.outlineConfirmed = true;
  task.outlineSnapshot = structuredClone(source.snapshotMetadata!.outlineSnapshot);

  const gen = generateSharedParagraphFactRevisionCandidate(task, source, '主笔甲');
  assert.equal(gen.success, true, gen.reason);
  const acc = acceptSharedParagraphFactRevisionCandidate(task, source, gen.candidateGroup!, '主笔甲', gen.candidateGroup!.runId);
  assert.equal(acc.success, true, acc.reason);

  return { task: acc.updatedTask!, draft: acc.newWorkingDraft!, source };
}

async function runReceiptTests() {
  console.log('--- 任务28：事实修订送审交接摘要（第一批）收据验收测试 ---');

  await check('1.1 送审确认弹窗展示紧凑交接摘要并准确提示核对进度', async () => {
    const { task, draft } = createFixture();
    const opId = draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task,
      draftId: draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '收据测试：核对首段',
    });
    let currentTask = r1.updatedTask!;

    const { container, unmount } = mount(
      <DraftingStage
        task={currentTask}
        onUpdateTask={(up) => {
          currentTask = { ...currentTask, ...up };
        }}
        onProceedToNextStage={() => {}}
        activeRole="主笔甲"
      />
    );

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('提交本轮审阅')
    );
    assert.ok(submitBtn);
    act(() => {
      submitBtn.click();
    });

    const modal = container.querySelector('[role="dialog"][aria-label="提交本轮审阅确认"]');
    assert.ok(modal);
    assert.ok(modal.textContent?.includes('第 1 轮'));
    assert.ok(modal.textContent?.includes('2 项'));
    assert.ok(modal.textContent?.includes('3 个'));

    const reminder = container.querySelector('[data-testid="submit-review-pending-reminder"]');
    assert.ok(reminder);
    assert.ok(reminder.textContent?.includes('仍有 2 段'));

    unmount();
  });

  await check('1.2 确认提交创建带有完整事实修订交接的只读审阅基准快照', async () => {
    const { task, draft } = createFixture();
    const opId = draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task,
      draftId: draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '确认提交核对记录',
    });
    const r2 = deferPostRevisionVerification({
      task: r1.updatedTask!,
      draftId: draft.id,
      operationId: opId,
      blockId: 'BLK-02',
      activeRole: '主笔甲',
      reason: '需要向科室复核',
    });

    const sub = submitDraftForReview(r2.updatedTask!, draft.id, '主笔甲', true);
    assert.ok(sub.baselineSnapshot);
    assert.equal(sub.baselineSnapshot.submittedReviewRound, 1);
    assert.equal(sub.baselineSnapshot.isHistoricalSnapshot, true);

    const summary = buildRevisionReviewHandoffSummary(sub.updatedTask, sub.baselineSnapshot, sub.workingDraft);
    assert.equal(summary.hasFormalBaseline, true);
    assert.equal(summary.verifiedCount, 1);
    assert.equal(summary.deferredCount, 1);
    assert.equal(summary.pendingCount, 2);
    assert.equal(summary.isAllVerified, false);
    assert.equal(summary.facts.length, 2);
    assert.equal(summary.blocks.length, 3);
  });

  await check('1.3 审阅页展示本轮事实修订说明、醒目免责声明与四份冻结出处入口', async () => {
    const { task, draft } = createFixture();
    const sub = submitDraftForReview(task, draft.id, '主笔甲', true);
    let currentTask = sub.updatedTask;

    const { container, unmount } = mount(
      <ReviewStage
        task={currentTask}
        onUpdateTask={(up) => {
          currentTask = { ...currentTask, ...up };
        }}
        onProceedToNextStage={() => {}}
        onViewSnippet={() => {}}
        activeRole="审阅乙"
      />
    );

    const banner = container.querySelector('[data-testid="revision-review-handoff-banner"]');
    assert.ok(banner);
    assert.ok(banner.textContent?.includes('主笔人工核对记录仅供审阅参考'));

    const expandBtn = container.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    assert.ok(expandBtn);
    act(() => {
      expandBtn.click();
    });

    // 检查四份冻结出处入口
    assert.ok(container.querySelector('[data-testid="btn-view-evidence-from-FACT-01"]'));
    assert.ok(container.querySelector('[data-testid="btn-view-evidence-to-FACT-01"]'));
    assert.ok(container.querySelector('[data-testid="btn-view-evidence-from-FACT-02"]'));
    assert.ok(container.querySelector('[data-testid="btn-view-evidence-to-FACT-02"]'));

    unmount();
  });

  await check('1.4 审阅乙针对送审段落提出意见并准确绑定审阅基准和BlockID', async () => {
    const { task, draft } = createFixture();
    const sub = submitDraftForReview(task, draft.id, '主笔甲', true);
    let currentTask = sub.updatedTask;

    const { container, unmount } = mount(
      <ReviewStage
        task={currentTask}
        onUpdateTask={(up) => {
          currentTask = { ...currentTask, ...up };
        }}
        onProceedToNextStage={() => {}}
        onViewSnippet={() => {}}
        activeRole="审阅乙"
      />
    );

    const expandBtn = container.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    act(() => {
      expandBtn.click();
    });

    const cmtBtn = container.querySelector('[data-testid="btn-comment-block-BLK-01"]') as HTMLButtonElement;
    assert.ok(cmtBtn);
    act(() => {
      cmtBtn.click();
    });

    const textarea = container.querySelector('textarea[placeholder*="详细描述具体的修改意见"]') as HTMLTextAreaElement;
    assert.ok(textarea);
    act(() => {
      simulateTextareaChange(textarea, '审阅收据测试意见：请核实首段表述。');
    });

    const form = textarea.closest('form');
    act(() => {
      form?.dispatchEvent(new (dom.window as any).Event('submit', { bubbles: true, cancelable: true }));
    });

    const newComment = currentTask.reviewComments.find((c) => c.content.includes('审阅收据测试意见'));
    assert.ok(newComment);
    assert.equal(newComment.targetBlockId, 'BLK-01');
    assert.equal(newComment.targetVersionId, currentTask.reviewBaseDraftId);
    assert.equal(newComment.reviewer, '审阅乙');

    unmount();
  });

  await check('1.5 未送审工作稿回退不冒充正式送审快照且损坏凭据安全降级', async () => {
    const rawTask = createRevisionReviewHandoffDemoTask();
    const workingDraft = rawTask.drafts[0];
    const summary = buildRevisionReviewHandoffSummary(rawTask, workingDraft, workingDraft);

    assert.equal(summary.hasFormalBaseline, false);
    assert.equal(summary.isFallbackOnly, true);
    assert.ok(summary.statusSummaryText.includes('尚未提交本轮审阅'));
    assert.equal(summary.isAllVerified, false);
    assert.equal(summary.hasCredential, false);
  });

  if (failures.length > 0) {
    console.error(`\n❌ 收据测试失败项 (${failures.length}):\n${failures.join('\n')}`);
    process.exit(1);
  } else {
    console.log('\n🎉 任务28 收据验收测试全部通过！');
    process.exit(0);
  }
}

runReceiptTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
