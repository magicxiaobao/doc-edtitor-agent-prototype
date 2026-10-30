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
import { validateTaskStructure } from './src/services/storageService';
import { PostRevisionVerificationModal } from './src/components/PostRevisionVerificationModal';
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

console.log(`\nTask27 Codex independent receipt: ${failures.length ? 'FAIL' : 'PASS'}; ${failures.length} failing groups.`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
