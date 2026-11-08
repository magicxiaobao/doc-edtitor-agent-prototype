import { dom } from './test-jsdom-env';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewRoundHistoryView } from './src/components/ReviewRoundHistoryView';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { SnippetDrawer } from './src/components/SnippetDrawer';
import { createRevisionReviewHandoffDemoTask } from './src/services/mockData';
import { submitDraftForReview, getApplicableReviewComments, validateFinalizationConditions } from './src/services/draftLifecycleService';
import { getFormalReviewBaselines, getBaselineAttributedComments, getUnattributedReviewComments, getReviewStageCommentCounts, getRoundDisplayName } from './src/services/reviewRoundHistoryService';
import type { Task, DraftVersion, ReviewComment, EvidenceSnippet } from './src/types';

// Prepared service fixtures: these cases independently test data boundaries and
// actual mounted components. They are not a cloud-browser or full-App journey.
function fixture() {
  let task = createRevisionReviewHandoffDemoTask();
  task.reviewComments = [];
  const workId = task.currentDraftId!;
  const r1Result = submitDraftForReview(task, workId, '主笔甲');
  task = r1Result.updatedTask;
  const r1 = r1Result.baselineSnapshot!;
  task = { ...task, drafts: task.drafts.map(d => d.id !== workId ? d : ({ ...d, blocks: d.blocks.map((b, i) => i ? b : { ...b, content: b.content + ' 第二轮修改。' }) })) };
  const r2Result = submitDraftForReview(task, workId, '主笔甲');
  task = r2Result.updatedTask;
  const r2 = r2Result.baselineSnapshot!;
  const work = task.drafts.find(d => d.id === workId)!;
  const c1 = comment('CMT-INDEPENDENT-R1', r1);
  const c2 = comment('CMT-INDEPENDENT-R2', r2);
  task.reviewComments = [c1, c2];
  return { task, work, r1, r2, c1, c2 };
}
function comment(id: string, base: DraftVersion): ReviewComment {
  return { id, type: 'paragraph', targetBlockId: base.blocks[0].id, targetBlockOrder: 1,
    targetVersionId: base.id, targetVersionNumber: base.versionNumber, baseParagraphText: base.blocks[0].content,
    reviewer: '审阅乙', content: id + ' 独立接收意见', status: 'pending', createdAt: '2026-11-08T04:00:00.000Z' };
}
function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); act(() => root.render(element));
  return { host, render(next: React.ReactElement) { act(() => root.render(next)); },
    close() { act(() => root.unmount()); host.remove(); } };
}
function click(host: HTMLElement, id: string) {
  const b = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  assert.ok(b, id); act(() => b.click());
}
function history(task: Task, work?: DraftVersion) {
  return <ReviewRoundHistoryView task={task} currentDraft={work} activeRole="主笔甲" onExitHistory={() => {}} />;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
const cases: Array<[string, () => void]> = [
  ['01 formal baseline identity and readonly operations preserve deeply frozen task', () => {
    const f = fixture(); const task = freeze(structuredClone(f.task)); const before = JSON.stringify(task);
    const ui = mount(history(task, task.drafts.find(d => d.id === task.currentDraftId)));
    try { assert.equal(getFormalReviewBaselines(task).length, 2); click(ui.host, `round-tab-${f.r1.id}`);
      assert.ok(ui.host.querySelector(`[data-testid="history-comment-item-${f.c1.id}"]`));
      assert.equal(ui.host.querySelectorAll('textarea').length, 0); assert.equal(JSON.stringify(task), before);
    } finally { ui.close(); }
  }],
  ['02 unrelated formal branch comments are not exposed as informal or missing-source records', () => {
    const f = fixture(); const foreign = { ...structuredClone(f.r1), id: 'DRAFT-SNAP-REV-OTHER-BRANCH', sourceDraftId: 'OTHER-WORK', submittedReviewRound: 3 };
    const c = comment('CMT-OTHER-BRANCH', foreign); f.task.drafts.push(foreign); f.task.reviewComments.push(c);
    const unassigned = getUnattributedReviewComments(f.task, getFormalReviewBaselines(f.task));
    assert.ok(!unassigned.some(x => x.comment.id === c.id), 'unrelated formal branch must not be called an unsent draft');
  }],
  ['03 rebound foreign-origin comment remains visible with accurate provenance', () => {
    const f = fixture(); const foreign = { ...structuredClone(f.r1), id: 'DRAFT-SNAP-REV-OTHER-REBOUND', sourceDraftId: 'OTHER-WORK', submittedReviewRound: 3 };
    const c = comment('CMT-OTHER-REBOUND', foreign);
    c.rebindRecord = { targetDraftId: f.work.id, toBlockId: f.work.blocks[0].id, toBlockOrder: 1, reboundAt: c.createdAt, reboundBy: '主笔甲' };
    f.task.drafts.push(foreign); f.task.reviewComments.push(c);
    const item = getUnattributedReviewComments(f.task, getFormalReviewBaselines(f.task)).find(x => x.comment.id === c.id);
    assert.ok(item); assert.ok(!item.reason.includes('非正式送审基准'), 'known formal origin is not an informal draft');
  }],
  ['04 no formal baselines still show informal and missing-source comments', () => {
    const task = createRevisionReviewHandoffDemoTask(); const work = task.drafts.find(d => d.id === task.currentDraftId)!;
    task.reviewComments = [comment('CMT-INFORMAL-EMPTY', work), { ...comment('CMT-MISSING-EMPTY', work), targetVersionId: 'MISSING-SOURCE' }];
    const ui = mount(history(task, work)); try {
      assert.ok(ui.host.querySelector('[data-testid="no-formal-baselines-notice"]'));
      assert.ok(ui.host.querySelector('[data-testid="unattributed-comment-CMT-INFORMAL-EMPTY"]'), 'empty-state must preserve original draft comments');
      assert.ok(ui.host.querySelector('[data-testid="unattributed-comment-CMT-MISSING-EMPTY"]'));
    } finally { ui.close(); }
  }],
  ['05 working-draft fallback does not acquire current formal-round opinion counts', () => {
    const task = createRevisionReviewHandoffDemoTask(); const work = task.drafts.find(d => d.id === task.currentDraftId)!;
    task.reviewComments = [comment('CMT-UNSENT', work)];
    const counts = getReviewStageCommentCounts(task, work, work);
    assert.equal(counts.currentRoundOriginalCount, 0); assert.equal(counts.applicableUnclosedCount, 1);
  }],
  ['06 identical duplicate comment IDs count and render only once', () => {
    const f = fixture(); f.task.reviewComments.push(structuredClone(f.c1));
    assert.equal(getBaselineAttributedComments(f.task, f.r1.id).length, 1);
    assert.equal(getReviewStageCommentCounts(f.task, f.work, f.r1).currentRoundOriginalCount, 1);
    const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r1.id}`);
      assert.equal(ui.host.querySelectorAll(`[data-testid="history-comment-item-${f.c1.id}"]`).length, 1);
    } finally { ui.close(); }
  }],
  ['07 switching round clears old block highlight even when stable block IDs are shared', () => {
    const f = fixture(); const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r1.id}`); click(ui.host, `btn-locate-comment-block-${f.c1.id}`);
      const selector = `[data-testid="history-baseline-block-${f.r1.blocks[0].id}"]`;
      assert.ok(ui.host.querySelector(selector)?.className.includes('ring-2'));
      click(ui.host, `round-tab-${f.r2.id}`);
      assert.ok(!ui.host.querySelector(selector)?.className.includes('ring-2'), 'R1 location must not highlight R2');
    } finally { ui.close(); }
  }],
  ['08 task context change resets old selected round and opinion filters', () => {
    const f = fixture(); const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r1.id}`);
      const status = ui.host.querySelector('select')!;
      act(() => { status.value = 'rejected'; status.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
      const next = structuredClone(f.task); next.id += '-SECOND-TASK';
      ui.render(history(next, next.drafts.find(d => d.id === next.currentDraftId)));
      assert.equal(ui.host.querySelector(`[data-testid="round-tab-${f.r2.id}"]`)?.getAttribute('aria-selected'), 'true');
      assert.equal(ui.host.querySelector('select')?.value, 'all');
    } finally { ui.close(); }
  }],
  ['09 equal-length replacement of baseline set selects authoritative latest baseline', () => {
    const f = fixture(); const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r1.id}`);
      const next = structuredClone(f.task); const r3 = { ...structuredClone(f.r2), id: 'DRAFT-SNAP-REV-REPLACED-R3', submittedReviewRound: 3 };
      next.drafts = next.drafts.filter(d => d.id !== f.r1.id); next.drafts.unshift(r3);
      next.reviewBaseDraftId = r3.id; next.currentReviewRound = 3;
      const work = next.drafts.find(d => d.id === next.currentDraftId)!; work.reviewBaselineIds = [f.r2.id, r3.id];
      ui.render(history(next, work));
      assert.equal(ui.host.querySelector(`[data-testid="round-tab-${r3.id}"]`)?.getAttribute('aria-selected'), 'true');
    } finally { ui.close(); }
  }],
  ['10 round tabs support advertised ArrowRight navigation and selection', () => {
    const f = fixture(); const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r1.id}`);
      const r1 = ui.host.querySelector<HTMLButtonElement>(`[data-testid="round-tab-${f.r1.id}"]`)!;
      r1.focus(); act(() => r1.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      const r2 = ui.host.querySelector(`[data-testid="round-tab-${f.r2.id}"]`)!;
      assert.equal(r2.getAttribute('aria-selected'), 'true'); assert.equal(document.activeElement, r2);
    } finally { ui.close(); }
  }],
  ['11 both opinion filters expose accessible names', () => {
    const f = fixture(); const ui = mount(history(f.task, f.work)); try {
      for (const select of ui.host.querySelectorAll('select')) {
        const named = select.getAttribute('aria-label') || select.getAttribute('aria-labelledby') || (select.id && ui.host.querySelector(`label[for="${select.id}"]`));
        assert.ok(named, 'status/reviewer select requires an accessible label');
      }
    } finally { ui.close(); }
  }],
  ['12 Escape on a source drawer does not exit the underlying round history view', () => {
    const f = fixture(); const snippet = f.task.snippets[0];
    function Harness() {
      const [shown, setShown] = useState(true); const [source, setSource] = useState<EvidenceSnippet | null>(null);
      return <>{shown && <ReviewRoundHistoryView task={f.task} currentDraft={f.work} activeRole="主笔甲" onExitHistory={() => setShown(false)} />}
        <button data-testid="open-source" onClick={() => setSource(snippet)}>source</button>
        <SnippetDrawer snippet={source} documents={f.task.documents} task={f.task} currentDraft={f.r1} onClose={() => setSource(null)} /></>;
    }
    const ui = mount(<Harness />); try {
      click(ui.host, 'open-source');
      const drawer = ui.host.querySelector('[aria-labelledby="snippet-drawer-title"]')!; assert.ok(drawer);
      act(() => drawer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.ok(ui.host.querySelector('[data-testid="review-round-history-view"]'), 'Escape must not navigate behind an open source drawer');
    } finally { ui.close(); }
  }],
  ['13 unknown round is not borrowed and normal save snapshot is not promoted', () => {
    const f = fixture(); delete f.r1.submittedReviewRound;
    assert.equal(getRoundDisplayName(f.r1), '轮次未知');
    const saved = { ...structuredClone(f.r2), id: 'MANUAL-SAVE', submittedReviewRound: undefined, summary: '提交审阅' };
    f.task.drafts.push(saved); f.work.reviewBaselineIds!.push(saved.id);
    assert.ok(!getFormalReviewBaselines(f.task, f.work).some(d => d.id === saved.id));
  }],
  ['14 R1 pending opinion still blocks finalization while R2 has no opinion', () => {
    const f = fixture(); f.task.reviewComments = [f.c1];
    const before = JSON.stringify(f.task); const ui = mount(history(f.task, f.work)); try {
      click(ui.host, `round-tab-${f.r2.id}`);
      const c = getReviewStageCommentCounts(f.task, f.work, f.r2);
      assert.equal(c.currentRoundOriginalCount, 0); assert.equal(c.applicableUnclosedCount, 1);
      assert.equal(getApplicableReviewComments(f.task, f.work).length, 1);
      const result = validateFinalizationConditions(f.task, f.work.id, '主笔甲');
      assert.ok(result.reasons.some(x => x.includes('尚有未闭环的审阅意见'))); assert.equal(JSON.stringify(f.task), before);
    } finally { ui.close(); }
  }],
  ['15 return from readonly R1 permits new opinions only against current R2', () => {
    const f = fixture(); let task = f.task;
    const ui = mount(<ReviewStage task={task} activeRole="审阅乙" onUpdateTask={p => { task = { ...task, ...p }; }} onProceedToNextStage={() => {}} />);
    try {
      click(ui.host, 'btn-open-round-history'); click(ui.host, `round-tab-${f.r1.id}`); click(ui.host, 'btn-exit-round-history');
      const add = Array.from(ui.host.querySelectorAll('button')).find(b => b.textContent?.includes('提出审阅意见'))!;
      act(() => add.click()); const input = ui.host.querySelector('textarea')!;
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      act(() => { set.call(input, '回看后当前基准批注'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
      act(() => input.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(task.reviewComments[0].targetVersionId, f.r2.id);
    } finally { ui.close(); }
  }],
];
let failed = 0;
for (const [name, run] of cases) { try { run(); console.log('PASS '+name); } catch (error) { failed++; console.error('FAIL '+name, error); } }
console.log(`Codex independent Task29: ${cases.length-failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
