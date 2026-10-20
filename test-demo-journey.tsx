import {simulateTextareaChange} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {App} from './src/App';
import {STORAGE_KEY_V2, type AppStoragePayload} from './src/services/storageService';
import {runDocumentAudit} from './src/services/mockAuditService';
import {AuditAndExportStage} from './src/components/stages/AuditAndExportStage';

const host=document.createElement('div'); document.body.append(host);
const root=createRoot(host);
const alerts:string[]=[];
const originalConfirm=window.confirm;
const originalAlert=globalThis.alert;
globalThis.alert=message=>{alerts.push(String(message));};
window.confirm=()=>{throw new Error('Native confirm is unavailable in the AI Studio sandbox');};
const click=(text:string,scope:ParentNode=host)=>{
  const choices=[...scope.querySelectorAll('button')].filter(b=>b.textContent?.includes(text));
  assert.equal(choices.length,1,`expected one button: ${text}`);
  assert(!choices[0].disabled,`disabled button: ${text}`);
  act(()=>choices[0].click());
};
const state=()=>JSON.parse(localStorage.getItem(STORAGE_KEY_V2)!) as AppStoragePayload;
const task=()=>state().tasks.find(t=>t.id===state().currentTaskId)!;
act(()=>root.render(<App/>));
click('展开演示专区');
click('2. 存在口径冲突');
assert(task().facts.some(f=>f.hasConflict&&!f.selectedConflictValue));
click('任务要求');
assert(host.textContent?.includes('统计期间'));
click('材料与事实',host.querySelector('nav[aria-label="工作阶段进度"]')!);
click('立即裁决此冲突');
const candidate=[...host.querySelectorAll('span')].find(el=>el.textContent?.trim()==='128 项')!;
assert(candidate);
act(()=>{(candidate.closest('.cursor-pointer') as HTMLElement).click();});
act(()=>simulateTextareaChange(host.querySelector('textarea')!,'已核对科室汇总台账，采用128项口径。'));
click('确认采信并写入事实');
assert.equal(task().facts.find(f=>f.id==='FACT-01')?.selectedConflictValue,'128');
click('确认本次事实清单');
assert(task().factSnapshot?.items?.some(f=>f.value==='128'));
click('下一步：文风与大纲');
click('单位文风规范提炼');
click('确认并采纳文风规则');
assert(task().styleConfirmed);
click('确认大纲并进入起草');
assert(task().outlineConfirmed);
click('下一步：正文起草');
click('立即生成初稿');
await act(async()=>{await new Promise(r=>setTimeout(r,750));});
assert(task().drafts[0].blocks.some(b=>b.content.includes('128项')));
click('生成整稿候选');
await act(async()=>{await new Promise(r=>setTimeout(r,750));});
click('整体采纳并创建新工作稿',host.querySelector('[role="dialog"]')!);
assert(task().currentDraftId);
click('保存版本快照');
click('确认保存快照');
const workingId=task().currentDraftId;
const historical=task().drafts.find(d=>d.isHistoricalSnapshot)!;
assert(historical);
const historyText=historical.blocks.map(b=>b.content);
const working=()=>task().drafts.find(d=>d.id===task().currentDraftId)!;
assert(!working().isHistoricalSnapshot,'saving a snapshot must leave the working draft active');
const gapBlock=working().blocks.find(b=>b.content.includes('服务满意度'))!;
const gapText='服务满意度相关量化材料尚待补齐，当前仅记录资料缺口，不据此作成效判断。';
act(()=>simulateTextareaChange(host.querySelector(`[data-testid="textarea-block-${gapBlock.id}"]`)!,gapText));
assert.equal(task().currentDraftId,workingId);
assert.deepEqual(task().drafts.find(d=>d.id===historical.id)!.blocks.map(b=>b.content),historyText);
assert(!runDocumentAudit(task(),working().blocks,workingId).some(i=>i.originalText==='服务满意度明显提升'),'a missing-evidence statement must not produce an invented positive quote');
const positive={...gapBlock,content:'经反馈，服务满意度显著提升。'};
const warning=runDocumentAudit(task(),[positive],workingId).find(i=>i.type==='unverified_sentence');
assert.equal(warning?.originalText,'服务满意度显著提升');
for(const content of ['服务满意度提升明显','服务满意度提高显著','尚未取得量化报告但服务满意度显著提升','服务满意度有所提升但缺乏量化依据','满意度未见提升但本期服务满意度显著提升','服务满意度未见显著提升但本期服务满意度显著提升']) {
  assert.equal(runDocumentAudit(task(),[{...gapBlock,referencedFactIds:['FACT-06'],content}],workingId).find(i=>i.issueId===`ISSUE-GAP-${gapBlock.id}-satisfaction`)?.originalText,content);
}
const qualified={...gapBlock,content:'服务满意度虽然定性感受有所提升，但目前尚缺少定量数据测评体系支撑。'};
assert.equal(runDocumentAudit(task(),[qualified],workingId).find(i=>i.type==='unverified_sentence')?.originalText,'服务满意度虽然定性感受有所提升');
assert(!runDocumentAudit(task(),[{...gapBlock,content:'服务满意度未见提升。'}],workingId).some(i=>i.type==='unverified_sentence'));
for(const content of ['服务满意度仍有提升空间。','服务满意度亟待提升。','服务满意度有待提高。','服务满意度将进一步提升。','力争服务满意度显著提升。','未观察到服务满意度显著提升。','服务满意度提升不明显。','服务满意度提高不显著。','服务满意度有所提升不明显。','尚未有证据表明服务满意度显著提升','缺乏服务满意度显著提升的依据','服务满意度显著提升的依据尚待补充']) {
  assert(!runDocumentAudit(task(),[{...gapBlock,referencedFactIds:['FACT-06'],content}],workingId).some(i=>i.issueId===`ISSUE-GAP-${gapBlock.id}-satisfaction`),`no achieved satisfaction outcome: ${content}`);
}
for(const connector of ['可以','可']) {
  const audit=(content:string)=>runDocumentAudit(task(),[{...gapBlock,referencedFactIds:['FACT-06'],content}],workingId).find(i=>i.issueId===`ISSUE-GAP-${gapBlock.id}-satisfaction`);
  for(const period of ['','本期','本年度','2026年']) {
    const denied=`没有充分证据${connector}表明${period}服务满意度显著提升`;
    assert(!audit(denied),`evidence denial governs the claim: ${denied}`);
  }
  for(const contrasted of [`没有充分证据${connector}表明上期成效但本期服务满意度显著提升`,`没有充分证据${connector}表明上期服务满意度显著提升但本期服务满意度显著提升`]) {
    assert.equal(audit(contrasted)?.originalText,contrasted);
  }
}
click('提交本轮审阅');click('确认提交并进入审阅');
click('审阅乙');click('提出审阅意见');
act(()=>{(host.querySelectorAll<HTMLInputElement>('input[name="cmtType"]')[1]).click();});
act(()=>{(host.querySelectorAll<HTMLInputElement>('input[name="newCommentSuggestionType"]')[1]).click();});
const commentForm=[...host.querySelectorAll('form')].find(f=>f.textContent?.includes('提交审阅意见'))!;
const newText='2026年1至9月，累计组织专题培训16场，累计参训800人次。';
act(()=>{
  const fields=commentForm.querySelectorAll('textarea');
  simulateTextareaChange(fields[0],'请精简培训段落并保留核准数据。');
  simulateTextareaChange(fields[1],newText);
});
click('提交审阅意见');
assert.equal(task().reviewComments.at(-1)?.reviewer,'审阅乙');
click('主笔甲');click('对比并落实修改到正文');click('确认修改并生成新版本');
assert.equal(working().blocks[0].content,newText);
assert(task().reviewComments.some(c=>c.status==='implemented'));
click('下一步：核校与定稿导出');
const readyForFinalization=structuredClone(task());
click('确认最终定稿');
assert(!task().isFinalized);
assert(host.querySelector('[role="dialog"]'));
click('取消',host.querySelector('[role="dialog"]')!);
assert(!task().isFinalized,'cancelling must not finalize');
click('确认最终定稿');click('确认定稿并归档');
assert(task().isFinalized,'the sandbox-compatible confirmation must finish finalization');
assert(working().isFinal);
const finalizedTaskId=task().id;
click('重置数据');click('取消',host.querySelector('[role="dialog"]')!);
assert(task().isFinalized,'cancelling reset must preserve the final version');
click('重置数据');
assert(host.querySelector('[role="dialog"]')?.textContent?.includes('不会自动备份当前改动'));
click('确认重置');
assert(!state().tasks.find(t=>t.id===finalizedTaskId)?.isFinalized,'confirmed reset must restore the preset');
let unexpectedUpdates=0;
const renderAudit=(data:typeof readyForFinalization)=>act(()=>root.render(<AuditAndExportStage task={data} activeRole="主笔甲" onUpdateTask={()=>unexpectedUpdates++}/>));
renderAudit(readyForFinalization);
click('确认最终定稿');
renderAudit({...readyForFinalization,factSnapshot:undefined});
click('确认定稿并归档');
assert(host.querySelector('[role="dialog"]'),'failed revalidation must keep the in-app explanation visible');
assert(host.querySelector('[role="alert"]')?.textContent?.includes('事实'));
assert.equal(unexpectedUpdates,0);
assert.equal(alerts.length,0,alerts.join('\n'));
act(()=>root.unmount());host.remove();
window.confirm=originalConfirm;globalThis.alert=originalAlert;
console.log('PASS: full App journey from conflict resolution to review, sandbox finalization and reset; faithful audit quotes');
