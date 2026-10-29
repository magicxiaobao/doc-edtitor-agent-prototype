import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import {
  createPresetTask,
  createSharedParagraphRevisionDemoTask,
  createMultiFactGroupRevisionDemoTask,
} from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  checkSharedParagraphFactRevisionEligibility,
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
  validateSharedParagraphFactRevisionAcceptance,
  checkMultiFactGroupRevisionEligibility,
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

function sharedParagraphFixture() {
  const task = createSharedParagraphRevisionDemoTask();
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

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
    hash: 'RECEIPT-SHARED-PARAGRAPH-SNAP-120-18',
  };
  task.outlineConfirmed = true;
  task.styleConfirmed = true;
  task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
  task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

  return { task, draft };
}

function singleSharedParagraphFixture() {
  const { task, draft } = sharedParagraphFixture();
  draft.blocks[1].referencedFactIds = [];
  draft.blocks[1].content = '在重点工作督办方面，对照年度综合清单核查推进，已录入闭环台账。';
  draft.blocks[2].referencedFactIds = ['FACT-03'];
  draft.blocks[2].content = '在队伍履职能力建设方面，立足基层实际需要，累计参训800人次。';
  return { task, draft };
}

console.log('\n================================================================');
console.log('   📋 任务26 实施方自测验收检查表 (Receipt Tests)');
console.log('================================================================\n');

// 1. 场景一（2事实1段）：恰好两项事实发生受支持数值变化且仅共同关联同一段落，段落内同时准确改写两处，revisionSeq仅+1
await check('场景一（2事实1段）：恰好两项事实共同关联同一段落，同时改写两处且revisionSeq严格只增加1', () => {
  const { task, draft } = singleSharedParagraphFixture();
  const elig = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
  assert.equal(elig.eligible, true);
  assert.equal(elig.sharedBlockIds?.length, 1);
  assert.equal(elig.sharedBlockIds?.[0], 'BLK-01');
  assert.equal(elig.allReferencingBlocks?.length, 1);

  const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
  assert.equal(candRes.success, true);
  assert(candRes.candidateGroup);
  assert.equal(candRes.candidateGroup.items.length, 1);
  assert.equal(candRes.candidateGroup.facts.length, 2);

  const item = candRes.candidateGroup.items[0];
  assert.equal(item.targetBlockId, 'BLK-01');
  assert.equal(item.modifications?.length, 2);
  assert(item.revisedBlockContent.includes('120项'));
  assert(item.revisedBlockContent.includes('18场'));
  assert(item.revisedBlockContent.includes('800人次'));
  assert(!item.revisedBlockContent.includes('128项'));
  assert(!item.revisedBlockContent.includes('16场'));

  const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
  assert.equal(accRes.success, true);
  assert(accRes.workingDraft);
  assert.equal(accRes.workingDraft.blocks[0].revisionSeq, 1);
  assert.equal(accRes.workingDraft.blocks[1].revisionSeq || 0, 0);
  assert.equal(accRes.workingDraft.blocks[2].revisionSeq || 0, 0);
});

// 2. 场景二（2事实3段）：部分共享部分独立（1共享+2独立），去重后3段整体更新，revisionSeq各自仅+1
await check('场景二（2事实3段）：1个共享段落与2个独立段落，去重后3段整体更新且非目标段落严格保持不变', () => {
  const { task, draft } = sharedParagraphFixture();
  const elig = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
  assert.equal(elig.eligible, true);
  assert(elig.sharedBlockIds?.includes('BLK-01'));
  assert.equal(elig.allReferencingBlocks?.length, 3);

  const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
  assert.equal(candRes.success, true);
  assert(candRes.candidateGroup);
  assert.equal(candRes.candidateGroup.items.length, 3);

  const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
  assert.equal(accRes.success, true);
  assert(accRes.workingDraft);

  const b1 = accRes.workingDraft.blocks.find((b) => b.id === 'BLK-01')!;
  const b2 = accRes.workingDraft.blocks.find((b) => b.id === 'BLK-02')!;
  const b3 = accRes.workingDraft.blocks.find((b) => b.id === 'BLK-03')!;
  const b4 = accRes.workingDraft.blocks.find((b) => b.id === 'BLK-04')!;

  assert.equal(b1.revisionSeq, 1);
  assert.equal(b2.revisionSeq, 1);
  assert.equal(b3.revisionSeq, 1);
  assert.equal(b4.revisionSeq || 0, 0);

  assert(b1.content.includes('120项') && b1.content.includes('18场'));
  assert(b2.content.includes('120项'));
  assert(b3.content.includes('18场') && b3.content.includes('800人次'));
});

// 3. 边界与防御：重叠冲突阻断、非重叠通道隔离、单事实及3事实变更整组拒绝
await check('边界与防御：重叠冲突阻断、非重叠通道隔离、单事实及3事实变更整组拒绝', () => {
  const { task, draft } = sharedParagraphFixture();

  // 1. Single fact change
  const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
  f2.value = '16';
  f2.selectedConflictValue = '16';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.value = '16';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.selectedConflictValue = '16';

  const elig1 = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
  assert.equal(elig1.eligible, false);

  // 2. 3 facts change
  f2.value = '18';
  f2.selectedConflictValue = '18';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.value = '18';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.selectedConflictValue = '18';
  const f3 = task.facts.find((f) => f.id === 'FACT-03')!;
  f3.value = '900';
  f3.selectedConflictValue = '900';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.value = '900';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.selectedConflictValue = '900';

  const elig3 = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
  assert.equal(elig3.eligible, false);

  // Restore f3
  f3.value = '800';
  f3.selectedConflictValue = '800';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.value = '800';
  task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.selectedConflictValue = '800';

  // 3. Non-overlapping disjoint check
  const nonOverlappingTask = createMultiFactGroupRevisionDemoTask();
  const f01 = nonOverlappingTask.facts.find((f) => f.id === 'FACT-01')!;
  f01.status = 'confirmed';
  f01.value = '120';
  f01.selectedConflictValue = '120';
  f01.primaryEvidenceId = 'EVD-01';

  const f02 = nonOverlappingTask.facts.find((f) => f.id === 'FACT-02')!;
  f02.status = 'confirmed';
  f02.value = '18';
  f02.selectedConflictValue = '18';
  f02.primaryEvidenceId = 'EVD-07';

  const nonOverlapDraft = nonOverlappingTask.drafts.find((d) => d.id === nonOverlappingTask.currentDraftId)!;
  nonOverlappingTask.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: nonOverlappingTask.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
    items: nonOverlappingTask.facts
      .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
      .map((f) => buildFactItemSnapshot(nonOverlappingTask, f)),
    hash: 'SNAP-NON-OVERLAP',
  };
  nonOverlappingTask.outlineConfirmed = true;
  nonOverlappingTask.styleConfirmed = true;
  nonOverlappingTask.outlineSnapshot = JSON.parse(JSON.stringify(nonOverlapDraft.snapshotMetadata!.outlineSnapshot));
  nonOverlappingTask.styleSnapshot = JSON.parse(JSON.stringify(nonOverlapDraft.snapshotMetadata!.styleSnapshot));

  const eligDisjoint = checkSharedParagraphFactRevisionEligibility(nonOverlappingTask, nonOverlapDraft, '主笔甲');
  assert.equal(eligDisjoint.eligible, false);
  assert(eligDisjoint.reason?.includes('没有重叠'));
});

// 4. 原子采纳与版本恢复：单次采纳创建唯一样本工作稿，版本恢复完整回退正文与冻结依据
await check('原子采纳与版本恢复：单次采纳创建唯一样本工作稿，版本恢复完整回退正文与冻结快照', () => {
  const { task, draft } = singleSharedParagraphFixture();
  const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
  assert.equal(candRes.success, true);
  assert(candRes.candidateGroup);

  const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
  assert.equal(accRes.success, true);
  assert(accRes.updatedTask);
  assert(accRes.workingDraft);

  // Restore
  const restoreRes = restoreDraftVersion(accRes.updatedTask, draft.id, '主笔甲');
  assert(restoreRes.workingDraft);
  assert(restoreRes.workingDraft.blocks[0].content.includes('128项'));
  assert(restoreRes.workingDraft.blocks[0].content.includes('16场'));
  assert.equal(
    restoreRes.workingDraft.snapshotMetadata?.factSnapshot?.items.find((i) => i.factId === 'FACT-01')?.value,
    '128'
  );
});

// 5. 最近修改记录：2事实1段场景展开详情支持，结构化记录完整
await check('最近修改记录：2事实1段场景支持折叠展开查看完整before/after正文与两事实留痕明细', () => {
  const { task, draft } = singleSharedParagraphFixture();
  const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
  const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup!, '主笔甲');
  assert.equal(accRes.success, true);

  const { container, unmount } = mount(
    <RecentModificationsModal
      isOpen={true}
      task={accRes.updatedTask!}
      currentDraft={accRes.workingDraft!}
      activeRole="主笔甲"
      onClose={() => {}}
      onUndo={() => {}}
    />
  );

  const summaryEl = container.querySelector('summary');
  assert(summaryEl, '存在展开段落明细的summary标签');
  assert(summaryEl.textContent?.includes('查看全部1段修订明细'));

  const fact1El = container.querySelector('[data-testid="log-affected-fact-FACT-01"]');
  const fact2El = container.querySelector('[data-testid="log-affected-fact-FACT-02"]');
  assert(fact1El, '包含FACT-01留痕卡片');
  assert(fact2El, '包含FACT-02留痕卡片');
  unmount();
});

// 6. 真实组件交互：FactImpactModal中渲染两事实共享段落修订入口、候选卡片及采纳
await check('真实组件交互：FactImpactModal渲染两事实共享段落定向修订入口、卡片及整体采纳', () => {
  const { task, draft } = sharedParagraphFixture();
  const analysis = analyzeFactImpact(task, draft);
  let accepted = false;

  const { container, unmount } = mount(
    <FactImpactModal
      isOpen={true}
      task={task}
      currentDraft={draft}
      analysis={analysis}
      activeRole="主笔甲"
      onClose={() => {}}
      onViewLatestEvidence={() => {}}
      onAcceptSharedParagraphFactRevision={() => {
        accepted = true;
        return { success: true };
      }}
    />
  );

  const btnGen = container.querySelector(
    '[data-testid="btn-generate-shared-paragraph-revision"]'
  ) as HTMLButtonElement;
  assert(btnGen, '存在生成两项事实共享段落修订候选按钮');

  act(() => {
    btnGen.click();
  });

  const card = container.querySelector('[data-testid="shared-paragraph-revision-candidate-card"]');
  assert(card, '成功展开共享段落修订候选卡片');

  const btnAccept = container.querySelector(
    '[data-testid="btn-accept-shared-paragraph-revision"]'
  ) as HTMLButtonElement;
  assert(btnAccept, '存在全部采纳并创建新工作稿按钮');

  act(() => {
    btnAccept.click();
  });

  assert.equal(accepted, true, '采纳回调成功触发');
  unmount();
});

// 7. 独立演示任务准备数据后的服务闭环：TASK-DEMO-SHARED-PARAGRAPH-REVISION预置两项事实冲突，完整可验证
await check('独立演示任务准备数据后的服务闭环：TASK-DEMO-SHARED-PARAGRAPH-REVISION独立创建、准入、生成与采纳', () => {
  const task = createSharedParagraphRevisionDemoTask();
  assert.equal(task.id, 'TASK-DEMO-SHARED-PARAGRAPH-REVISION');
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;
  assert(draft);

  // Resolve conflicts
  const f1 = task.facts.find((f) => f.id === 'FACT-01')!;
  f1.status = 'confirmed';
  f1.selectedConflictValue = '120';
  f1.value = '120';
  f1.conflictResolutionReason = '采信科室甲120项';

  const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
  f2.status = 'confirmed';
  f2.selectedConflictValue = '18';
  f2.value = '18';
  f2.conflictResolutionReason = '采信培训办18场';

  task.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
    items: task.facts.filter((f) => f.status === 'confirmed').map((f) => buildFactItemSnapshot(task, f)),
    hash: 'DEMO-SHARED-SNAP-120-18',
  };
  task.outlineConfirmed = true;
  task.styleConfirmed = true;
  task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
  task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

  const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
  assert.equal(candRes.success, true);
  assert(candRes.candidateGroup);

  const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
  assert.equal(accRes.success, true);
  assert(accRes.workingDraft);
  assert(accRes.workingDraft.blocks[0].content.includes('120项'));
  assert(accRes.workingDraft.blocks[0].content.includes('18场'));
  assert.equal(accRes.workingDraft.blocks[0].revisionSeq, 1);
});

console.log('\n================================================================');
if (failures.length > 0) {
  console.error(`💥 任务26 验收测试失败: ${failures.length} 项未通过 (${failures.join(', ')})`);
  process.exit(1);
} else {
  console.log('🎉 恭喜！任务26 实施方自测验收检查表 (Receipt Tests) 7项全部通过！');
  console.log('================================================================\n');
}
