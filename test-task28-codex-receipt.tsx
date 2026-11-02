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
import type { Task, DraftVersion } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL ${name}: ${String(e)}`);
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

function createCodexFixture() {
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
    hash: 'codex-task28',
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

async function runCodexReceiptTests() {
  console.log('--- CODEX 独立接收核验：任务28（事实修订送审交接摘要 第一批）---');

  await check('CODEX-1: 提交审阅前核对未全部完成不阻断送审，弹窗显示真实进度与警示', async () => {
    const f = createCodexFixture();
    const opId = f.draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task: f.task,
      draftId: f.draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '已核验首段',
    });
    const task = r1.updatedTask!;

    // 此时 BLK-02 与 BLK-03 仍待核对
    const validation = validateSubmitReviewContext(
      task,
      f.draft.id,
      '主笔甲',
      computeSubmitReviewFreshnessHash(task, f.draft.id)
    );
    assert.equal(validation.valid, true, '未全部核对不作为强制门禁阻断送审');
  });

  await check('CODEX-2: 提交审阅后工作稿后续编辑不回写冻结基准，正文差异感知准确', async () => {
    const f = createCodexFixture();
    const opId = f.draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task: f.task,
      draftId: f.draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '送审基准核对',
    });

    const sub = submitDraftForReview(r1.updatedTask!, f.draft.id, '主笔甲', true);
    assert.equal(sub.success, true);
    const baseSnapshot = sub.baselineSnapshot!;
    let workingDraft = sub.workingDraft;
    let task = sub.updatedTask;

    // 仅在工作稿上增加核对记录
    const r2 = recordPostRevisionVerification({
      task,
      draftId: workingDraft.id,
      operationId: opId,
      blockId: 'BLK-02',
      activeRole: '主笔甲',
      notes: '工作稿补记核对',
    });
    task = r2.updatedTask!;
    workingDraft = task.drafts.find((d) => d.id === workingDraft.id)!;

    const summary1 = buildRevisionReviewHandoffSummary(task, baseSnapshot, workingDraft);
    assert.equal(summary1.verifiedCount, 1, '旧基准冻结核对数不随工作稿改变');
    assert.equal(summary1.isCurrentDraftContentModified, false, '仅核对变动不得报告为正文变动');

    // 在工作稿上修改第1段文本
    const editRes = applyDraftContentChange(
      task,
      workingDraft.id,
      (blocks) => blocks.map((b) => (b.id === 'BLK-01' ? { ...b, content: b.content + '【修订后新改动】' } : b)),
      '后续修改',
      '主笔甲'
    );
    task = editRes.updatedTask!;
    workingDraft = task.drafts.find((d) => d.id === workingDraft.id)!;

    const summary2 = buildRevisionReviewHandoffSummary(task, baseSnapshot, workingDraft);
    assert.equal(summary2.isCurrentDraftContentModified, true, '精准感知工作稿与送审基准的正文差异');
  });

  await check('CODEX-3: 批注权限边界隔离：审阅乙/丁可针对送审段落提批注，供稿丙不可越权', async () => {
    const f = createCodexFixture();
    const sub = submitDraftForReview(f.task, f.draft.id, '主笔甲', true);
    let task = sub.updatedTask;

    // 审阅乙挂载并提出意见
    const { container: revContainer, unmount: unmountRev } = mount(
      <ReviewStage
        task={task}
        onUpdateTask={(up) => {
          task = { ...task, ...up };
        }}
        onProceedToNextStage={() => {}}
        onViewSnippet={() => {}}
        activeRole="审阅乙"
      />
    );

    const expandBtn = revContainer.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    act(() => {
      expandBtn.click();
    });

    const cmtBtn = revContainer.querySelector('[data-testid="btn-comment-block-BLK-01"]');
    assert.ok(cmtBtn, '审阅乙可见针对本段提出意见入口');
    unmountRev();

    // 供稿丙挂载：不可见提出意见入口
    const { container: supContainer, unmount: unmountSup } = mount(
      <ReviewStage
        task={task}
        onUpdateTask={() => {}}
        onProceedToNextStage={() => {}}
        onViewSnippet={() => {}}
        activeRole="供稿丙"
      />
    );

    const expandBtn2 = supContainer.querySelector('[data-testid="btn-toggle-handoff-details"]') as HTMLButtonElement;
    act(() => {
      expandBtn2.click();
    });

    const cmtBtnSup = supContainer.querySelector('[data-testid="btn-comment-block-BLK-01"]');
    assert.equal(cmtBtnSup, null, '供稿丙不可见批注提出入口，权限严格隔离');
    unmountSup();
  });

  await check('CODEX-4: 多轮次送审各自冻结独立摘要，历史快照轮次不可篡改', async () => {
    const f = createCodexFixture();
    const sub1 = submitDraftForReview(f.task, f.draft.id, '主笔甲', true);
    const base1 = sub1.baselineSnapshot!;
    assert.equal(base1.submittedReviewRound, 1);

    const sub2 = submitDraftForReview(sub1.updatedTask, sub1.workingDraft.id, '主笔甲', true);
    const base2 = sub2.baselineSnapshot!;
    assert.equal(base2.submittedReviewRound, 2);

    // 回看基准1：依然保持第1轮
    const summary1 = buildRevisionReviewHandoffSummary(sub2.updatedTask, base1, sub2.workingDraft);
    assert.equal(summary1.reviewRound, 1, '旧基准轮次不被后继全局轮次覆盖');
  });

  await check('CODEX-5: 恢复版本不继承有效活动核对凭据，仅保留来源追溯', async () => {
    const f = createCodexFixture();
    const opId = f.draft.postRevisionVerificationCredential!.operationId;
    const r1 = recordPostRevisionVerification({
      task: f.task,
      draftId: f.draft.id,
      operationId: opId,
      blockId: 'BLK-01',
      activeRole: '主笔甲',
      notes: '恢复前核对',
    });

    const restRes = restoreDraftVersion(r1.updatedTask!, f.draft.id, '主笔甲');
    assert.equal(restRes.success, true);
    const restoredDraft = restRes.restoredDraft!;
    assert.equal(restRes.hasPostRevisionVerificationCredential, false, '恢复稿不继承活动凭据');
    assert.ok(restRes.sourcePostRevisionVerificationCredential, '恢复稿保留来源凭据用于追溯');

    const sub = submitDraftForReview(restRes.updatedTask, restoredDraft.id, '主笔甲', true);
    const baseSnapshot = sub.baselineSnapshot!;
    const summary = buildRevisionReviewHandoffSummary(sub.updatedTask, baseSnapshot, sub.workingDraft);

    assert.equal(summary.isAdoptedSourceReferenceOnly, true, '准确标记为仅来源参考');
    assert.ok(summary.statusMessage.includes('来源稿事实修订追溯参考'));
  });

  if (failures.length > 0) {
    console.error(`\n❌ CODEX 验收失败项 (${failures.length}):\n${failures.join('\n')}`);
    process.exit(1);
  } else {
    console.log('\n🎉 CODEX 独立接收核验全部 100% 通过！');
    process.exit(0);
  }
}

runCodexReceiptTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
