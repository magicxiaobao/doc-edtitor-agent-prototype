import {dom} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {MaterialsAndFactsStage} from './src/components/stages/MaterialsAndFactsStage';
import {createPresetTask} from './src/services/mockData';
import {queryMockRag} from './src/services/mockRagService';
import {createFactCandidate, confirmFact} from './src/services/factLifecycleService';
import {validateMaterialForSupplementation} from './src/services/materialSupplementService';
import type {EvidenceSnippet, Task} from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${String(error)}`); }
}
function buttons(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === text);
}
function click(host: HTMLElement, text: string) {
  const found = buttons(host, text); assert.equal(found.length, 1, `one button: ${text}`);
  assert(!found[0].disabled, `enabled button: ${text}`); act(() => found[0].click());
}
function exactText(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('span')].some(s => s.textContent === text);
}
function fill(host: HTMLElement, placeholder: string, value: string) {
  const input = [...host.querySelectorAll('input')].find(i => i.placeholder === placeholder)!;
  assert(input, placeholder);
  act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  });
}
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 850)); }); }
async function fixture(run: (f: {
  host: HTMLDivElement; current: () => Task; render: (next?: Task) => void;
  updates: Partial<Task>[]; views: EvidenceSnippet[];
}) => Promise<void>) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let task = createPresetTask('under_review'); const updates: Partial<Task>[] = []; const views: EvidenceSnippet[] = [];
  const render = (next = task) => {
    task = next;
    act(() => root.render(<MaterialsAndFactsStage task={task} activeRole="主笔甲"
      onUpdateTask={u => { updates.push(u); task = {...task, ...u}; }}
      onViewSnippet={s => views.push(s)} onProceedToNextStage={() => {}}/>));
  };
  try { render(); click(host, '模拟知识库RAG检索'); await run({host, current: () => task, render, updates, views}); }
  finally { act(() => root.unmount()); host.remove(); }
}
const notice = '提示：检索结果需经主笔核验，有原文的候选也不等于已核准事实。';

await check('normal retrieval keeps four exact source actions and creates only a pending fact through the real form', async () => {
  await fixture(async ({host, current, updates, views}) => {
    const before = structuredClone(current());
    click(host, '执行检索'); await settle();
    assert(exactText(host, '候选原文片段（4条）')); assert(host.textContent?.includes(notice));
    assert.equal(buttons(host, '定位原文').length, 4);
    const ids = ['EVD-01', 'EVD-02', 'EVD-03', 'EVD-05'];
    for (const b of buttons(host, '定位原文')) act(() => b.click());
    assert.deepEqual(views, ids.map(id => before.snippets.find(s => s.id === id)));
    assert.deepEqual(current(), before); assert.equal(updates.length, 0);
    const establish = buttons(host, '+ 建立事实候选'); assert.equal(establish.length, 4);
    act(() => establish[0].click());
    fill(host, '例如：组织专题培训 / 开展专项调研', '检索候选任务核验项');
    fill(host, '例如：25 / 120', '120'); fill(host, '例如：场 / 项 / 人次 / 次', '项');
    click(host, '保存并加入事实清单');
    assert.equal(updates.length, 1);
    const created = current().facts.at(-1)!;
    assert.equal(created.status, 'pending'); assert.equal(created.primaryEvidenceId, 'EVD-01');
    assert.equal(created.value, '120'); assert.equal(created.unit, '项');
    assert.deepEqual(current().facts.slice(0, -1), before.facts);
    assert.deepEqual(current().drafts, before.drafts, 'creating a candidate cannot rewrite frozen history');
  });
});

await check('clue-only results show a noninteractive label and remain ineligible for facts and supplementation', async () => {
  await fixture(async ({host, current, updates, views}) => {
    const before = structuredClone(current());
    click(host, '2. 仅有生成答案 (CLUE-01)'); click(host, '执行检索'); await settle();
    assert(exactText(host, '检索线索（1条）')); assert(exactText(host, '检索线索'));
    assert(exactText(host, '无原文可定位')); assert(host.textContent?.includes(notice));
    assert(host.textContent?.includes('不可直接确认为已核验事实'));
    assert.equal(buttons(host, '定位原文').length, 0); assert.equal(buttons(host, '+ 建立事实候选').length, 0);
    assert(![...host.querySelectorAll('button,a,input')].some(e => e.textContent?.includes('无原文可定位')));
    assert.deepEqual(current(), before); assert.equal(updates.length, 0); assert.equal(views.length, 0);
  });
  const result = await queryMockRag('满意度', 'clue_only'); const snippet = result.snippets[0];
  const task = createPresetTask('ready_to_draft'); task.endDate = '2026-12-31';
  // Give the clue a real registered document and an aligned period so denial is
  // specifically about its clue status, not a missing ID or wrong-period shortcut.
  task.documents.push({id: snippet.sourceDocId, name: snippet.docName, source: '检索', period: snippet.period,
    usage: 'rag_clue', fileType: 'pasted', parseStatus: 'parsed', content: snippet.text});
  task.snippets.push(snippet);
  const data = {metric: '服务满意度', value: '1', unit: '%', period: snippet.period,
    metricScope: '仅线索', primaryEvidenceId: snippet.id, evidenceIds: [snippet.id], hasConflict: false};
  const candidate = createFactCandidate(task, data, '主笔甲');
  assert.equal(candidate.success, false); assert(candidate.error?.includes('线索'));
  task.facts.push({...data, id: 'RAG-NEGATIVE-FACT', status: 'pending'});
  const confirmed = confirmFact(task, 'RAG-NEGATIVE-FACT', '主笔甲');
  assert.equal(confirmed.success, false); assert(confirmed.error?.includes('线索'));
  const supplementation = validateMaterialForSupplementation(task, snippet);
  assert.equal(supplementation.eligible, false); assert(supplementation.reason?.includes('线索'));
});

await check('empty retrieval removes prior cards and counts while retaining the existing empty explanation', async () => {
  await fixture(async ({host, updates, views}) => {
    click(host, '执行检索'); await settle(); assert.equal(buttons(host, '定位原文').length, 4);
    click(host, '3. 无检索结果'); click(host, '执行检索'); await settle();
    assert(exactText(host, '检索结果')); assert(host.textContent?.includes('未在当前知识库中检索到'));
    assert(!/0条依据|（0条）|候选原文片段（4条）|检索线索（1条）/.test(host.textContent || ''));
    assert.equal(buttons(host, '定位原文').length, 0); assert.equal(buttons(host, '+ 建立事实候选').length, 0);
    assert.equal(updates.length, 0); assert.equal(views.length, 0);
  });
});

await check('timeout and permission failures clear stale results and allow a real successful retry', async () => {
  for (const [scenario, error] of [['4. 响应超时 (504)', '504 Gateway Timeout'], ['5. 无密级权限 (403)', '403 Forbidden']]) {
    await fixture(async ({host, current, updates}) => {
      const before = structuredClone(current());
      click(host, '执行检索'); await settle();
      click(host, scenario); click(host, '执行检索'); await settle();
      assert(host.textContent?.includes(error)); assert(!exactText(host, '候选原文片段（4条）'));
      assert.equal(buttons(host, '定位原文').length, 0); assert.equal(buttons(host, '+ 建立事实候选').length, 0);
      click(host, '1. 正常命中原文'); click(host, '点击重试检索'); await settle();
      assert(exactText(host, '候选原文片段（4条）')); assert(!host.textContent?.includes(error));
      assert.equal(buttons(host, '定位原文').length, 4);
      assert.equal(updates.length, 0); assert.deepEqual(current(), before);
    });
  }
});

await check('cancelled retrieval never restores old cards or writes facts, drafts or snapshots', async () => {
  await fixture(async ({host, current, updates, views}) => {
    const before = structuredClone(current());
    click(host, '执行检索'); await settle();
    click(host, '2. 仅有生成答案 (CLUE-01)'); click(host, '执行检索'); click(host, '取消检索'); await settle();
    assert.equal(buttons(host, '执行检索').length, 1); assert.equal(buttons(host, '取消检索').length, 0);
    assert(!host.textContent?.includes('RAG检索执行中')); assert(!exactText(host, '检索线索（1条）'));
    assert.equal(buttons(host, '定位原文').length, 0); assert.equal(buttons(host, '+ 建立事实候选').length, 0);
    assert.equal(updates.length, 0); assert.equal(views.length, 0); assert.deepEqual(current(), before);
  });
});

await check('task switches clear completed results and isolate in-flight completion before a fresh retrieval', async () => {
  await fixture(async ({host, current, render, updates, views}) => {
    click(host, '执行检索'); await settle();
    const next = {...structuredClone(current()), id: 'RAG-OTHER-TASK'}; render(next);
    assert(!exactText(host, '候选原文片段（4条）')); assert.equal(buttons(host, '定位原文').length, 0);
    click(host, '执行检索'); render({...structuredClone(next), id: 'RAG-THIRD-TASK'}); await settle();
    assert(!exactText(host, '候选原文片段（4条）')); assert.equal(buttons(host, '定位原文').length, 0);
    assert.equal(buttons(host, '取消检索').length, 0);
    click(host, '执行检索'); await settle(); assert(exactText(host, '候选原文片段（4条）'));
    assert.equal(updates.length, 0); assert.equal(views.length, 0);
  });
});

await check('registered clue metadata governs each card and mixed counts never label a clue as original text', async () => {
  await fixture(async ({host, current, render, updates, views}) => {
    click(host, '执行检索'); await settle();
    const mixed = structuredClone(current());
    mixed.documents.find(d => d.id === 'SRC-03')!.usage = 'rag_clue'; render(mixed);
    assert.equal(buttons(host, '定位原文').length, 3); assert.equal(buttons(host, '+ 建立事实候选').length, 3);
    assert(exactText(host, '无原文可定位'));
    assert(exactText(host, '检索结果（候选原文片段3条，检索线索1条）'), 'mixed header must count each actual classification');
    const allClues = structuredClone(mixed);
    for (const d of allClues.documents.filter(d => ['SRC-01', 'SRC-02', 'SRC-03', 'SRC-05'].includes(d.id))) d.usage = 'rag_clue';
    render(allClues);
    assert(exactText(host, '检索线索（4条）')); assert.equal(buttons(host, '定位原文').length, 0);
    assert.equal(buttons(host, '+ 建立事实候选').length, 0);
    assert.equal(updates.length, 0); assert.equal(views.length, 0);
  });
});

assert.equal(failures.length, 0, `RAG regressions: ${failures.join('; ')}`);
