import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createMultiParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './src/components/stages/StyleAndOutlineStage';
import { App } from './src/App';
import { loadPersistedState } from './src/services/storageService';
import { restoreDraftVersion, validateUndoEligibility, validateFinalizationConditions } from './src/services/draftLifecycleService';
import { checkMultiParagraphFactRevisionEligibility as eligible,
  generateMultiParagraphFactRevisionCandidate as generate,
  acceptMultiParagraphFactRevisionCandidate as accept,
  validateMultiParagraphFactRevisionAcceptance as validate } from './src/services/factRevisionCandidateService';
import type { Task, DraftVersion } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); }
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function approve(task: Task) {
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = { confirmedAt: '2026-10-27T07:00:00Z', hash: 'codex-task24-approval',
    factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(task, f)) };
}
function fixture() {
  const task = clone(createMultiParagraphRevisionDemoTask());
  const draft = task.drafts.find(d => d.id === task.currentDraftId)!;
  Object.assign(task.facts[0], { status: 'confirmed', value: '120', selectedConflictValue: '120',
    primaryEvidenceId: 'EVD-01', conflictResolutionReason: '核实同期间同范围，采信甲120项' });
  approve(task);
  task.outlineConfirmed = true;
  task.outlineSnapshot = clone(draft.snapshotMetadata!.outlineSnapshot);
  return { task, draft };
}
function candidate(task: Task, draft: DraftVersion) {
  const r = generate(task, draft, '主笔甲', { targetFactId: 'FACT-01' });
  assert.equal(r.success, true, r.reason); return r.candidateGroup!;
}
function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, render: (e: React.ReactElement) => act(() => root.render(e)),
    close: () => { act(() => root.unmount()); host.remove(); } };
}
function click(host: HTMLElement, id: string) {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  assert.ok(button, id); act(() => button.click());
}
function modal(task: Task, draft: DraftVersion, extra: Partial<React.ComponentProps<typeof FactImpactModal>> = {}) {
  return <FactImpactModal isOpen onClose={() => {}} task={task} currentDraft={draft}
    analysis={analyzeFactImpact(task, draft)} activeRole="主笔甲" {...extra} />;
}

await check('1 重复稳定ID不能使未关联正文被目标段落覆盖', () => {
  const { task, draft } = fixture();
  draft.blocks.push({ ...clone(draft.blocks[2]), id: 'BLK-01', order: 7,
    content: '独立对照段落，应保持原文。', referencedFactIds: [] });
  const before = structuredClone(task);
  const result = generate(task, draft, '主笔甲');
  if (result.candidateGroup) {
    const accepted = accept(task, draft, result.candidateGroup, '主笔甲', result.candidateGroup.runId);
    assert.equal(accepted.success, false, '重复ID不可采纳或覆盖未关联对照段落');
  }
  assert.equal(result.success, false, '重复Block ID必须在生成前明确拒绝');
  assert.deepEqual(task, before);
});

await check('2 #82差异标记必须落在实际变化位置，保留其他指标同值', () => {
  const { task, draft } = fixture();
  draft.blocks[0].content = '其他项目128项。2026年1至9月，累计完成重点任务128项。';
  const view = mount(modal(task, draft));
  try {
    click(view.host, 'btn-generate-multi-paragraph-fact-revision-BLK-01');
    const diff = view.host.querySelector('[data-testid="revision-diff-view-BLK-01"]')!.textContent!;
    assert.ok(diff.startsWith('其他项目128项。'), diff);
    assert.ok(diff.includes('累计完成重点任务[删: 128项][改: 120项]'), diff);
    assert.equal(view.host.querySelector('[data-testid="revised-block-content-BLK-01"]')!.textContent,
      '其他项目128项。2026年1至9月，累计完成重点任务120项。');
    assert.ok(!diff.includes('1280项'));
  } finally { view.close(); }
});

await check('3 从任一关联段落进入只有一组候选及一个整体采纳入口', () => {
  const { task, draft } = fixture(); const view = mount(modal(task, draft));
  try {
    for (const block of ['BLK-01', 'BLK-02']) {
      click(view.host, `btn-generate-multi-paragraph-fact-revision-${block}`);
      assert.equal(view.host.querySelectorAll('[data-testid="multi-paragraph-revision-candidate-card-FACT-01"]').length, 1);
      assert.equal(view.host.querySelectorAll('[data-testid="btn-accept-multi-fact-revision-FACT-01"]').length, 1);
      assert.equal(view.host.querySelectorAll('[data-testid="candidate-item-BLK-01"]').length, 1);
      assert.equal(view.host.querySelectorAll('[data-testid="candidate-item-BLK-02"]').length, 1);
    }
    click(view.host, 'btn-cancel-multi-fact-revision-FACT-01');
    assert.equal(view.host.querySelectorAll('[data-testid^="multi-paragraph-revision-candidate-card-"]').length, 0);
  } finally { view.close(); }
});

await check('4 合并日志真实组件展示全部段落明细与整体来源，不伪称单段AI建议', () => {
  const { task, draft } = fixture(); const c = candidate(task, draft);
  const r = accept(task, draft, c, '主笔甲', c.runId); assert.equal(r.success, true, r.reason);
  const view = mount(<RecentModificationsModal isOpen onClose={() => {}} task={r.updatedTask!}
    currentDraft={r.newWorkingDraft} activeRole="主笔甲" onUndo={() => { throw Error('不得单撤'); }} />);
  try {
    assert.ok(view.host.textContent!.includes('多段落事实修订'), view.host.textContent!);
    const details = view.host.querySelector<HTMLDetailsElement>('details')!;
    act(() => details.querySelector('summary')!.click()); assert.equal(details.open, true);
    for (const b of draft.blocks.slice(0, 2)) {
      const detail = view.host.querySelector(`[data-testid="log-affected-block-${b.id}"]`);
      assert.ok(detail, `须可展开查看${b.id}`);
      assert.ok(detail.textContent!.includes(b.content));
      assert.ok(detail.textContent!.includes(b.content.replace('128项', '120项')));
      assert.equal(detail.querySelectorAll('.line-clamp-2').length, 0, '逐段明细不得不可展开截断');
    }
    assert.ok(view.host.textContent!.includes('EVD-01'));
    assert.equal(view.host.querySelector<HTMLButtonElement>('[data-testid^="btn-undo-log-"]')!.disabled, true);
  } finally { view.close(); }
});

await check('5 新演示任务审阅意见须绑定本稿与真正的培训段落', () => {
  const task = createMultiParagraphRevisionDemoTask(); const draft = task.drafts[0];
  assert.equal(task.reviewComments.length, 3);
  for (const c of task.reviewComments) {
    assert.equal(c.targetVersionId, draft.id, c.id);
    if (c.type === 'paragraph') {
      const b = draft.blocks.find(b => b.id === c.targetBlockId)!;
      assert.ok(b); assert.equal(c.baseParagraphText, b.content); assert.ok(b.content.includes('800人次'));
      assert.equal(c.targetBlockOrder, b.order);
    }
  }
});

await check('6 服务入口缺失或未知角色不能默认获得主笔权限', () => {
  const { task, draft } = fixture();
  for (const args of [['FACT-01'], ['FACT-01', '未知角色'], [undefined], ['审阅乙'], ['供稿丙']]) {
    const checkResult = (eligible as (...args: any[]) => { eligible: boolean })(task, draft, ...args);
    assert.equal(checkResult.eligible, false, JSON.stringify(args));
    const generated = (generate as (...args: any[]) => { success: boolean })(task, draft, ...args);
    assert.equal(generated.success, false, JSON.stringify(args));
  }
  assert.equal(eligible(task, draft, 'FACT-01', '主笔甲').eligible, true);
});

await check('7 无硬编码：非120/128、非固定Fact/Block ID仍仅更新关联数值', () => {
  const { task: source } = fixture();
  const task: Task = JSON.parse(JSON.stringify(source).replaceAll('128', '47').replaceAll('120', '52')
    .replaceAll('FACT-01', 'FACT-Z9').replaceAll('BLK-01', 'BLOCK-X7').replaceAll('BLK-02', 'BLOCK-Y8'));
  const draft = task.drafts[0]; const before = structuredClone(task);
  const r = generate(task, draft, '主笔甲'); assert.equal(r.success, true, r.reason);
  assert.equal(r.candidateGroup!.fromValue, '47'); assert.equal(r.candidateGroup!.toValue, '52');
  const a = accept(task, draft, r.candidateGroup!, '主笔甲', r.candidateGroup!.runId);
  assert.equal(a.success, true, a.reason);
  assert.deepEqual(a.newWorkingDraft!.blocks.slice(2), draft.blocks.slice(2));
  assert.deepEqual(task, before);
});

await check('8 任何目标段落失败均无部分候选或业务写入', () => {
  for (const content of ['截至6月末，累计完成重点任务128项。', '累计完成重点任务128项/年。',
    '2026年1至9月，计划累计完成重点任务128项。', '累计完成重点任务128项。累计完成重点任务128项。',
    '累计完成重点任务120项。']) {
    const { task, draft } = fixture(); draft.blocks[1].content = content; const before = structuredClone(task);
    const r = generate(task, draft, '主笔甲'); assert.equal(r.success, false, content);
    assert.ok(r.reason?.includes('BLK-02')); assert.equal(r.candidateGroup, undefined);
    assert.deepEqual(task, before);
  }
});

await check('9 生成后正文/引用/原文/审批/全组负载变化均整体拒绝并零写入', () => {
  const mutations: ((t: Task, d: DraftVersion) => void)[] = [
    (_t, d) => { d.blocks[1].revisionSeq = 1; },
    (_t, d) => { d.blocks[2].content += '人工补充'; },
    (_t, d) => { d.blocks[2].referencedFactIds.push('FACT-01'); },
    (_t, d) => { d.blocks.reverse(); },
    t => { t.snippets[0].text += '新增原文'; },
    t => { t.outline[0].suggestedWordCount += 100; },
    t => { t.audience = '新受众'; },
  ];
  for (const mutate of mutations) {
    const { task, draft } = fixture(); const c = candidate(task, draft); mutate(task, draft); const before = structuredClone(task);
    assert.equal(accept(task, draft, c, '主笔甲', c.runId).success, false);
    assert.deepEqual(task, before);
  }
  const { task, draft } = fixture(); const c = candidate(task, draft);
  for (const bad of [{ ...c, items: c.items.slice(0, 1) }, { ...c, items: [...c.items, c.items[0]] },
    { ...c, items: c.items.map((i, n) => n ? { ...i, revisedBlockContent: '未经核准的正文' } : i) }]) {
    assert.equal(validate(task, draft, bad, '主笔甲', c.runId).valid, false);
  }
});

await check('10 一次采纳冻结历史、新稿复核为空、日志整体不可撤与完整恢复', () => {
  const { task, draft } = fixture(); const before = structuredClone(task); const c = candidate(task, draft);
  const r = accept(task, draft, c, '主笔甲', c.runId); assert.equal(r.success, true, r.reason);
  assert.deepEqual(task, before); assert.equal(r.updatedTask!.drafts.length, task.drafts.length + 1);
  assert.deepEqual(r.archivedDraft!.blocks, draft.blocks);
  assert.deepEqual(r.newWorkingDraft!.factReviewRecords, []);
  assert.equal(r.updatedTask!.modificationLogs!.length, 1);
  assert.equal(validateUndoEligibility(r.updatedTask!, r.newWorkingDraft, r.modificationLog!.id, '主笔甲').canUndo, false);
  assert.equal(accept(r.updatedTask!, r.newWorkingDraft, c, '主笔甲', c.runId).success, false);
  const restored = restoreDraftVersion(r.updatedTask!, r.archivedDraft!.id, '主笔甲');
  assert.deepEqual(restored.workingDraft.blocks, draft.blocks);
  assert.equal(restored.workingDraft.snapshotMetadata!.factSnapshot!.items[0].value, '128');
  assert.equal(validateFinalizationConditions(r.updatedTask!, r.newWorkingDraft!.id, '主笔甲').checks.commentsClosed, false);
});

await check('11 真实起草组件的多段采纳接线与刷新等价数据恢复', () => {
  const { task } = fixture(); let latest = task;
  function Harness() {
    const [current, setCurrent] = React.useState(task); latest = current;
    return <DraftingStage task={current} activeRole="主笔甲" onViewSnippet={() => {}} onProceedToNextStage={() => {}}
      onUpdateTask={update => setCurrent(prev => ({ ...prev, ...update }))} />;
  }
  const view = mount(<Harness />);
  try {
    click(view.host, 'btn-open-fact-impact');
    click(view.host, 'btn-generate-multi-paragraph-fact-revision-BLK-02');
    click(view.host, 'btn-accept-multi-fact-revision-FACT-01');
    const d = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.equal(latest.drafts.length, 2); assert.equal(latest.modificationLogs!.length, 1);
    assert.ok(d.blocks[0].content.includes('120项')); assert.ok(d.blocks[1].content.includes('120项'));
    assert.deepEqual(d.blocks.slice(2), task.drafts[0].blocks.slice(2));
    const reloaded = clone(latest); const rd = reloaded.drafts.find(d => d.id === reloaded.currentDraftId)!;
    assert.equal(validateFinalizationConditions(reloaded, rd.id, '主笔甲').checks.commentsClosed, false);
  } finally { view.close(); }
});

await check('12 多段候选取消/关闭/切换/失败及同稿陈旧上下文保护', () => {
  const { task, draft } = fixture(); let invoked = 0;
  const props = { onAcceptMultiParagraphFactRevision: () => { invoked++; return { success: false, reason: '独立回归模拟写入失败' }; } };
  const view = mount(modal(task, draft, props));
  try {
    click(view.host, 'btn-generate-multi-paragraph-fact-revision-BLK-01');
    click(view.host, 'btn-accept-multi-fact-revision-FACT-01'); assert.equal(invoked, 1);
    assert.ok(view.host.textContent!.includes('独立回归模拟写入失败'));
    task.audience = '已变更受众'; view.render(modal(task, draft, props));
    assert.equal(view.host.querySelector<HTMLButtonElement>('[data-testid="btn-retry-accept-multi-fact-revision-FACT-01"]')!.disabled, true);
    view.render(modal(task, draft, { ...props, isOpen: false })); view.render(modal(task, draft, props));
    assert.equal(view.host.querySelectorAll('[data-testid^="multi-paragraph-revision-candidate-card-"]').length, 0);
    view.render(modal(task, draft, { ...props, activeRole: '审阅乙' }));
    assert.equal(view.host.querySelectorAll('[data-testid^="btn-generate-multi-paragraph-fact-revision-"]').length, 0);
  } finally { view.close(); }
});

await check('13 独立演示真实跨阶段组件：裁决、事实大纲核准、整体采纳', () => {
  const initial = createMultiParagraphRevisionDemoTask(); const scope = initial.facts[0].metricScope;
  let latest = initial;
  function Journey() {
    const [task, setTask] = React.useState(initial); const [stage, setStage] = React.useState(2); latest = task;
    const props = { task, activeRole: '主笔甲' as const, onViewSnippet: () => {},
      onUpdateTask: (patch: Partial<Task>) => setTask(t => ({ ...t, ...patch })),
      onProceedToNextStage: () => setStage(s => s + 1) };
    return stage === 2 ? <MaterialsAndFactsStage {...props} /> : stage === 3 ?
      <StyleAndOutlineStage {...props} /> : <DraftingStage {...props} />;
  }
  const view = mount(<Journey />);
  const byText = (text: string) => {
    const button = [...view.host.querySelectorAll('button')].find(b => b.textContent!.trim() === text);
    assert.ok(button, text); assert.equal(button.disabled, false); act(() => button.click());
  };
  try {
    byText('裁决冲突'); click(view.host, 'conflict-candidate-120');
    const input = view.host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
    act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, scope);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      simulateTextareaChange(view.host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!, '核实两份原文同期间同范围，仅采信120项。');
    });
    byText('确认采信并写入事实'); byText('确认本次事实清单'); byText('下一步：文风与大纲');
    byText('确认大纲并进入起草'); byText('下一步：正文起草');
    click(view.host, 'btn-open-fact-impact'); click(view.host, 'btn-generate-multi-paragraph-fact-revision-BLK-02');
    click(view.host, 'btn-accept-multi-fact-revision-FACT-01');
    const draft = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.ok(draft.blocks.slice(0, 2).every(b => b.content.includes('120项')));
    assert.equal(latest.drafts.length, 2); assert.equal(latest.modificationLogs!.length, 1);
    assert.equal(validateFinalizationConditions(latest, draft.id, '主笔甲').checks.commentsClosed, false);
  } finally { view.close(); }
});

await check('14 App显式创建演示任务不覆盖原任务，快速重复创建仅保留一份', () => {
  localStorage.clear(); const view = mount(<App />);
  try {
    const before = clone(loadPersistedState().tasks);
    const toggle = [...view.host.querySelectorAll('button')].find(b => b.textContent!.trim() === '展开演示专区');
    assert.ok(toggle); act(() => toggle.click());
    const create = view.host.querySelector<HTMLButtonElement>('[data-testid="btn-create-multi-fact-demo-task"]');
    assert.ok(create); act(() => { create.click(); create.click(); });
    const saved = loadPersistedState();
    assert.equal(saved.tasks.filter(t => t.id === 'TASK-DEMO-MULTI-PARAGRAPH-REVISION').length, 1);
    for (const old of before) assert.deepEqual(saved.tasks.find(t => t.id === old.id), old);
    const demoBefore = clone(saved.tasks.find(t => t.id === saved.currentTaskId));
    act(() => create.click()); assert.deepEqual(loadPersistedState().tasks.find(t => t.id === saved.currentTaskId), demoBefore);
  } finally { view.close(); localStorage.clear(); }
});

if (failures.length) { console.error(`Codex independent failures: ${failures.length}\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log('Task24 Codex independent checks: 14 groups passed.');
