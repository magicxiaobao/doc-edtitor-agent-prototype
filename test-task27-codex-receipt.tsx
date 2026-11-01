import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPostRevisionVerificationDemoTask, createSharedParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { generateSharedParagraphFactRevisionCandidate, acceptSharedParagraphFactRevisionCandidate } from './src/services/factRevisionCandidateService';
import { evaluatePostRevisionVerification as evaluate, recordPostRevisionVerification as record,
  deferPostRevisionVerification as defer, revokePostRevisionVerification as revoke,
  isValidVerificationCredential, isValidVerificationRecord } from './src/services/postRevisionVerificationService';
import { createDraftSnapshot, restoreDraftVersion, validateFinalizationConditions } from './src/services/draftLifecycleService';
import { validateTaskStructure, savePersistedState, loadPersistedState } from './src/services/storageService';
import { PostRevisionVerificationModal } from './src/components/PostRevisionVerificationModal';
import { SnippetDrawer } from './src/components/SnippetDrawer';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './src/components/stages/StyleAndOutlineStage';
import { DraftingStage } from './src/components/stages/DraftingStage';
import type { Task, DraftVersion } from './src/types';

// Independent acceptance assertions. Prepared service fixtures are NOT browser or cross-stage UI evidence.
const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.error(`FAIL ${name}: ${String(e)}`); }
}
const clone = <T,>(value: T): T => structuredClone(value);
function fixture() {
  const task = createSharedParagraphRevisionDemoTask();
  const source = task.drafts.find(d => d.id === task.currentDraftId)!;
  for (const [id, value, evidenceId] of [['FACT-01', '120', 'EVD-01'], ['FACT-02', '18', 'EVD-07']]) {
    Object.assign(task.facts.find(f => f.id === id)!, { status: 'confirmed', value,
      selectedConflictValue: value, primaryEvidenceId: evidenceId, conflictResolutionReason: '已核对本期同口径原文' });
  }
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  task.factSnapshot = { confirmedAt: '2026-10-30T04:00:00Z', hash: 'codex-task27',
    factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(task, f)) };
  task.outlineConfirmed = true;
  task.outlineSnapshot = clone(source.snapshotMetadata!.outlineSnapshot);
  const generated = generateSharedParagraphFactRevisionCandidate(task, source, '主笔甲');
  assert.equal(generated.success, true, generated.reason);
  const candidate = generated.candidateGroup!;
  const original = clone(task);
  const adopted = acceptSharedParagraphFactRevisionCandidate(task, source, candidate, '主笔甲', candidate.runId);
  assert.equal(adopted.success, true, adopted.reason);
  assert.equal(JSON.stringify(task) === JSON.stringify(original), true, '事实修订采纳不得原地修改输入');
  return { task: adopted.updatedTask!, draft: adopted.newWorkingDraft!, source, candidate };
}
function params(task: Task, draft: DraftVersion, blockId = 'BLK-01') {
  const block = draft.blocks.find(b => b.id === blockId)!;
  return { task, draftId: draft.id, operationId: draft.postRevisionVerificationCredential!.operationId,
    blockId, activeRole: '主笔甲' as const, notes: '已核对本段正文和冻结依据', reason: '需重新核对出处',
    baselineState: { paragraphContent: block.content, revisionSeq: block.revisionSeq ?? 0,
      referencedFactIds: [...block.referencedFactIds] } };
}
function verifiedFixture() {
  const f = fixture();
  const r = record(params(f.task, f.draft));
  assert.equal(r.success, true, r.reason);
  const task = r.updatedTask!, draft = task.drafts.find(d => d.id === f.draft.id)!;
  assert.equal(evaluate(task, draft).verifiedCount, 1);
  return { ...f, task, draft };
}
function mount(task: Task, draft: DraftVersion, onUpdateTask: (task: Partial<Task>) => void = () => {}) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = (t: Task, d: DraftVersion) => act(() => root.render(<PostRevisionVerificationModal
    isOpen task={t} currentDraft={d} activeRole="主笔甲" onClose={() => {}} onUpdateTask={onUpdateTask} />));
  render(task, draft);
  return { host, render, close: () => { act(() => root.unmount()); host.remove(); } };
}

await check('01 真实采纳形成2事实3段冻结清单，初始0已记录且正文800人次不变', () => {
  const { task, draft, source } = fixture();
  const c = draft.postRevisionVerificationCredential!;
  assert.equal(c.sourceDraftId, source.id); assert.equal(c.targetDraftId, draft.id);
  assert.equal(c.facts.length, 2); assert.equal(c.blocks.length, 3);
  assert.equal(new Set(c.blocks.map(b => b.blockId)).size, 3);
  assert.deepEqual(c.blocks.find(b => b.blockId === 'BLK-01')!.associatedFactIds.sort(), ['FACT-01', 'FACT-02']);
  assert.ok(draft.blocks[0].content.includes('800人次'));
  assert.equal(evaluate(task, draft).pendingCount, 3);
  task.modificationLogs = []; // Credential must survive log pruning.
  assert.equal(evaluate(task, draft).pendingCount, 3);
});

await check('02 正式reviewComments不得被额外reviews空数组清空或绕过定稿校验', () => {
  const { task, draft } = fixture();
  assert.ok(task.reviewComments.some(c => c.status === 'pending'));
  assert.equal(validateFinalizationConditions(task, draft.id, '主笔甲').checks.commentsClosed, false);
  Object.assign(task, { reviews: [] }); // Simulates an unknown optional legacy field, not a valid model alias.
  assert.equal(validateTaskStructure(task), true, '未知额外字段可通过现有存储结构检查');
  const before = clone(task);
  const result = validateFinalizationConditions(task, draft.id, '主笔甲');
  assert.equal(result.checks.commentsClosed, false, '真实待处理意见仍须阻断');
  assert.equal(JSON.stringify(task) === JSON.stringify(before), true, '只读定稿校验不得清空意见');
});

for (const action of [record, defer, revoke]) {
  await check(`03-${action.name} 必须只通过返回值更新，不能改写输入稿件`, () => {
    const f = action === revoke ? verifiedFixture() : fixture();
    const before = clone(f.task);
    const r = action(params(f.task, f.draft));
    assert.equal(r.success, true, r.reason);
    assert.equal(JSON.stringify(f.task) === JSON.stringify(before), true, `输入被${action.name}改写`);
    assert.equal(r.updatedTask!.drafts.length, before.drafts.length);
    assert.deepEqual(r.updatedTask!.reviewComments, before.reviewComments);
    assert.deepEqual(r.updatedTask!.modificationLogs, before.modificationLogs);
  });
}

for (const [label, mutate] of [
  ['单位', (t: Task) => { t.facts.find(f => f.id === 'FACT-01')!.unit = '件'; }],
  ['期间', (t: Task) => { t.facts.find(f => f.id === 'FACT-01')!.period = '2026年全年'; }],
  ['口径', (t: Task) => { t.facts.find(f => f.id === 'FACT-01')!.metricScope += '（新增统计范围）'; }],
  ['主出处', (t: Task) => { t.facts.find(f => f.id === 'FACT-01')!.primaryEvidenceId = 'EVD-02'; }],
  ['出处原文', (t: Task) => { t.snippets.find(s => s.id === 'EVD-01')!.text += '（原文修订）'; }],
] as const) {
  await check(`04-${label} 相关事实或出处变化使旧记录失效并拦截重新签署`, () => {
    const { task, draft } = verifiedFixture();
    mutate(task);
    assert.equal(evaluate(task, draft).blockEvaluations.find(b => b.blockId === 'BLK-01')!.displayStatus, 'invalidated');
    assert.equal(record(params(task, draft)).success, false, '事实/出处变动未处理时不得签署');
  });
}

await check('05 关联数值再次变化后记录服务必须拒绝，不得先保存再显示无效', () => {
  const { task, draft } = fixture();
  task.facts.find(f => f.id === 'FACT-01')!.value = '121';
  assert.equal(record(params(task, draft)).success, false);
});

await check('06 段落材料补写存证关联变化使核对失效', () => {
  const { task, draft } = verifiedFixture();
  const s = task.snippets.find(s => s.id === 'EVD-07')!;
  draft.blocks[0].adoptedEvidences = [{ evidenceId: s.id, sourceDocId: s.sourceDocId,
    sourceDocName: s.docName, snippetLocation: s.location, snippetText: s.text, period: s.period,
    usage: 'current_fact', associatedFactId: 'FACT-02', contentFingerprint: 'new-material', capturedAt: '2026-10-30T05:00:00Z' }];
  assert.equal(evaluate(task, draft).blockEvaluations.find(b => b.blockId === 'BLK-01')!.displayStatus, 'invalidated');
});

for (const key of ['taskId', 'draftId', 'operationId'] as const) {
  await check(`07-${key} 跨上下文同名段落记录不得算有效`, () => {
    const { task, draft } = verifiedFixture();
    draft.postRevisionVerificationRecords![0][key] = 'OTHER-CONTEXT';
    assert.equal(evaluate(task, draft).verifiedCount, 0, `${key}未检查`);
  });
}

for (const corrupt of ['duplicate-block', 'duplicate-fact', 'empty-association', 'unknown-fact'] as const) {
  await check(`08-${corrupt} 重复ID或不闭合关联的凭据必须拒绝`, () => {
    const { task, draft } = fixture();
    const c = draft.postRevisionVerificationCredential!;
    if (corrupt === 'duplicate-block') c.blocks.push(clone(c.blocks[0]));
    if (corrupt === 'duplicate-fact') c.facts.push(clone(c.facts[0]));
    if (corrupt === 'empty-association') c.blocks[0].associatedFactIds = [];
    if (corrupt === 'unknown-fact') c.blocks[0].associatedFactIds = ['NONEXISTENT'];
    assert.equal(isValidVerificationCredential(c), false, corrupt);
    assert.equal(record(params(task, draft)).success, false, corrupt);
  });
}

await check('09 嵌套出处和事件损坏须隔离，不能以浅校验当成有效数据', () => {
  const { task, draft } = verifiedFixture();
  const malformed = clone(draft.postRevisionVerificationCredential!) as unknown as { facts: { fromEvidence: unknown }[] };
  malformed.facts[0].fromEvidence = null;
  assert.equal(isValidVerificationCredential(malformed), false, 'null出处被接受');
  const rec = clone(draft.postRevisionVerificationRecords![0]);
  Object.assign(rec, { history: [null], events: [null] });
  assert.equal(isValidVerificationRecord(rec), false, '损坏事件被接受');
  Object.assign(draft, { postRevisionVerificationCredential: malformed });
  assert.equal(validateTaskStructure(task), true, '可选元数据异常不得丢弃正文');
  assert.equal(evaluate(task, draft).hasCredential, false);
});

await check('10 正文修改及改回后序号递增失效，无关段落变化保持有效', () => {
  const { task, draft } = verifiedFixture();
  draft.blocks[3].content += '无关段落编辑。';
  task.facts.find(f => f.id === 'FACT-04')!.value = '13';
  assert.equal(evaluate(task, draft).verifiedCount, 1);
  draft.blocks[0].revisionSeq = (draft.blocks[0].revisionSeq ?? 0) + 1;
  assert.equal(evaluate(task, draft).verifiedCount, 0);
});

await check('11 打开表单后正文刷新不能用旧说明签署新正文', () => {
  const { task, draft } = fixture(); let writes = 0;
  const m = mount(task, draft, () => { writes++; });
  try {
    const input = m.host.querySelector<HTMLTextAreaElement>('[data-testid="input-verification-notes-BLK-01"]')!;
    act(() => simulateTextareaChange(input, '仅核对了原来的正文'));
    const changed = clone(task), next = changed.drafts.find(d => d.id === draft.id)!;
    next.blocks[0].content += '新增尚未人工核对的句子。'; next.blocks[0].revisionSeq = 2;
    m.render(changed, next);
    const button = m.host.querySelector<HTMLButtonElement>('[data-testid="btn-record-verification-BLK-01"]')!;
    act(() => button.click());
    assert.equal(writes, 0, '旧表单绑定被点击时的最新正文替换');
  } finally { m.close(); }
});

await check('12 操作批次切换必须清理同版本内旧表单', () => {
  const { task, draft } = fixture(); const m = mount(task, draft);
  try {
    act(() => simulateTextareaChange(m.host.querySelector<HTMLTextAreaElement>('[data-testid="input-verification-notes-BLK-01"]')!, '旧操作的核对说明'));
    const nextTask = clone(task), nextDraft = nextTask.drafts.find(d => d.id === draft.id)!;
    nextDraft.postRevisionVerificationCredential!.operationId = 'NEW-OPERATION';
    m.render(nextTask, nextDraft);
    assert.equal(m.host.querySelector<HTMLTextAreaElement>('[data-testid="input-verification-notes-BLK-01"]')!.value, '');
  } finally { m.close(); }
});

await check('13 独立演示必须从两项待裁决事实开始，不能预造采纳与凭据', () => {
  const task = createPostRevisionVerificationDemoTask();
  assert.equal(task.id, 'TASK-DEMO-POST-REVISION-VERIFICATION');
  for (const id of ['FACT-01', 'FACT-02']) {
    const f = task.facts.find(f => f.id === id)!;
    assert.equal(f.status, 'pending'); assert.equal(f.selectedConflictValue, undefined);
  }
  assert.equal(task.drafts.length, 1);
  assert.equal(task.drafts[0].postRevisionVerificationCredential, undefined);
  assert.equal((task.modificationLogs || []).length, 0);
});

await check('14 保存快照和恢复必须返回新任务，不能修改输入任务的版本集合', () => {
  const { task, draft } = verifiedFixture(), before = clone(task);
  const saved = createDraftSnapshot(task, draft.id, '核对中间快照', '主笔甲');
  assert.equal(JSON.stringify(task) === JSON.stringify(before), true, '保存快照原地修改了task.drafts');
  const savedBefore = clone(saved.updatedTask);
  const restored = restoreDraftVersion(saved.updatedTask, saved.snapshotDraft.id, '主笔甲');
  assert.equal(JSON.stringify(saved.updatedTask) === JSON.stringify(savedBefore), true, '恢复版本原地修改了task');
  assert.equal(restored.workingDraft.postRevisionVerificationCredential, undefined);
});

await check('15 只读历史冻结当时结论，不跟随当前任务变化', () => {
  const { task, draft } = verifiedFixture();
  const saved = createDraftSnapshot(task, draft.id, '已核对一段', '主笔甲');
  const frozen = clone(saved.snapshotDraft);
  saved.updatedTask.facts.find(f => f.id === 'FACT-01')!.value = '999';
  assert.equal(evaluate(saved.updatedTask, saved.snapshotDraft).verifiedCount, 1);
  assert.deepEqual(saved.snapshotDraft, frozen);
  assert.equal(record({ ...params(saved.updatedTask, draft), draftId: saved.snapshotDraft.id }).success, false);
});

await check('16 出处删除、排除或关键口径被清空不能仍算已核对或重新签署', () => {
  for (const kind of ['snippet', 'document', 'excluded', 'scope', 'primary', 'period', 'unit']) {
    const { task, draft } = verifiedFixture();
    if (kind === 'snippet') task.snippets = task.snippets.filter(s => s.id !== 'EVD-01');
    if (kind === 'document') task.documents = task.documents.filter(d => d.id !== 'SRC-01');
    if (kind === 'excluded') task.documents.find(d => d.id === 'SRC-01')!.excluded = true;
    const f = task.facts.find(f => f.id === 'FACT-01')!;
    if (kind === 'scope') f.metricScope = '';
    if (kind === 'primary') f.primaryEvidenceId = '';
    if (kind === 'period') f.period = '';
    if (kind === 'unit') f.unit = '';
    assert.equal(evaluate(task, draft).verifiedCount, 0, kind);
    assert.equal(record(params(task, draft)).success, false, kind);
  }
});

await check('17 关联事实重新冲突时仍允许留痕暂缓和撤回，禁止签署完成', () => {
  const { task, draft } = verifiedFixture();
  Object.assign(task.facts[0], { status: 'pending', selectedConflictValue: undefined });
  assert.equal(record(params(task, draft)).success, false);
  assert.equal(defer(params(task, draft, 'BLK-02')).success, true);
  assert.equal(revoke(params(task, draft)).success, true);
});

await check('18 仅保留出处别名、坏事件和不完整冻结总览必须安全隔离', () => {
  const { task, draft } = verifiedFixture();
  const c = clone(draft.postRevisionVerificationCredential!);
  delete (c.facts[0] as Partial<typeof c.facts[number]>).fromEvidence;
  assert.equal(isValidVerificationCredential(c), false, 'UI实际使用的必需出处不能由别名掩盖');
  const rec = clone(draft.postRevisionVerificationRecords![0]);
  Object.assign(rec, { events: [{ id: 'E', timestamp: 'now' }], history: [{ id: 'E', timestamp: 'now' }] });
  assert.equal(isValidVerificationRecord(rec), false, '缺少动作/操作人/说明的事件不能被接受');
  const saved = createDraftSnapshot(task, draft.id, '历史', '主笔甲');
  Object.assign(saved.snapshotDraft.frozenPostRevisionVerificationOverview!.blockEvaluations[0], { credBlock: null });
  assert.equal(validateTaskStructure(saved.updatedTask), true);
  assert.equal(saved.snapshotDraft.frozenPostRevisionVerificationOverview, undefined);
  assert.equal(evaluate(saved.updatedTask, saved.snapshotDraft).hasCredential, false, '损坏历史不能按任务最新状态重算当时结论');
});

await check('19 表单开始核对后原文及补写关联变化必须清理旧说明', () => {
  for (const kind of ['source', 'adopted']) {
    const { task, draft } = fixture(); const m = mount(task, draft);
    try {
      act(() => simulateTextareaChange(m.host.querySelector<HTMLTextAreaElement>('[data-testid="input-verification-notes-BLK-01"]')!, '已查看原来的依据'));
      const changed = clone(task), next = changed.drafts.find(d => d.id === draft.id)!;
      if (kind === 'source') changed.snippets.find(s => s.id === 'EVD-01')!.text += '本期原文有修订';
      else next.blocks[0].adoptedEvidences = [{ evidenceId: 'EVD-07', sourceDocId: 'SRC-07', sourceDocName: '培训汇总',
        snippetText: '组织专题培训18场', period: '2026年1至9月', usage: 'current_fact', associatedFactId: 'FACT-02', contentFingerprint: 'new-link', capturedAt: '2026-11-01T03:00:00Z' }];
      m.render(changed, next);
      assert.equal(m.host.querySelector<HTMLTextAreaElement>('[data-testid="input-verification-notes-BLK-01"]')!.value, '', kind);
    } finally { m.close(); }
  }
});

await check('20 已引用未改写事实及裁决理由变化使原结论失效，无关事实不误伤', () => {
  for (const kind of ['other-associated', 'decision']) {
    const { task, draft } = verifiedFixture();
    if (kind === 'other-associated') task.facts.find(f => f.id === 'FACT-03')!.value = '900';
    else task.facts[0].conflictResolutionReason = '裁决理由已重新核定';
    assert.equal(evaluate(task, draft).verifiedCount, 0, kind);
  }
});

await check('21 真实出处抽屉必须展示请求的修订前128依据，不能被目标稿120快照替换', () => {
  const { task, draft } = fixture(); const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let closed = false;
  let requested: Parameters<NonNullable<React.ComponentProps<typeof PostRevisionVerificationModal>['onViewSnippet']>> | undefined;
  act(() => root.render(<PostRevisionVerificationModal isOpen task={task} currentDraft={draft} activeRole="主笔甲"
    onClose={() => { closed = true; }} onViewSnippet={(...args) => { requested = args; }} />));
  try {
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="btn-view-evidence-before-FACT-01"]')!.click());
    assert.ok(requested);
    act(() => root.render(<SnippetDrawer snippet={requested![0]} fact={requested![1]} adoptedEvidence={requested![2]}
      freezeDraftEvidence={requested![3]} documents={task.documents} task={task} currentDraft={draft} onClose={() => {}} />));
    assert.ok(host.textContent!.includes('累计完成重点任务128项'), '修订前出处必须是128');
    assert.ok(!host.textContent!.includes('累计完成重点任务120项'), '不得把目标稿采纳依据冒充旧依据');
    assert.equal(closed, true, '打开全局抽屉前须释放核对弹窗焦点隔离');
  } finally { act(() => root.unmount()); host.remove(); }
});

await check('22 凭据上下文不属于所选任务时不显示活动清单，演示意见归属正确', () => {
  const { task, draft } = fixture(); draft.postRevisionVerificationCredential!.taskId = 'OTHER';
  assert.equal(evaluate(task, draft).hasCredential, false);
  const demo = createPostRevisionVerificationDemoTask();
  assert.ok(demo.reviewComments.every(c => c.targetVersionId === demo.currentDraftId));
});

await check('23 真实组件两次裁决到核对、暂缓、撤回、持久化及正文失效闭环', () => {
  const initial = createPostRevisionVerificationDemoTask(); let latest = initial;
  function Journey() {
    const [task, setTask] = React.useState(initial), [stage, setStage] = React.useState(2); latest = task;
    const props = { task, activeRole: '主笔甲' as const, onViewSnippet: () => {},
      onUpdateTask: (patch: Partial<Task>) => setTask(t => ({ ...t, ...patch })), onProceedToNextStage: () => setStage(s => s + 1) };
    return stage === 2 ? <MaterialsAndFactsStage {...props} /> : stage === 3 ? <StyleAndOutlineStage {...props} /> : <DraftingStage {...props} />;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  act(() => root.render(<Journey />));
  const click = (id: string) => { const b = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    assert.ok(b, id); assert.notEqual(b.disabled, true, id); act(() => b.click()); };
  const text = (value: string) => { const b = [...host.querySelectorAll('button')].find(b => b.textContent!.trim() === value)!;
    assert.ok(b, value); assert.equal(b.disabled, false, value); act(() => b.click()); };
  const input = (id: string, value: string) => act(() => simulateTextareaChange(host.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`)!, value));
  try {
    for (const [index, value] of [[0, '120'], [1, '18']] as const) {
      const buttons = [...host.querySelectorAll('button')].filter(b => b.textContent!.trim() === '裁决冲突');
      act(() => buttons[index].click()); click(`conflict-candidate-${value}`);
      const scope = host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;
      act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(scope, initial.facts[index].metricScope);
        scope.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        simulateTextareaChange(host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!, '已核对同期间同口径的正式原文，采信本期最新统计。'); });
      text('确认采信并写入事实');
    }
    text('确认本次事实清单'); text('下一步：文风与大纲'); text('确认大纲并进入起草'); text('下一步：正文起草');
    const before = clone(latest);
    click('btn-open-fact-impact'); click('btn-generate-shared-paragraph-revision'); click('btn-cancel-shared-paragraph-revision');
    assert.equal(JSON.stringify(latest), JSON.stringify(before));
    click('btn-generate-shared-paragraph-revision'); click('btn-accept-shared-paragraph-revision');
    assert.equal(latest.drafts.length, 2); assert.equal(latest.modificationLogs!.length, 1);
    click('btn-open-post-revision-verification'); input('input-verification-notes-BLK-01', '已核对本段120项、18场及800人次原文和出处');
    click('btn-record-verification-BLK-01');
    click('btn-defer-verification-BLK-02'); input('input-defer-reason-BLK-02', '等待复查表述'); click('btn-confirm-defer-BLK-02');
    click('btn-revoke-verification-BLK-01'); input('input-revoke-reason-BLK-01', '需重新核对行文'); click('btn-confirm-revoke-BLK-01');
    input('input-verification-notes-BLK-01', '已重新核对全文及冻结出处'); click('btn-record-verification-BLK-01');
    let current = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.equal(evaluate(latest, current).verifiedCount, 1); assert.equal(evaluate(latest, current).deferredCount, 1);
    assert.equal(savePersistedState([latest], latest.id, '主笔甲'), true);
    const loaded = loadPersistedState(); assert.equal(loaded.isCorrupted, false);
    assert.equal(evaluate(loaded.tasks[0], loaded.tasks[0].drafts.find(d => d.id === current.id)).verifiedCount, 1);
    click('btn-close-post-revision-verification-modal');
    act(() => simulateTextareaChange(host.querySelector<HTMLTextAreaElement>('#paragraph-textarea-BLK-01')!, current.blocks[0].content + '经人工复查调整表述。'));
    current = latest.drafts.find(d => d.id === latest.currentDraftId)!;
    assert.equal(evaluate(latest, current).blockEvaluations.find(b => b.blockId === 'BLK-01')!.displayStatus, 'invalidated');
  } finally { act(() => root.unmount()); host.remove(); localStorage.clear(); }
});

await check('24 结构合法但采用值被篡改的凭据不能覆盖所选稿真实快照', () => {
  const { task, draft } = verifiedFixture();
  draft.postRevisionVerificationCredential!.facts[0].toValue = '999';
  assert.equal(evaluate(task, draft).verifiedCount, 0);
  assert.equal(record(params(task, draft)).success, false);
});

console.log(`\nTask27 Codex independent receipt: ${failures.length ? 'FAIL' : 'PASS'}; ${failures.length} failing groups.`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
