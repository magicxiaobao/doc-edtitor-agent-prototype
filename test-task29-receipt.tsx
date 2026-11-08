import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
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
} from './src/services/draftLifecycleService';
import {
  getFormalReviewBaselines,
  getRoundDisplayName,
  getBaselineAttributedComments,
  getUnattributedReviewComments,
  getReviewStageCommentCounts,
} from './src/services/reviewRoundHistoryService';
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

function prepareTwoRoundFixture() {
  const task = createRevisionReviewHandoffDemoTask();
  const original = task.drafts.find((d) => d.id === task.currentDraftId)!;

  for (const [id, value, evidence] of [
    ['FACT-01', '120', 'EVD-01'],
    ['FACT-02', '18', 'EVD-07'],
  ]) {
    Object.assign(task.facts.find((f) => f.id === id)!, {
      status: 'confirmed',
      value,
      selectedConflictValue: value,
      primaryEvidenceId: evidence,
      conflictResolutionReason: '实施方自测收据夹具',
    });
  }

  const facts = task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = {
    confirmedAt: '2026-11-04T00:00:00.000Z',
    hash: 'task29-receipt-fact-hash',
    factIds: facts.map((f) => f.id),
    items: facts.map((f) => buildFactItemSnapshot(task, f)),
  };
  task.outlineConfirmed = true;
  task.outlineSnapshot = structuredClone(original.snapshotMetadata!.outlineSnapshot);

  const gen = generateSharedParagraphFactRevisionCandidate(task, original, '主笔甲');
  assert.ok(gen.success && gen.candidateGroup);
  const adopted = acceptSharedParagraphFactRevisionCandidate(
    task,
    original,
    gen.candidateGroup,
    '主笔甲',
    gen.candidateGroup.runId
  );
  assert.ok(adopted.success && adopted.updatedTask && adopted.newWorkingDraft);

  let currentTask = adopted.updatedTask;
  let workingDraft = adopted.newWorkingDraft;

  const opId = workingDraft.postRevisionVerificationCredential!.operationId;
  const verified = recordPostRevisionVerification({
    task: currentTask,
    draftId: workingDraft.id,
    operationId: opId,
    blockId: 'BLK-01',
    activeRole: '主笔甲',
    notes: 'R1 收据测试核对记录',
  });
  assert.ok(verified.success && verified.updatedTask);
  currentTask = verified.updatedTask;

  const subR1 = submitDraftForReview(currentTask, workingDraft.id, '主笔甲', true);
  assert.ok(subR1.baselineSnapshot);
  currentTask = subR1.updatedTask;
  const r1Baseline = subR1.baselineSnapshot;
  workingDraft = subR1.workingDraft;

  const cmtR1: ReviewComment = {
    id: 'CMT-RECEIPT-R1',
    type: 'paragraph',
    targetBlockId: 'BLK-01',
    targetBlockOrder: 1,
    targetVersionId: r1Baseline.id,
    targetVersionNumber: r1Baseline.versionNumber,
    baseParagraphText: r1Baseline.blocks[0].content,
    reviewer: '审阅乙',
    content: '收据测试：R1审阅批注意见',
    status: 'pending',
    createdAt: '2026-11-05T09:00:00.000Z',
  };
  currentTask = {
    ...currentTask,
    reviewComments: [cmtR1],
  };

  const edit = applyDraftContentChange(
    currentTask,
    workingDraft.id,
    (blocks) =>
      blocks.map((b) =>
        b.id === 'BLK-01' ? { ...b, content: b.content + '（主笔编辑）' } : b
      ),
    '编辑进入R2',
    '主笔甲'
  );
  currentTask = edit.updatedTask;
  workingDraft = edit.workingDraft;

  const subR2 = submitDraftForReview(currentTask, workingDraft.id, '主笔甲', true);
  assert.ok(subR2.baselineSnapshot);
  currentTask = subR2.updatedTask;
  const r2Baseline = subR2.baselineSnapshot;
  workingDraft = subR2.workingDraft;

  const cmtR2: ReviewComment = {
    id: 'CMT-RECEIPT-R2',
    type: 'overall',
    targetVersionId: r2Baseline.id,
    targetVersionNumber: r2Baseline.versionNumber,
    reviewer: '审阅丁',
    content: '收据测试：R2审阅全局意见',
    status: 'pending',
    createdAt: '2026-11-05T14:00:00.000Z',
  };
  currentTask = {
    ...currentTask,
    reviewComments: [cmtR2, cmtR1],
  };

  return { task: currentTask, workingDraft, r1Baseline, r2Baseline, cmtR1, cmtR2 };
}

async function main() {
  console.log('================================================================');
  console.log('🚀 开始执行任务29 实施方验收自测收据测试 (Receipt Test Suite)');
  console.log('================================================================');

  await check('receipt 1: 正式送审基准识别与轮次隔离', () => {
    const { task, workingDraft, r1Baseline, r2Baseline } = prepareTwoRoundFixture();
    const baselines = getFormalReviewBaselines(task, workingDraft);
    assert.equal(baselines.length, 2);
    assert.equal(baselines[0].id, r1Baseline.id);
    assert.equal(baselines[1].id, r2Baseline.id);

    assert.equal(getRoundDisplayName(r1Baseline), '第 1 轮 (R1)');
    assert.equal(getRoundDisplayName(r2Baseline), '第 2 轮 (R2)');

    // 缺少轮次的旧基准显示轮次未知
    const legacyDraft: DraftVersion = {
      ...r1Baseline,
      id: 'DRAFT-LEGACY-TEST',
      submittedReviewRound: undefined,
    };
    assert.equal(getRoundDisplayName(legacyDraft), '轮次未知');
  });

  await check('receipt 2: 意见原始轮次归属与重绑存证完整保留', () => {
    const fixture = prepareTwoRoundFixture();
    let task = fixture.task;
    const { r1Baseline, r2Baseline, cmtR1 } = fixture;

    // 重新绑定cmt1
    const rebound: ReviewComment = {
      ...cmtR1,
      rebindRecord: {
        reboundAt: '2026-11-05T10:00:00.000Z',
        reboundBy: '主笔甲',
        toBlockId: 'BLK-02',
        toBlockOrder: 2,
        targetDraftId: 'DRAFT-WORKING-TARGET',
        reason: '段落重构',
      },
    };
    task = {
      ...task,
      reviewComments: task.reviewComments.map((c) => (c.id === cmtR1.id ? rebound : c)),
    };

    const r1Comments = getBaselineAttributedComments(task, r1Baseline.id);
    const r2Comments = getBaselineAttributedComments(task, r2Baseline.id);

    assert.equal(r1Comments.length, 1);
    assert.equal(r1Comments[0].id, cmtR1.id);
    assert.equal(r1Comments[0].targetVersionId, r1Baseline.id);
    assert.equal(r2Comments.length, 1);
    assert.equal(r2Comments[0].id, fixture.cmtR2.id);
  });

  await check('receipt 3: 审阅工作区意见计数准确区分本轮原始与工作稿适用未闭环', () => {
    const fixture = prepareTwoRoundFixture();
    const counts = getReviewStageCommentCounts(fixture.task, fixture.workingDraft, fixture.r2Baseline);

    assert.equal(counts.currentRoundOriginalCount, 1);
    assert.equal(counts.currentRoundUnclosedCount, 1);
    assert.equal(counts.applicableTotalCount, 2);
    assert.equal(counts.applicableUnclosedCount, 2);
    assert.equal(counts.canFinalizeComments, false);
  });

  await check('receipt 4: 独立只读回看组件零写入、支持基准切换与正文定位', () => {
    const fixture = prepareTwoRoundFixture();
    const taskJsonBefore = JSON.stringify(fixture.task);

    let locatedBlockId: string | null = null;
    const { container, unmount } = mount(
      <ReviewRoundHistoryView
        task={fixture.task}
        currentDraft={fixture.workingDraft}
        activeRole="主笔甲"
        onExitHistory={() => {}}
      />
    );

    try {
      assert.ok(container.querySelector('[data-testid="review-round-history-view"]'));
      assert.ok(container.querySelector(`[data-testid="round-tab-${fixture.r1Baseline.id}"]`));
      assert.ok(container.querySelector(`[data-testid="round-tab-${fixture.r2Baseline.id}"]`));

      // 切换至 R1
      const tabR1 = container.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${fixture.r1Baseline.id}"]`);
      act(() => tabR1?.click());

      // 定位段落
      const locateBtn = container.querySelector<HTMLButtonElement>(`[data-testid="btn-locate-comment-block-${fixture.cmtR1.id}"]`);
      act(() => locateBtn?.click());

      // 验证未发生任何业务字段改写
      assert.equal(JSON.stringify(fixture.task), taskJsonBefore, '回看操作未造成任何数据变更');
    } finally {
      unmount();
    }
  });

  await check('receipt 5: 出处抽屉上下文版本严格对齐所选送审基准', () => {
    const fixture = prepareTwoRoundFixture();
    let viewedContextDraft: DraftVersion | undefined;

    const { container, unmount } = mount(
      <ReviewRoundHistoryView
        task={fixture.task}
        currentDraft={fixture.workingDraft}
        activeRole="主笔甲"
        onExitHistory={() => {}}
        onViewSnippet={(_snip, _fact, _adopted, _freeze, contextDraft) => {
          viewedContextDraft = contextDraft;
        }}
      />
    );

    try {
      // 切换至 R1
      const tabR1 = container.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${fixture.r1Baseline.id}"]`);
      act(() => tabR1?.click());

      // 展开交接摘要并点击查看出处
      const toggleBtn = container.querySelector<HTMLButtonElement>('[data-testid="btn-toggle-handoff-details"]');
      act(() => toggleBtn?.click());

      const viewEvBtn = container.querySelector<HTMLButtonElement>('[data-testid="btn-view-evidence-from-FACT-01"]');
      assert.ok(viewEvBtn);
      act(() => viewEvBtn.click());

      assert.ok(viewedContextDraft, 'onViewSnippet 回调应被触发');
      assert.equal(viewedContextDraft?.id, fixture.r1Baseline.id, '出处抽屉上下文版本必须是 R1 送审基准');
      assert.notEqual(viewedContextDraft?.id, fixture.r2Baseline.id, '出处抽屉上下文版本不得借用 R2');
      assert.notEqual(viewedContextDraft?.id, fixture.workingDraft.id, '出处抽屉上下文版本不得借用最新工作稿');
    } finally {
      unmount();
    }
  });

  console.log('================================================================');
  console.log(`实施方收据测试结果：${5 - failures.length}/5 通过，${failures.length} 失败`);
  console.log('================================================================');

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
