import { dom } from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {DecisionNoteModal} from './src/components/DecisionNoteModal';
import {StyleAndOutlineStage} from './src/components/stages/StyleAndOutlineStage';
import {DraftingStage} from './src/components/stages/DraftingStage';
import {createPresetTask} from './src/services/mockData';
import {resolveDraftFactEvidence} from './src/services/factLifecycleService';
import type {Task} from './src/types';
const host = document.createElement('div');document.body.append(host);
const root = createRoot(host);
let cancelled=0, confirmed='';
act(()=>root.render(<DecisionNoteModal initialNote="采纳方向" onCancel={()=>cancelled++} onConfirm={n=>confirmed=n}/>));
assert.equal(document.activeElement,host.querySelector('textarea'));
act(()=>{host.querySelectorAll('button')[0].click();});
assert.equal(cancelled,1); assert.equal(confirmed,'');
act(()=>{host.querySelectorAll('button')[1].click();});
assert.equal(confirmed,'采纳方向');
act(()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
assert.equal(cancelled,2);
const task=createPresetTask('ready_to_draft');
const previousOutline=JSON.stringify(task.outline);
let updated:Partial<Task>|undefined;
const mount=(role:'主笔甲'|'审阅乙')=>act(()=>root.render(<StyleAndOutlineStage task={task} activeRole={role} onUpdateTask={u=>updated=u} onViewSnippet={()=>{}} onProceedToNextStage={()=>{}}/>));
mount('主笔甲');
const input=[...host.querySelectorAll('input')].find(i=>i.value===task.outline[0].title)!;
assert(input);
const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!;
act(()=>{setter.call(input,'新的大纲标题');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
assert.equal(updated?.outline?.[0].title,'新的大纲标题');
assert.equal(updated?.outlineConfirmed,false);assert.equal(updated?.outlineSnapshot,undefined);
assert.equal(JSON.stringify(task.outline),previousOutline);
mount('审阅乙');
assert([...host.querySelectorAll('input')].find(i=>i.value===task.outline[0].title)?.disabled);
const noFacts = {...task, id:'NO-APPROVED-FACTS', facts: task.facts.map(f=>({...f,status:'pending' as const}))};
act(()=>root.render(<StyleAndOutlineStage task={noFacts} activeRole="主笔甲" onUpdateTask={u=>updated=u} onViewSnippet={()=>{}} onProceedToNextStage={()=>{}}/>));
const template=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('标准'))!;assert(template);
act(()=>template.click());
assert.equal(updated!.outline![0].assignedFactIds.length,0);
assert.equal(updated!.outline![0].hasMaterialGap,true);
const stale=createPresetTask('under_review'); stale.factSnapshot=undefined;
act(()=>root.render(<DraftingStage task={stale} activeRole="主笔甲" onUpdateTask={()=>{}} onViewSnippet={()=>{}}/>));
assert(host.textContent?.includes('引用事实已变动/待复核'));
const openOutline=host.querySelector<HTMLButtonElement>('[data-testid="btn-open-tablet-outline"]');assert(openOutline);
act(()=>openOutline.click());
const closeOutline=host.querySelector<HTMLButtonElement>('[data-testid="btn-close-tablet-outline"]');assert(closeOutline);
assert(closeOutline.closest('[data-testid="drawer-tablet-outline"]'));
act(()=>closeOutline.click());assert(!host.querySelector('[data-testid="drawer-tablet-outline"]'));
act(()=>root.unmount());host.remove();

// -------------------------------------------------------------
// 回归测试：ready_to_draft 预置事实与快照口径一致性及首稿生成链路
// -------------------------------------------------------------
{
  // A. 预置任务直接比较
  const readyTask = createPresetTask('ready_to_draft');
  assert(readyTask.factSnapshot, 'ready_to_draft 必须具备预置 factSnapshot');
  assert.equal(readyTask.factSnapshot.items?.length, 4, '快照仅包含4项核准事实');
  assert.deepEqual(readyTask.factSnapshot.factIds, ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'], 'factIds 一一对应核准事实');
  assert(!readyTask.factSnapshot.factIds.includes('FACT-05'), 'FACT-05 历史项未混入快照');
  assert(!readyTask.factSnapshot.factIds.includes('FACT-06'), 'FACT-06 缺口项未混入快照');

  const confirmedFacts = readyTask.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  assert.equal(confirmedFacts.length, 4);
  for (const f of confirmedFacts) {
    const snap = readyTask.factSnapshot.items?.find(item => item.factId === f.id);
    assert(snap, `快照必须收录核准事实 ${f.id}`);
    assert.equal(snap.metric, f.metric, `${f.id} 指标名称一致`);
    assert.equal(snap.value, f.selectedConflictValue || f.value, `${f.id} 采用值一致`);
    assert.equal(snap.unit, f.unit, `${f.id} 单位一致`);
    assert.equal(snap.period, f.period, `${f.id} 统计期间一致`);
    assert.equal(snap.metricScope, f.metricScope, `${f.id} metricScope 口径一致`);
    assert.equal(snap.primaryEvidenceId, f.primaryEvidenceId, `${f.id} primaryEvidenceId 一致`);
  }
  // 重点校验 FACT-03 的 metricScope 带有完整的括号说明
  const snapFact03 = readyTask.factSnapshot.items?.find(item => item.factId === 'FACT-03')!;
  assert.equal(snapFact03.metricScope, '专题培训实名参训人次统计（注：单位为人次，非人数）');
  // FACT-01 采信 128 项与冲突裁决候选信息保留
  const snapFact01 = readyTask.factSnapshot.items?.find(item => item.factId === 'FACT-01')!;
  assert.equal(snapFact01.selectedConflictValue, '128');
  assert.equal(snapFact01.primaryEvidenceId, 'EVD-02');
  assert.equal(snapFact01.hasConflict, true);
  assert(snapFact01.conflictCandidates?.some(c => c.value === '120'));
  assert(snapFact01.conflictCandidates?.some(c => c.value === '128'));

  // B. 真实首稿生成链路（挂载组件，触发“立即生成初稿”，检查实际草稿与依据差异标志）
  const draftHost = document.createElement('div');
  document.body.append(draftHost);
  const draftRoot = createRoot(draftHost);
  let taskWithInitialDraft: Task = readyTask;
  
  act(() => {
    draftRoot.render(
      <DraftingStage
        task={readyTask}
        activeRole="主笔甲"
        onUpdateTask={(updated) => {
          taskWithInitialDraft = { ...taskWithInitialDraft, ...updated };
        }}
        onViewSnippet={() => {}}
      />
    );
  });

  // 点击“立即生成初稿”按钮
  const genBtn = [...draftHost.querySelectorAll('button')].find(b => b.textContent?.includes('立即生成初稿'));
  assert(genBtn, '待起草场景必须提供立即生成初稿按钮');
  await act(async () => {
    genBtn.click();
    await new Promise(resolve => setTimeout(resolve, 850));
  });

  assert(taskWithInitialDraft.drafts.length > 0, '必须通过组件真实生命周期生成初稿');
  const initialDraft = taskWithInitialDraft.drafts[0];
  assert.equal(initialDraft.versionNumber, 'v1.0 (初稿)');
  assert(initialDraft.snapshotMetadata?.factSnapshot, '草稿必须冻结快照元数据');

  // 检查培训段落
  const trainingBlock = initialDraft.blocks.find(b => b.referencedFactIds.includes('FACT-03'));
  assert(trainingBlock, '初稿必须生成包含培训事实引用的段落');
  assert(trainingBlock.content.includes('16场'), '培训段落包含16场');
  assert(trainingBlock.content.includes('800人次'), '培训段落包含800人次');
  assert(trainingBlock.content.includes('2026年1至9月'), '培训段落包含正确统计期间');

  // 逐项检查 4 项核准事实在首稿中的依据比对结果：绝不应出现无操作的虚假差异
  for (const f of confirmedFacts) {
    const evidence = resolveDraftFactEvidence(f, initialDraft, taskWithInitialDraft);
    assert.equal(evidence.hasSnapshotDiff, false, `${f.id} 不应存在数值/单位差异`);
    assert.equal(evidence.hasPeriodDiff, false, `${f.id} 不应存在期间差异`);
    assert.equal(evidence.hasScopeDiff, false, `${f.id} 不应存在口径差异（尤其FACT-03）`);
    assert.equal(evidence.hasEvidenceDiff, false, `${f.id} 不应存在材料依据ID差异`);
  }

  // 重新将生成的草稿挂载到 DraftingStage，断言页面无“口径已调整”或“引用事实已变动”等虚假告警
  act(() => {
    draftRoot.render(
      <DraftingStage
        task={taskWithInitialDraft}
        activeRole="主笔甲"
        onUpdateTask={() => {}}
        onViewSnippet={() => {}}
      />
    );
  });
  assert(!draftHost.textContent?.includes('口径已调整'), '首稿生成后页面不得出现口径已调整告警');
  assert(!draftHost.textContent?.includes('引用事实已变动/待复核'), '首稿生成后页面不得出现引用事实已变动告警');

  // C. 真实变化仍可检出（改变当前事实，草稿冻结快照保持不变，差异标志严格触发）
  const isolatedTask = JSON.parse(JSON.stringify(taskWithInitialDraft)) as Task;
  const modFact03 = isolatedTask.facts.find(f => f.id === 'FACT-03')!;
  modFact03.metricScope = '修改后的新口径说明';
  const diffEvidence03 = resolveDraftFactEvidence(modFact03, initialDraft, isolatedTask);
  assert.equal(diffEvidence03.hasScopeDiff, true, '真实修改 FACT-03 口径后，hasScopeDiff 必须严格触发 true');

  const modFact02 = isolatedTask.facts.find(f => f.id === 'FACT-02')!;
  modFact02.period = '2026年1至10月';
  const diffEvidence02 = resolveDraftFactEvidence(modFact02, initialDraft, isolatedTask);
  assert.equal(diffEvidence02.hasPeriodDiff, true, '真实修改 FACT-02 期间后，hasPeriodDiff 必须严格触发 true');

  const modFact04 = isolatedTask.facts.find(f => f.id === 'FACT-04')!;
  modFact04.value = '15';
  const diffEvidence04 = resolveDraftFactEvidence(modFact04, initialDraft, isolatedTask);
  assert.equal(diffEvidence04.hasSnapshotDiff, true, '真实修改 FACT-04 数值后，hasSnapshotDiff 必须严格触发 true');

  // D. 相邻场景回归
  // under_review 场景草稿与依据一致
  const reviewTask = createPresetTask('under_review');
  const reviewDraft = reviewTask.drafts[0];
  for (const f of reviewTask.facts.filter(fact => fact.status === 'confirmed' && !fact.isHistoricOnly)) {
    const revEv = resolveDraftFactEvidence(f, reviewDraft, reviewTask);
    assert.equal(revEv.hasSnapshotDiff, false, `under_review ${f.id} hasSnapshotDiff 必须为 false`);
    assert.equal(revEv.hasPeriodDiff, false, `under_review ${f.id} hasPeriodDiff 必须为 false`);
    assert.equal(revEv.hasScopeDiff, false, `under_review ${f.id} hasScopeDiff 必须为 false`);
    assert.equal(revEv.hasEvidenceDiff, false, `under_review ${f.id} hasEvidenceDiff 必须为 false`);
  }
  // conflict_pending 仍待裁决
  const conflictTask = createPresetTask('conflict_pending');
  assert.equal(conflictTask.facts[0].hasConflict, true);
  assert.equal(conflictTask.facts[0].status, 'pending');
  assert.equal(conflictTask.facts[0].selectedConflictValue, undefined);

  draftRoot.unmount();
  draftHost.remove();
}

console.log('PASS: sandbox decision modal cancel/confirm/focus, outline reconfirmation and role edit guard');
console.log('PASS: ready_to_draft preset facts & snapshot scope consistency, initial draft lifecycle & diff detection');
