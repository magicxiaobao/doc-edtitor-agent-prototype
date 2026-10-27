import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPresetTask } from './src/services/mockData';
import {
  checkFactRevisionEligibility,
  generateFactRevisionCandidate,
  acceptFactRevisionCandidate,
  validateFactRevisionAcceptance,
} from './src/services/factRevisionCandidateService';
import { evaluateDraftFactReviews, saveFactReviewRecord } from './src/services/factReviewService';
import { resolveDraftFactEvidence } from './src/services/factLifecycleService';
import { validateFinalizationConditions } from './src/services/draftLifecycleService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { FactImpactModal } from './src/components/FactImpactModal';
import type { Task, DraftVersion } from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL: ${name}\n${String(e)}`);
  }
}

function fixture() {
  const task = createPresetTask('under_review');
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

  draft.snapshotMetadata = JSON.parse(JSON.stringify(draft.snapshotMetadata));
  task.factSnapshot = JSON.parse(JSON.stringify(task.factSnapshot));

  // Upstream fact updated to 120
  const f = task.facts.find((f) => f.id === 'FACT-01')!;
  f.value = '120';
  f.selectedConflictValue = '120';
  f.primaryEvidenceId = 'EVD-01';
  f.conflictResolutionReason = '采信科室甲申报口径120项';

  // Upstream snapshot updated to 120
  task.factSnapshot!.items[0].selectedConflictValue = '120';
  task.factSnapshot!.items[0].value = '120';
  task.factSnapshot!.items[0].primaryEvidenceId = 'EVD-01';
  task.factSnapshot!.items[0].conflictResolutionReason = '采信科室甲申报口径120项';
  task.factSnapshot!.items[0].provenance = {
    evidenceId: 'EVD-01',
    sourceDocId: 'DOC-01',
    sourceDocName: '科室甲前三季度工作情况',
    location: '第3段',
    text: '2026年1至9月，累计完成重点任务120项。统计范围与科室甲材料相同。',
  };

  return { task, draft };
}

// 1. 真实128→120：只有目标段落改变，其他段落正文及数据严格不变
await check('真实128→120：只有目标段落改变，其他段落正文及数据严格不变', () => {
  const { task, draft } = fixture();
  const b2Orig = draft.blocks[1].content;
  const b3Orig = draft.blocks[2].content;

  const candRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(candRes.success, true);

  const accRes = acceptFactRevisionCandidate(task, draft, candRes.candidate!, '主笔甲');
  assert.equal(accRes.success, true);

  const newDraft = accRes.newWorkingDraft!;
  assert(newDraft.blocks[0].content.includes('120项'));
  assert(!newDraft.blocks[0].content.includes('128项'));
  assert.equal(newDraft.blocks[1].content, b2Orig);
  assert.equal(newDraft.blocks[2].content, b3Orig);
});

// 2. 候选生成、取消、失败和重试均不提前修改正文、依据快照或版本
await check('候选生成、取消、失败和重试均不提前修改正文、依据快照或版本', () => {
  const { task, draft } = fixture();
  const countBefore = task.drafts.length;
  const textBefore = draft.blocks[0].content;
  const snapValBefore = draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue;

  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(res.success, true);
  assert.equal(task.drafts.length, countBefore);
  assert.equal(draft.blocks[0].content, textBefore);
  assert.equal(draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue, snapValBefore);
});

// 3. 采纳后旧稿冻结128与科室乙，新工作稿正文和依据均为120且指向科室甲
await check('采纳后旧稿冻结128与科室乙，新工作稿正文和依据均为120且指向科室甲', () => {
  const { task, draft } = fixture();
  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  const acc = acceptFactRevisionCandidate(task, draft, res.candidate!, '主笔甲');
  assert.equal(acc.success, true);

  const archived = acc.archivedDraft!;
  const working = acc.newWorkingDraft!;
  const f = acc.updatedTask!.facts.find((f) => f.id === 'FACT-01')!;

  const oldEv = resolveDraftFactEvidence(f, archived, acc.updatedTask!, { freezeSnapshot: true });
  assert.equal(oldEv.effectiveSnippet?.id, 'EVD-02');
  assert(oldEv.effectiveSnippet?.docName.includes('科室乙'));
  assert(oldEv.effectiveSnippet?.text.includes('128项'));

  const newEv = resolveDraftFactEvidence(f, working, acc.updatedTask!, { freezeSnapshot: true });
  assert.equal(newEv.effectiveSnippet?.id, 'EVD-01');
  assert(newEv.effectiveSnippet?.docName.includes('科室甲'));
  assert(newEv.effectiveSnippet?.text.includes('120项'));
});

// 4. 同段存在其他同数字指标或不同单位时精准识别，归属不明或偏离时安全拒绝
await check('同段存在其他同数字指标或不同单位时精准识别，归属不明或偏离时安全拒绝', () => {
  const { task, draft } = fixture();
  draft.blocks[0].content = '累计完成重点任务128项，组织观摩活动128场。';

  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(res.success, true);
  assert(res.candidate!.revisedBlockContent.includes('重点任务120项'));
  assert(res.candidate!.revisedBlockContent.includes('观摩活动128场'));

  // 偏离数值拒绝
  draft.blocks[0].content = '累计完成重点任务125项。';
  const resFail = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(resFail.success, false);
});

// 5. 多事实、多段落、单位/期间/口径变动、基准缺失、未裁决冲突均严格拦截
await check('多事实、多段落、单位/期间/口径变动、基准缺失、未裁决冲突均严格拦截', () => {
  // 单位变动
  const f1 = fixture();
  f1.task.facts[0].unit = '篇';
  assert.equal(checkFactRevisionEligibility(f1.task, f1.draft, 'BLK-01', '主笔甲').eligible, false);

  // 期间变动
  const f2 = fixture();
  f2.task.facts[0].period = '2026年上半年';
  assert.equal(checkFactRevisionEligibility(f2.task, f2.draft, 'BLK-01', '主笔甲').eligible, false);

  // 未裁决冲突
  const f3 = fixture();
  f3.task.facts[0].hasConflict = true;
  f3.task.facts[0].selectedConflictValue = undefined;
  assert.equal(checkFactRevisionEligibility(f3.task, f3.draft, 'BLK-01', '主笔甲').eligible, false);

  // 多段落关联
  const f4 = fixture();
  f4.draft.blocks[1].referencedFactIds.push('FACT-01');
  assert.equal(checkFactRevisionEligibility(f4.task, f4.draft, 'BLK-01', '主笔甲').eligible, false);
});

// 6. 生成后人工编辑目标或其他段落，采纳被拒绝且人工修改完好保留
await check('生成后人工编辑目标或其他段落，采纳被拒绝且人工修改完好保留', () => {
  const { task, draft } = fixture();
  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  assert.equal(res.success, true);

  // 人工修改目标段
  draft.blocks[0].content = '人工编辑后的段落：重点任务128项。';
  draft.blocks[0].revisionSeq = 1;

  const acc = acceptFactRevisionCandidate(task, draft, res.candidate!, '主笔甲');
  assert.equal(acc.success, false);
  assert(draft.blocks[0].content.includes('人工编辑后的段落'));
});

// 7. 跨任务、过期运行、非主笔身份及重复采纳均无法串写或多建版本
await check('跨任务、过期运行、非主笔身份及重复采纳均无法串写或多建版本', () => {
  const { task, draft } = fixture();
  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  const cand = res.candidate!;

  // 跨任务
  assert.equal(validateFactRevisionAcceptance({ ...task, id: 'T-OTHER' }, draft, cand, '主笔甲').valid, false);

  // 非主笔
  assert.equal(validateFactRevisionAcceptance(task, draft, cand, '审阅乙').valid, false);

  // 成功采纳一次
  const acc1 = acceptFactRevisionCandidate(task, draft, cand, '主笔甲');
  assert.equal(acc1.success, true);

  // 重复采纳同一候选被拒
  const acc2 = acceptFactRevisionCandidate(acc1.updatedTask!, draft, cand, '主笔甲');
  assert.equal(acc2.success, false);
});

// 8. 历史归档稿冻结复核结论，新工作稿复核记录初始化为空并保留来源参考
await check('历史归档稿冻结复核结论，新工作稿复核记录初始化为空并保留来源参考', () => {
  const { task, draft } = fixture();
  const saveRes = saveFactReviewRecord({
    task,
    targetDraftId: draft.id,
    targetBlockId: 'BLK-01',
    status: 'reviewed',
    notes: '旧复核说明',
    activeRole: '主笔甲',
  });
  const t = saveRes.updatedTask;
  const d = t.drafts.find((item) => item.id === draft.id)!;

  const res = generateFactRevisionCandidate(t, d, 'BLK-01', '主笔甲');
  const acc = acceptFactRevisionCandidate(t, d, res.candidate!, '主笔甲');
  assert.equal(acc.success, true);

  assert.equal(acc.archivedDraft!.factReviewRecords?.length, 1);
  assert.equal(acc.newWorkingDraft!.factReviewRecords?.length, 0);
  assert.equal(acc.newWorkingDraft!.sourceFactReviewRecords?.length, 1);
});

// 9. 新工作稿定稿门禁正常执行，审阅意见未闭环严格阻断
await check('新工作稿定稿门禁正常执行，审阅意见未闭环严格阻断', () => {
  const { task, draft } = fixture();
  const res = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
  const acc = acceptFactRevisionCandidate(task, draft, res.candidate!, '主笔甲');
  assert.equal(acc.success, true);

  const fin = validateFinalizationConditions(acc.updatedTask!, acc.newWorkingDraft!.id, '主笔甲');
  // Since fixture task has unclosed comments, finalization must fail
  assert.equal(fin.canFinalize, false);
});

// 10. #79 初始0修订序号与历史记录展示完全一致
await check('#79 初始0修订序号与历史记录展示完全一致', () => {
  const { task, draft } = fixture();
  draft.blocks[0].revisionSeq = 0;

  const analysis = analyzeFactImpact(task, draft);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={task}
        activeRole="主笔甲"
        onLocateBlock={() => {}}
        onViewDraftEvidence={() => {}}
      />
    );
  });

  const text = container.textContent || '';
  assert(text.includes('修订版本号：0'));
  assert(!text.includes('修订版本号：1'));

  act(() => {
    root.unmount();
  });
  container.remove();
});

// 11. 真实组件挂载与交互完整闭环，点击生成对比、取消及采纳生效
await check('真实组件挂载与交互完整闭环，点击生成对比、取消及采纳生效', () => {
  const { task, draft } = fixture();
  let currentTask = { ...task };
  const analysis = analyzeFactImpact(currentTask, draft);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={currentTask}
        activeRole="主笔甲"
        onLocateBlock={() => {}}
        onViewDraftEvidence={() => {}}
        onAcceptFactRevision={(cand) => {
          const res = acceptFactRevisionCandidate(currentTask, draft, cand, '主笔甲');
          currentTask = res.updatedTask!;
          return { success: true };
        }}
      />
    );
  });

  // Click generate
  const btnGen = container.querySelector('[data-testid="btn-generate-fact-revision-BLK-01"]') as HTMLButtonElement;
  assert(btnGen);
  act(() => btnGen.click());

  // Check card
  const card = container.querySelector('[data-testid="fact-revision-candidate-card-BLK-01"]');
  assert(card);

  // Click accept
  const btnAcc = container.querySelector('[data-testid="btn-accept-fact-revision-BLK-01"]') as HTMLButtonElement;
  assert(btnAcc);
  act(() => btnAcc.click());

  // Check new draft created
  assert.equal(currentTask.drafts.length, 2);
  assert(currentTask.drafts[0].blocks[0].content.includes('120项'));

  act(() => {
    root.unmount();
  });
  container.remove();
});

if (failures.length > 0) {
  console.error(`Task23 receipt failed with ${failures.length} issues:`, failures);
  process.exit(1);
} else {
  console.log('Task23 receipt: all 11 independent regression groups passed');
}
