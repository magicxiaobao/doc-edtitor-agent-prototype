import {dom, simulateTextareaChange} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {createPresetTask} from './src/services/mockData';
import {evaluateDraftFactReviews, saveFactReviewRecord, revokeFactReviewRecord, getFactReviewContext} from './src/services/factReviewService';
import {createDraftSnapshot, applyDraftContentChange, restoreDraftVersion, submitDraftForReview,
  acceptDraftCandidate, finalizeDraft,computeDraftBlocksHash} from './src/services/draftLifecycleService';
import {validateTaskStructure, savePersistedState, loadPersistedState, removeStorageItem,
  STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1, BACKUP_CORRUPTED_KEY} from './src/services/storageService';
import {DraftingStage} from './src/components/stages/DraftingStage';
import type {Task, DraftVersion, DraftCandidate} from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try {await run(); console.log(`PASS: ${name}`);}
  catch (e) {failures.push(name); console.error(`FAIL: ${name}\n${String(e)}`);}
}
function draftOf(t: Task) {return t.drafts.find(d => d.id === t.currentDraftId)!;}
function fixture() {
  const t = createPresetTask('under_review');
  const f = t.facts.find(f => f.id === 'FACT-01')!;
  f.value = '120'; f.selectedConflictValue = '120'; f.primaryEvidenceId = 'EVD-01';
  return t;
}
function record(t = fixture(), status: 'reviewed' | 'deferred' = 'reviewed') {
  return saveFactReviewRecord({task:t, targetDraftId:t.currentDraftId, targetBlockId:'BLK-01',
    status, notes:'已核对本次120项原文，保留人工核对说明。', activeRole:'主笔甲'});
}
function state(t: Task, d = draftOf(t)) {
  return evaluateDraftFactReviews(t, d).blockEvaluations.find(b => b.blockId === 'BLK-01');
}
function mount(t: Task) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let current = t; let updates = 0;
  const render = () => <DraftingStage task={current} activeRole="主笔甲" onViewSnippet={() => {}}
    onProceedToNextStage={() => {}} onUpdateTask={patch => {current = {...current, ...patch}; updates++; root.render(render());}}/>;
  act(() => root.render(render()));
  return {host, task:() => current, updates:() => updates,
    setTask:(next:Task) => {current=next; act(() => root.render(render()));},
    close:() => {act(() => root.unmount());host.remove();}};
}
function click(host: ParentNode, id: string) {
  const b = host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
  assert(b, id); act(() => b.click());
}

await check('历史冻结保存当时的结论，最新差异消失也不隐藏历史留痕', () => {
  const r = record();
  const snap = createDraftSnapshot(r.updatedTask,r.workingDraft.id,'冻结复核','主笔甲');
  const atSave = structuredClone(snap.snapshotDraft);
  const f = snap.updatedTask.facts.find(f => f.id === 'FACT-01')!;
  f.value='125'; f.selectedConflictValue='125';
  assert.equal(state(snap.updatedTask,snap.snapshotDraft)?.displayStatus,'reviewed');
  const view=mount({...snap.updatedTask,currentDraftId:snap.snapshotDraft.id});
  try {click(view.host,'btn-open-fact-impact'); assert(view.host.textContent?.includes('保存当时的任务状态（冻结）'));}
  finally {view.close();}
  // All current facts equal this draft's frozen baseline: history is still inspectable.
  for (const item of snap.snapshotDraft.snapshotMetadata!.factSnapshot!.items) {
    const fact=snap.updatedTask.facts.find(f=>f.id===item.factId)!;
    Object.assign(fact,{value:item.value,selectedConflictValue:item.selectedConflictValue,
      unit:item.unit,period:item.period,metricScope:item.metricScope,primaryEvidenceId:item.primaryEvidenceId});
  }
  assert.equal(state(snap.updatedTask,snap.snapshotDraft)?.displayStatus,'reviewed');
  assert.deepEqual(snap.snapshotDraft,atSave,'viewing must not mutate history');
  const restored=restoreDraftVersion(snap.updatedTask,snap.snapshotDraft.id,'主笔甲');
  assert.equal(restored.workingDraft.factReviewRecords?.length,0);
  assert(restored.workingDraft.sourceFactReviewRecords?.length);
});

await check('重新复核保留先前说明和撤回元数据，撤回不能改写已有历史事件', () => {
  const a=record();
  const b=revokeFactReviewRecord({task:a.updatedTask,targetDraftId:a.workingDraft.id,
    targetBlockId:'BLK-01',reason:'原说明需要重新核对',activeRole:'主笔甲'});
  const old=structuredClone(b.workingDraft.factReviewRecords![0]);
  const c=record(b.updatedTask);
  assert.equal(c.workingDraft.factReviewRecords?.length,2);
  assert(c.workingDraft.factReviewRecords?.some(r=>r.id===old.id&&r.revocation?.reason==='原说明需要重新核对'));
  assert.deepEqual(b.workingDraft.factReviewRecords![0],old);
});

await check('最新出处删除、待确认数值变化及冻结原文变化均使记录失效', () => {
  for(const mutate of [
    (t:Task,d:DraftVersion)=>{t.snippets=t.snippets.filter(s=>s.id!=='EVD-01');},
    (t:Task,d:DraftVersion)=>{d.snapshotMetadata!.factSnapshot!.items.find(f=>f.factId==='FACT-01')!.provenance!.text+='修改历史片段';},
    (t:Task,d:DraftVersion)=>{d.snapshotMetadata!.factSnapshot!.items.find(f=>f.factId==='FACT-01')!.primaryEvidenceId='EVD-03';},
  ]) {const r=record();mutate(r.updatedTask,r.workingDraft);assert.equal(state(r.updatedTask)?.displayStatus,'invalidated');}
  const t=fixture();t.facts.find(f=>f.id==='FACT-01')!.status='pending';const r=record(t);
  assert.equal(state(r.updatedTask)?.displayStatus,'reviewed');
  r.updatedTask.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue='125';
  assert.equal(state(r.updatedTask)?.displayStatus,'invalidated');
});

await check('空口径和未裁决/已删除事实可记录人工核对限制，不会刚保存就无效', () => {
  for(const prepare of [
    (t:Task)=>{t.facts.find(f=>f.id==='FACT-01')!.metricScope='';},
    (t:Task)=>{t.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue=undefined;},
    (t:Task)=>{t.facts=t.facts.filter(f=>f.id!=='FACT-01');},
  ]) {const t=fixture();prepare(t);const r=record(t);assert.equal(state(r.updatedTask)?.displayStatus,'reviewed');}
});

await check('新增复核字段损坏不能重置正文或导致运行时崩溃', () => {
  for(const malformed of [null,'bad',[{id:'x',taskId:'t',draftId:'d',blockId:'BLK-01',notes:'x',status:'reviewed'}]]) {
    const t=fixture();const body=structuredClone(draftOf(t).blocks);
    (draftOf(t) as any).factReviewRecords=malformed;
    assert.equal(validateTaskStructure(t),true,'repair optional review fields');
    assert.doesNotThrow(()=>evaluateDraftFactReviews(t,draftOf(t)));
    assert.deepEqual(draftOf(t).blocks,body);
    for(const k of [STORAGE_KEY_V2,LEGACY_STORAGE_KEY_V1,BACKUP_CORRUPTED_KEY])removeStorageItem(k);
    savePersistedState([t],t.id,'主笔甲');
    const loaded=loadPersistedState();assert.equal(loaded.isCorrupted,false);
    assert.equal(loaded.currentTaskId,t.id);assert.deepEqual(draftOf(loaded.tasks[0]).blocks,body);
  }
});

await check('已输入120项说明后依据改为125，实际组件拒绝陈旧表单提交并保留说明', () => {
  const t=fixture();const view=mount(t);
  try {
    click(view.host,'btn-open-fact-impact');
    const input=view.host.querySelector('[data-testid="input-review-notes-BLK-01"]') as HTMLTextAreaElement;
    act(()=>simulateTextareaChange(input,'已核对120项，需要保存这份具体说明'));
    const next=structuredClone(t);next.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue='125';
    view.setTask(next);click(view.host,'btn-submit-review-BLK-01');
    assert.equal(view.task().drafts.flatMap(d=>d.factReviewRecords||[]).length,0);
    assert(view.host.textContent?.includes('重新核对'));
    assert.equal((view.host.querySelector('[data-testid="input-review-notes-BLK-01"]') as HTMLTextAreaElement).value,
      '已核对120项，需要保存这份具体说明');
  } finally {view.close();}
});

await check('不同任务/版本的同名段落不能套用记录，实际正文编辑和撤销仍递增修订序号', () => {
  const r=record();const other=fixture();other.id+='OTHER';draftOf(other).factReviewRecords=structuredClone(r.workingDraft.factReviewRecords);
  assert.equal(state(other)?.displayStatus,'pending');
  const otherDraft=structuredClone(r.workingDraft);otherDraft.id+='OTHER';
  other.drafts=[otherDraft];other.currentDraftId=otherDraft.id;
  assert.equal(state(other)?.displayStatus,'pending');
  const edited=applyDraftContentChange(r.updatedTask,r.workingDraft.id,bs=>bs.map(b=>b.id==='BLK-01'?{...b,content:b.content+'修改'}:b),'编辑','主笔甲');
  const reverted=applyDraftContentChange(edited.updatedTask,edited.workingDraft.id,bs=>bs.map(b=>b.id==='BLK-01'?{...b,content:r.workingDraft.blocks[0].content}:b),'恢复文字','主笔甲');
  assert.equal(state(reverted.updatedTask)?.displayStatus,'invalidated');
  const aligned=structuredClone(r.updatedTask);
  const item=draftOf(aligned).snapshotMetadata!.factSnapshot!.items.find(i=>i.factId==='FACT-01')!;
  Object.assign(aligned.facts.find(f=>f.id==='FACT-01')!,{value:item.value,selectedConflictValue:item.selectedConflictValue,
    unit:item.unit,period:item.period,metricScope:item.metricScope,primaryEvidenceId:item.primaryEvidenceId});
  assert.equal(state(aligned)?.displayStatus,'invalidated');
  assert.equal(state(record(aligned).updatedTask)?.displayStatus,'reviewed','差异恢复一致后仍可重新确认此前失效的记录');
});

await check('审阅基准/候选归档/定稿都冻结结论，新稿仅保留来源参考', () => {
  const r=record();const submitted=submitDraftForReview(structuredClone(r.updatedTask),r.workingDraft.id,'主笔甲');
  submitted.updatedTask.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue='125';
  assert.equal(state(submitted.updatedTask,submitted.baselineSnapshot)?.displayStatus,'reviewed');
  const d=r.workingDraft,t=r.updatedTask;
  const candidate:DraftCandidate={taskId:t.id,runId:'receipt22',baseDraftId:d.id,
    baseDraftContentHash:computeDraftBlocksHash(d.blocks),generatedAt:new Date().toISOString(),
    upstreamApprovalVersion:{factSnapshotConfirmedAt:t.factSnapshot?.confirmedAt,factSnapshotHash:t.factSnapshot?.hash,
      styleConfirmedAt:t.styleSnapshot?.confirmedAt,outlineConfirmedAt:t.outlineSnapshot?.confirmedAt},
    instructionPrompt:'标准',blocks:structuredClone(d.blocks),snapshotMetadata:structuredClone(d.snapshotMetadata!)};
  const accepted=acceptDraftCandidate(t,d,candidate,'主笔甲');
  assert.equal(accepted.workingDraft.factReviewRecords?.length,0);
  assert.equal(accepted.workingDraft.sourceFactReviewRecords?.length,1);
  assert.equal(state(accepted.updatedTask,accepted.archivedDraft)?.displayStatus,'reviewed');
  // Keep finalization's original gates. Restore all live facts to the draft's legal baseline.
  const tFinal=structuredClone(t);tFinal.reviewComments=[];
  for(const item of draftOf(tFinal).snapshotMetadata!.factSnapshot!.items){
    Object.assign(tFinal.facts.find(f=>f.id===item.factId)!,{value:item.value,selectedConflictValue:item.selectedConflictValue,
      primaryEvidenceId:item.primaryEvidenceId,unit:item.unit,period:item.period,metricScope:item.metricScope});
  }
  const expected=evaluateDraftFactReviews(tFinal,draftOf(tFinal));
  const result=finalizeDraft(tFinal,tFinal.currentDraftId,'主笔甲');
  assert(result.success,result.error);
  result.updatedTask!.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue='125';
  assert.deepEqual(evaluateDraftFactReviews(result.updatedTask!,result.finalDraft),expected);
});

await check('提交入口重验依据，实际徽章聚焦、键盘关闭与任务切换清理有效', () => {
  const t=fixture(),d=draftOf(t),context=getFactReviewContext(t,d,d.blocks[0]);
  t.facts.find(f=>f.id==='FACT-01')!.selectedConflictValue='125';
  assert.throws(()=>saveFactReviewRecord({task:t,targetDraftId:d.id,targetBlockId:'BLK-01',status:'reviewed',
    notes:'120项旧说明',activeRole:'主笔甲',expectedContextFingerprint:context}),/重新核对/);
  const r=record(),view=mount(r.updatedTask);
  try{
    click(view.host,'badge-block-review-status-BLK-01');
    const modal=view.host.querySelector('[data-testid="fact-impact-modal"]')!;
    assert.equal((document.activeElement as HTMLElement)?.dataset.reviewBlockId,'BLK-01');
    act(()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})));
    assert(modal.contains(document.activeElement));
    act(()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    assert(!view.host.querySelector('[data-testid="fact-impact-modal"]'));
    click(view.host,'btn-open-fact-impact');
    const input=view.host.querySelector('[data-testid="input-review-notes-BLK-01"]') as HTMLTextAreaElement;
    act(()=>simulateTextareaChange(input,'旧任务说明'));
    const other=fixture();other.id+='SWITCH';view.setTask(other);
    click(view.host,'btn-open-fact-impact');
    assert.equal((view.host.querySelector('[data-testid="input-review-notes-BLK-01"]') as HTMLTextAreaElement).value,'');
  }finally{view.close();}
});

await check('损坏的可选失效原因和撤回元数据被隔离，历史面板仍可查看',()=>{
  const r=record();const edited=applyDraftContentChange(r.updatedTask,r.workingDraft.id,
    bs=>bs.map(b=>b.id==='BLK-01'?{...b,content:b.content+'修改'}:b),'编辑','主笔甲');
  const saved=createDraftSnapshot(edited.updatedTask,edited.workingDraft.id,'保存失效结论','主笔甲');
  (saved.snapshotDraft.frozenFactReviewOverview!.blockEvaluations[0] as any).invalidatedReason={bad:'object'};
  saved.updatedTask.currentDraftId=saved.snapshotDraft.id;
  assert(validateTaskStructure(saved.updatedTask));
  assert.equal(saved.snapshotDraft.frozenFactReviewOverview,undefined);
  assert(saved.snapshotDraft.factReviewRecovery?.frozenFactReviewOverview);
  const view=mount(saved.updatedTask);
  try{assert.doesNotThrow(()=>click(view.host,'btn-open-fact-impact'));}finally{view.close();}
  const bad=record();(bad.workingDraft.factReviewRecords![0] as any).revocation={revokedBy:{bad:'role'}};
  assert(validateTaskStructure(bad.updatedTask));
  assert.equal(bad.workingDraft.factReviewRecords?.length,0);
});

if(failures.length){console.error(`${failures.length} receipt groups failed`);process.exitCode=1;}
else console.log('Task22 receipt: all 10 independent regression groups passed');
