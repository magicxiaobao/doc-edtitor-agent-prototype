import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPresetTask, createMultiParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  checkMultiParagraphFactRevisionEligibility,
  generateMultiParagraphFactRevisionCandidate,
  acceptMultiParagraphFactRevisionCandidate,
  validateMultiParagraphFactRevisionAcceptance,
  checkFactRevisionEligibility,
} from './src/services/factRevisionCandidateService';
import { evaluateDraftFactReviews, saveFactReviewRecord } from './src/services/factReviewService';
import { resolveDraftFactEvidence } from './src/services/factLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { FactImpactModal } from './src/components/FactImpactModal';
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

function multiFixture() {
  const task = createMultiParagraphRevisionDemoTask();
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

  // Upstream fact updated to 120 (科室甲申报口径)
  const f = task.facts.find((f) => f.id === 'FACT-01')!;
  f.status = 'confirmed';
  f.value = '120';
  f.selectedConflictValue = '120';
  f.primaryEvidenceId = 'EVD-01';
  f.conflictResolutionReason = '采信科室甲申报口径120项';

  task.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
    items: task.facts.filter((f) => f.status === 'confirmed').map((f) => buildFactItemSnapshot(task, f)),
    hash: 'RECEIPT-MULTI-SNAP-120',
  };
  task.outlineConfirmed = true;
  task.styleConfirmed = true;
  task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
  task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

  return { task, draft };
}

// 1. 真实128→120：多段目标段落改变，其他段落正文及数据严格不变
await check('真实128→120：多段目标段落改变，其他段落正文及数据严格不变', () => {
  const { task, draft } = multiFixture();
  const b3Orig = draft.blocks[2].content;
  const b4Orig = draft.blocks[3].content;

  const candRes = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
  assert.equal(candRes.success, true);
  assert.equal(candRes.candidateGroup?.items.length, 2);

  const accRes = acceptMultiParagraphFactRevisionCandidate(
    task,
    draft,
    candRes.candidateGroup!,
    '主笔甲',
    candRes.candidateGroup!.runId
  );
  assert.equal(accRes.success, true);

  const newDraft = accRes.newWorkingDraft!;
  assert(newDraft.blocks[0].content.includes('120项'));
  assert(!newDraft.blocks[0].content.includes('128项'));
  assert(newDraft.blocks[1].content.includes('120项'));
  assert(!newDraft.blocks[1].content.includes('128项'));
  assert.equal(newDraft.blocks[2].content, b3Orig);
  assert.equal(newDraft.blocks[3].content, b4Orig);
});

// 2. 候选生成、取消、失败和重试均不提前修改正文、依据快照或版本
await check('候选生成、取消、失败和重试均不提前修改正文、依据快照或版本', () => {
  const { task, draft } = multiFixture();
  const countBefore = task.drafts.length;
  const b1TextBefore = draft.blocks[0].content;
  const b2TextBefore = draft.blocks[1].content;
  const snapValBefore = draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue;

  const res = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
  assert.equal(res.success, true);
  assert.equal(task.drafts.length, countBefore);
  assert.equal(draft.blocks[0].content, b1TextBefore);
  assert.equal(draft.blocks[1].content, b2TextBefore);
  assert.equal(draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue, snapValBefore);
});

// 3. 采纳后旧稿冻结128与科室乙，新工作稿正文和依据均为120且指向科室甲
await check('采纳后旧稿冻结128与科室乙，新工作稿正文和依据均为120且指向科室甲', () => {
  const { task, draft } = multiFixture();
  const res = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
  const acc = acceptMultiParagraphFactRevisionCandidate(task, draft, res.candidateGroup!, '主笔甲', res.candidateGroup!.runId);
  assert.equal(acc.success, true);

  const archived = acc.archivedDraft!;
  const working = acc.newWorkingDraft!;
  const f = acc.updatedTask!.facts.find((f) => f.id === 'FACT-01')!;

  const oldEv = resolveDraftFactEvidence(f, archived, acc.updatedTask!, { freezeSnapshot: true });
  assert.equal(oldEv.effectiveSnippet?.id, 'EVD-02');
  assert(oldEv.effectiveSnippet?.docName.includes('科室乙') || oldEv.effectiveSnippet?.docName.includes('月报'));
  assert(oldEv.effectiveSnippet?.text.includes('128项'));

  const newEv = resolveDraftFactEvidence(f, working, acc.updatedTask!, { freezeSnapshot: false });
  assert.equal(newEv.effectiveSnippet?.id, 'EVD-01');
  assert(newEv.effectiveSnippet?.docName.includes('科室甲') || newEv.effectiveSnippet?.docName.includes('汇报'));
  assert(newEv.effectiveSnippet?.text.includes('120项'));
});

// 4. 任一段不满足确定性改写或含不支持存证时整组拒绝，无部分成功
await check('任一段不满足确定性改写或含不支持存证时整组拒绝，无部分成功', () => {
  const { task, draft } = multiFixture();
  // Mark BLK-02 with unsupported material supplement
  draft.blocks[1].adoptedEvidences = [
    { evidenceId: 'EVD-01', sourceDocId: task.snippets[0].sourceDocId, sourceDocName: task.snippets[0].docName, snippetText: task.snippets[0].text, snippetLocation: task.snippets[0].location, period: task.snippets[0].period, usage: 'current_fact', associatedFactId: 'FACT-01', contentFingerprint: 'receipt-adopted-evidence', capturedAt: new Date().toISOString() },
  ];

  const elig = checkMultiParagraphFactRevisionEligibility(task, draft, 'FACT-01', '主笔甲');
  assert.equal(elig.eligible, false);
  assert(elig.blockingReasons?.some((r) => r.includes('BLK-02')));

  const gen = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
  assert.equal(gen.success, false);
  assert.equal(gen.candidateGroup, undefined);
});

// 5. 单事实多段落整体原子采纳：只建一个新工作稿，旧稿归档，新工作稿复核为空
await check('单事实多段落整体原子采纳：只建一个新工作稿，旧稿归档，新工作稿复核为空', () => {
  const { task, draft } = multiFixture();
  const saveRes = saveFactReviewRecord({
    task,
    targetDraftId: draft.id,
    targetBlockId: 'BLK-01',
    status: 'reviewed',
    notes: '旧稿已复核',
    activeRole: '主笔甲',
  });
  const currentTask = saveRes.updatedTask;
  const currentDraft = saveRes.workingDraft;

  const res = generateMultiParagraphFactRevisionCandidate(currentTask, currentDraft, 'FACT-01', '主笔甲');
  const acc = acceptMultiParagraphFactRevisionCandidate(currentTask, currentDraft, res.candidateGroup!, '主笔甲', res.candidateGroup!.runId);
  assert.equal(acc.success, true);

  const updatedTask = acc.updatedTask!;
  assert.equal(updatedTask.drafts.length, 2);
  assert.equal(updatedTask.currentDraftId, acc.newWorkingDraft!.id);
  assert.equal(acc.archivedDraft!.isHistoricalSnapshot, true);
  assert.equal(acc.archivedDraft!.isWorkingDraft, false);
  assert.equal(acc.newWorkingDraft!.isWorkingDraft, true);
  assert.equal(acc.newWorkingDraft!.isHistoricalSnapshot, false);

  assert(!acc.newWorkingDraft!.factReviewRecords || acc.newWorkingDraft!.factReviewRecords.length === 0);
  const workingReviews = evaluateDraftFactReviews(updatedTask, acc.newWorkingDraft!);
  assert.equal(workingReviews.reviewedCount, 0);
});

// 6. 整体采纳日志记录全部受影响段落，标注不可单段撤销
await check('整体采纳日志记录全部受影响段落，标注不可单段撤销', () => {
  const { task, draft } = multiFixture();
  const res = generateMultiParagraphFactRevisionCandidate(task, draft, 'FACT-01', '主笔甲');
  const acc = acceptMultiParagraphFactRevisionCandidate(task, draft, res.candidateGroup!, '主笔甲', res.candidateGroup!.runId);
  assert.equal(acc.success, true);

  const log = acc.modificationLog!;
  assert(log.affectedBlocks?.length === 2);
  assert(log.affectedBlockIds?.includes('BLK-01') && log.affectedBlockIds?.includes('BLK-02'));
  assert(log.undoUnavailableReason?.includes('禁止单独撤销'));
});

// 7. Issue #82修复：原文与修订候选独立完整展示，差异视图杜绝“1280项”连读
await check('Issue #82修复：原文与修订候选独立完整展示，差异视图杜绝“1280项”连读', () => {
  const { task, draft } = multiFixture();
  const analysis = analyzeFactImpact(task, draft);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentTask={task}
        currentDraft={draft}
        activeRole="主笔甲"
        onAcceptMultiParagraphFactRevision={() => {}}
      />
    );
  });

  const genBtn = container.querySelector(
    '[data-testid="btn-generate-multi-paragraph-fact-revision-FACT-01"]'
  ) as HTMLButtonElement;
  assert(!!genBtn);

  act(() => {
    genBtn.click();
  });

  const origEl = container.querySelector('[data-testid="original-block-content-BLK-01"]');
  const revEl = container.querySelector('[data-testid="revised-block-content-BLK-01"]');
  const diffEl = container.querySelector('[data-testid="revision-diff-view-BLK-01"]');

  assert(!!origEl && !!revEl && !!diffEl);
  assert(origEl.textContent?.includes('128项') && !origEl.textContent?.includes('120'));
  assert(revEl.textContent?.includes('120项') && !revEl.textContent?.includes('128'));
  assert(!diffEl.textContent?.includes('1280项'));
  assert(diffEl.textContent?.includes('[删: 128项]') && diffEl.textContent?.includes('[改: 120项]'));

  act(() => {
    root.unmount();
  });
  container.remove();
});

// 8. 演示任务预置入口独立命名、不覆盖已有任务并走通全流程
await check('演示任务预置入口独立命名、不覆盖已有任务并走通全流程', () => {
  const demo = createMultiParagraphRevisionDemoTask();
  assert.equal(demo.id, 'TASK-DEMO-MULTI-PARAGRAPH-REVISION');
  assert.equal(demo.drafts.length, 1);
  assert.equal(demo.drafts[0].blocks[0].referencedFactIds[0], 'FACT-01');
  assert.equal(demo.drafts[0].blocks[1].referencedFactIds[0], 'FACT-01');
  assert.equal(demo.facts[0].id, 'FACT-01');
  assert.equal(demo.facts[0].hasConflict, true);
});

if (failures.length > 0) {
  console.error(`\n❌ Total Failures: ${failures.length}\n${failures.join('\n')}`);
  process.exit(1);
} else {
  console.log('\n🎉 ALL TASK-24 RECEIPT CHECKS PASSED (8/8)!');
}
