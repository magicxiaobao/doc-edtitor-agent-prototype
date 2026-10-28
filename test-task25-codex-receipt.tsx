import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createMultiFactGroupRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { saveFactReviewRecord } from './src/services/factReviewService';
import { restoreDraftVersion, validateFinalizationConditions, validateUndoEligibility } from './src/services/draftLifecycleService';
import { checkMultiFactGroupRevisionEligibility as eligible, generateMultiFactGroupRevisionCandidate as generate,
  validateMultiFactGroupRevisionAcceptance as validate, acceptMultiFactGroupRevisionCandidate as accept } from './src/services/factRevisionCandidateService';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './src/components/stages/StyleAndOutlineStage';
import { App } from './src/App';
import { loadPersistedState, savePersistedState } from './src/services/storageService';
import type { Task, DraftVersion, MultiFactGroupRevisionCandidate, UserRole } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); }
}
const clone = <T,>(value: T): T => structuredClone(value);
function approve(task: Task) {
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = { hash: 'codex-task25', confirmedAt: '2026-10-28T04:00:00Z',
    factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(task, f)) };
}
function fixture() {
  const task = createMultiFactGroupRevisionDemoTask(); const draft = task.drafts[0];
  for (const [id, value, evidence] of [['FACT-01', '120', 'EVD-01'], ['FACT-02', '18', 'EVD-07']]) {
    Object.assign(task.facts.find(f => f.id === id)!, { status: 'confirmed', value, selectedConflictValue: value,
      primaryEvidenceId: evidence, conflictResolutionReason: '核实同期间同范围，采信最新材料' });
  }
  approve(task); task.outlineConfirmed = true; task.outlineSnapshot = clone(draft.snapshotMetadata!.outlineSnapshot);
  return { task, draft };
}
function candidate(task: Task, draft: DraftVersion) {
  const r = generate(task, draft, '主笔甲'); assert.equal(r.success, true, r.reason);
  const c = r.candidateGroup!; assert.equal(validate(task, draft, c, '主笔甲', c.runId).valid, true);
  return c;
}
function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  act(() => root.render(element));
  return { host, render: (e: React.ReactElement) => act(() => root.render(e)),
    close: () => { act(() => root.unmount()); host.remove(); } };
}
function click(host: HTMLElement, id: string) {
  const b = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  assert.ok(b, id); assert.notEqual(b.disabled, true, id); act(() => b.click());
}
function modal(task: Task, draft: DraftVersion, extra: Partial<React.ComponentProps<typeof FactImpactModal>> = {}) {
  return <FactImpactModal isOpen task={task} currentDraft={draft} analysis={analyzeFactImpact(task, draft)}
    activeRole="主笔甲" onClose={() => {}} {...extra} />;
}

await check('1 整组采纳、两事实三段计数、全量正文及输入不变性', () => {
  const { task, draft } = fixture(); const before = clone(task); const c = candidate(task, draft);
  assert.equal(c.facts.length, 2); assert.equal(c.items.length, 3);
  const r = accept(task, draft, c, '主笔甲', c.runId); assert.equal(r.success, true, r.reason);
  assert.deepEqual(task, before); const next = r.newWorkingDraft!;
  for (const b of draft.blocks) {
    const n = next.blocks.find(x => x.id === b.id)!;
    if (c.targetBlockIds.includes(b.id)) {
      const f = c.facts.find(x => x.referencingBlockIds.includes(b.id))!;
      assert.equal(n.content, b.content.replace(`${f.metric}${f.fromValue}`, `${f.metric}${f.toValue}`));
      assert.equal(n.revisionSeq, (b.revisionSeq ?? 0) + 1);
      assert.deepEqual(n.referencedFactIds, b.referencedFactIds);
    } else assert.deepEqual(n, b);
  }
  assert.ok(next.blocks[2].content.includes('800人次'));
  assert.equal(r.updatedTask!.drafts.length, 2); assert.equal(r.updatedTask!.modificationLogs!.length, 1);
  assert.equal(accept(r.updatedTask!, next, c, '主笔甲', c.runId).success, false);
  assert.deepEqual(r.archivedDraft!.snapshotMetadata, draft.snapshotMetadata);
  assert.equal(analyzeFactImpact(r.updatedTask!, next).changedFactsCount, 0);
});

await check('2 两项事实各关联一段且重排后按稳定ID修订', () => {
  const { task, draft } = fixture(); draft.blocks[1].referencedFactIds = [];
  draft.blocks.reverse(); draft.blocks.forEach((b, i) => { b.order = i + 1; });
  const c = candidate(task, draft); assert.equal(c.items.length, 2);
  const r = accept(task, draft, c, '主笔甲', c.runId); assert.equal(r.success, true);
  assert.equal(r.newWorkingDraft!.blocks.find(b => b.id === 'BLK-02')!.content, draft.blocks.find(b => b.id === 'BLK-02')!.content);
});

await check('3 权限、只读、缺失重复ID、陈旧稿与完整基准保护', () => {
  for (const role of ['审阅乙', '供稿丙', undefined, 'unknown']) {
    const { task, draft } = fixture(); assert.equal(generate(task, draft, role as UserRole).success, false);
  }
  const changes: Array<(t: Task, d: DraftVersion) => void> = [
    (_t, d) => { d.isHistoricalSnapshot = true; }, (_t, d) => { d.isFinal = true; },
    (_t, d) => { d.blocks[4].id = d.blocks[0].id; }, (_t, d) => { d.blocks[4].id = ''; },
    (_t, d) => { d.snapshotMetadata!.factSnapshot = undefined; },
    (t) => { t.currentDraftId = 'other'; }, (t) => { t.factSnapshot!.items.pop(); },
  ];
  for (const change of changes) { const { task, draft } = fixture(); change(task, draft); assert.equal(generate(task, draft, '主笔甲').success, false); }
  const { task, draft } = fixture(); const stale = clone(draft); stale.blocks[0].content += '人工修改';
  assert.equal(generate(task, stale, '主笔甲').success, false);
});

await check('4 重叠、单位期间口径和最后一段改写失败均不写入', () => {
  const changes: Array<(t: Task, d: DraftVersion) => void> = [
    (_t, d) => { d.blocks[2].referencedFactIds.push('FACT-01'); },
    (t) => { t.facts[1].unit = '期'; approve(t); },
    (t) => { t.facts[1].period = '2026年1至6月'; approve(t); },
    (t) => { t.facts[1].metricScope += '不同口径'; approve(t); },
    (_t, d) => { d.blocks[2].content = '2026年1至9月，计划组织专题培训16场，累计参训800人次。'; },
    (_t, d) => { d.blocks[2].content = d.blocks[2].content.replace('16场', '116场'); },
  ];
  for (const change of changes) { const { task, draft } = fixture(); candidate(task, draft); change(task, draft);
    const before = clone(task); assert.equal(generate(task, draft, '主笔甲').success, false); assert.deepEqual(task, before); }
});

await check('5 生成后正文、修订、引用、事实、原文和审批变化均使整组失效', () => {
  const changes: Array<(t: Task, d: DraftVersion) => void> = [
    (_t, d) => { d.blocks[2].content += '编辑'; }, (_t, d) => { d.blocks[4].content += '对照编辑'; },
    (_t, d) => { d.blocks[2].revisionSeq = 2; }, (_t, d) => { d.blocks[2].referencedFactIds.pop(); },
    (t) => { t.facts[1].selectedConflictValue = '19'; }, (t) => { t.facts[1].status = 'pending'; },
    (t) => { t.snippets.find(s => s.id === 'EVD-07')!.text += '原文变化'; },
    (t) => { t.documents.find(d => d.id === 'SRC-07')!.content += '正文变化'; },
    (t) => { t.styleConfirmed = false; }, (t) => { t.outlineConfirmed = false; },
    (t) => { t.factSnapshot = undefined; }, (t) => { t.audience += '新受众'; },
  ];
  for (const change of changes) { const { task, draft } = fixture(); const c = candidate(task, draft); change(task, draft);
    const before = clone(task); assert.equal(validate(task, draft, c, '主笔甲', c.runId).valid, false);
    assert.equal(accept(task, draft, c, '主笔甲', c.runId).success, false); assert.deepEqual(task, before); }
});

await check('6 缺项、重复项、额外项与候选篡改不会推进依据', () => {
  const changes: Array<(c: MultiFactGroupRevisionCandidate) => void> = [
    c => { c.items.pop(); }, c => { c.items.push(clone(c.items[0])); }, c => { c.items[2].revisedBlockContent += '篡改'; },
    c => { c.facts[1].toValue = '20'; }, c => { c.facts[1].factId = c.facts[0].factId; },
    c => { c.targetFactIds.pop(); }, c => { c.targetBlockIds.push('BLK-04'); },
  ];
  for (const change of changes) { const { task, draft } = fixture(); const c = candidate(task, draft); change(c);
    const before = clone(task); assert.equal(accept(task, draft, c, '主笔甲', c.runId).success, false); assert.deepEqual(task, before); }
});

await check('7 非完整候选结构返回安全拒绝，不抛异常', () => {
  const { task, draft } = fixture(); const original = candidate(task, draft);
  for (const field of ['items', 'targetFactIds', 'targetBlockIds', 'upstreamContext']) {
    const c = clone(original); delete (c as unknown as Record<string, unknown>)[field];
    assert.equal(validate(task, draft, c, '主笔甲', c.runId).valid, false, field);
  }
  const c = clone(original); (c.facts as unknown[])[1] = null;
  assert.equal(validate(task, draft, c, '主笔甲', c.runId).valid, false);
});

await check('8 人工复核冻结、来源参考、审阅门禁及整稿恢复', () => {
  let { task, draft } = fixture();
  task = saveFactReviewRecord({ task, targetDraftId: draft.id, targetBlockId: 'BLK-03', activeRole: '主笔甲',
    status: 'reviewed', notes: '核对培训16与18，尚未修改正文' }).updatedTask;
  draft = task.drafts.find(d => d.id === task.currentDraftId)!; const c = candidate(task, draft);
  const r = accept(task, draft, c, '主笔甲', c.runId); assert.equal(r.success, true);
  assert.equal(r.archivedDraft!.factReviewRecords!.length, 1); assert.deepEqual(r.newWorkingDraft!.factReviewRecords, []);
  assert.equal(r.newWorkingDraft!.sourceFactReviewRecords!.length, 1);
  assert.equal(validateFinalizationConditions(r.updatedTask!, r.newWorkingDraft!.id, '主笔甲').checks.commentsClosed, false);
  assert.equal(validateUndoEligibility(r.updatedTask!, r.newWorkingDraft!, r.modificationLog!.id, '主笔甲').canUndo, false);
  const restored = restoreDraftVersion(r.updatedTask!, draft.id, '主笔甲');
  assert.deepEqual(restored.workingDraft.blocks, draft.blocks); assert.deepEqual(restored.workingDraft.snapshotMetadata, draft.snapshotMetadata);
  assert.equal(analyzeFactImpact(restored.updatedTask, restored.workingDraft).changedFactsCount, 2);
});

await check('9 两事实同值消歧、单份候选及完整原文候选', () => {
  const { task, draft } = fixture(); draft.blocks[0].content = '其他项目128项。2026年1至9月，累计完成重点任务128项。';
  draft.blocks[2].content = '其他培训16场。2026年1至9月，组织专题培训16场，累计参训800人次。';
  const before = clone(task); const view = mount(modal(task, draft));
  try {
    for (const entry of ['btn-generate-multi-fact-group-revision', 'btn-generate-multi-fact-group-revision-BLK-03']) {
      click(view.host, entry); assert.equal(view.host.querySelectorAll('[data-testid="multi-fact-group-revision-candidate-card"]').length, 1);
      assert.equal(view.host.querySelectorAll('[data-testid="btn-accept-multi-fact-group-revision"]').length, 1);
      assert.ok(view.host.querySelector('[data-testid="revision-diff-view-BLK-01"]')!.textContent!.startsWith('其他项目128项。'));
      assert.ok(view.host.querySelector('[data-testid="revision-diff-view-BLK-03"]')!.textContent!.includes('组织专题培训[删: 16场][改: 18场]'));
    }
    click(view.host, 'btn-cancel-multi-fact-group-revision'); assert.equal(view.host.querySelectorAll('[data-testid="multi-fact-group-revision-candidate-card"]').length, 0);
    assert.deepEqual(task, before);
  } finally { view.close(); }
});

await check('10 两项事实均有最新原文入口，旧依据入口独立', () => {
  const { task, draft } = fixture(); const view = mount(modal(task, draft));
  try { click(view.host, 'btn-generate-multi-fact-group-revision');
    for (const id of ['FACT-01', 'FACT-02']) {
      assert.ok(view.host.querySelector(`[data-testid="btn-view-evidence-${id}"]`));
      assert.ok(view.host.querySelector(`[data-testid="btn-view-latest-evidence-${id}"]`), `缺少${id}最新原文入口`);
    }
  } finally { view.close(); }
});

await check('11 采纳失败保留候选、成功后同批重复点击只调用一次', () => {
  const { task, draft } = fixture(); let calls = 0;
  const props = { onAcceptMultiFactGroupRevision: () => { calls++; return calls === 1 ? { success: false, reason: '写入失败测试' } : { success: true }; } };
  const view = mount(modal(task, draft, props));
  try { click(view.host, 'btn-generate-multi-fact-group-revision'); click(view.host, 'btn-accept-multi-fact-group-revision');
    assert.equal(calls, 1); assert.ok(view.host.textContent!.includes('写入失败测试'));
    const retry = view.host.querySelector<HTMLButtonElement>('[data-testid="btn-retry-accept-multi-fact-group-revision"]')!;
    act(() => { retry.click(); retry.click(); }); assert.equal(calls, 2);
  } finally { view.close(); }
});

await check('12 任务版本角色切换、Escape和关闭清除候选且无写入', () => {
  const { task, draft } = fixture(); const before = clone(task); let closed = 0;
  const view = mount(modal(task, draft, { onClose: () => { closed++; } }));
  try {
    click(view.host, 'btn-generate-multi-fact-group-revision');
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(closed, 1);
    view.render(modal(task, draft, { isOpen: false })); view.render(modal(task, draft));
    assert.equal(view.host.querySelectorAll('[data-testid="multi-fact-group-revision-candidate-card"]').length, 0);
    for (const role of ['审阅乙', '供稿丙'] as const) {
      view.render(modal(task, draft)); click(view.host, 'btn-generate-multi-fact-group-revision');
      view.render(modal(task, draft, { activeRole: role }));
      assert.equal(view.host.querySelectorAll('[data-testid^="btn-generate-multi-fact-group-revision"]').length, 0);
      assert.equal(view.host.querySelectorAll('[data-testid="multi-fact-group-revision-candidate-card"]').length, 0);
    }
    const other = fixture(); other.task.id += '-other'; view.render(modal(other.task, other.draft));
    assert.equal(view.host.querySelectorAll('[data-testid="multi-fact-group-revision-candidate-card"]').length, 0);
    assert.deepEqual(task, before);
  } finally { view.close(); }
});

await check('13 损坏的可选事实日志不使合法正文和完整段落日志崩溃', () => {
  const { task, draft } = fixture(); const c = candidate(task, draft); const r = accept(task, draft, c, '主笔甲', c.runId);
  r.modificationLog!.affectedFacts = [null, { metric: { invalid: true } }] as never;
  assert.equal(savePersistedState([r.updatedTask!], r.newWorkingDraft!.id, '主笔甲'), true);
  const loaded = loadPersistedState().tasks.find(t => t.id === task.id)!; assert.ok(loaded);
  const view = mount(<RecentModificationsModal isOpen onClose={() => {}} task={loaded}
    currentDraft={loaded.drafts.find(d => d.id === loaded.currentDraftId)} activeRole="主笔甲" onUndo={() => {}} />);
  try { assert.ok(view.host.textContent!.includes('来源版本')); assert.equal(view.host.querySelectorAll('[data-testid^="log-affected-block-"]').length, 3); }
  finally { view.close(); localStorage.clear(); }
});

await check('14 真实跨阶段组件完成两次裁决、核准、取消、采纳和完整日志', () => {
  const initial = createMultiFactGroupRevisionDemoTask(); let latest = initial;
  function Journey() {
    const [task, setTask] = React.useState(initial); const [stage, setStage] = React.useState(2); latest = task;
    const props = { task, activeRole: '主笔甲' as const, onViewSnippet: () => {},
      onUpdateTask: (patch: Partial<Task>) => setTask(t => ({ ...t, ...patch })), onProceedToNextStage: () => setStage(s => s + 1) };
    return stage === 2 ? <MaterialsAndFactsStage {...props} /> : stage === 3 ? <StyleAndOutlineStage {...props} /> : <DraftingStage {...props} />;
  }
  const view = mount(<Journey />);
  const byText = (text: string) => { const b = [...view.host.querySelectorAll('button')].find(b => b.textContent!.trim() === text);
    assert.ok(b, text); assert.equal(b.disabled, false); act(() => b.click()); };
  try {
    for (const [index, value] of [[0, '120'], [1, '18']] as const) {
      const buttons = [...view.host.querySelectorAll('button')].filter(b => b.textContent!.trim() === '裁决冲突');
      assert.ok(buttons[index]); act(() => buttons[index].click()); click(view.host, `conflict-candidate-${value}`);
      const input = view.host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
      act(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, initial.facts[index].metricScope);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        simulateTextareaChange(view.host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!, '核实两份原文同期间同范围，采信最新数值。');
      }); byText('确认采信并写入事实');
    }
    byText('确认本次事实清单'); byText('下一步：文风与大纲'); byText('确认大纲并进入起草'); byText('下一步：正文起草');
    const before = clone(latest); click(view.host, 'btn-open-fact-impact'); click(view.host, 'btn-generate-multi-fact-group-revision');
    click(view.host, 'btn-cancel-multi-fact-group-revision'); assert.deepEqual(latest, before);
    click(view.host, 'btn-generate-multi-fact-group-revision'); click(view.host, 'btn-accept-multi-fact-group-revision');
    const next = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.equal(latest.drafts.length, 2); assert.equal(latest.modificationLogs!.length, 1);
    assert.ok(next.blocks[2].content.includes('18场')); assert.ok(next.blocks[2].content.includes('800人次'));
    const b = [...view.host.querySelectorAll('button')].find(b => b.textContent!.includes('最近修改记录'))!;
    act(() => b.click()); const summary = view.host.querySelector('summary')!; act(() => summary.click());
    assert.equal(view.host.querySelectorAll('[data-testid^="log-affected-fact-"]').length, 2);
    assert.equal(view.host.querySelectorAll('[data-testid^="log-affected-block-"]').length, 3);
  } finally { view.close(); }
});

await check('15 App显式创建、快速重复创建及已编辑演示复用不覆盖旧任务', () => {
  localStorage.clear(); const view = mount(<App />);
  try {
    const before = clone(loadPersistedState().tasks);
    const toggle = [...view.host.querySelectorAll('button')].find(b => b.textContent!.trim() === '展开演示专区')!;
    act(() => toggle.click()); const create = view.host.querySelector<HTMLButtonElement>('[data-testid="btn-create-multi-fact-group-demo-task"]')!;
    act(() => { create.click(); create.click(); }); const saved = loadPersistedState();
    assert.equal(saved.tasks.filter(t => t.id === 'TASK-DEMO-MULTI-FACT-GROUP-REVISION').length, 1);
    for (const old of before) assert.deepEqual(saved.tasks.find(t => t.id === old.id), old);
    const demo = clone(saved.tasks.find(t => t.id === saved.currentTaskId)); act(() => create.click());
    assert.deepEqual(loadPersistedState().tasks.find(t => t.id === saved.currentTaskId), demo);
  } finally { view.close(); localStorage.clear(); }
});

await check('16 真实起草组件的旧冻结与最新原文入口分别接线且不写入', () => {
  const { task, draft } = fixture(); const before = clone(task);
  let viewed: { id: string; text: string; frozen: boolean | undefined } | undefined;
  const view = mount(<DraftingStage task={task} activeRole="主笔甲" onUpdateTask={() => assert.fail('查看出处不应写入任务')}
    onProceedToNextStage={() => {}} onViewSnippet={(snippet, fact, _adopted, frozen) => {
      viewed = { id: fact!.id, text: snippet.text, frozen };
    }} />);
  try {
    for (const [id, oldValue, newValue] of [['FACT-01', '128项', '120项'], ['FACT-02', '16场', '18场']]) {
      for (const latest of [false, true]) {
        click(view.host, 'btn-open-fact-impact'); click(view.host, 'btn-generate-multi-fact-group-revision');
        click(view.host, `${latest ? 'btn-view-latest-evidence' : 'btn-view-evidence'}-${id}`);
        assert.ok(viewed); assert.equal(viewed.id, id); assert.equal(viewed.frozen, !latest);
        assert.ok(viewed.text.includes(latest ? newValue : oldValue), viewed.text);
      }
    }
    assert.deepEqual(task, before); assert.equal(draft.id, task.currentDraftId);
  } finally { view.close(); }
});

if (failures.length) { console.error(`Task25 Codex independent failures: ${failures.length}\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log('Task25 Codex independent checks: 16 groups passed.');
