import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPresetTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { FactImpactModal } from './src/components/FactImpactModal';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './src/components/stages/StyleAndOutlineStage';
import { validateUndoEligibility, restoreDraftVersion } from './src/services/draftLifecycleService';
import { checkFactRevisionEligibility, generateFactRevisionCandidate,
  validateFactRevisionAcceptance, acceptFactRevisionCandidate } from './src/services/factRevisionCandidateService';
import type { Task, DraftVersion } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); }
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function approve(task: Task) {
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = { confirmedAt: new Date().toISOString(), hash: 'receipt-approved',
    factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(task, f)) };
}
function fixture() {
  const task = clone(createPresetTask('under_review'));
  const draft = task.drafts.find(d => d.id === task.currentDraftId)!;
  const fact = task.facts.find(f => f.id === 'FACT-01')!;
  Object.assign(fact, { value: '120', selectedConflictValue: '120', primaryEvidenceId: 'EVD-01',
    conflictResolutionReason: '同期间、单位、统计范围，采信甲120项' });
  approve(task);
  return { task, draft };
}
function candidate(task: Task, draft: DraftVersion) {
  const result = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(result.success, true, result.reason); return result.candidate!;
}
function reject(task: Task, draft: DraftVersion, why: string) {
  assert.equal(checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲').eligible, false, why);
}

await check('1 指标语义、完整数字与单位边界，不因唯一同值误改其他指标', () => {
  for (const text of ['其他项目128项，累计完成重点任务125项。',
    '2026年1至9月，累计完成重点任务1128项，其他项目128项。',
    '累计完成重点任务128项次。', '累计完成重点任务1.128项。']) {
    const { task, draft } = fixture(); draft.blocks[0].content = text;
    assert.equal(generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲').success, false, text);
  }
  const { task, draft } = fixture();
  draft.blocks[0].content = '累计完成重点任务128项。其他项目128项。';
  assert.equal(candidate(task, draft).revisedBlockContent, '累计完成重点任务120项。其他项目128项。');
});
await check('2 最新事实必须由有效本期原文支撑', () => {
  const mutations: ((t: Task) => void)[] = [
    t => { t.documents[0].usage = 'style_ref'; },
    t => { t.documents[0].excluded = true; },
    t => { t.documents[0].usage = 'rag_clue'; },
    t => { t.snippets[0].period = '2025年度'; },
    t => { t.snippets[0].text = '2026年1至9月，累计完成重点任务119项。'; },
  ];
  for (const mutate of mutations) { const { task, draft } = fixture(); mutate(task); approve(task);
    reject(task, draft, '不合格来源不能准入'); }
});
await check('3 最新核准快照与事实、出处逐字段对应，不能把旧128快照绑定到120正文', () => {
  for (const alter of [(t: Task) => { t.factSnapshot!.items[0].value = '128'; t.factSnapshot!.items[0].selectedConflictValue = '128'; },
    (t: Task) => { t.factSnapshot!.items[0].provenance!.text = '伪造原文120项'; },
    (t: Task) => { t.factSnapshot!.items.pop(); }]) {
    const { task, draft } = fixture(); alter(task); reject(task, draft, '快照实际内容不匹配');
  }
});
await check('4 完整事实集合及非目标条目变化不能静默推进整稿依据', () => {
  for (const mutate of [(t: Task) => { t.factSnapshot!.items[1].metric = '已改培训指标'; },
    (t: Task) => { t.facts[1].metric = '已改培训指标'; approve(t); },
    (t: Task) => { t.facts[1].conflictResolutionReason = '新的事实采信说明'; approve(t); }]) {
    const { task, draft } = fixture(); mutate(task); reject(task, draft, '非目标事实变化');
  }
});
await check('5 文风审批、章节篇幅及任务期间实质变化必须拒绝', () => {
  for (const mutate of [(t: Task) => { t.styleSnapshot!.hash = 'reapproved-different-style'; t.styleRules[0].description = '改用全新写作规范'; },
    (t: Task) => { t.outlineSnapshot!.sections[0].suggestedWordCount += 100; t.outline[0].suggestedWordCount += 100; },
    (t: Task) => { t.startDate = '2025-01-01'; }, (t: Task) => { t.targetWordCount = 6000; }]) {
    const { task, draft } = fixture(); mutate(task); reject(task, draft, '任务或结构实质变化');
  }
});
await check('6 未关联补写存证覆盖全稿且不能凭同名片段更新补写证据', () => {
  for (const index of [0, 1]) { const { task, draft } = fixture();
    draft.blocks[index].adoptedEvidences = [{ evidenceId: 'EVD-01', sourceDocId: 'SRC-01',
      sourceDocName: '甲', snippetText: '含未明确归属的另一个指标128项', period: '2026年1至9月',
      usage: 'current_fact', contentFingerprint: 'same', capturedAt: new Date().toISOString() }];
    reject(task, draft, `第${index + 1}段未关联存证不能忽略`);
  }
});
await check('7 候选上下文涵盖原文、引用、修订序号及任务要求，不只比较哈希时间戳', () => {
  const mutations: ((t: Task, d: DraftVersion) => void)[] = [
    t => { t.snippets[0].text += ' 原文已补充说明'; },
    t => { t.documents[0].content += '\n材料已更新'; },
    (_t, d) => { d.blocks[1].referencedFactIds.reverse(); d.blocks[1].referencedFactIds.push('FACT-04'); },
    (_t, d) => { d.blocks[1].revisionSeq = (d.blocks[1].revisionSeq ?? 0) + 2; },
    t => { t.audience = '变更后的受众'; },
    (_t, d) => { d.snapshotMetadata!.factSnapshot!.items[1].provenance!.text += ' 冻结原文变更'; },
  ];
  for (const mutate of mutations) { const { task, draft } = fixture(); const c = candidate(task, draft);
    mutate(task, draft); assert.equal(validateFactRevisionAcceptance(task, draft, c, '主笔甲', c.runId).valid, false); }
});
await check('8 运行取消/缺失、错配目标及被改写候选不能采纳', () => {
  const { task, draft } = fixture(); const c = candidate(task, draft);
  assert.equal(validateFactRevisionAcceptance(task, draft, c, '主笔甲', null).valid, false);
  for (const altered of [{ ...c, targetFactId: 'FACT-02' }, { ...c, revisedBlockContent: '虚构完成999项。' }]) {
    assert.equal(validateFactRevisionAcceptance(task, draft, altered, '主笔甲', c.runId).valid, false);
  }
});
await check('9 采纳可追溯，旧正文依据冻结，新稿仅一段变化且不能正文单独撤销', () => {
  const { task, draft } = fixture(); const before = structuredClone(task); const c = candidate(task, draft);
  const result = acceptFactRevisionCandidate(task, draft, c, '主笔甲', c.runId);
  assert.equal(result.success, true, result.reason); assert.deepEqual(task, before);
  assert.equal(result.archivedDraft!.snapshotMetadata!.factSnapshot!.items[0].value, '128');
  assert.equal(result.newWorkingDraft!.snapshotMetadata!.factSnapshot!.items[0].value, '120');
  assert.deepEqual(result.newWorkingDraft!.blocks.slice(1), draft.blocks.slice(1));
  assert.deepEqual(result.updatedTask!.reviewComments, task.reviewComments);
  const log = result.updatedTask!.modificationLogs!.find(l => l.source === 'fact_change_revision');
  assert.ok(log, '必须有定向修订来源日志'); assert.equal(log.draftId, result.newWorkingDraft!.id);
  assert.ok(log.undoUnavailableReason, '整稿依据变更不得开放正文单独撤销');
  assert.equal(validateUndoEligibility(result.updatedTask!, result.newWorkingDraft, log.id, '主笔甲').canUndo, false);
  const restored = restoreDraftVersion(result.updatedTask!, result.archivedDraft!.id, '主笔甲');
  assert.equal(restored.workingDraft.blocks[0].content, draft.blocks[0].content);
  assert.equal(restored.workingDraft.snapshotMetadata!.factSnapshot!.items[0].value, '128');
});
await check('10 关闭清理候选、失败保留说明，同稿上下文变更禁用采纳', () => {
  const { task, draft } = fixture(); const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container); const root = createRoot(container);
  const render = (isOpen: boolean) => act(() => root.render(<FactImpactModal isOpen={isOpen}
    onClose={() => {}} task={task} currentDraft={draft} analysis={analyzeFactImpact(task, draft)}
    onLocateBlock={() => {}} onViewDraftEvidence={() => {}} onAcceptFactRevision={() => ({ success: false, reason: '测试错误' })} />));
  try { render(true); act(() => container.querySelector<HTMLButtonElement>('[data-testid="btn-generate-fact-revision-BLK-01"]')!.click());
    assert.ok(container.querySelector('[data-testid="fact-revision-candidate-card-BLK-01"]'));
    render(false); render(true);
    assert.equal(Boolean(container.querySelector('[data-testid="fact-revision-candidate-card-BLK-01"]')), false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="btn-generate-fact-revision-BLK-01"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="btn-accept-fact-revision-BLK-01"]')!.click());
    assert.ok(container.textContent!.includes('测试错误'));
    assert.ok(container.querySelector('[data-testid="fact-revision-candidate-card-BLK-01"]'));
    task.snippets[0].text += ' 上下文已经变化'; render(true);
    assert.equal(container.querySelector<HTMLButtonElement>('[data-testid="btn-retry-accept-fact-revision-BLK-01"]')!.disabled, true);
    assert.ok(container.querySelector('[data-testid="alert-revision-stale-BLK-01"]'));
  } finally { act(() => root.unmount()); container.remove(); }
});
await check('11 预存未引用缺口不是新增核准事实，不应阻断原来合格的定向修订', () => {
  const { task, draft } = fixture(); draft.blocks[3].referencedFactIds = [];
  assert.equal(checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲').eligible, true);
});
await check('12 真实起草组件接线：生成、采纳、只改一段、切新稿及来源留痕', () => {
  const { task } = fixture(); let latest = task;
  const host = dom.window.document.createElement('div'); dom.window.document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [current, setCurrent] = React.useState(task); latest = current;
    return <DraftingStage task={current} activeRole="主笔甲" onViewSnippet={() => {}}
      onProceedToNextStage={() => {}} onUpdateTask={patch => setCurrent(previous => ({ ...previous, ...patch }))} />;
  }
  try {
    act(() => root.render(<Harness />));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-open-fact-impact"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-generate-fact-revision-BLK-01"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-accept-fact-revision-BLK-01"]')!.click());
    assert.equal(latest.drafts.length, task.drafts.length + 1);
    assert.notEqual(latest.currentDraftId, task.currentDraftId);
    const working = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.ok(working.blocks[0].content.includes('120项'));
    assert.deepEqual(working.blocks.slice(1), task.drafts[0].blocks.slice(1));
    assert.deepEqual(working.factReviewRecords, []);
    assert.equal(latest.reviewComments.filter(c => c.status === 'pending').length,
      task.reviewComments.filter(c => c.status === 'pending').length);
    assert.ok(latest.modificationLogs!.some(l => l.source === 'fact_change_revision'));
  } finally { act(() => root.unmount()); host.remove(); }
});
await check('13 任务内已更新正文不能被同ID的陈旧草稿参数覆盖', () => {
  const { task, draft } = fixture(); const c = candidate(task, draft); const fresh = clone(task);
  fresh.drafts[0].blocks[1].content += ' 任务中已保存新的人工内容';
  assert.equal(validateFactRevisionAcceptance(fresh, draft, c, '主笔甲', c.runId).valid, false);
});
await check('14 真实跨阶段组件：裁决填写相同统计口径、确认事实/大纲，再采纳修订', () => {
  const initial = clone(createPresetTask('under_review')); let latest = initial;
  const scope = initial.facts[0].metricScope;
  const host = dom.window.document.createElement('div'); dom.window.document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [task, setTask] = React.useState(initial); const [stage, setStage] = React.useState(2); latest = task;
    const shared = { task, activeRole: '主笔甲' as const, onViewSnippet: () => {},
      onUpdateTask: (patch: Partial<Task>) => setTask(t => ({ ...t, ...patch })),
      onProceedToNextStage: () => setStage(s => s + 1) };
    return stage === 2 ? <MaterialsAndFactsStage {...shared} /> : stage === 3 ?
      <StyleAndOutlineStage {...shared} /> : <DraftingStage {...shared} />;
  }
  const click = (text: string) => { const b = [...host.querySelectorAll('button')].find(b => b.textContent!.trim() === text);
    assert.ok(b, text); assert.equal(b.disabled, false, text); act(() => b.click()); };
  try {
    act(() => root.render(<Harness />)); click('裁决冲突');
    act(() => host.querySelector<HTMLElement>('[data-testid="conflict-candidate-120"]')!.click());
    const input = host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
    assert.ok(input);
    assert.equal(input.value, initial.facts[0].conflictCandidates![0].description, '默认仍沿用所选候选口径，保留#70行为');
    act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, scope);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      simulateTextareaChange(host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!, '已核对两份材料统计范围相同，仅采信120项，保留原统计口径定义。'); });
    click('确认采信并写入事实');
    assert.equal(latest.facts[0].metricScope, scope); assert.equal(latest.facts[0].primaryEvidenceId, 'EVD-01');
    assert.equal(latest.factSnapshot, undefined); assert.equal(latest.outlineConfirmed, false);
    click('确认本次事实清单'); click('下一步：文风与大纲'); click('确认大纲并进入起草'); click('下一步：正文起草');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-open-fact-impact"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-generate-fact-revision-BLK-01"]')!.click());
    const adopt = host.querySelector<HTMLButtonElement>('[data-testid="btn-accept-fact-revision-BLK-01"]');
    assert.ok(adopt, host.textContent?.slice(-1500)); assert.equal(adopt.disabled, false); act(() => adopt.click());
    const working = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.ok(working.blocks[0].content.includes('120项'));
    assert.equal(working.snapshotMetadata!.factSnapshot!.items[0].primaryEvidenceId, 'EVD-01');
    assert.equal(latest.drafts.find(d => d.id === initial.currentDraftId)!.snapshotMetadata!.factSnapshot!.items[0].primaryEvidenceId, 'EVD-02');
  } finally { act(() => root.unmount()); host.remove(); }
});
await check('15 正文或原文明示的统计期间不符、片段不属于材料时不能替换', () => {
  { const { task, draft } = fixture(); draft.blocks[0].content = '2025年1至9月，累计完成重点任务128项。';
    assert.equal(generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲').success, false); }
  { const { task, draft } = fixture(); task.snippets[0].text = '2025年1至9月，累计完成重点任务120项。'; approve(task);
    reject(task, draft, '原文明示期间不一致'); }
  { const { task, draft } = fixture(); task.documents[0].content = '这份材料没有该指标或对应原文。';
    reject(task, draft, '原文片段不属于当前来源材料'); }
});
await check('16 旧稿局部快照字段缺失或损坏时明确拒绝，不抛异常或伪造完整基准', () => {
  const mutations: ((t: Task, d: DraftVersion) => void)[] = [
    (_t, d) => { Reflect.deleteProperty(d.snapshotMetadata!, 'outlineSections'); },
    t => { Reflect.deleteProperty(t.factSnapshot!, 'factIds'); },
    (_t, d) => { Object.assign(d.snapshotMetadata!.factSnapshot!.items[0].provenance!, { text: { broken: true } }); },
    t => { Object.defineProperty(t.factSnapshot!.items, 0, { value: null }); },
  ];
  for (const mutate of mutations) { const { task, draft } = fixture(); mutate(task, draft);
    assert.doesNotThrow(() => reject(task, draft, '部分基准不完整必须安全拒绝')); }
});
if (failures.length) throw new Error(`${failures.length} Codex groups failed: ${failures.join(', ')}`);
console.log('Task23 Codex receipt: all 16 groups passed');
