import {dom, simulateTextareaChange} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {App} from './src/App';
import {FactImpactModal} from './src/components/FactImpactModal';
import {DraftingStage} from './src/components/stages/DraftingStage';
import {createPresetTask} from './src/services/mockData';
import {analyzeFactImpact} from './src/services/factImpactService';
import {modifyOrExcludeFact} from './src/services/factLifecycleService';
import {savePersistedState, loadPersistedState, removeStorageItem, STORAGE_KEY_V2,
  LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY} from './src/services/storageService';
import type {Task, DraftVersion} from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${String(error)}`); }
}
function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {host, render: (view: React.ReactElement) => act(() => root.render(view)),
    close: () => {act(() => root.unmount()); host.remove();}};
}
function button(host: ParentNode, label: string) {
  const choices = [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  assert.equal(choices.length, 1, `one button: ${label}`); return choices[0];
}
function click(host: ParentNode, label: string) { act(() => button(host, label).click()); }
function draftOf(task: Task) { return task.drafts.find(d => d.id === task.currentDraftId)!; }
function business(task: Task) { return structuredClone({drafts: task.drafts, facts: task.facts,
  reviewComments: task.reviewComments, modificationLogs: task.modificationLogs}); }

await check('real fact update invalidates task approval without flagging unchanged facts', () => {
  const task = createPresetTask('under_review'); const draft = draftOf(task);
  const fact = task.facts.find(f => f.selectedConflictValue === '128')!;
  const result = modifyOrExcludeFact(task, fact.id, {value: '120', selectedConflictValue: '120',
    primaryEvidenceId: 'EVD-01'}, '主笔甲'); assert(result.success);
  const changed = result.updatedTask!;
  assert.equal(changed.factSnapshot, undefined, 'preserve upstream invalidation');
  const analysis = analyzeFactImpact(changed, draft);
  assert.equal(analysis.changedFactsCount, 1);
  assert.deepEqual(analysis.affectedBlockIds, draft.blocks.filter(b => b.referencedFactIds.includes(fact.id)).map(b => b.id));
  const view = mount(<DraftingStage task={changed} activeRole="主笔甲" onUpdateTask={() => {}}
    onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>);
  try {
    assert(view.host.textContent?.includes('事实清单未核准/快照缺失'));
    assert(button(view.host, '生成整稿候选').disabled, 'do not weaken approval gate');
    act(() => (view.host.querySelector('[data-testid="btn-open-fact-impact"]') as HTMLElement).click());
    assert(view.host.textContent?.includes('任务事实清单尚未重新确认'));
  } finally {view.close();}
});

await check('period/evidence removal and addition cannot be reported as unchanged', () => {
  const task = createPresetTask('under_review'); const draft = draftOf(task);
  const item = draft.snapshotMetadata!.factSnapshot!.items[0];
  for (const [field, type] of [['period', 'period'], ['primaryEvidenceId', 'primary_evidence']] as const) {
    const changed = {...task, facts: task.facts.map(f => f.id === item.factId ? {...f, [field]: ''} : f)};
    assert(analyzeFactImpact(changed, draft).impactItems.find(i => i.factId === item.factId)?.differenceTags.some(t => t.type === type), `cleared ${field}`);
    const missing = structuredClone(draft); missing.snapshotMetadata!.factSnapshot!.items[0][field] = '';
    assert(analyzeFactImpact(task, missing).impactItems.find(i => i.factId === item.factId)?.differenceTags.some(t => t.type === type), `added ${field}`);
  }
});

await check('referenced gap without a frozen item is disclosed rather than called fully consistent', () => {
  const task = createPresetTask('under_review'); const draft = draftOf(task);
  const gap = task.facts.find(f => f.status === 'gap')!;
  assert(draft.blocks.some(b => b.referencedFactIds.includes(gap.id)));
  const view = mount(<FactImpactModal isOpen analysis={analyzeFactImpact(task, draft)} currentDraft={draft}
    task={task} onClose={() => {}} onLocateBlock={() => {}} onViewDraftEvidence={() => {}}/>);
  try {
    assert(view.host.textContent?.includes('缺少快照基准'));
    assert(view.host.textContent?.includes(gap.metric));
    assert(!view.host.textContent?.includes('全部已核准事实，其数值、单位、统计期间、统计口径与主出处均与任务最新事实保持一致'));
  } finally {view.close();}
});

await check('real App drawer keeps working/history/final evidence frozen and reports missing provenance', async () => {
  const keys = [STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY];
  for (const mode of ['working', 'history', 'final', 'missing-provenance', 'missing-item', 'deleted', 'deleted-missing-item'] as const) {
    keys.forEach(removeStorageItem);
    const task = createPresetTask('under_review'); task.currentStage = 'drafting';
    const draft = draftOf(task); const original = structuredClone(draft.snapshotMetadata!.factSnapshot!.items[0]);
    if (mode === 'history') {draft.isHistoricalSnapshot = true; draft.isWorkingDraft = false;}
    if (mode === 'final') {draft.isFinal = true; draft.isWorkingDraft = false;}
    if (mode === 'missing-provenance') delete draft.snapshotMetadata!.factSnapshot!.items[0].provenance;
    if (mode === 'missing-item' || mode === 'deleted-missing-item') draft.snapshotMetadata!.factSnapshot!.items = draft.snapshotMetadata!.factSnapshot!.items.filter(i => i.factId !== original.factId);
    // The live snippet with the SAME old ID is also altered. A frozen viewer must not borrow it.
    const liveMarker = '当前材料已经改写，不是采纳时原文';
    task.snippets = task.snippets.map(s => s.id === original.primaryEvidenceId ? {...s, text: liveMarker} : s);
    task.facts = mode === 'deleted' || mode === 'deleted-missing-item' ? task.facts.filter(f => f.id !== original.factId) : task.facts.map(f =>
      f.id === original.factId ? {...f, value: '120', selectedConflictValue: '120', primaryEvidenceId: 'EVD-01', metricScope: '当前甲口径'} : f);
    assert(savePersistedState([task], task.id, '主笔甲'));
    const view = mount(<App/>);
    try {
      const baseline = business(loadPersistedState().tasks[0]);
      act(() => (view.host.querySelector('[data-testid="btn-open-fact-impact"]') as HTMLElement).click());
      const card = view.host.querySelector(`[data-testid="fact-impact-card-${original.factId}"]`)!; assert(card, mode);
      click(card, '查看本稿依据');
      if (mode === 'deleted-missing-item') {
        assert(!view.host.querySelector('[aria-labelledby="snippet-drawer-title"]'));
        assert(view.host.textContent?.includes('既无本稿冻结记录，也无当前事实记录'));
        assert.deepEqual(business(loadPersistedState().tasks[0]), baseline);
        continue;
      }
      const drawer = view.host.querySelector('[aria-labelledby="snippet-drawer-title"]')!; assert(drawer, mode);
      const text = drawer.textContent || '';
      if (mode === 'missing-item' || mode === 'missing-provenance') {
        assert(text.includes('未保存') || text.includes('未记录'), `${mode}: truthful limitation`);
        assert(!text.includes(liveMarker));
        assert(!text.includes(task.snippets.find(s => s.id === 'EVD-01')!.text));
      } else {
        assert(text.includes(original.provenance!.text), `${mode}: actual frozen excerpt`);
        assert(text.includes(`材料名称：${original.provenance!.sourceDocName}`));
        assert(text.includes('仅保存采纳时片段，未保存当时全文'));
      }
      assert(!text.includes('来源：科室甲'), `${mode}: no live full text`);
      assert(!text.includes(liveMarker));
      if (mode === 'working') assert(!text.includes('只读快照'), 'viewing frozen evidence does not turn a working draft into history');
      click(view.host, '关闭抽屉');
      assert.deepEqual(business(loadPersistedState().tasks[0]), baseline, `${mode}: opening/closing leaves business data unchanged`);
    } finally {view.close(); keys.forEach(removeStorageItem);}
  }
});

await check('impact dialog traps Tab/Shift+Tab, closes on Escape, restores focus on unmount', () => {
  const task = createPresetTask('under_review'); const draft = draftOf(task);
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  let closed = 0;
  const view = mount(<FactImpactModal isOpen analysis={analyzeFactImpact(task, draft)} currentDraft={draft}
    task={task} onClose={() => {closed++;}} onLocateBlock={() => {}} onViewDraftEvidence={() => {}}/>);
  try {
    const modal = view.host.querySelector('[role="dialog"]')!;
    const buttons = [...modal.querySelectorAll<HTMLButtonElement>('button')].filter(b => !b.disabled);
    const first = buttons[0], last = buttons[buttons.length - 1];
    last.focus(); const forward = new dom.window.KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true});
    act(() => last.dispatchEvent(forward)); assert(forward.defaultPrevented); assert.equal(document.activeElement, first);
    first.focus(); const reverse = new dom.window.KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true, cancelable:true});
    act(() => first.dispatchEvent(reverse)); assert(reverse.defaultPrevented); assert.equal(document.activeElement, last);
    act(() => last.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true})));
    assert.equal(closed, 1);
  } finally {view.close(); assert.equal(document.activeElement, trigger); trigger.remove();}
});

await check('task/version switch cancels impact dialog and delayed location even with reused block IDs', async () => {
  const task = createPresetTask('under_review'); const draft = draftOf(task);
  const changed = modifyOrExcludeFact(task, draft.snapshotMetadata!.factSnapshot!.items[0].factId,
    {value: '120', selectedConflictValue: '120'}, '主笔甲').updatedTask!;
  const render = (t: Task) => <DraftingStage task={t} activeRole="主笔甲" onUpdateTask={() => {}}
    onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>;
  const view = mount(render(changed));
  try {
    const open = () => act(() => (view.host.querySelector('[data-testid="btn-open-fact-impact"]') as HTMLElement).click());
    open();
    const otherDraft: DraftVersion = {...structuredClone(draft), id:'ANOTHER-DRAFT', versionNumber:'v2.0'};
    const switched = {...changed, currentDraftId:otherDraft.id, drafts:[...changed.drafts, otherDraft]};
    view.render(render(switched));
    assert(!view.host.querySelector('[data-testid="fact-impact-modal"]'), 'version switch clears dialog context');
    open(); const locate = view.host.querySelector<HTMLButtonElement>('[data-testid^="btn-locate-block-"]')!;
    act(() => locate.click());
    view.render(render({...switched, id:'ANOTHER-TASK'}));
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    await act(async () => {await new Promise(r => setTimeout(r, 130));});
    assert.equal(document.activeElement, outside, 'old delayed focus cannot move into another task with the same block ID');
    outside.remove();
  } finally {view.close();}
});

if (failures.length) {console.error(`${failures.length} Task21 receipt regression groups failed`); process.exitCode=1;}
