import { dom, simulateTextareaChange } from './test-jsdom-env';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { acceptSharedParagraphFactRevisionCandidate, generateSharedParagraphFactRevisionCandidate } from './src/services/factRevisionCandidateService';
import { applyDraftContentChange, createDraftSnapshot, submitDraftForReview } from './src/services/draftLifecycleService';
import { deferPostRevisionVerification, recordPostRevisionVerification, revokePostRevisionVerification } from './src/services/postRevisionVerificationService';
import { buildRevisionReviewHandoffSummary, computeSubmitReviewFreshnessHash, validateSubmitReviewContext } from './src/services/revisionReviewHandoffService';
import { loadPersistedState, resetStorageWithBackup, savePersistedState } from './src/services/storageService';
import type { Task } from './src/types';

// Prepared service fixture. Generation, adoption, recording and submission use production
// services. These tests do not claim an unprepared cross-stage user journey or cloud browser run.
function prepareDraft() {
  const task = createRevisionReviewHandoffDemoTask();
  const original = task.drafts.find(d => d.id === task.currentDraftId)!;
  for (const [id, value, evidence] of [['FACT-01', '120', 'EVD-01'], ['FACT-02', '18', 'EVD-07']]) {
    Object.assign(task.facts.find(f => f.id === id)!, {
      status: 'confirmed', value, selectedConflictValue: value, primaryEvidenceId: evidence,
      conflictResolutionReason: '独立验收准备夹具，同期同口径原文',
    });
  }
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = {
    confirmedAt: '2026-11-04T00:00:00.000Z', hash: 'independent-receipt-fixture',
    factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(task, f)),
  };
  task.outlineConfirmed = true;
  task.outlineSnapshot = structuredClone(original.snapshotMetadata!.outlineSnapshot);
  const generated = generateSharedParagraphFactRevisionCandidate(task, original, '主笔甲');
  assert.ok(generated.success && generated.candidateGroup, generated.reason);
  const group = generated.candidateGroup;
  const adopted = acceptSharedParagraphFactRevisionCandidate(task, original, group, '主笔甲', group.runId);
  assert.ok(adopted.success && adopted.updatedTask && adopted.newWorkingDraft, adopted.reason);
  return { task: adopted.updatedTask, draft: adopted.newWorkingDraft };
}

const NOTE = '独立验收，首段核对 120项、18场和800人次';
const DEFER = '独立验收，第二段暂缓补查台账';
const REVOKE = '独立验收，首段核对已撤回并待重新记录';

function working(task: Task) {
  return task.drafts.find(d => d.id === task.currentDraftId)!;
}

function prepareSubmitted() {
  const { task, draft } = prepareDraft();
  const context = { draftId: draft.id, operationId: draft.postRevisionVerificationCredential!.operationId, activeRole: '主笔甲' as const };
  const verified = recordPostRevisionVerification({ task, ...context, blockId: 'BLK-01', notes: NOTE });
  assert.ok(verified.success && verified.updatedTask, verified.error);
  const deferred = deferPostRevisionVerification({ task: verified.updatedTask, ...context, blockId: 'BLK-02', reason: DEFER });
  assert.ok(deferred.success && deferred.updatedTask, deferred.error);
  const submitted = submitDraftForReview(deferred.updatedTask, draft.id, '主笔甲');
  assert.ok(submitted.baselineSnapshot);
  return { task: submitted.updatedTask, baseline: submitted.baselineSnapshot, draft: submitted.workingDraft, context };
}

function mount(element: React.ReactElement) {
  const host = dom.window.document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: React.ReactElement) => act(() => root.render(next));
  render(element);
  return { host, render, close: () => { act(() => root.unmount()); host.remove(); } };
}

function button(host: ParentNode, id: string) {
  const target = host.querySelector<HTMLButtonElement>(`button[data-testid="${id}"]`);
  assert.ok(target, `Missing button ${id}`);
  return target;
}

function clickText(host: ParentNode, label: string) {
  const target = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(label));
  assert.ok(target, `Missing button ${label}`);
  act(() => target.click());
  return target;
}

function review(task: Task, activeRole: '审阅乙' | '供稿丙' = '审阅乙') {
  return <ReviewStage task={task} onUpdateTask={() => {}} onProceedToNextStage={() => {}} activeRole={activeRole} />;
}

const cases: Array<[string, () => void]> = [
  ['01 actual submission freezes 1 verified, 1 deferred, 1 pending and no comment mutation', () => {
    const { task, baseline, draft } = prepareSubmitted();
    const summary = buildRevisionReviewHandoffSummary(task, baseline, draft);
    assert.equal(baseline.submittedReviewRound, 1);
    assert.equal(baseline.sourceDraftId, draft.id);
    assert.equal(summary.hasFormalBaseline, true);
    assert.deepEqual([summary.factsCount, summary.uniqueBlocksCount, summary.verifiedCount, summary.pendingCount, summary.deferredCount], [2, 3, 1, 2, 1]);
    assert.deepEqual(summary.blocks[0].associatedFactIds, ['FACT-01', 'FACT-02']);
    assert.match(summary.blocks[0].submittedContent, /800人次/);
    assert.equal(task.reviewComments.filter(c => c.status === 'pending').length, 3);
  }],
  ['02 legacy submission without a snapshot is labeled working-draft reference', () => {
    const { task, draft } = prepareDraft();
    const { updatedTask, workingDraft } = submitDraftForReview(task, draft.id, '主笔甲', false);
    assert.equal(buildRevisionReviewHandoffSummary(updatedTask, workingDraft, workingDraft).hasFormalBaseline, false);
  }],
  ['03 manually saved history is not a formal submission', () => {
    const { task, draft } = prepareDraft();
    const saved = createDraftSnapshot(task, draft.id, '手动保存供比较', '主笔甲');
    const snapshot = saved.updatedTask.drafts.find(d => d.isHistoricalSnapshot && d.sourceDraftId === draft.id)!;
    assert.ok(snapshot);
    assert.equal(buildRevisionReviewHandoffSummary(saved.updatedTask, snapshot, working(saved.updatedTask)).hasFormalBaseline, false);
  }],
  ['04 a legacy historical submission never borrows a later global round number', () => {
    const { task, baseline, draft } = prepareSubmitted();
    delete baseline.submittedReviewRound;
    const second = submitDraftForReview(task, draft.id, '主笔甲');
    const summary = buildRevisionReviewHandoffSummary(second.updatedTask, baseline, second.workingDraft);
    assert.equal(summary.hasFormalBaseline, true);
    assert.ok(!summary.reviewRound, 'Missing frozen round should be shown as unknown');
  }],
  ['05 truncated frozen overview cannot crash the handoff view', () => {
    const { task, baseline, draft } = prepareSubmitted();
    Reflect.set(baseline.frozenPostRevisionVerificationOverview!, 'blockEvaluations', null);
    assert.doesNotThrow(() => buildRevisionReviewHandoffSummary(task, baseline, draft));
  }],
  ['06 persisted recovery never promotes raw records to signed frozen status', () => {
    const { task, baseline } = prepareSubmitted();
    Reflect.set(baseline.frozenPostRevisionVerificationOverview!, 'blockEvaluations', null);
    assert.equal(savePersistedState([task], task.id, '主笔甲'), true);
    const reloaded = loadPersistedState().tasks.find(t => t.id === task.id)!;
    assert.ok(reloaded);
    const recovered = reloaded.drafts.find(d => d.id === baseline.id)!;
    assert.ok(recovered.postRevisionVerificationRecovery);
    assert.deepEqual(recovered.blocks, baseline.blocks);
    const summary = buildRevisionReviewHandoffSummary(reloaded, recovered, working(reloaded));
    assert.equal(summary.verifiedCount, 0);
    assert.ok(summary.blocks.every(b => b.status !== 'verified' && b.notes !== NOTE));
  }],
  ['07 baseline cannot display a credential for a different working draft', () => {
    const { task, baseline, draft } = prepareSubmitted();
    baseline.postRevisionVerificationCredential!.targetDraftId = 'OTHER-WORKING-DRAFT';
    const summary = buildRevisionReviewHandoffSummary(task, baseline, draft);
    assert.equal(summary.verifiedCount, 0);
    assert.ok(!summary.hasCredential || summary.blocks.every(b => b.status !== 'verified'));
  }],
  ['08 card does not show a foreign raw record in place of the frozen record', () => {
    const { task, baseline, draft } = prepareSubmitted();
    const records = baseline.postRevisionVerificationRecords!;
    records.push({ ...records[0], id: 'FOREIGN-RECORD', taskId: 'OTHER-TASK', notes: '其他任务的签署说明' });
    const summary = buildRevisionReviewHandoffSummary(task, baseline, draft);
    assert.ok(!JSON.stringify(summary).includes('其他任务的签署说明'));
  }],
  ['09 deleted paragraph is absent from submitted text and has no comment action', () => {
    const { task, draft } = prepareDraft();
    const edited = applyDraftContentChange(task, draft.id, blocks => blocks.filter(b => b.id !== 'BLK-01'), '删去第1段', '主笔甲');
    const submitted = submitDraftForReview(edited.updatedTask, edited.workingDraft.id, '主笔甲');
    const summary = buildRevisionReviewHandoffSummary(submitted.updatedTask, submitted.baselineSnapshot, submitted.workingDraft);
    const block = summary.blocks.find(b => b.blockId === 'BLK-01')!;
    assert.equal(block.status, 'block_missing');
    const ui = mount(review(submitted.updatedTask));
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      assert.deepEqual({ commentAction: Boolean(ui.host.querySelector('[data-testid="btn-comment-block-BLK-01"]')),
        submittedText: Boolean(block.submittedContent) }, { commentAction: false, submittedText: false });
    } finally { ui.close(); }
  }],
  ['10 revoked status shows the latest reason on the card before history expands', () => {
    const { task, draft, context } = prepareSubmitted();
    const revoked = revokePostRevisionVerification({ task, ...context, blockId: 'BLK-01', reason: REVOKE });
    assert.ok(revoked.success && revoked.updatedTask, revoked.error);
    const submitted = submitDraftForReview(revoked.updatedTask, draft.id, '主笔甲');
    const ui = mount(review(submitted.updatedTask));
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      assert.ok(ui.host.textContent?.includes(REVOKE));
    } finally { ui.close(); }
  }],
  ['11 paragraph order change is a visible submitted document difference', () => {
    const { task, baseline, draft } = prepareSubmitted();
    const { updatedTask, workingDraft } = applyDraftContentChange(task, draft.id,
      ([first, second, ...rest]) => [{ ...second, order: first.order }, { ...first, order: second.order }, ...rest],
      '调换前两段顺序', '主笔甲');
    assert.equal(buildRevisionReviewHandoffSummary(updatedTask, baseline, workingDraft).isCurrentDraftContentModified, true);
  }],
  ['12 confirmation detects changed related source text without changed value or approval status', () => {
    const { task, draft } = prepareDraft();
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    const updated = structuredClone(task);
    updated.snippets.find(s => s.id === 'EVD-01')!.text += ' 来源原文已补充说明。';
    const checked = validateSubmitReviewContext({ task: updated, currentDraft: working(updated), activeRole: '主笔甲', previewSnapshotHash });
    assert.equal(checked.isStale, true);
    assert.equal(checked.valid, false);
  }],
  ['13 confirmation detects changed related fact unit, period and scope', () => {
    const { task, draft } = prepareDraft();
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    const accepted = [{ unit: '件' }, { period: '2026年1至6月' }, { metricScope: '只计部分单位' }].filter(change => {
      const updated = structuredClone(task);
      Object.assign(updated.facts.find(f => f.id === 'FACT-01')!, change);
      const checked = validateSubmitReviewContext({ task: updated, currentDraft: working(updated), activeRole: '主笔甲', previewSnapshotHash });
      return checked.valid;
    });
    assert.deepEqual(accepted, []);
  }],
  ['14 confirmation rejects a draft no longer selected even with its old matching preview', () => {
    const { task, draft } = prepareDraft();
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    const other = { ...draft, id: 'OTHER-WORKING-DRAFT' };
    const changed: Task = { ...task, drafts: [other, ...task.drafts], currentDraftId: other.id };
    const checked = validateSubmitReviewContext({ task: changed, currentDraft: draft, activeRole: '主笔甲', previewSnapshotHash });
    assert.equal(checked.valid, false);
  }],
  ['15 submit confirmation closes with Escape and returns focus to the entry', () => {
    const { task } = prepareDraft();
    const ui = mount(<DraftingStage task={task} onUpdateTask={() => assert.fail('Cancel wrote task')} onViewSnippet={() => {}}
      onProceedToNextStage={() => assert.fail('Cancel navigated')} activeRole="主笔甲" />);
    try {
      const entry = clickText(ui.host, '提交本轮审阅');
      const dialog = ui.host.querySelector('[role="dialog"][aria-label="提交本轮审阅确认"]');
      assert.ok(dialog);
      const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
      close.focus();
      act(() => close.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      assert.ok(!ui.host.querySelector('[aria-label="提交本轮审阅确认"]'), 'Escape should close the submit dialog');
      assert.ok(document.activeElement === entry, 'Focus should return to the submit entry');
    } finally { ui.close(); }
  }],
  ['16 a role change collapses expanded details and clears history selection', () => {
    const { task } = prepareSubmitted();
    const ui = mount(review(task));
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      assert.ok(ui.host.querySelector('[data-testid="btn-view-evidence-from-FACT-01"]'));
      ui.render(review(task, '供稿丙'));
      assert.ok(!ui.host.querySelector('[data-testid="btn-view-evidence-from-FACT-01"]'));
    } finally { ui.close(); }
  }],
  ['17 two synchronous confirm clicks produce one task update and one round', () => {
    const { task } = prepareDraft();
    const updates: Partial<Task>[] = [];
    const ui = mount(<DraftingStage task={task} onUpdateTask={patch => updates.push(patch)} onViewSnippet={() => {}}
      onProceedToNextStage={() => {}} activeRole="主笔甲" />);
    try {
      clickText(ui.host, '提交本轮审阅');
      const confirm = button(ui.host, 'btn-confirm-submit-review');
      act(() => { confirm.click(); confirm.click(); });
      const submissions = updates.filter(patch => patch.currentStage === 'review');
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].drafts?.length, task.drafts.length + 1);
    } finally { ui.close(); }
  }],
  ['18 actual App source drawer uses the requested 128-item fragment and the review baseline', () => {
    const { task, baseline } = prepareSubmitted();
    assert.equal(savePersistedState([task], task.id, '审阅乙'), true);
    const ui = mount(<App />);
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      act(() => button(ui.host, 'btn-view-evidence-from-FACT-01').click());
      const drawer = ui.host.querySelector('[role="dialog"][aria-labelledby="snippet-drawer-title"]');
      assert.ok(drawer);
      assert.match(drawer.textContent || '', /累计完成重点任务128项/);
      assert.match(drawer.textContent || '', /科室乙前三季度汇总/);
      assert.ok(drawer.textContent?.includes(baseline.versionNumber), 'Source drawer must identify the selected review baseline');
    } finally { ui.close(); }
  }],
  ['19 frozen overview rejects invalid signed counts and null nested evaluations', () => {
    for (const mode of ['count', 'nested']) {
      const { task, baseline, draft } = prepareSubmitted();
      const overview = baseline.frozenPostRevisionVerificationOverview!;
      if (mode === 'count') overview.verifiedCount = 99;
      else Reflect.set(overview.blockEvaluations, '0', null);
      const summary = buildRevisionReviewHandoffSummary(task, baseline, draft);
      assert.equal(summary.verifiedCount, 0);
      assert.equal(summary.hasCredential, false);
    }
  }],
  ['20 source-of-truth confirmation rejects a stale same-ID draft object', () => {
    const { task, draft } = prepareDraft();
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    const updated = applyDraftContentChange(task, draft.id,
      blocks => blocks.map((b, i) => i === 0 ? { ...b, content: b.content + ' 当前真实正文已变更。' } : b),
      '编辑当前正文', '主笔甲').updatedTask;
    const result = validateSubmitReviewContext({ task: updated, currentDraft: draft, activeRole: '主笔甲', previewSnapshotHash });
    assert.equal(result.valid, false);
    assert.equal(result.isStale, true);
  }],
  ['21 pre-submit changes to paragraph relations and verification time require confirmation again', () => {
    const { task, draft } = prepareSubmitted();
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    for (const mode of ['relations', 'record-time']) {
      const updated = structuredClone(task);
      const current = working(updated);
      if (mode === 'relations') current.blocks[0].referencedFactIds = ['FACT-01'];
      else current.postRevisionVerificationRecords![0].verifiedAt = '2026-11-06T09:00:00.000Z';
      const result = validateSubmitReviewContext({ task: updated, currentDraft: current, activeRole: '主笔甲', previewSnapshotHash });
      assert.equal(result.valid, false, mode);
    }
  }],
  ['22 handoff record details come from the frozen evaluation', () => {
    const { task, baseline, draft } = prepareSubmitted();
    baseline.postRevisionVerificationRecords![0].notes = '同上下文原始记录被改动，不能覆盖冻结说明';
    const summary = buildRevisionReviewHandoffSummary(task, baseline, draft);
    assert.equal(summary.blocks[0].notes, NOTE);
  }],
  ['23 preview rejects a cross-task credential instead of showing a zero-of-zero progress', () => {
    const { task, draft } = prepareDraft();
    draft.postRevisionVerificationCredential!.taskId = 'OTHER-TASK';
    const ui = mount(<DraftingStage task={task} onUpdateTask={() => {}} onViewSnippet={() => {}}
      onProceedToNextStage={() => {}} activeRole="主笔甲" />);
    try {
      clickText(ui.host, '提交本轮审阅');
      const dialog = ui.host.querySelector('[aria-label="提交本轮审阅确认"]')!;
      assert.ok(!dialog.textContent?.includes('核对进度：0/0'));
    } finally { ui.close(); }
  }],
  ['24 submit dialog initially takes focus and traps Tab in both directions', () => {
    const { task } = prepareDraft();
    const ui = mount(<DraftingStage task={task} onUpdateTask={() => {}} onViewSnippet={() => {}}
      onProceedToNextStage={() => {}} activeRole="主笔甲" />);
    try {
      clickText(ui.host, '提交本轮审阅');
      const dialog = ui.host.querySelector<HTMLElement>('[aria-label="提交本轮审阅确认"]')!;
      assert.ok(dialog.contains(document.activeElement), 'Opening the dialog moves focus inside');
      const controls = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      controls[0].focus();
      act(() => controls[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
      assert.ok(document.activeElement === controls.at(-1), 'Shift+Tab wraps to last control');
      act(() => controls.at(-1)!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      assert.ok(document.activeElement === controls[0], 'Tab wraps to first control');
    } finally { ui.close(); }
  }],
  ['25 selected old submission exposes its own handoff from the version view', () => {
    const first = prepareSubmitted();
    const second = submitDraftForReview(first.task, first.draft.id, '主笔甲');
    const task = { ...second.updatedTask, currentDraftId: first.baseline.id };
    const ui = mount(<DraftingStage task={task} onUpdateTask={() => {}} onViewSnippet={() => {}}
      onProceedToNextStage={() => {}} activeRole="主笔甲" />);
    try {
      assert.ok(ui.host.querySelector('[data-testid="revision-review-handoff-banner"]'));
      assert.ok(ui.host.textContent?.includes('第 1 轮送审基准'));
      assert.ok(!ui.host.textContent?.includes('第 2 轮送审基准'));
    } finally { ui.close(); }
  }],
  ['26 actual App creates the demo and drives adjudication, adoption, handoff, comment, edit and historical reload', () => {
    localStorage.clear();
    resetStorageWithBackup(); // Fresh default tasks for this JSDOM App journey.
    const ui = mount(<App />);
    const read = () => {
      const task = loadPersistedState().tasks.find(t => t.id === 'TASK-DEMO-REVISION-REVIEW-HANDOFF');
      assert.ok(task);
      return task;
    };
    const click = (id: string) => {
      const target = ui.host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      assert.ok(target, id);
      act(() => target.click());
    };
    const fill = (id: string, value: string) => {
      const input = ui.host.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`);
      assert.ok(input, id);
      act(() => simulateTextareaChange(input, value));
    };
    try {
      clickText(ui.host, '展开演示专区');
      click('btn-create-revision-review-handoff-demo-task');
      const initial = read();
      assert.equal(initial.drafts.length, 1);
      assert.ok(initial.facts.filter(f => f.hasConflict).every(f => f.status === 'pending'));
      for (const [index, value] of [[0, '120'], [1, '18']] as const) {
        const decisions = Array.from(ui.host.querySelectorAll('button')).filter(b => b.textContent?.trim() === '裁决冲突');
        act(() => decisions[index].click());
        click(`conflict-candidate-${value}`);
        const scope = ui.host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
        const reason = ui.host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!;
        act(() => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(scope, initial.facts[index].metricScope);
          scope.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
          simulateTextareaChange(reason, '已核验本期同口径正式材料，采用此统计值并保留原始出处。');
        });
        clickText(ui.host, '确认采信并写入事实');
      }
      clickText(ui.host, '确认本次事实清单');
      clickText(ui.host, '下一步：文风与大纲');
      clickText(ui.host, '确认大纲并进入起草');
      clickText(ui.host, '下一步：正文起草');
      click('btn-open-fact-impact');
      click('btn-generate-shared-paragraph-revision');
      click('btn-cancel-shared-paragraph-revision');
      assert.equal(read().drafts.length, 1);
      click('btn-generate-shared-paragraph-revision');
      click('btn-accept-shared-paragraph-revision');
      assert.equal(read().drafts.length, 2);
      click('btn-open-post-revision-verification');
      fill('input-verification-notes-BLK-01', '核对本期120项、18场与800人次，保留原文作为送审参考。');
      click('btn-record-verification-BLK-01');
      click('btn-defer-verification-BLK-02');
      fill('input-defer-reason-BLK-02', '暂缓签署第二段，等待督办台账进一步核查。');
      click('btn-confirm-defer-BLK-02');
      click('btn-close-post-revision-verification-modal');
      clickText(ui.host, '提交本轮审阅');
      clickText(ui.host, '取消');
      assert.equal(read().drafts.length, 2);
      assert.equal(read().currentReviewRound, 0);
      clickText(ui.host, '提交本轮审阅');
      click('btn-confirm-submit-review');
      const firstTask = read();
      const first = firstTask.drafts.find(d => d.id === firstTask.reviewBaseDraftId)!;
      const frozen = JSON.stringify(first);
      assert.equal(firstTask.currentReviewRound, 1);
      assert.equal(first.frozenPostRevisionVerificationOverview!.verifiedCount, 1);
      assert.equal(first.frozenPostRevisionVerificationOverview!.deferredCount, 1);
      clickText(ui.host, '审阅乙');
      click('btn-toggle-handoff-details');
      click('btn-locate-block-BLK-01');
      assert.ok(ui.host.querySelector('#review-baseline-block-BLK-01')?.className.includes('ring-2'));
      click('btn-view-evidence-from-FACT-01');
      const drawer = ui.host.querySelector('[aria-labelledby="snippet-drawer-title"]')!;
      assert.ok(drawer.textContent?.includes('累计完成重点任务128项'));
      assert.ok(drawer.textContent?.includes(first.versionNumber));
      clickText(ui.host, '关闭返回');
      click('btn-comment-block-BLK-01');
      const input = ui.host.querySelector<HTMLTextAreaElement>('textarea[placeholder="详细描述具体的修改意见..."]')!;
      assert.ok(input);
      act(() => simulateTextareaChange(input, '请进一步核实第一段重点任务成效表述。'));
      act(() => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      const commented = read();
      assert.equal(commented.reviewComments.length, initial.reviewComments.length + 1);
      assert.equal(commented.reviewComments[0].targetVersionId, first.id);
      assert.equal(commented.reviewComments[0].targetBlockId, 'BLK-01');
      assert.equal(commented.reviewComments[0].baseParagraphText, first.blocks[0].content);
      clickText(ui.host, '主笔甲');
      clickText(ui.host, '前往正文起草工作区');
      const paragraph = ui.host.querySelector<HTMLTextAreaElement>('#paragraph-textarea-BLK-01')!;
      act(() => simulateTextareaChange(paragraph, paragraph.value + '经主笔补充复核表述。'));
      clickText(ui.host, '进入审阅页面');
      assert.ok(ui.host.querySelector('[data-testid="current-draft-modified-badge"]'));
      assert.equal(JSON.stringify(read().drafts.find(d => d.id === first.id)), frozen);
      clickText(ui.host, '前往正文起草工作区');
      clickText(ui.host, '提交本轮审阅');
      click('btn-confirm-submit-review');
      assert.equal(read().currentReviewRound, 2);
      clickText(ui.host, '前往正文起草工作区');
      clickText(ui.host, '版本历史');
      const oldVersion = Array.from(ui.host.querySelectorAll('button')).find(b =>
        b.textContent?.trim() === '查看此版本' && b.parentElement?.parentElement?.textContent?.includes(first.versionNumber));
      assert.ok(oldVersion);
      act(() => oldVersion.click());
      assert.ok(ui.host.querySelector('[data-testid="revision-review-handoff-banner"]')?.textContent?.includes('第 1 轮送审基准'));
      ui.render(<React.Fragment />);
      ui.render(<App />);
      assert.ok(ui.host.querySelector('[data-testid="revision-review-handoff-banner"]')?.textContent?.includes('第 1 轮送审基准'));
      assert.equal(JSON.stringify(read().drafts.find(d => d.id === first.id)), frozen);
      assert.equal(loadPersistedState().tasks.length, 5);
    } finally { ui.close(); }
  }],
  ['27 actual App keeps old review-source version aligned after a later submission', () => {
    const first = prepareSubmitted();
    const second = submitDraftForReview(first.task, first.draft.id, '主笔甲');
    const task: Task = { ...second.updatedTask, currentDraftId: first.baseline.id, currentStage: 'review' };
    assert.equal(savePersistedState([task], task.id, '审阅乙'), true);
    const ui = mount(<App />);
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      act(() => button(ui.host, 'btn-view-evidence-from-FACT-01').click());
      const drawer = ui.host.querySelector('[aria-labelledby="snippet-drawer-title"]')!;
      assert.ok(drawer.textContent?.includes(first.baseline.versionNumber), 'Old baseline source retains its version context');
    } finally { ui.close(); }
  }],
  ['28 current withdrawal time is visible and a later deferral uses the current reason', () => {
    const { task, draft, context } = prepareSubmitted();
    const revoked = revokePostRevisionVerification({ task, ...context, blockId: 'BLK-01', reason: REVOKE });
    assert.ok(revoked.updatedTask && revoked.updatedRecord?.revocation);
    const submitted = submitDraftForReview(revoked.updatedTask, draft.id, '主笔甲');
    const ui = mount(review(submitted.updatedTask));
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      const card = ui.host.querySelector('[data-testid="handoff-block-card-BLK-01"]')!;
      assert.ok(card.textContent?.includes(new Date(revoked.updatedRecord.revocation.revokedAt).toLocaleString('zh-CN', { hour12: false })));
      const deferred = deferPostRevisionVerification({ task: submitted.updatedTask, ...context, blockId: 'BLK-01', reason: 'CURRENT-DEFER-AFTER-WITHDRAWAL' });
      assert.ok(deferred.updatedTask);
      const next = submitDraftForReview(deferred.updatedTask, draft.id, '主笔甲');
      ui.render(review(next.updatedTask));
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      const current = ui.host.querySelector('[data-testid="handoff-block-card-BLK-01"]')!;
      assert.ok(current.textContent?.includes('CURRENT-DEFER-AFTER-WITHDRAWAL'));
      assert.ok(!current.textContent?.includes(REVOKE));
    } finally { ui.close(); }
  }],
  ['29 legacy editable draft without the optional working flag can still submit', () => {
    const { task, draft } = prepareDraft();
    delete draft.isWorkingDraft;
    const previewSnapshotHash = computeSubmitReviewFreshnessHash(task, draft, '主笔甲');
    assert.equal(validateSubmitReviewContext({ task, currentDraft: draft, activeRole: '主笔甲', previewSnapshotHash }).valid, true);
  }],
  ['30 manual snapshot description cannot label it a formal submission', () => {
    const { task, draft } = prepareDraft();
    const saved = createDraftSnapshot(task, draft.id, '提交审阅前人工备份，尚未送审', '主笔甲');
    const snapshot = saved.snapshotDraft;
    const viewed = { ...saved.updatedTask, currentDraftId: snapshot.id };
    assert.equal(buildRevisionReviewHandoffSummary(viewed, snapshot, snapshot).hasFormalBaseline, false);
  }],
  ['31 deleted submitted paragraph never displays an identical-body conclusion', () => {
    const { task, draft } = prepareDraft();
    const edited = applyDraftContentChange(task, draft.id, blocks => blocks.filter(b => b.id !== 'BLK-01'), '送审前删除首段', '主笔甲');
    const submitted = submitDraftForReview(edited.updatedTask, edited.workingDraft.id, '主笔甲');
    const ui = mount(review(submitted.updatedTask));
    try {
      act(() => button(ui.host, 'btn-toggle-handoff-details').click());
      const card = ui.host.querySelector('[data-testid="handoff-block-card-BLK-01"]')!;
      assert.ok(!card.textContent?.includes('送审正文与采纳正文完全一致'));
    } finally { ui.close(); }
  }],
];

let failures = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    localStorage.clear();
  }
}
console.log(`Task28 independent receipt: ${cases.length - failures}/${cases.length} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
