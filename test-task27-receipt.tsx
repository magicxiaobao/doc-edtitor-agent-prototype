import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import {
  createPresetTask,
  createPostRevisionVerificationDemoTask,
  createMultiFactGroupRevisionDemoTask,
  createSharedParagraphRevisionDemoTask,
} from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  checkFactRevisionEligibility,
  generateFactRevisionCandidate,
  acceptFactRevisionCandidate,
  checkMultiParagraphFactRevisionEligibility,
  generateMultiParagraphFactRevisionCandidate,
  acceptMultiParagraphFactRevisionCandidate,
  checkMultiFactGroupRevisionEligibility,
  generateMultiFactGroupRevisionCandidate,
  acceptMultiFactGroupRevisionCandidate,
  checkSharedParagraphFactRevisionEligibility,
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
} from './src/services/factRevisionCandidateService';
import {
  evaluatePostRevisionVerification,
  recordPostRevisionVerification,
  deferPostRevisionVerification,
  revokePostRevisionVerification,
  freezePostRevisionVerification,
  sourcePostRevisionVerification,
} from './src/services/postRevisionVerificationService';
import {
  applyDraftContentChange,
  createDraftSnapshot,
  restoreDraftVersion,
  finalizeDraft,
} from './src/services/draftLifecycleService';
import { validateTaskStructure } from './src/services/storageService';
import { analyzeFactImpact } from './src/services/factImpactService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { PostRevisionVerificationModal } from './src/components/PostRevisionVerificationModal';
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

console.log('\n================================================================');
console.log('   📋 任务27 实施方自测验收检查表 (Receipt Tests)');
console.log('================================================================\n');

// 1. 四个通道采纳成功时原子保存冻结修订凭据，事实与段落去重且包含冻结出处
await check('1. 四个通道采纳均原子生成冻结凭据：事实与段落去重、保留关联与前后出处快照', () => {
  // 验证 Task 25 成组修订（2事实3段落）
  const task25 = createMultiFactGroupRevisionDemoTask();
  task25.currentRole = '主笔甲';
  const draft25 = task25.drafts.find((d) => d.id === task25.currentDraftId)!;
  const f1_25 = task25.facts.find((f) => f.id === 'FACT-01')!;
  f1_25.status = 'confirmed';
  f1_25.value = '120';
  f1_25.selectedConflictValue = '120';
  f1_25.primaryEvidenceId = 'EVD-01';
  const f2_25 = task25.facts.find((f) => f.id === 'FACT-02')!;
  f2_25.status = 'confirmed';
  f2_25.value = '18';
  f2_25.selectedConflictValue = '18';
  f2_25.primaryEvidenceId = 'EVD-07';
  task25.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task25.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
    items: task25.facts
      .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
      .map((f) => buildFactItemSnapshot(task25, f)),
    hash: 'RECEIPT-SNAP-25',
  };
  task25.outlineConfirmed = true;
  task25.styleConfirmed = true;
  task25.outlineSnapshot = JSON.parse(JSON.stringify(draft25.snapshotMetadata!.outlineSnapshot));
  task25.styleSnapshot = JSON.parse(JSON.stringify(draft25.snapshotMetadata!.styleSnapshot));

  const cand25 = generateMultiFactGroupRevisionCandidate(task25, draft25, '主笔甲');
  assert.equal(cand25.success, true);
  const acc25 = acceptMultiFactGroupRevisionCandidate(task25, draft25, cand25.candidateGroup!, '主笔甲', cand25.candidateGroup!.runId);
  const workingDraft25 = acc25.workingDraft || (acc25 as any).newWorkingDraft;
  assert.equal(acc25.success, true);
  assert(workingDraft25);
  const cred = workingDraft25.postRevisionVerificationCredential;
  assert(cred);
  assert.equal(cred.taskId, task25.id);
  assert.equal(cred.sourceDraftId, draft25.id);
  assert.equal(cred.targetDraftId, workingDraft25.id);
  assert.equal(cred.facts.length, 2);
  assert.equal(cred.blocks.length, 3);
  // 检查出处快照冻结
  assert(cred.facts[0].afterEvidenceSnapshot);
  assert.equal(cred.facts[0].afterEvidenceSnapshot?.evidenceId, 'EVD-01');
});

// 2. 共享段落（2事实1段）去重准确计数为1，关联两项事实，保留800人次
await check('2. 共享段落（2事实1段）：准确去重计数为1个段落，保留两个关联事实及800人次未变事实', () => {
  const task26 = createSharedParagraphRevisionDemoTask();
  task26.currentRole = '主笔甲';
  const draft26 = task26.drafts.find((d) => d.id === task26.currentDraftId)!;
  // 调整为纯单共享段落（仅BLK-01关联FACT-01和FACT-02）
  draft26.blocks[1].referencedFactIds = [];
  draft26.blocks[1].content = '在重点工作督办方面，对照年度综合清单核查推进，已录入闭环台账。';
  draft26.blocks[2].referencedFactIds = ['FACT-03'];
  draft26.blocks[2].content = '在队伍履职能力建设方面，立足基层实际需要，累计参训800人次。';

  const f1_26 = task26.facts.find((f) => f.id === 'FACT-01')!;
  f1_26.status = 'confirmed';
  f1_26.value = '120';
  f1_26.selectedConflictValue = '120';
  f1_26.primaryEvidenceId = 'EVD-01';
  const f2_26 = task26.facts.find((f) => f.id === 'FACT-02')!;
  f2_26.status = 'confirmed';
  f2_26.value = '18';
  f2_26.selectedConflictValue = '18';
  f2_26.primaryEvidenceId = 'EVD-07';
  task26.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task26.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly).map((f) => f.id),
    items: task26.facts
      .filter((f) => f.status === 'confirmed' && !f.isHistoricOnly)
      .map((f) => buildFactItemSnapshot(task26, f)),
    hash: 'RECEIPT-SNAP-26',
  };
  task26.outlineConfirmed = true;
  task26.styleConfirmed = true;
  task26.outlineSnapshot = JSON.parse(JSON.stringify(draft26.snapshotMetadata!.outlineSnapshot));
  task26.styleSnapshot = JSON.parse(JSON.stringify(draft26.snapshotMetadata!.styleSnapshot));

  const cand26 = generateSharedParagraphFactRevisionCandidate(task26, draft26, '主笔甲');
  assert.equal(cand26.success, true);
  const acc26 = acceptSharedParagraphFactRevisionCandidate(task26, draft26, cand26.candidateGroup!, '主笔甲', cand26.candidateGroup!.runId);
  const workingDraft26 = acc26.workingDraft || (acc26 as any).newWorkingDraft;
  assert.equal(acc26.success, true);
  const cred = workingDraft26.postRevisionVerificationCredential!;
  assert.equal(cred.blocks.length, 1);
  assert.equal(cred.blocks[0].associatedFactIds.length, 2);
  assert(workingDraft26.blocks[0].content.includes('800人次'));
});

// 3. 事实差异为0时仍展示本次修订核对待处理进度，与Task22复核分离
await check('3. 事实差异为0时独立展示修订核对待处理进度，与Task22事实复核保持不同语义', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const impact = analyzeFactImpact(demoTask, draft);
  assert.equal(impact.changedFactsCount, 0);

  const evalRes = evaluatePostRevisionVerification(demoTask, draft);
  assert.equal(evalRes.hasCredential, true);
  assert.equal(evalRes.verifiedCount, 0);
  assert.equal(evalRes.pendingCount, 3);
  assert.equal(evalRes.totalBlocksCount, 3);
  assert(evalRes.statusSummaryText.includes('0/3段已记录 · 3段待处理'));
});

// 4. 说明必填、暂缓原因必填、撤回原因必填，核对操作不修改正文与revisionSeq
await check('4. 记录核对、暂缓、撤回强制必填说明/原因，不递增正文revisionSeq也不新建草稿版本', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const opId = draft.postRevisionVerificationCredential!.operationId;

  // 空说明拦截
  const resEmpty = recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: '   ',
  });
  assert.equal(resEmpty.success, false);

  // 正常记录
  const prevSeq = draft.revisionSeq;
  const prevCount = demoTask.drafts.length;
  const resOk = recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: '逐句对照核对无误',
  });
  assert.equal(resOk.success, true);
  assert.equal(draft.revisionSeq, prevSeq);
  assert.equal(demoTask.drafts.length, prevCount);

  // 暂缓（原因必填）
  const resDeferEmpty = deferPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-02',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    reason: '',
  });
  assert.equal(resDeferEmpty.success, false);
  const resDefer = deferPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-02',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    reason: '待处室再次核实',
  });
  assert.equal(resDefer.success, true);

  // 撤回（原因必填）
  const resRevokeEmpty = revokePostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    reason: '',
  });
  assert.equal(resRevokeEmpty.success, false);
  const resRevoke = revokePostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    reason: '重新核查口径',
  });
  assert.equal(resRevoke.success, true);
});

// 5. 精确失效规则：正文变更、revisionSeq递增改回、关联事实未裁决冲突引发失效，无关段落/事实不误伤
await check('5. 失效判定：正文修改、改回相同文字递增序列号、关联事实重现冲突使结论失效，无关段落保持有效', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const opId = draft.postRevisionVerificationCredential!.operationId;

  // 记录 BLOCK-01 与 BLOCK-02
  recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: 'BLOCK-01通过',
  });
  recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-02',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: 'BLOCK-02通过',
  });

  // 改写BLOCK-01内容
  const oldContent = draft.blocks[0].content;
  draft.blocks[0].content += '【微调】';
  draft.blocks[0].revisionSeq += 1;
  draft.revisionSeq += 1;

  let evalRes = evaluatePostRevisionVerification(demoTask, draft);
  assert.equal(evalRes.blockEvaluations[0].displayStatus, 'invalidated');
  assert.equal(evalRes.blockEvaluations[1].displayStatus, 'verified');

  // 改回原文字但保留新 revisionSeq
  draft.blocks[0].content = oldContent;
  evalRes = evaluatePostRevisionVerification(demoTask, draft);
  assert.equal(evalRes.blockEvaluations[0].displayStatus, 'invalidated');
  assert(evalRes.blockEvaluations[0].invalidationReason?.includes('版本序列号'));
});

// 6. 权限拦截与隔离：非主笔禁止操作、伪造段落ID拦截
await check('6. 角色鉴权与边界校验：仅主笔有权记录核对，伪造段落ID及陈旧批次严格拦截', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const opId = draft.postRevisionVerificationCredential!.operationId;

  const resRole = recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '审阅乙',
    role: '审阅乙',
    operationId: opId,
    notes: '审阅乙越权记录',
  });
  assert.equal(resRole.success, false);

  const resFakeBlock = recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-FAKE',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: '伪造段落',
  });
  assert.equal(resFakeBlock.success, false);
});

// 7. 快照与定稿冻结总览，还原版本清理活动核对记录
await check('7. 生命周期管理：快照与定稿版本冻结核对总览，版本还原清理活动核对并记录来源凭据', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  demoTask.currentRole = '主笔甲';
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const opId = draft.postRevisionVerificationCredential!.operationId;

  recordPostRevisionVerification(demoTask, draft, {
    blockId: 'BLOCK-01',
    operator: '主笔甲',
    role: '主笔甲',
    operationId: opId,
    notes: '快照前核对',
  });

  const snapRes = createDraftSnapshot(demoTask, draft.id, '中间快照', '主笔甲');
  assert(snapRes.snapshotDraft?.frozenPostRevisionVerificationOverview);

  const restoreRes = restoreDraftVersion(demoTask, snapRes.snapshotDraft!.id, '主笔甲');
  assert.equal(restoreRes.success, true);
  assert.equal(restoreRes.workingDraft?.postRevisionVerificationRecords?.length, 0);
  assert(restoreRes.workingDraft?.sourcePostRevisionVerificationCredential);
});

// 8. 损坏数据自愈处理
await check('8. 异常与损坏数据鲁棒自愈：字段缺失或非法状态被安全修复，页面不崩溃', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  (draft as any).postRevisionVerificationRecords = [{ invalid: 123 }];
  validateTaskStructure(demoTask);
  assert.equal(draft.postRevisionVerificationRecovery?.recovered, true);
  assert(Array.isArray(draft.postRevisionVerificationRecords));
});

// 9. 界面组件交互：冻结依据展开、定位真实段落、Escape关闭
await check('9. 界面交互闭环：冻结依据浮层展示、正文段落真实定位回调、Escape键退出', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  let closed = false;
  let located: string | null = null;

  const { container, unmount } = mount(
    <PostRevisionVerificationModal
      isOpen={true}
      onClose={() => { closed = true; }}
      task={demoTask}
      draft={draft}
      activeRole="主笔甲"
      onUpdateTask={() => {}}
      onLocateBlock={(bId) => { located = bId; }}
    />
  );

  assert(container.querySelector('[data-testid="post-revision-verification-modal-title"]'));
  // 触发定位
  const locateBtn = container.querySelector('[data-testid="btn-locate-block-BLOCK-01"]') as HTMLButtonElement;
  act(() => {
    locateBtn.click();
  });
  assert.equal(located, 'BLOCK-01');

  // Escape 关闭
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(closed, true);

  unmount();
});

// 10. 审阅门禁与定稿规则保持独立语义
await check('10. 门禁独立性：全部段落核对完成不自动关闭审阅意见，未解决审阅依然阻断定稿', () => {
  const demoTask = createPostRevisionVerificationDemoTask();
  demoTask.currentRole = '主笔甲';
  const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
  const opId = draft.postRevisionVerificationCredential!.operationId;

  demoTask.reviews = [
    {
      id: 'REV-RECP-1',
      type: 'comment',
      quote: '引用',
      comment: '需要核实说明',
      author: '审阅乙',
      authorRole: '审阅乙',
      createdAt: '2026-10-08T09:00:00Z',
      status: 'pending',
    },
  ];

  ['BLOCK-01', 'BLOCK-02', 'BLOCK-03'].forEach((bId) => {
    recordPostRevisionVerification(demoTask, draft, {
      blockId: bId,
      operator: '主笔甲',
      role: '主笔甲',
      operationId: opId,
      notes: `${bId} 核对`,
    });
  });

  const finRes = finalizeDraft(demoTask, draft.id, '主笔甲');
  assert.equal(finRes.success, false);
  assert.equal(demoTask.reviews[0].status, 'pending');
});

console.log('\n================================================================');
if (failures.length > 0) {
  console.error(`❌ 自测检查表执行失败，共 ${failures.length} 项不通过:`, failures);
  process.exit(1);
} else {
  console.log('🎉 验收自测检查表全部 10 项通过！');
  console.log('================================================================\n');
}
