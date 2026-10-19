import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPresetTask } from './src/services/mockData';
import { validateSelectedMaterialsQuantitativeClaims } from './src/services/materialSupplementService';
import { extractClausePeriod } from './src/services/factLifecycleService';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { MaterialSupplementModal } from './src/components/MaterialSupplementModal';
import type { Task, EvidenceSnippet, SourceDocument } from './src/types';

const task = createPresetTask('ready_to_draft');
task.startDate = '2026-01-01'; task.endDate = '2026-12-31';
const fact = task.facts.find(f => f.id === 'FACT-02')!;
fact.period = '2026年1月';
const snippet = {...task.snippets.find(s => s.id === 'EVD-03')!, period: fact.period, text: '2026年1月，组织专题培训16场并开展交流。'};
assert.equal(validateSelectedMaterialsQuantitativeClaims(task, [snippet]).valid, true);
assert.equal(validateSelectedMaterialsQuantitativeClaims(task, [{...snippet, text: '2026年1月，组织专题培训16场。2026年2月，组织专题培训16场。'}]).valid, false);
const text = '2025年，开展活动12次。2026年1月，开展活动2次。';
assert.equal(extractClausePeriod(text, '2次', '2026年', text.lastIndexOf('2次')).period, '2026年1月');
assert.equal(extractClausePeriod('上半年，组织专题培训16场', '16场', '2027年').period, '2027年上半年');
for (const scenario of ['ready_to_draft', 'under_review'] as const) {
  const preset = createPresetTask(scenario);
  assert(!preset.factSnapshot?.factIds.includes('FACT-06'));
  for (const item of preset.factSnapshot!.items!) assert.equal(preset.facts.find(f => f.id === item.factId)?.status, 'confirmed');
}

const container = document.createElement('div'); document.body.append(container);
const root = createRoot(container);
const alerts: string[] = [];
const previousAlert = globalThis.alert;
globalThis.alert = (message) => { alerts.push(String(message)); };
const updates: Partial<Task>[] = [];
const empty = {...task, facts: []};
act(() => root.render(<MaterialsAndFactsStage task={empty} activeRole="主笔甲" onUpdateTask={u => updates.push(u)} onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
const button = (label: string) => {
  const result = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label));
  assert(result, `missing button: ${label}`); return result;
};
act(() => button('确认本次事实清单').click());
assert.equal(updates.length, 0); assert(alerts.some(a => a.includes('至少一项')));
act(() => button('检索').click());
act(() => button('执行检索').click());
act(() => button('取消').click());
const other = {...empty, id: 'other-task'};
act(() => root.render(<MaterialsAndFactsStage task={other} activeRole="主笔甲" onUpdateTask={u => updates.push(u)} onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
await act(async () => { await new Promise(r => setTimeout(r, 850)); });
assert(!container.textContent?.includes('检索返回结果'));

const material: SourceDocument = {id:'DEMO-SOURCE',name:'补写演示材料',source:'演示',usage:'current_fact',period:'2026年1至9月',fileType:'pasted',parseStatus:'parsed',content:'完善分类登记与反馈。'};
const evidence: EvidenceSnippet = {id:'DEMO-SNIP',sourceDocId:material.id,docName:material.name,period:material.period,location:'第1段',text:material.content};
const supplementTask = createPresetTask('under_review');
supplementTask.documents.push(material); supplementTask.snippets.push(evidence);
let success = 0, closed = 0;
act(() => root.render(<MaterialSupplementModal isOpen task={supplementTask} currentDraft={supplementTask.drafts[0]} activeBlock={supplementTask.drafts[0].blocks[0]} activeRole="主笔甲" onClose={() => closed++} onSupplementSuccess={() => success++} onViewSnippet={() => {}}/>));
act(() => (container.querySelector('[data-testid="checkbox-select-snippet-DEMO-SNIP"]') as HTMLButtonElement).click());
// Empty instruction is explicitly unsupported and must remain editable in the modal.
const textarea = container.querySelector('textarea')!;
const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
act(() => { setter.call(textarea, '翻译成英语'); textarea.dispatchEvent(new dom.window.Event('input', {bubbles:true})); });
await act(async () => { (container.querySelector('[data-testid="btn-submit-material-supplement"]') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 1200)); });
assert.equal(success, 0); assert.equal(closed, 0);
assert(container.textContent?.includes('未支持') || container.textContent?.includes('不支持'));
act(() => root.unmount()); container.remove(); globalThis.alert = previousAlert;
console.log('PASS: demo material units/occurrences, presets, empty confirmation, cancellation and unsupported prompt');
