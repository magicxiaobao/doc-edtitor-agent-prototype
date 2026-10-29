import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createSharedParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { saveFactReviewRecord } from './src/services/factReviewService';
import { restoreDraftVersion, validateFinalizationConditions, validateUndoEligibility } from './src/services/draftLifecycleService';
import { generateSharedParagraphFactRevisionCandidate as generate, validateSharedParagraphFactRevisionAcceptance as validate,
  acceptSharedParagraphFactRevisionCandidate as accept, checkMultiFactGroupRevisionEligibility } from './src/services/factRevisionCandidateService';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { MaterialsAndFactsStage } from './src/components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './src/components/stages/StyleAndOutlineStage';
import { App } from './src/App';
import { loadPersistedState } from './src/services/storageService';
import type { Task, DraftVersion, MultiFactGroupRevisionCandidate, UserRole } from './src/types';
const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); }
}
const clone = <T,>(value: T): T => structuredClone(value);
function approve(t: Task) {
  const facts = t.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  t.factSnapshot = { hash: 'codex-task26', confirmedAt: '2026-10-29T04:00:00Z', factIds: facts.map(f => f.id), items: facts.map(f => buildFactItemSnapshot(t, f)) };
}
function fixture(single = false) {
  const task = createSharedParagraphRevisionDemoTask(), draft = task.drafts[0];
  for (const [id, value, evidence] of [['FACT-01','120','EVD-01'],['FACT-02','18','EVD-07']]) {
    Object.assign(task.facts.find(f => f.id === id)!, { status:'confirmed', value, selectedConflictValue:value,
      primaryEvidenceId:evidence, conflictResolutionReason:'核实同期间同范围，采信最新材料' });
  }
  approve(task); task.outlineConfirmed = true; task.outlineSnapshot = clone(draft.snapshotMetadata!.outlineSnapshot);
  if (single) {
    draft.blocks[1].referencedFactIds = []; draft.blocks[1].content = '任务督办台账已核对。';
    draft.blocks[2].referencedFactIds = ['FACT-03']; draft.blocks[2].content = '累计参训800人次。';
  }
  return {task,draft};
}
function candidate(t: Task, d: DraftVersion) {
  const r = generate(t,d,'主笔甲'); assert.equal(r.success,true,r.reason); const c = r.candidateGroup!;
  assert.equal(validate(t,d,c,'主笔甲',c.runId).valid,true); return c;
}
function mount(e: React.ReactElement) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); act(()=>root.render(e));
  return {host,render:(n:React.ReactElement)=>act(()=>root.render(n)),close:()=>{act(()=>root.unmount());host.remove();}};
}
function click(h: HTMLElement,id:string) {
  const b=h.querySelector<HTMLElement>(`[data-testid="${id}"]`);assert.ok(b,id);assert.notEqual((b as HTMLButtonElement).disabled,true,id);act(()=>b.click());
}
function modal(t:Task,d:DraftVersion,extra:Partial<React.ComponentProps<typeof FactImpactModal>>={}) {
  return <FactImpactModal isOpen task={t} currentDraft={d} analysis={analyzeFactImpact(t,d)} activeRole="主笔甲" onClose={()=>{}} {...extra}/>;
}
await check('1 单共享段和混合三段：精确结果、并集去重、序号只加一、输入不变、重复采纳拒绝',()=>{
  for(const single of [true,false]) {
    const {task,draft}=fixture(single), before=clone(task), c=candidate(task,draft);
    assert.equal(c.facts.length,2);assert.equal(c.items.length,single?1:3);assert.equal(new Set(c.targetBlockIds).size,c.items.length);
    const r=accept(task,draft,c,'主笔甲',c.runId);assert.equal(r.success,true,r.reason);assert.deepEqual(task,before);
    for(const b of draft.blocks) {
      const next=r.newWorkingDraft!.blocks.find(x=>x.id===b.id)!;
      if(c.targetBlockIds.includes(b.id)) {
        assert.equal(next.content,b.content.replace('累计完成重点任务128项','累计完成重点任务120项').replace('组织专题培训16场','组织专题培训18场'));
        assert.equal(next.revisionSeq,(b.revisionSeq??0)+1);assert.deepEqual(next.referencedFactIds,b.referencedFactIds);
      } else assert.deepEqual(next,b);
    }
    assert.equal(r.updatedTask!.drafts.length,2);assert.equal(r.updatedTask!.modificationLogs!.length,1);
    assert.equal(analyzeFactImpact(r.updatedTask!,r.newWorkingDraft!).changedFactsCount,0);
    assert.equal(accept(r.updatedTask!,r.newWorkingDraft!,c,'主笔甲',c.runId).success,false);
  }
});
await check('2 稳定ID与正文顺序重排，旧通道仍拒绝共享段',()=>{
  const {task,draft}=fixture();draft.blocks.reverse();draft.blocks.forEach((b,i)=>b.order=i+1);
  const c=candidate(task,draft);assert.deepEqual(c.items.map(i=>i.targetBlockId),['BLK-03','BLK-02','BLK-01']);
  assert.equal(checkMultiFactGroupRevisionEligibility(task,draft,'主笔甲').eligible,false);
  assert.equal(accept(task,draft,c,'主笔甲',c.runId).success,true);
});
await check('3 数值交叉与长度变化基于同一原文，其他同值指标不被修改',()=>{
  for(const [a,b] of [['16','18'],['12000','2']]) {
    const {task,draft}=fixture(true);
    draft.blocks[0].content='2026年1至9月，累计完成重点任务128项，其他事项128项，组织专题培训16场，历时16天，参训800人次。';
    for(const [id,value] of [['FACT-01',a],['FACT-02',b]]) {
      const f=task.facts.find(x=>x.id===id)!;f.value=value;f.selectedConflictValue=value;
      const s=task.snippets.find(x=>x.id===f.primaryEvidenceId)!;const doc=task.documents.find(x=>x.id===s.sourceDocId)!;
      const text=`2026年1至9月，${f.metric}${value}${f.unit}。`;doc.content=doc.content.replace(s.text,text);s.text=text;
    } approve(task);
    const c=candidate(task,draft);assert.equal(c.items[0].revisedBlockContent,`2026年1至9月，累计完成重点任务${a}项，其他事项128项，组织专题培训${b}场，历时16天，参训800人次。`);
  }
});
await check('4 同旧值同单位的不同指标按事实归属消歧',()=>{
  const {task,draft}=fixture(true);const f=task.facts[1];f.unit='项';
  const snap=draft.snapshotMetadata!.factSnapshot!.items.find(i=>i.factId===f.id)!;
  Object.assign(snap,{unit:'项',value:'128',selectedConflictValue:'128'});snap.provenance!.text='2026年1至9月，组织专题培训128项。';
  draft.blocks[0].content='2026年1至9月，累计完成重点任务128项，组织专题培训128项，其他事项128项，参训800人次。';
  const s=task.snippets.find(x=>x.id==='EVD-07')!,doc=task.documents.find(x=>x.id===s.sourceDocId)!;
  const text='2026年1至9月，组织专题培训18项。';doc.content=doc.content.replace(s.text,text);s.text=text;approve(task);
  const c=candidate(task,draft);assert.equal(c.items[0].revisedBlockContent,'2026年1至9月，累计完成重点任务120项，组织专题培训18项，其他事项128项，参训800人次。');
});
await check('5 歧义、计划语义、期间、单位、口径与末段失败整组拒绝且无写入',()=>{
  const changes:Array<(t:Task,d:DraftVersion)=>void>=[
    (_t,d)=>{d.blocks[0].content+='累计完成重点任务128项。';},
    (_t,d)=>{d.blocks[2].content='2026年1至9月，计划组织专题培训16场。';},
    (_t,d)=>{d.blocks[2].content=d.blocks[2].content.replace('16场','116场');},
    (t)=>{t.facts[1].unit='期';approve(t);},(t)=>{t.facts[1].period='2026年1至6月';approve(t);},
    (t)=>{t.facts[1].metricScope+='口径改变';approve(t);},
  ];
  for(const change of changes){const {task,draft}=fixture();candidate(task,draft);change(task,draft);const before=clone(task);
    assert.equal(generate(task,draft,'主笔甲').success,false);assert.deepEqual(task,before);}
});
await check('6 权限、只读、稳定ID、快照完整性与陈旧参数保护',()=>{
  for(const role of ['审阅乙','供稿丙',undefined,'unknown']){const {task,draft}=fixture();assert.equal(generate(task,draft,role as UserRole).success,false);}
  const changes:Array<(t:Task,d:DraftVersion)=>void>=[(_t,d)=>{d.isFinal=true;},(_t,d)=>{d.isHistoricalSnapshot=true;},
    (_t,d)=>{d.blocks[5].id=d.blocks[0].id;},(_t,d)=>{d.blocks[5].id='';},(_t,d)=>{d.snapshotMetadata!.factSnapshot=undefined;},
    (t)=>{t.currentDraftId='other';},(t)=>{t.factSnapshot!.items.pop();}];
  for(const change of changes){const {task,draft}=fixture();candidate(task,draft);change(task,draft);assert.equal(generate(task,draft,'主笔甲').success,false);}
  const {task,draft}=fixture();const stale=clone(draft);stale.blocks[0].content+='修改';assert.equal(generate(task,stale,'主笔甲').success,false);
});
await check('7 全稿正文、修订、引用、原文、事实与审批变化使已有效候选失效',()=>{
  const changes:Array<(t:Task,d:DraftVersion)=>void>=[(_t,d)=>{d.blocks[0].content+='编辑';},(_t,d)=>{d.blocks[5].content+='编辑';},
    (_t,d)=>{d.blocks[0].revisionSeq=1;},(_t,d)=>{d.blocks[0].referencedFactIds.pop();},(t)=>{t.facts[1].selectedConflictValue='19';},
    (t)=>{t.snippets.find(s=>s.id==='EVD-07')!.text+='原文改变';},(t)=>{t.documents.find(d=>d.id==='SRC-07')!.content+='材料改变';},
    (t)=>{t.facts[1].status='pending';},(t)=>{t.outlineConfirmed=false;},(t)=>{t.styleConfirmed=false;},(t)=>{t.factSnapshot=undefined;}];
  for(const change of changes){const {task,draft}=fixture(),c=candidate(task,draft);change(task,draft);const before=clone(task);
    assert.equal(validate(task,draft,c,'主笔甲',c.runId).valid,false);assert.equal(accept(task,draft,c,'主笔甲',c.runId).success,false);assert.deepEqual(task,before);}
});
await check('8 缺失重复额外候选项、改写区间与关联事实篡改安全拒绝',()=>{
  const changes:Array<(c:MultiFactGroupRevisionCandidate)=>void>=[c=>{c.items.pop();},c=>{c.items.push(clone(c.items[0]));},
    c=>{c.items[0].modifications![0].originalOffset!.start++;},c=>{c.items[0].modifications!.pop();},c=>{c.items[0].associatedFactIds=['FACT-01'];},
    c=>{c.items[0].revisedBlockContent+='篡改';},c=>{c.targetBlockIds.push('BLK-04');},c=>{c.facts[1].factId=c.facts[0].factId;}];
  for(const change of changes){const {task,draft}=fixture(),c=candidate(task,draft);change(c);assert.equal(accept(task,draft,c,'主笔甲',c.runId).success,false);}
  const {task,draft}=fixture(),base=candidate(task,draft);
  for(const key of ['items','targetFactIds','targetBlockIds','upstreamContext']){const c=clone(base);delete (c as unknown as Record<string,unknown>)[key];assert.equal(validate(task,draft,c,'主笔甲',c.runId).valid,false);}
  for(const bad of [null,[],{originalOffset:null}]){const c=clone(base);(c.items[0] as unknown as Record<string,unknown>).modifications=[bad];assert.equal(validate(task,draft,c,'主笔甲',c.runId).valid,false);}
  assert.equal(validate(task,draft,base,'主笔甲',null).valid,false);
});
await check('9 共享段删改文本完整准确，每个单位只出现一次',()=>{
  const {task,draft}=fixture(),v=mount(modal(task,draft));
  try{click(v.host,'btn-generate-shared-paragraph-revision');
    const c=candidate(task,draft),item=c.items[0];
    assert.equal(v.host.querySelector('[data-testid="original-block-content-BLK-01"]')!.textContent,item.originalBlockContent);
    assert.equal(v.host.querySelector('[data-testid="revised-block-content-BLK-01"]')!.textContent,item.revisedBlockContent);
    const expected=item.originalBlockContent.replace('128项','[删: 128项][改: 120项]').replace('16场','[删: 16场][改: 18场]');
    assert.equal(v.host.querySelector('[data-testid="revision-diff-view-BLK-01"]')!.textContent,expected);
  }finally{v.close();}
});
await check('10 仅真实控件可进入键盘序列，无隐藏测试别名按钮或重复候选',()=>{
  const {task,draft}=fixture(),v=mount(modal(task,draft,{onAcceptSharedParagraphFactRevision:()=>({success:true})}));
  try{click(v.host,'btn-generate-shared-paragraph-revision');
    const hidden=[...v.host.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(e=>e.matches('button,input,select,textarea,a[href]')&&e.tabIndex>=0);
    assert.equal(hidden.length,0,'aria-hidden控件不能仍可Tab聚焦');
    assert.equal(v.host.querySelectorAll('[data-testid="shared-paragraph-revision-candidate-card"]').length,1);
    assert.equal(v.host.querySelectorAll('[data-testid="btn-accept-shared-paragraph-revision"]').length,1);
  }finally{v.close();}
});
await check('11 人工复核冻结、来源参考、核校门禁、禁止单段撤销与全稿恢复',()=>{
  let {task,draft}=fixture();task=saveFactReviewRecord({task,targetDraftId:draft.id,targetBlockId:'BLK-01',activeRole:'主笔甲',status:'reviewed',notes:'已核对共享段两事实，尚未更新正文'}).updatedTask;
  draft=task.drafts.find(d=>d.id===task.currentDraftId)!;const c=candidate(task,draft),r=accept(task,draft,c,'主笔甲',c.runId);
  assert.equal(r.archivedDraft!.factReviewRecords!.length,1);assert.deepEqual(r.newWorkingDraft!.factReviewRecords,[]);assert.equal(r.newWorkingDraft!.sourceFactReviewRecords!.length,1);
  assert.equal(validateFinalizationConditions(r.updatedTask!,r.newWorkingDraft!.id,'主笔甲').checks.commentsClosed,false);
  assert.equal(validateUndoEligibility(r.updatedTask!,r.newWorkingDraft!,r.modificationLog!.id,'主笔甲').canUndo,false);
  const restored=restoreDraftVersion(r.updatedTask!,draft.id,'主笔甲');assert.deepEqual(restored.workingDraft.blocks,draft.blocks);assert.deepEqual(restored.workingDraft.snapshotMetadata,draft.snapshotMetadata);
});
await check('12 两事实一段日志真正展开完整前后文；异常可选元数据保留日志正文',()=>{
  const {task,draft}=fixture(true),c=candidate(task,draft),r=accept(task,draft,c,'主笔甲',c.runId);
  for(const malformed of [false,true]){const t=clone(r.updatedTask!);if(malformed)(t.modificationLogs![0] as unknown as Record<string,unknown>).affectedFacts=[null];
    const v=mount(<RecentModificationsModal isOpen task={t} currentDraft={r.newWorkingDraft!} activeRole="主笔甲" onClose={()=>{}} onUndo={()=>{}}/>);
    try{if(!malformed){const summary=v.host.querySelector('summary')!;assert.ok(summary);act(()=>summary.click());assert.equal(summary.parentElement!.hasAttribute('open'),true);
      assert.equal(v.host.querySelectorAll('[data-testid^="log-affected-fact-"]').length,2);
      const block=v.host.querySelector('[data-testid="log-affected-block-BLK-01"]')!;assert.ok(block.textContent!.includes(c.items[0].originalBlockContent));assert.ok(block.textContent!.includes(c.items[0].revisedBlockContent));
    }else{assert.ok(v.host.textContent!.includes('两项事实成组'));assert.ok(v.host.textContent!.includes('格式不完整'));assert.ok(v.host.querySelector('[data-testid="log-affected-block-BLK-01"]'),'可选事实元数据异常不能隐藏有效逐段完整正文');}}finally{v.close();}}
});
await check('13 取消、Escape关闭、角色与版本切换清除候选；采纳失败重试与同批双击只写一次',()=>{
  const {task,draft}=fixture();let calls=0,closed=0;
  const extra={onClose:()=>{closed++;},onAcceptSharedParagraphFactRevision:()=>({success:++calls>1,reason:'模拟业务失败'})};
  const v=mount(modal(task,draft,extra));try{
    click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,'btn-cancel-shared-paragraph-revision');assert.equal(v.host.querySelector('[data-testid="shared-paragraph-revision-candidate-card"]'),null);
    click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,'btn-accept-shared-paragraph-revision');assert.ok(v.host.textContent!.includes('模拟业务失败'));
    const retry=v.host.querySelector<HTMLButtonElement>('[data-testid="btn-retry-accept-shared-paragraph-revision"]')!;act(()=>{retry.click();retry.click();});assert.equal(calls,2);
    click(v.host,'btn-generate-shared-paragraph-revision');v.render(modal(task,draft,{...extra,activeRole:'审阅乙'}));assert.equal(v.host.querySelector('[data-testid="shared-paragraph-revision-candidate-card"]'),null);
    v.render(modal(task,draft,extra));click(v.host,'btn-generate-shared-paragraph-revision');const old=clone(draft);old.id='historical';old.isHistoricalSnapshot=true;
    v.render(modal(task,old,extra));assert.equal(v.host.querySelector('[data-testid="shared-paragraph-revision-candidate-card"]'),null);
    v.render(modal(task,draft,extra));click(v.host,'btn-generate-shared-paragraph-revision');act(()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(closed,1);
  }finally{v.close();}
});
await check('14 真实跨阶段两次裁决、事实与大纲核准、取消、整组采纳和日志',()=>{
  const initial=createSharedParagraphRevisionDemoTask();let latest=initial;
  function Journey(){const [task,setTask]=React.useState(initial),[stage,setStage]=React.useState(2);latest=task;
    const p={task,activeRole:'主笔甲' as const,onViewSnippet:()=>{},onUpdateTask:(patch:Partial<Task>)=>setTask(t=>({...t,...patch})),onProceedToNextStage:()=>setStage(s=>s+1)};
    return stage===2?<MaterialsAndFactsStage {...p}/>:stage===3?<StyleAndOutlineStage {...p}/>:<DraftingStage {...p}/>;}
  const v=mount(<Journey/>);const byText=(text:string)=>{const b=[...v.host.querySelectorAll('button')].find(b=>b.textContent!.trim()===text);assert.ok(b,text);assert.equal(b.disabled,false);act(()=>b.click());};
  try{for(const [index,value] of [[0,'120'],[1,'18']] as const){const bs=[...v.host.querySelectorAll('button')].filter(b=>b.textContent!.trim()==='裁决冲突');act(()=>bs[index].click());click(v.host,`conflict-candidate-${value}`);
      const input=v.host.querySelector<HTMLInputElement>('#conflict-statistical-scope')!;act(()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,initial.facts[index].metricScope);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));simulateTextareaChange(v.host.querySelector<HTMLTextAreaElement>('#conflict-decision-reason')!,'核实两份原文同期间同范围，采信最新值。');});byText('确认采信并写入事实');}
    byText('确认本次事实清单');byText('下一步：文风与大纲');byText('确认大纲并进入起草');byText('下一步：正文起草');const before=clone(latest);
    click(v.host,'btn-open-fact-impact');click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,'btn-cancel-shared-paragraph-revision');assert.deepEqual(latest,before);
    click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,'btn-accept-shared-paragraph-revision');const next=latest.drafts.find(d=>d.id===latest.currentDraftId)!;
    assert.equal(latest.drafts.length,2);assert.equal(latest.modificationLogs!.length,1);assert.ok(next.blocks[0].content.includes('120项，组织专题培训18场，参训800人次'));assert.equal(next.blocks[0].revisionSeq,1);
    const log=[...v.host.querySelectorAll('button')].find(b=>b.textContent!.includes('最近修改记录'))!;act(()=>log.click());act(()=>v.host.querySelector('summary')!.click());
    assert.equal(v.host.querySelectorAll('[data-testid^="log-affected-fact-"]').length,2);assert.equal(v.host.querySelectorAll('[data-testid^="log-affected-block-"]').length,3);
  }finally{v.close();}
});
await check('15 真实起草组件四个出处入口和共享段定位展示所有关联事实，无业务写入',()=>{
  const {task}=fixture();let viewed:{id:string;text:string;frozen:boolean|undefined}|undefined;
  const v=mount(<DraftingStage task={task} activeRole="主笔甲" onUpdateTask={()=>assert.fail('只读操作不应写入')} onProceedToNextStage={()=>{}}
    onViewSnippet={(s,f,_a,frozen)=>{viewed={id:f!.id,text:s.text,frozen};}}/>);
  try{for(const [id,oldVal,newVal] of [['FACT-01','128项','120项'],['FACT-02','16场','18场']]){for(const latest of [false,true]){
      click(v.host,'btn-open-fact-impact');click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,`${latest?'btn-view-latest-evidence':'btn-view-evidence'}-${id}`);
      assert.ok(viewed);assert.equal(viewed.id,id);assert.equal(viewed.frozen,!latest);assert.ok(viewed.text.includes(latest?newVal:oldVal));}}
    click(v.host,'btn-open-fact-impact');click(v.host,'btn-generate-shared-paragraph-revision');click(v.host,'btn-locate-candidate-block-BLK-01');
    assert.ok(v.host.textContent!.includes('累计完成重点任务'));assert.ok(v.host.textContent!.includes('组织专题培训'));assert.ok(v.host.querySelector('#paragraph-textarea-BLK-01'));
  }finally{v.close();}
});
await check('16 App显式创建、双击去重、复用不覆盖其他任务',()=>{
  localStorage.clear();const v=mount(<App/>);try{const before=clone(loadPersistedState().tasks);const toggle=[...v.host.querySelectorAll('button')].find(b=>b.textContent!.trim()==='展开演示专区')!;act(()=>toggle.click());
    const b=v.host.querySelector<HTMLButtonElement>('[data-testid="btn-create-shared-paragraph-demo-task"]')!;assert.ok(b);act(()=>{b.click();b.click();});const saved=loadPersistedState();
    assert.equal(saved.tasks.filter(t=>t.id==='TASK-DEMO-SHARED-PARAGRAPH-REVISION').length,1);for(const old of before)assert.deepEqual(saved.tasks.find(t=>t.id===old.id),old);
    const demo=clone(saved.tasks.find(t=>t.id===saved.currentTaskId));act(()=>b.click());assert.deepEqual(loadPersistedState().tasks.find(t=>t.id===saved.currentTaskId),demo);
  }finally{v.close();localStorage.clear();}
});
await check('17 原文编辑区间真实重叠整组拒绝；多共享段并集唯一',()=>{
  const {task,draft}=fixture(true);candidate(task,draft);
  const f=task.facts[1], old=draft.snapshotMetadata!.factSnapshot!.items.find(i=>i.factId===f.id)!;
  f.metric=task.facts[0].metric;f.unit='项';Object.assign(old,{metric:f.metric,unit:'项',value:'128',selectedConflictValue:'128'});
  old.provenance!.text='2026年1至9月，累计完成重点任务128项。';
  const snip=task.snippets.find(s=>s.id==='EVD-07')!,doc=task.documents.find(d=>d.id===snip.sourceDocId)!;
  const text='2026年1至9月，累计完成重点任务18项。';doc.content=doc.content.replace(snip.text,text);snip.text=text;approve(task);
  const result=generate(task,draft,'主笔甲');assert.equal(result.success,false);assert.ok(result.reason!.includes('修改定位范围发生重叠'),result.reason);
  const another=fixture();another.draft.blocks[1].content='2026年1至9月，累计完成重点任务128项，组织专题培训16场。';another.draft.blocks[1].referencedFactIds=['FACT-01','FACT-02'];
  const c=candidate(another.task,another.draft);assert.equal(c.items.filter(i=>i.modifications?.length===2).length,2);assert.equal(c.items.length,3);
});
await check('18 顶部与下方段落入口生成后，两个通道均聚焦并滚动至真实候选卡片',()=>{
  const originalScroll=dom.window.HTMLElement.prototype.scrollIntoView;
  let scrolled:HTMLElement[]=[];
  dom.window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};
  try{for(const shared of [true,false]){const {task,draft}=fixture();if(!shared)draft.blocks[0].referencedFactIds=['FACT-01','FACT-03'];
    const prefix=shared?'shared-paragraph':'multi-fact-group';const cardId=shared?'shared-paragraph-revision-candidate-card':'multi-fact-group-revision-candidate-card';
    const v=mount(modal(task,draft));try{for(const suffix of ['', '-BLK-03']){const button=v.host.querySelector<HTMLButtonElement>(`[data-testid="btn-generate-${prefix}-revision${suffix}"]`)!;
      assert.ok(button);button.focus();scrolled=[];act(()=>button.click());const card=v.host.querySelector<HTMLElement>(`[data-testid="${cardId}"]`)!;
      assert.ok(card);assert.equal(document.activeElement===card,true,'生成后键盘焦点必须进入真实候选');assert.ok(scrolled.includes(card),'生成后必须滚动至真实候选');
      click(v.host,`btn-cancel-${prefix}-revision`);
    }}finally{v.close();}
  }}finally{dom.window.HTMLElement.prototype.scrollIntoView=originalScroll;}
});
if(failures.length){console.error(`Task26 Codex independent failures: ${failures.length}\n${failures.join('\n')}`);process.exitCode=1;}
else console.log('Task26 Codex independent checks: 18 groups passed.');
