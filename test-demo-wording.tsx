import './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {createPresetTask} from './src/services/mockData';
import {generateDraftFromFactsAndOutline} from './src/services/mockDraftService';
import {modifyOrExcludeFact} from './src/services/factLifecycleService';
import {DraftingStage} from './src/components/stages/DraftingStage';
import type {Task} from './src/types';

const prompts = ['', '精简表达', '突出成效', '优化问题与安排的对应', '改成面向单位负责人的汇报口吻'];
const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${String(error)}`); }
}
function generate(task: Task, prompt: string) {
  const before = structuredClone(task);
  const blocks = generateDraftFromFactsAndOutline(task, {instructionPrompt: prompt});
  assert.deepEqual(task, before, 'generating candidates must not mutate any saved task state');
  return blocks;
}
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  assert(found, `missing button: ${text}`); return found;
}
const trainingVariants = [
  ['组织专题培训', '开展专题调研', '组织专题培训', '开展专题调研'],
  ['专题培训', '专题调研', '组织专题培训', '开展专题调研'],
  ['累计组织专题培训', '累计开展专题调研', '累计组织专题培训', '累计开展专题调研'],
  ['共举办专题培训', '共开展专题调研', '共举办专题培训', '共开展专题调研'],
] as const;

await check('all generation styles keep verb/noun/cumulative metrics natural and retain quantitative evidence', () => {
  for (const [trainingName, researchName, trainingPhrase, researchPhrase] of trainingVariants) {
    const task = createPresetTask('ready_to_draft');
    task.facts.find(f => f.id === 'FACT-02')!.metric = trainingName;
    task.facts.find(f => f.id === 'FACT-04')!.metric = researchName;
    for (const prompt of prompts) {
      const blocks = generate(task, prompt);
      const training = blocks.find(b => b.referencedFactIds.includes('FACT-02'))!;
      const research = blocks.find(b => b.referencedFactIds.includes('FACT-04'))!;
      assert(training && research);
      assert(training.content.includes(`${trainingPhrase}16场`), training.content);
      assert(training.content.includes('参训800人次'), training.content);
      assert(research.content.includes(`${researchPhrase}12次`), research.content);
      assert(training.content.includes(task.facts[1].period));
      assert.deepEqual(training.referencedFactIds, ['FACT-02', 'FACT-03']);
      assert(!/(组织组织|开展开展|累计累计|累计共)/.test(blocks.map(b => b.content).join('\n')));
      assert(!blocks.flatMap(b => b.referencedFactIds).some(id => ['FACT-05', 'FACT-06'].includes(id)));
    }
  }
});

await check('quantities alone never add target attainment, effect evaluations or institutional outcomes', () => {
  const task = createPresetTask('ready_to_draft');
  // These are unsupported claims in the former templates, not forbidden words in human documents.
  const unsupported = [
    '质效大幅跃升', '取得显著成效', '机制健全运转', '有效强化',
    '序时指标平稳达成', '序时指标高效达成', '重点攻坚成效显著',
    '制度优化', '流程改进举措', '长效机制', '如期销号', '保障全系统高质量运转',
  ];
  for (const prompt of prompts) {
    const blocks = generate(task, prompt); const text = blocks.map(b => b.content).join('\n');
    for (const claim of unsupported) assert(!text.includes(claim), `${prompt}: ${claim}`);
    for (const value of ['128项', '16场', '800人次', '12次']) assert(text.includes(value));
    assert(blocks.some(b => b.content.includes('【待补材料依据】') && !b.referencedFactIds.length));
  }
});

await check('actual changed conflict selections, custom values and periods remain data driven', () => {
  for (const selected of ['120', '128']) {
    const task = createPresetTask('ready_to_draft');
    const result = modifyOrExcludeFact(task, 'FACT-01', {
      selectedConflictValue: selected, primaryEvidenceId: selected === '120' ? 'EVD-01' : 'EVD-02',
    }, '主笔甲');
    assert(result.success && result.updatedTask);
    const changed = result.updatedTask;
    changed.startDate = '2027-04-01'; changed.endDate = '2027-06-30';
    for (const fact of changed.facts.filter(f => f.status === 'confirmed')) fact.period = '2027年4至6月';
    changed.facts.find(f => f.id === 'FACT-02')!.value = '23';
    changed.facts.find(f => f.id === 'FACT-03')!.value = '910';
    changed.facts.find(f => f.id === 'FACT-04')!.value = '19';
    for (const prompt of prompts) {
      const blocks = generate(changed, prompt); const text = blocks.map(b => b.content).join('\n');
      for (const value of [`${selected}项`, '23场', '910人次', '19次', '2027年4至6月']) assert(text.includes(value));
      assert(!text.includes(`${selected === '120' ? '128' : '120'}项`));
      assert(!/2026|16场|800人次|12次/.test(text));
    }
  }
});

await check('a separately assigned attendance-scale fact is not turned into an event or a completed quota', () => {
  const task = createPresetTask('ready_to_draft');
  task.outline = [{...task.outline[0], assignedFactIds: ['FACT-03']}];
  for (const prompt of prompts) {
    const blocks = generate(task, prompt);
    assert.equal(blocks.length, 1); assert.deepEqual(blocks[0].referencedFactIds, ['FACT-03']);
    assert(blocks[0].content.includes('专题培训参训规模为800人次'), blocks[0].content);
    assert(!blocks[0].content.includes('16场'));
  }
});

await check('real initial-draft generation preserves frozen raw quotation even when it contains repeated verbs', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let task = createPresetTask('ready_to_draft');
  const quote = '原始登记保留：组织组织专题培训16场；成效尚无评估依据。';
  task.factSnapshot!.items.find(f => f.factId === 'FACT-02')!.provenance!.text = quote;
  const before = structuredClone(task);
  try {
    act(() => root.render(<DraftingStage task={task} activeRole="主笔甲" onUpdateTask={u => {task = {...task, ...u};}}
      onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
    await act(async () => { button(host, '立即生成初稿').click(); await new Promise(r => setTimeout(r, 750)); });
    const draft = task.drafts.find(d => d.id === task.currentDraftId)!; assert(draft);
    assert(draft.blocks.some(b => b.content.includes('组织专题培训16场')));
    assert(!draft.blocks.some(b => b.content.includes('组织组织')));
    assert.equal(draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === 'FACT-02')!.provenance!.text, quote);
    assert.deepEqual(task.facts, before.facts); assert.deepEqual(task.snippets, before.snippets);
  } finally {act(() => root.unmount()); host.remove();}
});

await check('real whole-draft candidate generation and rejection preserve current draft and saved history', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const task = createPresetTask('under_review');
  const saved = structuredClone(task.drafts[0]); saved.id = 'WORDING-HISTORY'; saved.isWorkingDraft = false; saved.isHistoricalSnapshot = true;
  task.drafts.push(saved);
  const before = structuredClone(task); const updates: Partial<Task>[] = [];
  try {
    act(() => root.render(<DraftingStage task={task} activeRole="主笔甲" onUpdateTask={u => updates.push(u)}
      onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
    await act(async () => { button(host, '生成整稿候选').click(); await new Promise(r => setTimeout(r, 750)); });
    assert(host.textContent?.includes('起草候选稿（待主笔整体采纳）'));
    assert.deepEqual(task, before);
    assert(!updates.some(u => u.drafts), 'candidate must not write a draft before acceptance');
    act(() => button(host, '放弃候选稿').click());
    assert.deepEqual(task, before); assert(!updates.some(u => u.drafts));
  } finally {act(() => root.unmount()); host.remove();}
});

assert.equal(failures.length, 0, `wording regressions: ${failures.join('; ')}`);
