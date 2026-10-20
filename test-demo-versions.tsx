import './test-jsdom-env';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {createPresetTask} from './src/services/mockData';
import {findDraftFact,resolveDraftFactEvidence} from './src/services/factLifecycleService';
import {MaterialEvidenceList} from './src/components/MaterialEvidenceList';
import {SnippetDrawer} from './src/components/SnippetDrawer';
import {createDraftSnapshot,validateFinalizationConditions,finalizeDraft,submitDraftForReview,restoreDraftVersion,applyDraftContentChange} from './src/services/draftLifecycleService';
import {generateParagraphRevision} from './src/services/mockDraftService';
import {exportDocumentAsTxt,safeDownloadName} from './src/services/exportService';
import {rebindReviewCommentTargetBlock} from './src/services/reviewCoordinationService';
import type {DraftVersion,EvidenceSnippet,Fact,AdoptedEvidenceRecord} from './src/types';
const task=createPresetTask('under_review');
const working=task.drafts.find(d=>d.id===task.currentDraftId)!;
const fact=task.facts.find(f=>f.id==='FACT-01')!;
const history:DraftVersion=structuredClone(working);history.id='HIST-120';history.isHistoricalSnapshot=true;history.isWorkingDraft=false;
const frozen=history.snapshotMetadata!.factSnapshot!.items!.find(f=>f.factId===fact.id)!;
frozen.value='120';frozen.selectedConflictValue='120';frozen.primaryEvidenceId='EVD-01';
fact.value='999';fact.selectedConflictValue='999';
const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
let opened:EvidenceSnippet|undefined;
let openedAdopted:AdoptedEvidenceRecord|undefined;
const show=()=>act(()=>root.render(<MaterialEvidenceList task={task} currentDraft={history} activeBlock={history.blocks[0]} isCurrentDraftImmutable inspectingFactId={fact.id} onViewSnippet={(s,_f,ev)=>{opened=s;openedAdopted=ev;}}/>));
show();
const value=(label:string)=>[...host.querySelectorAll('span')].find(el=>el.textContent===label)?.parentElement?.textContent;
assert(value('稿件冻结采用值')?.includes('120 项'));
assert(value('任务最新核准值')?.includes('999 项'));
fact.value=frozen.value;fact.selectedConflictValue='128';show();
assert(value('稿件冻结采用值')?.includes('120 项'));
assert(value('任务最新核准值')?.includes('128 项'));
assert(host.textContent?.includes('版本差异提示'));
assert.equal(resolveDraftFactEvidence(fact,history,task).hasSnapshotDiff,true);
fact.selectedConflictValue=frozen.selectedConflictValue;
assert.equal(resolveDraftFactEvidence(fact,history,task).hasSnapshotDiff,false);
task.facts=task.facts.filter(f=>f.id!==fact.id);show();
assert(value('稿件冻结采用值')?.includes('120 项'));
assert(host.textContent?.includes('任务中已删除此事实'));
const orphanWorking={...history,isHistoricalSnapshot:false,isWorkingDraft:true};
const orphanFact=findDraftFact(task,orphanWorking,fact.id)!;
const orphanResolution=resolveDraftFactEvidence(orphanFact,orphanWorking,task);
assert.equal(orphanResolution.effectiveSnippet?.id,'EVD-01');
assert.equal(orphanResolution.currentSnippet,null);
assert(orphanResolution.currentConfirmedValue.includes('已删除'));
const evidence:AdoptedEvidenceRecord={evidenceId:'EVD-03',sourceDocId:task.snippets.find(s=>s.id==='EVD-03')!.sourceDocId,sourceDocName:'采用时材料名称',snippetLocation:'第1段',period:'2026年1至9月',usage:'current_fact',snippetText:'采用时保存的原文。',contentFingerprint:'DEMO-FROZEN',capturedAt:new Date().toISOString()};
history.blocks[0].adoptedEvidences=[evidence];
task.snippets.find(s=>s.id==='EVD-03')!.text='后来修改的材料原文。';
show();const open=[...host.querySelectorAll('button')].filter(b=>b.textContent?.includes('在抽屉中核验冻结片段')).at(-1);assert(open);act(()=>open.click());assert.equal(opened?.text,evidence.snippetText);
act(()=>root.render(<SnippetDrawer snippet={opened!} adoptedEvidence={openedAdopted} documents={task.documents} task={task} currentDraft={history} onClose={()=>{}}/>));
assert(host.textContent?.includes(evidence.snippetText));assert(!host.textContent?.includes('后来修改的材料原文'));
const sourceDocument=task.documents.find(d=>d.id===evidence.sourceDocId)!;
sourceDocument.name='当前材料名称';sourceDocument.period='2027年度';sourceDocument.content='采纳之后修改的全文，仅属于当前材料库。';
act(()=>root.render(<SnippetDrawer snippet={opened!} adoptedEvidence={openedAdopted} documents={task.documents} task={task} currentDraft={history} onClose={()=>{}}/>));
assert(!host.textContent?.includes(sourceDocument.content),'frozen evidence must not present current full text as adopted material');
assert(host.textContent?.includes('仅保存采纳时片段，未保存当时全文'),'explain the frozen full-text limit');
assert(host.textContent?.includes(evidence.sourceDocName));assert(host.textContent?.includes(evidence.snippetText));
// Identical evidence ID and text in two paragraphs must still open the clicked record.
const laterEvidence={...evidence,sourceDocName:'第二次采纳的材料',period:'2027年上半年',snippetLocation:'第9段',usage:'history_bg' as const};
history.blocks[1].adoptedEvidences=[laterEvidence];
act(()=>root.render(<MaterialEvidenceList task={task} currentDraft={history} activeBlock={history.blocks[1]} isCurrentDraftImmutable inspectingFactId={null} onViewSnippet={(s,_f,ev)=>{opened=s;openedAdopted=ev;}}/>));
const laterOpen=[...host.querySelectorAll('button')].filter(b=>b.textContent?.includes('在抽屉中核验冻结片段')).at(-1);assert(laterOpen);
act(()=>laterOpen.click());assert.equal(openedAdopted,laterEvidence);
act(()=>root.render(<SnippetDrawer snippet={opened!} adoptedEvidence={openedAdopted} documents={task.documents} task={task} currentDraft={history} onClose={()=>{}}/>));
assert(host.textContent?.includes(laterEvidence.sourceDocName));assert(host.textContent?.includes(laterEvidence.period));assert(host.textContent?.includes(laterEvidence.snippetLocation));
assert(!host.textContent?.includes(evidence.sourceDocName));
const saved=createDraftSnapshot(task,working.id,'里程碑','主笔甲');
assert.equal(saved.updatedTask.currentDraftId,task.currentDraftId);
assert(saved.snapshotDraft.isHistoricalSnapshot);
const fresh=createPresetTask('under_review');const draft=fresh.drafts.find(d=>d.id===fresh.currentDraftId)!;
fresh.reviewComments=[];draft.sourceDraftId='MAIN-ROOT';
const unrelated={...structuredClone(draft),id:'OTHER-BRANCH',sourceDraftId:undefined};const ancestor={...structuredClone(draft),id:'MAIN-ROOT',sourceDraftId:undefined};fresh.drafts.push(unrelated,ancestor);
fresh.reviewComments=[{id:'OLD-OPINION',type:'overall',targetVersionId:unrelated.id,reviewer:'审阅乙',content:'旧旁支意见',status:'pending',createdAt:new Date().toISOString()}];
assert.equal(validateFinalizationConditions(fresh,draft.id,'主笔甲').checks.commentsClosed,true);
fresh.reviewComments[0].targetVersionId=draft.id;
assert.equal(validateFinalizationConditions(fresh,draft.id,'主笔甲').checks.commentsClosed,false);
const roundOne=submitDraftForReview({...fresh,reviewComments:[]},draft.id,'主笔甲');
const oldOpinion={...fresh.reviewComments[0],targetVersionId:roundOne.baselineSnapshot!.id};
const roundTwo=submitDraftForReview({...roundOne.updatedTask,reviewComments:[oldOpinion]},draft.id,'主笔甲');
assert.notEqual(roundTwo.updatedTask.reviewBaseDraftId,oldOpinion.targetVersionId);
for(const status of ['pending','accepted_pending_implementation','need_discussion'] as const) {
 const reviewTask={...roundTwo.updatedTask,reviewComments:[{...oldOpinion,status}]};
 assert.equal(validateFinalizationConditions(reviewTask,draft.id,'主笔甲').checks.commentsClosed,false,`earlier round ${status} must block`);
}
assert.equal(validateFinalizationConditions({...roundTwo.updatedTask,reviewComments:[{...oldOpinion,status:'rejected',decisionReason:'已经核实无需修改'}]},draft.id,'主笔甲').checks.commentsClosed,true);
// A -> edit shared working draft -> review B -> restore A: B is a sibling, not an inherited review.
const savedA=createDraftSnapshot({...fresh,reviewComments:[]},draft.id,'保存 A','主笔甲');
const editedB=applyDraftContentChange(savedA.updatedTask,draft.id,blocks=>blocks.map((b,i)=>i?b:{...b,content:b.content+'后续编辑。'}),'A 后编辑','主笔甲');
const submittedB=submitDraftForReview(editedB.updatedTask,editedB.workingDraft.id,'主笔甲');
const siblingOpinion={...oldOpinion,targetVersionId:submittedB.baselineSnapshot!.id};
const restoredA=restoreDraftVersion({...submittedB.updatedTask,reviewComments:[siblingOpinion]},savedA.snapshotDraft.id,'主笔甲');
assert.equal(validateFinalizationConditions(restoredA.updatedTask,restoredA.workingDraft.id,'主笔甲').checks.commentsClosed,true,'later sibling B must not block restored A');
const restoredB=restoreDraftVersion({...submittedB.updatedTask,reviewComments:[siblingOpinion]},submittedB.baselineSnapshot!.id,'主笔甲');
assert.equal(validateFinalizationConditions(restoredB.updatedTask,restoredB.workingDraft.id,'主笔甲').checks.commentsClosed,false,'B opinions still block restored B');
// Rebind A's opinion onto B through the real action; the original target is audit history only.
const rebindInput={...restoredB.updatedTask,reviewComments:[{...siblingOpinion,type:'paragraph' as const,targetVersionId:savedA.snapshotDraft.id,targetBlockId:draft.blocks[0].id}]};
const rebound=rebindReviewCommentTargetBlock(rebindInput,siblingOpinion.id,restoredB.workingDraft.blocks[0].id,'主笔甲');
assert.equal(rebound.updatedComment.targetVersionId,savedA.snapshotDraft.id,'original target remains intact');
assert.equal(rebound.updatedComment.rebindRecord?.targetDraftId,restoredB.workingDraft.id);
const afterRebindA=restoreDraftVersion(rebound.updatedTask,savedA.snapshotDraft.id,'主笔甲');
assert.equal(validateFinalizationConditions(afterRebindA.updatedTask,afterRebindA.workingDraft.id,'主笔甲').checks.commentsClosed,true,'rebound B opinion must not gate restored A');
assert.equal(validateFinalizationConditions(rebound.updatedTask,restoredB.workingDraft.id,'主笔甲').checks.commentsClosed,false,'rebound opinion must still gate B');
// Snapshots and exports use the same branch scope for both pending and closed comments.
const scopedTask=structuredClone(restoredA.updatedTask);
const ownOpinion={...oldOpinion,id:'OWN-REVIEW',targetVersionId:scopedTask.currentDraftId,status:'implemented' as const,content:'本分支已落实意见'};
const unknownOpinion={...oldOpinion,id:'LEGACY-REVIEW',targetVersionId:'MISSING-LEGACY-VERSION',status:'rejected' as const,content:'未知旧关联意见'};
scopedTask.reviewComments=[{...siblingOpinion,id:'SIBLING-PENDING',content:'旁支待处理意见'},{...siblingOpinion,id:'SIBLING-CLOSED',status:'implemented',content:'旁支已落实意见'},ownOpinion,unknownOpinion];
const scopedDraft=scopedTask.drafts.find(d=>d.id===scopedTask.currentDraftId)!;
const scopedSaved=createDraftSnapshot(scopedTask,scopedDraft.id,'分支隔离快照','主笔甲');
const scopedReview=submitDraftForReview(scopedTask,scopedDraft.id,'主笔甲');
scopedDraft.blocks=[{...scopedDraft.blocks[0],content:'累计完成重点任务128项。',referencedFactIds:['FACT-01']}];
const scopedFinal=finalizeDraft(scopedTask,scopedDraft.id,'主笔甲');assert(scopedFinal.success,scopedFinal.error);
for(const snapshot of [scopedSaved.snapshotDraft,scopedReview.baselineSnapshot!,scopedFinal.finalDraft!]) {
 assert.deepEqual(snapshot.frozenReviewComments?.map(c=>c.id),[ownOpinion.id,unknownOpinion.id],'freeze only applicable opinions, including closed and unknown legacy records');
 assert.notEqual(snapshot.frozenReviewComments?.[0],ownOpinion,'freeze an independent copy');
}
const originalDownloadURL=URL.createObjectURL;URL.createObjectURL=undefined as unknown as typeof URL.createObjectURL;
try {
 for(const version of [scopedDraft,scopedSaved.snapshotDraft,scopedReview.baselineSnapshot!,scopedFinal.finalDraft!]) {
  const log=exportDocumentAsTxt(scopedTask,version,{includeBody:false,includeEvidence:false,includeReviewLog:true});
  assert(log.includes(ownOpinion.content));assert(log.includes(unknownOpinion.content));assert(!log.includes('旁支'),'export must not mix sibling reviews');
 }
} finally {URL.createObjectURL=originalDownloadURL;}
// Review rounds that actually preceded a saved snapshot remain inherited after restore.
const savedAfterRound=createDraftSnapshot(roundTwo.updatedTask,draft.id,'已有审阅的快照','主笔甲');
const inheritedRestore=restoreDraftVersion({...savedAfterRound.updatedTask,reviewComments:[oldOpinion]},savedAfterRound.snapshotDraft.id,'主笔甲');
assert.equal(validateFinalizationConditions(inheritedRestore.updatedTask,inheritedRestore.workingDraft.id,'主笔甲').checks.commentsClosed,false);
const metricTask=structuredClone(fresh);
metricTask.facts[0].unit='亩';
for(const [unit,before,after] of [['公里','100','200'],['吨','50','80'],['名','30','40'],['亩','3','5'],['吨','1,200','2,200'],['%','5','-5'],['吨','-1,200','+1,200']] as const) {
 const block={...draft.blocks[0],content:`本期完成${before}${unit}。`};
 const replacement={...oldOpinion,type:'paragraph' as const,suggestionType:'replacement' as const,suggestedChange:`本期完成${after}${unit}。`};
 const suggestion=generateParagraphRevision(block,'custom',fresh.id,draft.id,'METRIC-RUN',{task:metricTask,currentDraft:draft,sourceComment:replacement});
 assert.equal(suggestion.suggestedText,replacement.suggestedChange);
 const normalized=(n:string)=>String(Number(n.replaceAll(',','')));
 assert(suggestion.needsVerificationNotes?.some(n=>n.includes(`${normalized(before)}${unit}`)&&n.includes(`${normalized(after)}${unit}`)),`must warn on ${before}${unit} -> ${after}${unit}`);
}
for(const [before,after] of [['1,200吨','1200吨'],['+5%','5％'],['−5%','-5%']]) {
 const suggestion=generateParagraphRevision({...draft.blocks[0],content:`本期完成${before}。`},'custom',fresh.id,draft.id,'FORMAT-RUN',{task:metricTask,currentDraft:draft,sourceComment:{...oldOpinion,type:'paragraph',suggestionType:'replacement',suggestedChange:`本期完成${after}。`}});
 assert(!suggestion.needsVerificationNotes?.some(n=>n.includes('包含数据变动')),`${before} and ${after} should compare equal`);
}
fresh.reviewComments=[];draft.blocks=[{...draft.blocks[0],content:'累计完成重点任务128项。',referencedFactIds:['FACT-01']}];
const finalized=finalizeDraft(fresh,draft.id,'主笔甲');assert(finalized.success,finalized.error);
const finalHash=finalized.finalDraft!.snapshotMetadata!.factSnapshot!.hash;
draft.snapshotMetadata!.factSnapshot!.hash='CHANGED';assert.equal(finalized.finalDraft!.snapshotMetadata!.factSnapshot!.hash,finalHash);
assert(finalized.finalDraft!.versionNumber.includes(draft.versionNumber));
const noSnapshot={...draft,id:'WORK-NO-SNAPSHOT',isHistoricalSnapshot:false,isFinal:false,snapshotMetadata:undefined};
fresh.drafts.push(noSnapshot);fresh.facts=fresh.facts.map(f=>f.id==='FACT-01'?{...f,value:'120',selectedConflictValue:'128'}:{...f,status:'pending' as const});
const originalURL=URL.createObjectURL;URL.createObjectURL=undefined as unknown as typeof URL.createObjectURL;
try {
 const txt=exportDocumentAsTxt(fresh,noSnapshot,{includeBody:false,includeEvidence:true,includeReviewLog:false});assert(txt.includes('128项'));assert(!txt.includes('16场'));
 const conflictSnapshot={...noSnapshot,id:'SNAPSHOT-DECISION',snapshotMetadata:structuredClone(working.snapshotMetadata!)};
 conflictSnapshot.snapshotMetadata.factSnapshot!.items=[{...frozen,value:'120',selectedConflictValue:'128'}];
 const decided=exportDocumentAsTxt(fresh,conflictSnapshot,{includeBody:false,includeEvidence:true,includeReviewLog:false});
 assert(decided.includes(`${frozen.metric}：128项`));assert(!decided.includes(`${frozen.metric}：120项`));
 const missingFrozen={...noSnapshot,id:'HIST-NO-SNAPSHOT',isHistoricalSnapshot:true};fresh.drafts.push(missingFrozen);
 const old=exportDocumentAsTxt(fresh,missingFrozen,{includeBody:false,includeEvidence:true,includeReviewLog:false});assert(!old.includes('128项'));
} finally {URL.createObjectURL=originalURL;}
assert.equal(safeDownloadName('总结/2026:定稿.docx'),'总结_2026_定稿.docx');
act(()=>root.unmount());host.remove();
console.log('PASS: precise 120/999 evidence, deleted facts, frozen raw text, milestones, final review scope, deep snapshot and export selection');
