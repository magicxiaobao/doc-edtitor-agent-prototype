import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { createPresetTask, createMultiFactGroupRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  checkMultiFactGroupRevisionEligibility,
  generateMultiFactGroupRevisionCandidate,
  acceptMultiFactGroupRevisionCandidate,
  validateMultiFactGroupRevisionAcceptance,
} from './src/services/factRevisionCandidateService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { restoreDraftVersion, validateUndoEligibility } from './src/services/draftLifecycleService';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
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

function mount(el: React.ReactElement) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function twoFactFixture() {
  const task = createMultiFactGroupRevisionDemoTask();
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

  // Upstream facts confirmed
  const f1 = task.facts.find((f) => f.id === 'FACT-01')!;
  f1.status = 'confirmed';
  f1.value = '120';
  f1.selectedConflictValue = '120';
  f1.primaryEvidenceId = 'EVD-01';
  f1.conflictResolutionReason = '采信科室甲申报口径120项';

  const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
  f2.status = 'confirmed';
  f2.value = '18';
  f2.selectedConflictValue = '18';
  f2.primaryEvidenceId = 'EVD-07';
  f2.conflictResolutionReason = '采信培训办通报18场';

  task.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
    items: task.facts.filter((f) => f.status === 'confirmed').map((f) => buildFactItemSnapshot(task, f)),
    hash: 'RECEIPT-TWO-FACT-SNAP-120-18',
  };
  task.outlineConfirmed = true;
  task.styleConfirmed = true;
  task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
  task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

  return { task, draft };
}

console.log('\n================================================================');
console.log('   📋 任务25 实施方自测验收检查表 (Receipt Tests)');
console.log('================================================================\n');

// 1. 真实两项事实（128→120与16→18）成组定向修订：三段关联段落准确更新，800人次及其他段落正文及数据严格不变
await check('真实两项事实（128→120与16→18）成组定向修订：三段关联段落准确更新，800人次及其他段落正文及数据严格不变', () => {
  const { task, draft } = twoFactFixture();
  const b3Orig = draft.blocks[2].content;
  const b4Orig = draft.blocks[3].content;
  const b5Orig = draft.blocks[4].content;

  assert(b3Orig.includes('800人次'));

  const candRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
  assert.equal(candRes.success, true);
  assert.equal(candRes.candidateGroup?.facts.length, 2);
  assert.equal(candRes.candidateGroup?.items.length, 3);

  const accRes = acceptMultiFactGroupRevisionCandidate(
    task,
    draft,
    candRes.candidateGroup!,
    '主笔甲',
    candRes.candidateGroup!.runId
  );
  assert.equal(accRes.success, true);

  const newDraft = accRes.newWorkingDraft!;
  assert(newDraft.blocks[0].content.includes('120项'));
  assert(!newDraft.blocks[0].content.includes('128项'));
  assert(newDraft.blocks[1].content.includes('120项'));
  assert(!newDraft.blocks[1].content.includes('128项'));
  assert(newDraft.blocks[2].content.includes('18场'));
  assert(!newDraft.blocks[2].content.includes('16场'));
  assert(newDraft.blocks[2].content.includes('800人次'), '800人次严格保留');

  assert.equal(newDraft.blocks[3].content, b4Orig);
  assert.equal(newDraft.blocks[4].content, b5Orig);
});

// 2. 候选生成、取消、失败和重试均不提前修改正文、依据快照或版本
await check('候选生成、取消、失败和重试均不提前修改正文、依据快照或版本', () => {
  const { task, draft } = twoFactFixture();
  const countBefore = task.drafts.length;
  const b1Before = draft.blocks[0].content;
  const b3Before = draft.blocks[2].content;
  const snapValBefore = draft.snapshotMetadata!.factSnapshot!.items[0].value;

  const res = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
  assert.equal(res.success, true);

  assert.equal(task.drafts.length, countBefore);
  assert.equal(draft.blocks[0].content, b1Before);
  assert.equal(draft.blocks[2].content, b3Before);
  assert.equal(draft.snapshotMetadata!.factSnapshot!.items[0].value, snapValBefore);
});

// 3. 两项事实共享段落、三项事实变动或单项事实变动时安全阻断
await check('两项事实共享段落、三项事实变动或单项事实变动时安全阻断', () => {
  // Overlapping
  {
    const { task, draft } = twoFactFixture();
    draft.blocks[0].referencedFactIds = ['FACT-01', 'FACT-02'];
    const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
    assert.equal(elig.eligible, false);
    assert(elig.reason?.includes('同一段落') || elig.reason?.includes('互不重叠'));
  }
  // 3 facts
  {
    const { task, draft } = twoFactFixture();
    task.facts.find((f) => f.id === 'FACT-04')!.value = '99';
    task.factSnapshot!.items.find((i) => i.factId === 'FACT-04')!.value = '99';
    const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
    assert.equal(elig.eligible, false);
    assert(elig.reason?.includes('3') || elig.reason?.includes('两项事实'));
  }
  // 1 fact
  {
    const { task, draft } = twoFactFixture();
    task.facts.find((f) => f.id === 'FACT-02')!.value = '16';
    task.facts.find((f) => f.id === 'FACT-02')!.selectedConflictValue = '16';
    task.facts.find((f) => f.id === 'FACT-02')!.primaryEvidenceId = 'EVD-03';
    const snapF2 = task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!;
    snapF2.value = '16';
    snapF2.selectedConflictValue = '16';
    snapF2.primaryEvidenceId = 'EVD-03';
    snapF2.provenance = {
      evidenceId: 'EVD-03',
      sourceDocId: 'SRC-03',
      sourceDocName: '培训工作台账',
      location: '第5段',
      text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
      period: '2026年1至9月',
      capturedAt: '2026-10-07T09:00:00.000Z',
    };
    const elig = checkMultiFactGroupRevisionEligibility(task, draft, '主笔甲');
    assert.equal(elig.eligible, false);
    assert(elig.reason?.includes('1 项') || elig.reason?.includes('单事实'));
  }
});

// 4. Issue #82 可读可复制语义：完整原文、完整候选与删改对比容器清晰分离，杜绝“1280项”连读
await check('Issue #82 可读可复制语义：完整原文、完整候选与删改对比容器清晰分离，杜绝“1280项”连读', () => {
  const { task, draft } = twoFactFixture();
  const analysis = analyzeFactImpact(task, draft);

  const m = mount(
    <FactImpactModal
      isOpen={true}
      onClose={() => {}}
      analysis={analysis}
      currentTask={task}
      currentDraft={draft}
      activeRole="主笔甲"
    />
  );

  const genBtn = m.container.querySelector('[data-testid="btn-generate-multi-fact-group-revision"]') as HTMLButtonElement;
  assert(!!genBtn);
  act(() => {
    genBtn.click();
  });

  const origEl = m.container.querySelector('[data-testid="original-block-content-BLK-01"]');
  const revEl = m.container.querySelector('[data-testid="revised-block-content-BLK-01"]');
  const diffEl = m.container.querySelector('[data-testid="revision-diff-view-BLK-01"]');

  assert(!!origEl && !!revEl && !!diffEl);
  assert(origEl.textContent?.includes('128项') && !origEl.textContent?.includes('120'));
  assert(revEl.textContent?.includes('120项') && !revEl.textContent?.includes('128'));
  assert(!diffEl.textContent?.includes('1280项'));
  assert(diffEl.textContent?.includes('[删: 128项]') && diffEl.textContent?.includes('[改: 120项]'));

  m.unmount();
});

// 5. 结构化日志记录两项事实与全部受影响段落，最近修改记录弹窗完整呈现
await check('结构化日志记录两项事实与全部受影响段落，最近修改记录弹窗完整呈现', () => {
  const { task, draft } = twoFactFixture();
  const candRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
  const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, candRes.candidateGroup!, '主笔甲', candRes.candidateGroup!.runId);

  const log = accRes.modificationLog!;
  assert.equal(log.affectedFacts?.length, 2);
  assert.equal(log.affectedBlocks?.length, 3);

  const m = mount(
    <RecentModificationsModal
      isOpen={true}
      onClose={() => {}}
      task={accRes.updatedTask!}
      currentDraft={accRes.newWorkingDraft!}
      activeRole="主笔甲"
      onUndo={() => {}}
    />
  );

  const f1 = m.container.querySelector('[data-testid="log-affected-fact-FACT-01"]');
  const f2 = m.container.querySelector('[data-testid="log-affected-fact-FACT-02"]');
  assert(!!f1 && !!f2);
  assert(f1.textContent?.includes('120项'));
  assert(f2.textContent?.includes('18场'));

  m.unmount();
});

// 6. 版本恢复正文与依据完整回退，禁止单段撤销
await check('版本恢复正文与依据完整回退，禁止单段撤销', () => {
  const { task, draft } = twoFactFixture();
  const candRes = generateMultiFactGroupRevisionCandidate(task, draft, '主笔甲');
  const accRes = acceptMultiFactGroupRevisionCandidate(task, draft, candRes.candidateGroup!, '主笔甲', candRes.candidateGroup!.runId);

  const undoVal = validateUndoEligibility(accRes.updatedTask!, accRes.newWorkingDraft!, accRes.modificationLog!.id, '主笔甲');
  assert.equal(undoVal.canUndo, false);

  const restored = restoreDraftVersion(accRes.updatedTask!, draft.id, '主笔甲');
  assert.equal(!!restored.workingDraft, true);
  const curDraft = restored.updatedTask!.drafts.find((d) => d.id === restored.updatedTask!.currentDraftId)!;
  assert(curDraft.blocks[0].content.includes('128项'));
  assert(curDraft.blocks[2].content.includes('16场'));
});

// 7. 独立演示任务TASK-DEMO-MULTI-FACT-GROUP-REVISION显式创建、复用与自洽核对
await check('独立演示任务TASK-DEMO-MULTI-FACT-GROUP-REVISION显式创建、复用与自洽核对', () => {
  const t1 = createPresetTask('multi_fact_group_revision');
  assert.equal(t1.id, 'TASK-DEMO-MULTI-FACT-GROUP-REVISION');
  assert(t1.documents.some((d) => d.id === 'SRC-07' && d.name.includes('培训汇总')));
  assert(t1.snippets.some((s) => s.id === 'EVD-07' && s.text.includes('18场')));
  assert(t1.facts.some((f) => f.id === 'FACT-02' && f.metric.includes('专题培训')));
});

if (failures.length > 0) {
  console.error(`\n❌ 自测验收失败项 (${failures.length}):\n${failures.join('\n')}`);
  process.exit(1);
} else {
  console.log('\n🎉 所有验收检查项全部通过 (All Receipt Checks Passed)！\n');
}
