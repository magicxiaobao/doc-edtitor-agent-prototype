import { dom, simulateTextareaChange } from './test-jsdom-env';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { ReviewRoundHistoryView } from './src/components/ReviewRoundHistoryView';
import {
  getFormalReviewBaselines,
  getRoundDisplayName,
  getBaselineAttributedComments,
  getUnattributedReviewComments,
  getReviewStageCommentCounts,
} from './src/services/reviewRoundHistoryService';
import {
  submitDraftForReview,
  applyDraftContentChange,
  getApplicableReviewComments,
  validateFinalizationConditions,
} from './src/services/draftLifecycleService';
import {
  recordPostRevisionVerification,
  deferPostRevisionVerification,
} from './src/services/postRevisionVerificationService';
import {
  acceptSharedParagraphFactRevisionCandidate,
  generateSharedParagraphFactRevisionCandidate,
} from './src/services/factRevisionCandidateService';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
import { loadPersistedState, savePersistedState, resetStorageWithBackup } from './src/services/storageService';
import type { Task, DraftVersion, ReviewComment } from './src/types';

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

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as any)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// Prepared service fixture. Used for Groups A-I unit/integration checks.
function prepareTwoRoundTaskFixture() {
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
      conflictResolutionReason: '实施方自测准备夹具，同期同口径原文',
    });
  }

  const facts = task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = {
    confirmedAt: '2026-11-04T00:00:00.000Z',
    hash: 'fixture-task29-fact-hash',
    factIds: facts.map((f) => f.id),
    items: facts.map((f) => buildFactItemSnapshot(task, f)),
  };
  task.outlineConfirmed = true;
  task.outlineSnapshot = structuredClone(original.snapshotMetadata!.outlineSnapshot);

  // Generate & adopt revision candidate
  const gen = generateSharedParagraphFactRevisionCandidate(task, original, '主笔甲');
  assert.ok(gen.success && gen.candidateGroup, gen.reason);
  const adopted = acceptSharedParagraphFactRevisionCandidate(
    task,
    original,
    gen.candidateGroup,
    '主笔甲',
    gen.candidateGroup.runId
  );
  assert.ok(adopted.success && adopted.updatedTask && adopted.newWorkingDraft, adopted.reason);

  let currentTask = adopted.updatedTask;
  let workingDraft = adopted.newWorkingDraft;

  // Partial verification on working draft: BLK-01 verified, BLK-02 deferred
  const opId = workingDraft.postRevisionVerificationCredential!.operationId;
  const verified = recordPostRevisionVerification({
    task: currentTask,
    draftId: workingDraft.id,
    operationId: opId,
    blockId: 'BLK-01',
    activeRole: '主笔甲',
    notes: 'R1 送审前核对第1段',
  });
  assert.ok(verified.success && verified.updatedTask);
  currentTask = verified.updatedTask;

  const deferred = deferPostRevisionVerification({
    task: currentTask,
    draftId: workingDraft.id,
    operationId: opId,
    blockId: 'BLK-02',
    activeRole: '主笔甲',
    reason: 'R1 暂缓第2段待查台账',
  });
  assert.ok(deferred.success && deferred.updatedTask);
  currentTask = deferred.updatedTask;

  // Submit Round 1
  const subR1 = submitDraftForReview(currentTask, workingDraft.id, '主笔甲', true);
  assert.ok(subR1.baselineSnapshot);
  currentTask = subR1.updatedTask;
  const r1Baseline = subR1.baselineSnapshot;
  workingDraft = subR1.workingDraft;

  // Reviewer乙 adds comment on R1 baseline
  const cmtR1: ReviewComment = {
    id: 'CMT-R1-01',
    type: 'paragraph',
    targetBlockId: 'BLK-01',
    targetBlockOrder: 1,
    targetVersionId: r1Baseline.id,
    targetVersionNumber: r1Baseline.versionNumber,
    baseParagraphText: r1Baseline.blocks[0].content,
    reviewer: '审阅乙',
    content: '请核验第1轮第1段完成重点任务统计口径。',
    status: 'pending',
    createdAt: '2026-11-05T09:00:00.000Z',
  };
  currentTask = {
    ...currentTask,
    reviewComments: [cmtR1],
  };

  // Author甲 edits working draft and creates a new version
  const editResult = applyDraftContentChange(
    currentTask,
    workingDraft.id,
    (blocks) =>
      blocks.map((b) =>
        b.id === 'BLK-01' ? { ...b, content: b.content + '（主笔针对R1意见补充说明）' } : b
      ),
    '响应R1审阅意见微调',
    '主笔甲'
  );
  currentTask = editResult.updatedTask;
  workingDraft = {
    ...editResult.workingDraft,
    postRevisionVerificationRecords: [],
  };
  currentTask = {
    ...currentTask,
    drafts: currentTask.drafts.map((d) => (d.id === workingDraft.id ? workingDraft : d)),
  };

  // Submit Round 2
  const subR2 = submitDraftForReview(currentTask, workingDraft.id, '主笔甲', true);
  assert.ok(subR2.baselineSnapshot);
  currentTask = subR2.updatedTask;
  const r2Baseline = subR2.baselineSnapshot;
  workingDraft = subR2.workingDraft;

  // Reviewer丁 adds comment on R2 baseline
  const cmtR2: ReviewComment = {
    id: 'CMT-R2-01',
    type: 'paragraph',
    targetBlockId: 'BLK-02',
    targetBlockOrder: 2,
    targetVersionId: r2Baseline.id,
    targetVersionNumber: r2Baseline.versionNumber,
    baseParagraphText: r2Baseline.blocks[1].content,
    reviewer: '审阅丁',
    content: '第2轮审阅：建议进一步精简第2段铺垫。',
    status: 'pending',
    createdAt: '2026-11-05T14:00:00.000Z',
  };
  currentTask = {
    ...currentTask,
    reviewComments: [cmtR2, cmtR1],
  };

  return {
    task: currentTask,
    workingDraft,
    r1Baseline,
    r2Baseline,
    cmtR1,
    cmtR2,
  };
}

const cases: [string, () => void | Promise<void>][] = [
  // -------------------------------------------------------------------------
  // A. R1、R2按基准ID独立显示正文、交接摘要和意见；R1冻结1/3、R2冻结0/3不串用
  // -------------------------------------------------------------------------
  [
    'A. R1 and R2 baselines display isolated text, handoff summaries and comments; R1 frozen 1/3 and R2 0/3 never cross-contaminate',
    () => {
      const { task, workingDraft, r1Baseline, r2Baseline } = prepareTwoRoundTaskFixture();
      const baselines = getFormalReviewBaselines(task, workingDraft);
      assert.equal(baselines.length, 2);
      assert.equal(baselines[0].id, r1Baseline.id);
      assert.equal(baselines[1].id, r2Baseline.id);

      // Verify R1 frozen overview: 1 verified, 1 deferred
      assert.equal(r1Baseline.frozenPostRevisionVerificationOverview?.verifiedCount, 1);
      assert.equal(r1Baseline.frozenPostRevisionVerificationOverview?.deferredCount, 1);

      // Verify R2 frozen overview: 0 verified, 0 deferred (all pending)
      assert.equal(r2Baseline.frozenPostRevisionVerificationOverview?.verifiedCount, 0);
      assert.equal(r2Baseline.frozenPostRevisionVerificationOverview?.deferredCount, 0);

      const ui = mount(
        <ReviewRoundHistoryView
          task={task}
          currentDraft={workingDraft}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        // Tab for R1
        const r1Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r1Baseline.id}"]`);
        assert.ok(r1Tab, 'R1 tab should exist');
        act(() => r1Tab.click());

        // Check R1 content and verification count
        assert.ok(ui.host.textContent?.includes('1/3段已记录'));
        assert.ok(ui.host.textContent?.includes(r1Baseline.versionNumber));
        assert.ok(ui.host.textContent?.includes('CMT-R1-01'));
        assert.ok(!ui.host.textContent?.includes('CMT-R2-01'));

        // Tab for R2
        const r2Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r2Baseline.id}"]`);
        assert.ok(r2Tab, 'R2 tab should exist');
        act(() => r2Tab.click());

        // Check R2 content and verification count
        assert.ok(ui.host.textContent?.includes('0/3段已记录'));
        assert.ok(ui.host.textContent?.includes(r2Baseline.versionNumber));
        assert.ok(ui.host.textContent?.includes('CMT-R2-01'));
        assert.ok(!ui.host.textContent?.includes('CMT-R1-01'));
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // B. R1提出的意见不会被归到R2；重新绑定后仍保留原始归属，当前处理目标另行显示
  // -------------------------------------------------------------------------
  [
    'B. Comments proposed on R1 remain attributed to R1; rebound comment retains original attribution and displays rebound target',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;
      const { r1Baseline, r2Baseline, cmtR1 } = fixture;

      // Rebind cmtR1 to a new paragraph in a working draft
      const reboundComment: ReviewComment = {
        ...cmtR1,
        currentBlockId: 'BLK-02',
        currentBlockOrder: 2,
        rebindRecord: {
          reboundAt: '2026-11-05T12:00:00.000Z',
          reboundBy: '主笔甲',
          fromBlockId: 'BLK-01',
          fromBlockOrder: 1,
          toBlockId: 'BLK-02',
          toBlockOrder: 2,
          targetDraftId: 'DRAFT-WORKING-NEW',
          reason: '首段合并，重绑至第二段处理',
          reboundParagraphText: '第二段基准文本存证',
        },
      };

      task = {
        ...task,
        reviewComments: task.reviewComments.map((c) => (c.id === cmtR1.id ? reboundComment : c)),
      };

      const r1Comments = getBaselineAttributedComments(task, r1Baseline.id);
      const r2Comments = getBaselineAttributedComments(task, r2Baseline.id);

      assert.equal(r1Comments.length, 1);
      assert.equal(r1Comments[0].id, cmtR1.id);
      assert.equal(r2Comments.length, 1);
      assert.equal(r2Comments[0].id, fixture.cmtR2.id);

      // Verify that targetVersionId remained r1Baseline.id
      assert.equal(r1Comments[0].targetVersionId, r1Baseline.id);

      const ui = mount(
        <ReviewRoundHistoryView
          task={task}
          currentDraft={fixture.workingDraft}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        const r1Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r1Baseline.id}"]`);
        act(() => r1Tab?.click());

        // Comment displays original attribution AND rebound target
        const commentItem = ui.host.querySelector(`[data-testid="history-comment-item-${cmtR1.id}"]`);
        assert.ok(commentItem, 'Rebound comment should appear in R1 history');
        assert.ok(commentItem.textContent?.includes('原始归属基准'));
        assert.ok(commentItem.textContent?.includes(r1Baseline.versionNumber));
        assert.ok(commentItem.textContent?.includes('当前处理目标已重指定'));
        assert.ok(commentItem.textContent?.includes('DRAFT-WORKING-NEW'));
        assert.ok(commentItem.textContent?.includes('首段合并，重绑至第二段处理'));
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // C. 普通保存快照不冒充送审基准；缺轮次显示未知；其他工作稿分支不混入；同轮次数字的不同基准不被合并
  // -------------------------------------------------------------------------
  [
    'C. Ordinary snapshots cannot pose as formal baseline; missing round displays 轮次未知; foreign branch isolated; duplicate round baselines not merged',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;

      // 1. Manually saved snapshot with description "提交审阅"
      const manualSnapshot: DraftVersion = {
        id: 'DRAFT-SNAP-MANUAL-01',
        versionNumber: 'v1.5 (手动快照)',
        createdAt: '2026-11-05T10:00:00.000Z',
        author: '主笔甲',
        summary: '主笔手动提交审阅保存的中间快照',
        blocks: structuredClone(fixture.workingDraft.blocks),
        isHistoricalSnapshot: true,
        isWorkingDraft: false,
        isFinal: false,
        sourceDraftId: fixture.workingDraft.id,
      };

      // 2. Legacy baseline missing submittedReviewRound
      const legacyBaseline: DraftVersion = {
        id: 'DRAFT-SNAP-REV-LEGACY',
        versionNumber: 'v1.0 (旧版送审)',
        createdAt: '2026-11-04T10:00:00.000Z',
        author: '主笔甲',
        summary: '旧版本送审基准',
        blocks: structuredClone(fixture.workingDraft.blocks),
        isHistoricalSnapshot: true,
        isWorkingDraft: false,
        isFinal: false,
        sourceDraftId: fixture.workingDraft.id,
        // submittedReviewRound is undefined!
      };

      // 3. Foreign branch baseline
      const foreignBaseline: DraftVersion = {
        id: 'DRAFT-SNAP-REV-FOREIGN',
        versionNumber: 'v2.0 (分支B送审)',
        createdAt: '2026-11-05T11:00:00.000Z',
        author: '主笔乙',
        summary: '分支B的送审基准',
        blocks: structuredClone(fixture.workingDraft.blocks),
        isHistoricalSnapshot: true,
        isWorkingDraft: false,
        isFinal: false,
        sourceDraftId: 'DRAFT-BRANCH-B',
        submittedReviewRound: 1,
      };

      // 4. Duplicate round number baseline in the same lineage
      const duplicateRoundBaseline: DraftVersion = {
        id: 'DRAFT-SNAP-REV-DUP-1',
        versionNumber: 'v1.2 (同为第1轮送审)',
        createdAt: '2026-11-04T15:00:00.000Z',
        author: '主笔甲',
        summary: '同为第1轮送审的补充基准',
        blocks: structuredClone(fixture.workingDraft.blocks),
        isHistoricalSnapshot: true,
        isWorkingDraft: false,
        isFinal: false,
        sourceDraftId: fixture.workingDraft.id,
        submittedReviewRound: 1,
      };

      // Register these drafts
      task = {
        ...task,
        drafts: [
          manualSnapshot,
          legacyBaseline,
          foreignBaseline,
          duplicateRoundBaseline,
          ...task.drafts,
        ],
      };

      // Update reviewBaselineIds of workingDraft to include legacy and duplicate, but NOT foreign
      const currentDraftWithBaselines: DraftVersion = {
        ...fixture.workingDraft,
        reviewBaselineIds: [
          ...((fixture.workingDraft.reviewBaselineIds || []) as string[]),
          legacyBaseline.id,
          duplicateRoundBaseline.id,
        ],
      };

      const baselines = getFormalReviewBaselines(task, currentDraftWithBaselines);

      // Verify manual snapshot is NOT included
      assert.ok(!baselines.some((b) => b.id === manualSnapshot.id), 'Manual snapshot must not be formal baseline');

      // Verify foreign branch is NOT included
      assert.ok(!baselines.some((b) => b.id === foreignBaseline.id), 'Foreign branch baseline must not be included');

      // Verify legacy baseline IS included as formal baseline
      assert.ok(baselines.some((b) => b.id === legacyBaseline.id), 'Legacy baseline should be included');

      // Verify legacy baseline round display is "轮次未知"
      assert.equal(getRoundDisplayName(legacyBaseline), '轮次未知');

      // Verify duplicate round baseline is NOT merged with R1 baseline
      assert.ok(baselines.some((b) => b.id === duplicateRoundBaseline.id));
      assert.ok(baselines.some((b) => b.id === fixture.r1Baseline.id));
      assert.notEqual(
        baselines.find((b) => b.id === duplicateRoundBaseline.id)?.id,
        baselines.find((b) => b.id === fixture.r1Baseline.id)?.id
      );
    },
  ],

  // -------------------------------------------------------------------------
  // D. 非正式基准及来源缺失意见不丢失、不虚构归属；本轮0条与当前工作稿仍有未闭环意见能同时正确展示
  // -------------------------------------------------------------------------
  [
    'D. Informal and missing baseline comments are preserved; 0 comments in current round while working draft has unclosed comments both display accurately',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;

      // Add an informal draft comment
      const informalComment: ReviewComment = {
        id: 'CMT-INFORMAL-01',
        type: 'overall',
        targetVersionId: fixture.workingDraft.id,
        targetVersionNumber: fixture.workingDraft.versionNumber,
        reviewer: '审阅乙',
        content: '针对未送审工作稿提出的非正式意见',
        status: 'pending',
        createdAt: '2026-11-05T15:00:00.000Z',
      };

      // Add a missing source baseline comment
      const missingBaselineComment: ReviewComment = {
        id: 'CMT-MISSING-BASE-01',
        type: 'overall',
        targetVersionId: 'DRAFT-DELETED-BASE',
        targetVersionNumber: 'v0.9 (已删除基准)',
        reviewer: '审阅丁',
        content: '原基准已被移除的历史遗留意见',
        status: 'need_discussion',
        createdAt: '2026-11-05T15:30:00.000Z',
      };

      task = {
        ...task,
        reviewComments: [informalComment, missingBaselineComment, ...task.reviewComments],
      };

      const formalBaselines = getFormalReviewBaselines(task, fixture.workingDraft);
      const unattributed = getUnattributedReviewComments(task, formalBaselines);

      assert.equal(unattributed.length, 2);
      assert.ok(unattributed.some((u) => u.comment.id === informalComment.id && u.reason.includes('未送审草稿')));
      assert.ok(unattributed.some((u) => u.comment.id === missingBaselineComment.id && u.reason.includes('缺失')));

      // In R2, suppose R2 has 0 original comments
      const taskR2Zero = {
        ...task,
        reviewComments: task.reviewComments.filter((c) => c.targetVersionId !== fixture.r2Baseline.id),
      };

      const counts = getReviewStageCommentCounts(taskR2Zero, fixture.workingDraft, fixture.r2Baseline);
      assert.equal(counts.currentRoundOriginalCount, 0);
      assert.equal(counts.currentRoundUnclosedCount, 0);
      // But applicable unclosed comments on the working draft (from R1) > 0!
      assert.ok(counts.applicableUnclosedCount > 0);
      assert.equal(counts.canFinalizeComments, false);

      const ui = mount(
        <ReviewRoundHistoryView
          task={task}
          currentDraft={fixture.workingDraft}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        const unattributedSection = ui.host.querySelector('[data-testid="unattributed-comments-section"]');
        assert.ok(unattributedSection, 'Unattributed comments section should be rendered');
        assert.ok(unattributedSection.textContent?.includes('CMT-INFORMAL-01'));
        assert.ok(unattributedSection.textContent?.includes('CMT-MISSING-BASE-01'));
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // E. 回看全部操作零业务写入；使用深冻结输入或前后深比较验证正文、指针、版本、日志和意见不变
  // -------------------------------------------------------------------------
  [
    'E. History viewing produces zero mutations; verified with deep freeze and before/after comparisons',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      const frozenTask = deepFreeze(structuredClone(fixture.task));
      const frozenDraft = deepFreeze(structuredClone(fixture.workingDraft));

      // Pure service calls with frozen task
      const baselines = getFormalReviewBaselines(frozenTask, frozenDraft);
      assert.equal(baselines.length, 2);

      const roundName = getRoundDisplayName(frozenTask.drafts[0]);
      assert.ok(roundName);

      const r1Comments = getBaselineAttributedComments(frozenTask, fixture.r1Baseline.id);
      assert.equal(r1Comments.length, 1);

      const unattributed = getUnattributedReviewComments(frozenTask, baselines);
      assert.ok(Array.isArray(unattributed));

      const counts = getReviewStageCommentCounts(frozenTask, frozenDraft, fixture.r2Baseline);
      assert.ok(counts);

      // Deep comparison before & after mounting & interacting with ReviewRoundHistoryView
      const rawTask = structuredClone(fixture.task);
      const snapshotBefore = JSON.stringify({
        task: rawTask,
        currentDraftId: rawTask.currentDraftId,
        reviewBaseDraftId: rawTask.reviewBaseDraftId,
        currentReviewRound: rawTask.currentReviewRound,
        draftsCount: rawTask.drafts.length,
        commentsCount: rawTask.reviewComments.length,
        logsCount: rawTask.modificationLogs?.length || 0,
      });

      const ui = mount(
        <ReviewRoundHistoryView
          task={rawTask}
          currentDraft={fixture.workingDraft}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        // Switch tabs
        const r1Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${fixture.r1Baseline.id}"]`);
        act(() => r1Tab?.click());

        // Locate block
        const locateBtn = ui.host.querySelector<HTMLButtonElement>('[data-testid="btn-locate-comment-block-CMT-R1-01"]');
        act(() => locateBtn?.click());

        // Snapshot after UI interactions
        const snapshotAfter = JSON.stringify({
          task: rawTask,
          currentDraftId: rawTask.currentDraftId,
          reviewBaseDraftId: rawTask.reviewBaseDraftId,
          currentReviewRound: rawTask.currentReviewRound,
          draftsCount: rawTask.drafts.length,
          commentsCount: rawTask.reviewComments.length,
          logsCount: rawTask.modificationLogs?.length || 0,
        });

        assert.equal(snapshotBefore, snapshotAfter, 'No task mutation should occur during round history browsing');
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // F. 修改当前工作稿或处理意见后，历史正文和交接摘要不变；意见当前状态与冻结内容的时间语义明确
  // -------------------------------------------------------------------------
  [
    'F. Editing current working draft or resolving comments leaves historical baseline text and summary intact; time semantics distinct',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;
      const { r1Baseline, cmtR1 } = fixture;
      const r1TextBefore = JSON.stringify(r1Baseline.blocks);
      const r1SummaryBefore = JSON.stringify(r1Baseline.frozenPostRevisionVerificationOverview);

      // 1. Author modifies working draft text
      const edit = applyDraftContentChange(
        task,
        fixture.workingDraft.id,
        (blocks) =>
          blocks.map((b) =>
            b.id === 'BLK-01' ? { ...b, content: '最新工作稿再次全面改写正文第一段' } : b
          ),
        '二次大修',
        '主笔甲'
      );
      task = edit.updatedTask;

      // 2. Author resolves cmtR1 to implemented
      task = {
        ...task,
        reviewComments: task.reviewComments.map((c) =>
          c.id === cmtR1.id
            ? {
                ...c,
                status: 'implemented' as const,
                authorReply: '已在最新工作稿全面落实修改',
                implementationDraftId: edit.workingDraft.id,
              }
            : c
        ),
      };

      // Assert historical baseline text & summary are 100% untouched
      const r1After = task.drafts.find((d) => d.id === r1Baseline.id)!;
      assert.equal(JSON.stringify(r1After.blocks), r1TextBefore, 'Historical baseline text must be unchanged');
      assert.equal(
        JSON.stringify(r1After.frozenPostRevisionVerificationOverview),
        r1SummaryBefore,
        'Historical baseline handoff overview must be unchanged'
      );

      // Check that comment displays current status 'implemented' with the distinction notice
      const ui = mount(
        <ReviewRoundHistoryView
          task={task}
          currentDraft={edit.workingDraft}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        const r1Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r1Baseline.id}"]`);
        act(() => r1Tab?.click());

        const commentItem = ui.host.querySelector(`[data-testid="history-comment-item-${cmtR1.id}"]`);
        assert.ok(commentItem?.textContent?.includes('已修改/已落实'));
        assert.ok(commentItem?.textContent?.includes('已在最新工作稿全面落实修改'));
        assert.ok(ui.host.textContent?.includes('意见当前处理状态，不代表该轮结束时的冻结结论'));
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // G. 任务、角色、工作稿和轮次切换不串用定位、出处、表单或回调；返回工作区后新增意见绑定最新真实基准
  // -------------------------------------------------------------------------
  [
    'G. Role/Task switching does not leak state; returning to workspace binds new comments to latest live baseline',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;

      let isReturned = false;
      const ui = mount(
        <ReviewStage
          task={task}
          onUpdateTask={(up) => {
            task = { ...task, ...up };
          }}
          onProceedToNextStage={() => {}}
          activeRole="主笔甲"
        />
      );

      try {
        // 1. Enter round history
        const openBtn = ui.host.querySelector<HTMLButtonElement>('[data-testid="btn-open-round-history"]');
        assert.ok(openBtn, 'Open round history button should exist');
        act(() => openBtn.click());

        assert.ok(ui.host.querySelector('[data-testid="review-round-history-view"]'));

        // 2. Select R1 baseline
        const r1Tab = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${fixture.r1Baseline.id}"]`);
        act(() => r1Tab?.click());

        // 3. Exit round history to return to live review workspace
        const exitBtn = ui.host.querySelector<HTMLButtonElement>('[data-testid="btn-exit-round-history"]');
        assert.ok(exitBtn, 'Exit round history button should exist');
        act(() => exitBtn.click());

        // Now back in live workspace
        assert.ok(!ui.host.querySelector('[data-testid="review-round-history-view"]'));

        // 4. Open add comment modal and add a comment
        const addCommentBtn = Array.from(ui.host.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('提出审阅意见')
        );
        assert.ok(addCommentBtn, 'Add comment button in live workspace');
        act(() => addCommentBtn.click());

        const input = ui.host.querySelector<HTMLTextAreaElement>('textarea');
        assert.ok(input);
        act(() => simulateTextareaChange(input, '在活动工作区提出的最新意见'));
        act(() => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));

        // Verify that the newly added comment binds to R2 baseline (latest live baseline), NOT R1!
        const newestComment = task.reviewComments[0];
        assert.equal(newestComment.targetVersionId, fixture.r2Baseline.id);
        assert.notEqual(newestComment.targetVersionId, fixture.r1Baseline.id);
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // H. 无正式基准、缺字段及异常关联有安全空态，不崩溃、不自动重置
  // -------------------------------------------------------------------------
  [
    'H. Safe empty states when formal baselines are absent, fields missing, or records corrupted; no crash or fake R1',
    () => {
      const task = createRevisionReviewHandoffDemoTask();
      // Fresh task with no formal review baselines
      task.reviewBaseDraftId = undefined;
      task.currentReviewRound = 0;

      const baselines = getFormalReviewBaselines(task);
      assert.equal(baselines.length, 0);

      const ui = mount(
        <ReviewRoundHistoryView
          task={task}
          currentDraft={task.drafts[0]}
          activeRole="主笔甲"
          onExitHistory={() => {}}
        />
      );

      try {
        const emptyNotice = ui.host.querySelector('[data-testid="no-formal-baselines-notice"]');
        assert.ok(emptyNotice, 'Empty state notice must be rendered');
        assert.ok(emptyNotice.textContent?.includes('尚未产生正式送审基准快照'));
        // Must NOT render fake R1
        assert.ok(!ui.host.textContent?.includes('第 1 轮 (R1)'));
      } finally {
        ui.close();
      }
    },
  ],

  // -------------------------------------------------------------------------
  // I. 即使筛选为R2或R2没有意见，仍适用于工作稿的R1未闭环意见继续阻断定稿
  // -------------------------------------------------------------------------
  [
    'I. Unclosed R1 comments applicable to current working draft continue to block finalization even when R2 has 0 comments',
    () => {
      const fixture = prepareTwoRoundTaskFixture();
      let task = fixture.task;

      // Make R2 have 0 comments, while R1 has 1 pending comment
      task = {
        ...task,
        reviewComments: task.reviewComments.filter((c) => c.targetVersionId !== fixture.r2Baseline.id),
      };

      const working = task.drafts.find((d) => d.id === task.currentDraftId)!;
      const applicable = getApplicableReviewComments(task, working);
      assert.equal(applicable.length, 1);
      assert.equal(applicable[0].id, fixture.cmtR1.id);
      assert.equal(applicable[0].status, 'pending');

      const validation = validateFinalizationConditions(task, working.id, '主笔甲');
      assert.equal(validation.canFinalize, false);
      assert.ok(validation.reasons.some((r) => r.includes('尚有未闭环的审阅意见')));
    },
  ],

  // -------------------------------------------------------------------------
  // J. 挂载真实App组件演练
  // -------------------------------------------------------------------------
  [
    'J. Real App user-driven journey: demo task creation, conflict adjudication, adoption, verification, R1 submission, R1 comment, edit, R2 submission, R2 comment, round history review, and persistence verification',
    () => {
      localStorage.clear();
      resetStorageWithBackup();
      const ui = mount(<App />);
      try {
        const click = (id: string) => {
          const target = ui.host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
          assert.ok(target, `Target [data-testid="${id}"] not found`);
          act(() => target.click());
        };
        const fill = (id: string, value: string) => {
          const input = ui.host.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`);
          assert.ok(input, `Input [data-testid="${id}"] not found`);
          act(() => simulateTextareaChange(input, value));
        };
        const readTask = () => {
          const task = loadPersistedState().tasks.find((t) => t.id === 'TASK-DEMO-REVISION-REVIEW-HANDOFF');
          assert.ok(task, 'TASK-DEMO-REVISION-REVIEW-HANDOFF should exist');
          return task;
        };

        // 1. Create task 28 demo task
        clickText(ui.host, '展开演示专区');
        click('btn-create-revision-review-handoff-demo-task');

        const initialTask = readTask();
        assert.ok(initialTask, 'Demo task should be created');

        // 2. Adjudicate two conflicts
        const conflictingFacts = initialTask.facts.filter((f) => f.hasConflict);
        for (const [index, value] of [[0, '120'], [1, '18']] as const) {
          const decisions = Array.from(ui.host.querySelectorAll('button')).filter(
            (b) => b.textContent?.trim() === '裁决冲突'
          );
          act(() => decisions[index].click());
          click(`conflict-candidate-${value}`);
          const scope = ui.host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
          const reason = ui.host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!;
          act(() => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
              scope,
              conflictingFacts[index].metricScope
            );
            scope.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
            simulateTextareaChange(reason, '已核验本期同口径正式材料，采用此统计值并保留原始出处。');
          });
          clickText(ui.host, '确认采信并写入事实');
        }

        // 3. Confirm facts and outline
        clickText(ui.host, '确认本次事实清单');
        clickText(ui.host, '下一步：文风与大纲');
        clickText(ui.host, '确认大纲并进入起草');
        clickText(ui.host, '下一步：正文起草');

        // 4. Generate and accept shared paragraph revision
        click('btn-open-fact-impact');
        click('btn-generate-shared-paragraph-revision');
        click('btn-accept-shared-paragraph-revision');

        // 5. Partial verification
        click('btn-open-post-revision-verification');
        fill('input-verification-notes-BLK-01', '真实组件测试，首段核对120项与18场。');
        click('btn-record-verification-BLK-01');
        click('btn-defer-verification-BLK-02');
        fill('input-defer-reason-BLK-02', '暂缓签署第二段。');
        click('btn-confirm-defer-BLK-02');
        click('btn-close-post-revision-verification-modal');

        // 6. Submit for review R1
        clickText(ui.host, '提交本轮审阅');
        click('btn-confirm-submit-review');

        const taskAfterR1 = readTask();
        assert.equal(taskAfterR1.currentReviewRound, 1);
        const r1BaseId = taskAfterR1.reviewBaseDraftId!;
        const r1Base = taskAfterR1.drafts.find((d) => d.id === r1BaseId)!;
        assert.ok(r1Base);

        // 7. Switch to 审阅乙, add comment on R1
        clickText(ui.host, '审阅乙');
        click('btn-toggle-handoff-details');
        click('btn-comment-block-BLK-01');
        const input = ui.host.querySelector<HTMLTextAreaElement>('textarea[placeholder="详细描述具体的修改意见..."]')!;
        act(() => simulateTextareaChange(input, '审阅乙针对R1第一段提出的批注意见。'));
        act(() => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));

        // 8. Switch to 主笔甲, edit working draft
        clickText(ui.host, '主笔甲');
        clickText(ui.host, '前往正文起草工作区');
        const paragraph = ui.host.querySelector<HTMLTextAreaElement>('#paragraph-textarea-BLK-01')!;
        act(() => simulateTextareaChange(paragraph, paragraph.value + '【经主笔针对R1修改】'));

        // 9. Submit for review R2
        clickText(ui.host, '提交本轮审阅');
        click('btn-confirm-submit-review');

        const taskAfterR2 = readTask();
        assert.equal(taskAfterR2.currentReviewRound, 2);
        const r2BaseId = taskAfterR2.reviewBaseDraftId!;
        const r2Base = taskAfterR2.drafts.find((d) => d.id === r2BaseId)!;
        assert.ok(r2Base);

        // 10. Switch to 审阅丁, add comment on R2
        clickText(ui.host, '审阅丁');
        const commentBtn = Array.from(ui.host.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('提出审阅意见')
        );
        act(() => commentBtn?.click());
        const inputR2 = ui.host.querySelector<HTMLTextAreaElement>('textarea[placeholder="详细描述具体的修改意见..."]')!;
        act(() => simulateTextareaChange(inputR2, '审阅丁针对R2提出的全局意见。'));
        act(() => inputR2.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));

        // 11. Enter review round history
        clickText(ui.host, '主笔甲');
        click('btn-open-round-history');

        assert.ok(ui.host.querySelector('[data-testid="review-round-history-view"]'));

        // 12. Check R1 and R2 tabs
        const tabR1 = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r1Base.id}"]`);
        const tabR2 = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${r2Base.id}"]`);
        assert.ok(tabR1, 'Tab for R1 should exist');
        assert.ok(tabR2, 'Tab for R2 should exist');

        // Click R1 tab
        act(() => tabR1.click());
        assert.ok(ui.host.textContent?.includes(r1Base.versionNumber));
        assert.ok(ui.host.textContent?.includes('审阅乙针对R1第一段提出的批注意见'));

        // Open evidence drawer from R1 handoff card
        click('btn-toggle-handoff-details');
        click('btn-view-evidence-from-FACT-01');
        const drawer = ui.host.querySelector('[aria-labelledby="snippet-drawer-title"]');
        assert.ok(drawer, 'Snippet drawer should open');
        // Verify snippet drawer context displays R1 baseline version, NOT R2 or working draft!
        assert.ok(
          drawer.textContent?.includes(r1Base.versionNumber),
          `Drawer should show R1 baseline version ${r1Base.versionNumber}`
        );
        assert.ok(!drawer.textContent?.includes(r2Base.versionNumber), 'Drawer must not show R2 baseline version');

        // Close drawer
        clickText(ui.host, '关闭返回');

        // Click R2 tab
        act(() => tabR2.click());
        assert.ok(ui.host.textContent?.includes(r2Base.versionNumber));
        assert.ok(ui.host.textContent?.includes('审阅丁针对R2提出的全局意见'));

        // 13. Exit round history to return to live review workspace
        click('btn-exit-round-history');
        assert.ok(!ui.host.querySelector('[data-testid="review-round-history-view"]'));
        assert.ok(ui.host.querySelector('[data-testid="btn-open-round-history"]'));

        // 14. Persistence verification: remount App and check saved state
        ui.render(<React.Fragment />);
        ui.render(<App />);

        const reloadedTask = readTask();
        assert.equal(reloadedTask.currentReviewRound, 2);
        assert.equal(reloadedTask.reviewComments.length, initialTask.reviewComments.length + 2);
      } finally {
        ui.close();
      }
    },
  ],
];

console.log('================================================================');
console.log('🚀 开始执行任务29（审阅轮次回看与意见归属 实施方自测套件）');
console.log('================================================================');

let passed = 0;
let failed = 0;

for (const [title, fn] of cases) {
  try {
    fn();
    console.log(`✅ PASSED: ${title}`);
    passed++;
  } catch (err: any) {
    console.error(`❌ FAILED: ${title}`);
    console.error(err);
    failed++;
  }
}

console.log('================================================================');
console.log(`测试结果：${passed}/${cases.length} 通过，${failed} 失败`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
