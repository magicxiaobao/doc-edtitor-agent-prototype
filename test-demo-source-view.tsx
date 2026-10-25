import {dom, simulateTextareaChange} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {App} from './src/App';
import {SnippetDrawer} from './src/components/SnippetDrawer';
import {createPresetTask} from './src/services/mockData';
import {loadPersistedState, removeStorageItem, STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY} from './src/services/storageService';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${String(error)}`); }
}
function button(host: ParentNode, label: string) {
  const matches = [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  assert.equal(matches.length, 1, `one button: ${label}`); return matches[0];
}
function click(host: ParentNode, label: string) { act(() => button(host, label).click()); }
function material(host: HTMLElement, name: string) {
  let card: HTMLElement | null = [...host.querySelectorAll('span')].find(s => s.textContent === name)?.parentElement || null;
  while (card && ![...card.querySelectorAll('button')].some(b => b.textContent?.trim() === '查看原文与依据')) card = card.parentElement;
  assert(card, `material card: ${name}`); return card;
}
function drawer(host: HTMLElement) {
  const el = host.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="snippet-drawer-title"]');
  assert(el, 'real global source drawer'); return el;
}
function assertSource(host: HTMLElement, id: string, preset = createPresetTask('conflict_pending')) {
  const snippet = preset.snippets.find(s => s.id === id)!;
  const doc = preset.documents.find(d => d.id === snippet.sourceDocId)!;
  const view = drawer(host); const text = view.textContent || '';
  assert(text.includes(snippet.text), `requested excerpt ${id}`);
  assert(text.includes(`材料名称：${doc.name}`), `requested document ${doc.id}`);
  assert(text.includes(`原文位置：${snippet.location}`));
  assert(text.includes(`来源：${doc.source} (${doc.period})`), 'full text from the same source');
  for (const paragraph of doc.content.split('\n\n')) assert(text.includes(paragraph));
  assert(!text.includes('当前已核准'), 'opening a source cannot imply factual approval');
  assert(!text.includes('稿件冻结采用值'), 'raw source is independent of the viewed draft');
}
async function fixture(run: (host: HTMLDivElement) => void | Promise<void>) {
  // These are isolated JSDOM fixtures, never browser acceptance state.
  for (const key of [STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY]) removeStorageItem(key);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try { act(() => root.render(<App/>)); await run(host); }
  finally { act(() => root.unmount()); host.remove(); for (const key of [STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY]) removeStorageItem(key); }
}

await check('real App material cards preserve the requested alternative source and all document identities', async () => {
  await fixture(host => {
    click(host, '单位基础材料 (6)'); const before = structuredClone(loadPersistedState().tasks);
    // The browser reproduction: FACT-01 currently points at EVD-01, but the user opens SRC-02.
    click(material(host, '科室乙前三季度汇总'), '查看原文与依据');
    assertSource(host, 'EVD-02');
    assert(!drawer(host).textContent?.includes('来源：科室甲'));
    click(host, '关闭抽屉');
    for (const [name, id] of [['科室甲前三季度工作情况', 'EVD-01'], ['培训工作台账', 'EVD-03'], ['2025年度工作总结', 'EVD-04'], ['专题调研情况汇报', 'EVD-05'], ['知识库RAG检索回答', 'EVD-06']]) {
      click(material(host, name), '查看原文与依据'); assertSource(host, id); click(host, '关闭抽屉');
    }
    assert.deepEqual(loadPersistedState().tasks, before, 'viewing sources cannot mutate facts, drafts or snapshots');
  });
});

await check('real App RAG locating uses each requested source through the global drawer', async () => {
  await fixture(async host => {
    click(host, '模拟知识库RAG检索');
    const before = structuredClone(loadPersistedState().tasks);
    await act(async () => { button(host, '执行检索').click(); await new Promise(r => setTimeout(r, 850)); });
    const actions = [...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === '定位原文');
    assert.equal(actions.length, 4);
    for (const [index, id] of ['EVD-01', 'EVD-02', 'EVD-03', 'EVD-05'].entries()) {
      act(() => actions[index].click()); assertSource(host, id); click(host, '关闭抽屉');
    }
    assert.deepEqual(loadPersistedState().tasks, before);
  });
});

await check('source viewing after a real 128 decision preserves the 120 alternative without rewriting the decision', async () => {
  await fixture(host => {
    click(host, '裁决冲突');
    const description = createPresetTask('conflict_pending').facts[0].conflictCandidates!.find(c => c.value === '128')!.description;
    const choice = [...host.querySelectorAll('p')].find(p => p.textContent === description); assert(choice);
    act(() => { choice.click(); simulateTextareaChange(host.querySelector<HTMLTextAreaElement>('textarea[required]')!, '核对原文后采信128项，用于出处入口回归。'); });
    click(host, '确认采信并写入事实'); click(host, '确认本次事实清单');
    click(host, '单位基础材料 (6)');
    const before = structuredClone(loadPersistedState().tasks);
    click(material(host, '科室甲前三季度工作情况'), '查看原文与依据'); assertSource(host, 'EVD-01');
    assert(!drawer(host).textContent?.includes('来源：科室乙')); click(host, '关闭抽屉');
    assert.deepEqual(loadPersistedState().tasks, before);
  });
});

await check('raw source mode ignores historical/final draft context while default fact mode still freezes evidence', () => {
  const task = createPresetTask('under_review');
  const fact = task.facts.find(f => f.id === 'FACT-01')!;
  const alternative = task.snippets.find(s => s.id === 'EVD-01')!;
  const working = task.drafts.find(d => d.id === task.currentDraftId)!;
  const before = structuredClone(task);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    for (const isFinal of [false, true]) {
      const draft = {...working, isWorkingDraft: false, isHistoricalSnapshot: !isFinal, isFinal};
      act(() => root.render(<SnippetDrawer snippet={alternative} sourceOnly documents={task.documents}
        currentDraft={draft} task={task} onClose={() => {}}/>));
      assertSource(host, alternative.id, task);
      assert(!drawer(host).textContent?.includes('对照版本：'));
      act(() => root.render(<SnippetDrawer snippet={alternative} fact={fact} documents={task.documents}
        currentDraft={draft} task={task} onClose={() => {}}/>));
      const view = drawer(host).textContent || '';
      const frozen = draft.snapshotMetadata!.factSnapshot!.items.find(i => i.factId === fact.id)!.provenance!;
      assert(view.includes(frozen.text), 'fact view retains its frozen 128 excerpt');
      assert(view.includes('稿件冻结采用值（快照）'));
      assert(view.includes('仅保存采纳时片段，未保存当时全文'));
      assert(!view.includes('来源：科室甲'));
      assert(!view.includes(task.documents.find(d => d.id === frozen.sourceDocId)!.content), 'current full text cannot masquerade as historical content');
    }
    assert.deepEqual(task, before);
  } finally { act(() => root.unmount()); host.remove(); }
});

if (failures.length) { console.error(`${failures.length} source-view regression groups failed`); process.exitCode = 1; }
else console.log('All source-view App integration regressions passed.');
