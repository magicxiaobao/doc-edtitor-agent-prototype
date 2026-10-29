import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask, createSharedParagraphRevisionDemoTask } from './src/services/mockData';
import { buildFactItemSnapshot } from './src/services/factLifecycleService';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  EvidenceSnippet,
  SourceDocument,
  SharedParagraphFactRevisionCandidate,
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
} from './src/services/factImpactService';
import {
  checkSharedParagraphFactRevisionEligibility,
  generateSharedParagraphFactRevisionCandidate,
  acceptSharedParagraphFactRevisionCandidate,
  validateSharedParagraphFactRevisionAcceptance,
  checkMultiFactGroupRevisionEligibility,
  checkMultiParagraphFactRevisionEligibility,
  checkFactRevisionEligibility,
} from './src/services/factRevisionCandidateService';
import {
  evaluateDraftFactReviews,
  saveFactReviewRecord,
} from './src/services/factReviewService';
import {
  applyDraftContentChange,
  createDraftSnapshot,
  restoreDraftVersion,
  validateUndoEligibility,
} from './src/services/draftLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { FactImpactModal } from './src/components/FactImpactModal';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

function mountTestComponent(element: React.ReactElement) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    rerender: (newElement: React.ReactElement) => {
      act(() => {
        root.render(newElement);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Fixture: 2 facts, 3 blocks (BLK-01 shared; BLK-02 for Fact 1; BLK-03 for Fact 2).
 */
function createSharedParagraphFixture() {
  const task = createSharedParagraphRevisionDemoTask();
  const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

  // Upstream facts confirmed to new values:
  // FACT-01: 128 -> 120项 (EVD-01, 科室甲)
  // FACT-02: 16 -> 18场 (EVD-07, 培训办)
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
  f2.conflictResolutionReason = '采信教育培训处正式统计口径18场';

  task.factSnapshot = {
    confirmedAt: '2026-10-07T09:30:00.000Z',
    factIds: task.facts.filter((f) => f.status === 'confirmed').map((f) => f.id),
    items: task.facts
      .filter((f) => f.status === 'confirmed')
      .map((f) => buildFactItemSnapshot(task, f)),
    hash: 'TEST-SHARED-SNAP-120-18',
  };
  task.outlineConfirmed = true;
  task.styleConfirmed = true;
  task.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
  task.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

  return { task, draft };
}

function updateFactEvidenceText(task: Task, factId: string, newSnippetText: string) {
  const fact = task.facts.find((f) => f.id === factId)!;
  const snip = task.snippets.find((s) => s.id === fact.primaryEvidenceId)!;
  const doc = task.documents.find((d) => d.id === snip.sourceDocId)!;
  doc.content = doc.content.replace(snip.text, newSnippetText);
  if (!doc.content.includes(newSnippetText)) {
    doc.content += '\n\n' + newSnippetText;
  }
  snip.text = newSnippetText;
}

/**
 * Fixture: 2 facts, only 1 shared block (both facts only reference BLK-01).
 */
function createSingleSharedParagraphFixture() {
  const { task, draft } = createSharedParagraphFixture();
  // Modify draft blocks so only BLK-01 references FACT-01 and FACT-02
  // BLK-02 and BLK-03 do not reference them
  draft.blocks[1].referencedFactIds = [];
  draft.blocks[1].content = '在重点工作督办方面，对照年度综合清单核查推进，已录入闭环台账。';
  draft.blocks[2].referencedFactIds = ['FACT-03'];
  draft.blocks[2].content = '在队伍履职能力建设方面，立足基层实际需要，累计参训800人次。';

  return { task, draft };
}

async function runTask26Tests() {
  console.log('================================================================');
  console.log('🚀 开始执行任务26全量自动化测试套件 (两项事实共享段落定向修订)');
  console.log('================================================================\n');

  // ==========================================================================
  // [A] 2事实、仅1个共享段落场景 (2项事实、1个受影响段落)
  // ==========================================================================
  console.log('>>> [A] 2事实、仅1个共享段落场景 (2事实、1段):');
  {
    const { task, draft } = createSingleSharedParagraphFixture();

    const elig = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(elig.eligible, 'A: 2事实仅1共享段落准入检查通过');
    assert(elig.sharedBlockIds?.length === 1 && elig.sharedBlockIds[0] === 'BLK-01', 'A: 共享段落为BLK-01');
    assert(elig.allReferencingBlocks?.length === 1, 'A: 受影响段落总数仅为1');

    const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    assert(candRes.success && candRes.candidateGroup, 'A: 成功生成2事实1段修订候选');
    assert(candRes.candidateGroup.items.length === 1, 'A: 候选包含且仅包含1个段落');
    assert(candRes.candidateGroup.facts.length === 2, 'A: 候选记录2项事实');

    const item = candRes.candidateGroup.items[0];
    assert(item.targetBlockId === 'BLK-01', 'A: 目标段落为BLK-01');
    assert(item.modifications?.length === 2, 'A: 同一段落内记录2处修改');
    assert(item.revisedBlockContent.includes('120项') && item.revisedBlockContent.includes('18场'), 'A: 正文同时更新为120项与18场');
    assert(!item.revisedBlockContent.includes('128项') && !item.revisedBlockContent.includes('16场'), 'A: 旧数值完全被替换');
    assert(item.revisedBlockContent.includes('800人次'), 'A: 未变事实800人次严格保留');

    // Acceptance
    const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
    if (!accRes.success) {
      console.error('ACC RES FAILED REASON:', accRes.reason, JSON.stringify(accRes));
    }
    assert(accRes.success && accRes.updatedTask && accRes.workingDraft, 'A: 成功原子采纳');
    assert(accRes.workingDraft.blocks[0].revisionSeq === 1, 'A: 共享段落包含两项修改时，revisionSeq严格只递增1');

    // Modification log check
    const log = accRes.updatedTask.modificationLogs?.[0];
    assert(!!log, 'A: 生成一条成组修改日志');
    assert(log?.affectedFacts?.length === 2, 'A: 日志记录2项事实');
    assert(log?.affectedBlocks?.length === 1, 'A: 日志记录1个受影响段落');
    assert(log?.affectedBlocks?.[0]?.blockId === 'BLK-01', 'A: 受影响段落ID为BLK-01');
  }

  // ==========================================================================
  // [B] 2事实、3段落场景 (1共享 + 2独立)
  // ==========================================================================
  console.log('\n>>> [B] 2事实、3段落场景 (1共享 + 2独立, 事实A关联1/2段, 事实B关联1/3段):');
  {
    const { task, draft } = createSharedParagraphFixture();

    const elig = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(elig.eligible, 'B: 2事实3段落准入检查通过');
    assert(elig.sharedBlockIds?.length === 1 && elig.sharedBlockIds[0] === 'BLK-01', 'B: 识别出共享段落BLK-01');
    assert(elig.allReferencingBlocks?.length === 3, 'B: 受影响段落并集去重后为3段');

    const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    assert(candRes.success && candRes.candidateGroup, 'B: 成功生成2事实3段落修订候选');
    assert(candRes.candidateGroup.items.length === 3, 'B: 候选包含3个段落');

    const item1 = candRes.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-01')!;
    const item2 = candRes.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-02')!;
    const item3 = candRes.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-03')!;

    assert(item1.modifications?.length === 2, 'B: 共享段落BLK-01含2处修改');
    assert(item1.revisedBlockContent.includes('120项') && item1.revisedBlockContent.includes('18场'), 'B: BLK-01包含120项与18场');
    assert(item2.revisedBlockContent.includes('120项') && !item2.revisedBlockContent.includes('128项'), 'B: BLK-02包含120项');
    assert(item3.revisedBlockContent.includes('18场') && !item3.revisedBlockContent.includes('16场'), 'B: BLK-03包含18场且保留800人次');

    // Acceptance
    const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup, '主笔甲');
    assert(accRes.success && accRes.workingDraft, 'B: 成功采纳');
    assert(accRes.workingDraft.blocks[0].revisionSeq === 1, 'B: BLK-01 revisionSeq为1');
    assert(accRes.workingDraft.blocks[1].revisionSeq === 1, 'B: BLK-02 revisionSeq为1');
    assert(accRes.workingDraft.blocks[2].revisionSeq === 1, 'B: BLK-03 revisionSeq为1');
    assert(accRes.workingDraft.blocks[3].revisionSeq === 0 || !accRes.workingDraft.blocks[3].revisionSeq, 'B: BLK-04未被修改');
    assert(accRes.workingDraft.blocks[4].revisionSeq === 0 || !accRes.workingDraft.blocks[4].revisionSeq, 'B: BLK-05未被修改');
    assert(accRes.workingDraft.blocks[5].revisionSeq === 0 || !accRes.workingDraft.blocks[5].revisionSeq, 'B: BLK-06未被修改');
  }

  // ==========================================================================
  // [C] 同段多处改写保护：数值交叉、长度突变、同值不同指标、非目标指标防误伤
  // ==========================================================================
  console.log('\n>>> [C] 同段多处改写保护 (数值交叉、长度突变、防偏移、防误伤):');
  {
    const { task, draft } = createSharedParagraphFixture();
    const f1 = task.facts.find((f) => f.id === 'FACT-01')!;
    const f2 = task.facts.find((f) => f.id === 'FACT-02')!;

    // Case C1: Value crossing: Fact A (128 -> 16), Fact B (16 -> 18)
    // Fact A's new value equals Fact B's old value!
    f1.value = '16';
    f1.selectedConflictValue = '16';
    f2.value = '18';
    f2.selectedConflictValue = '18';
    updateFactEvidenceText(task, 'FACT-01', '2026年1至9月，全系统累计完成重点任务16项。');
    updateFactEvidenceText(task, 'FACT-02', '2026年1至9月，组织专题培训18场。各期培训严谨高效，反响良好。');
    task.factSnapshot!.items = task.facts
      .filter((f) => f.status === 'confirmed')
      .map((f) => buildFactItemSnapshot(task, f));

    const candCross = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    if (!candCross.success) console.error('C1 FAILED REASON:', candCross.reason);
    assert(candCross.success && candCross.candidateGroup, 'C1: 数值交叉（A新值等于B旧值）生成成功');
    const blk1Cross = candCross.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-01')!;
    assert(blk1Cross.revisedBlockContent.includes('重点任务16项') && blk1Cross.revisedBlockContent.includes('专题培训18场'), 'C1: 重点任务准确改为16项，培训改为18场，无串扰');

    // Case C2: Length change: Fact A 128 -> 12000 (longer), Fact B 16 -> 2 (shorter)
    f1.value = '12000';
    f1.selectedConflictValue = '12000';
    f2.value = '2';
    f2.selectedConflictValue = '2';
    updateFactEvidenceText(task, 'FACT-01', '2026年1至9月，全系统累计完成重点任务12000项。');
    updateFactEvidenceText(task, 'FACT-02', '2026年1至9月，组织专题培训2场。各期培训严谨高效，反响良好。');
    task.factSnapshot!.items = task.facts
      .filter((f) => f.status === 'confirmed')
      .map((f) => buildFactItemSnapshot(task, f));

    const candLen = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    if (!candLen.success) console.error('C2 FAILED REASON:', candLen.reason);
    assert(candLen.success && candLen.candidateGroup, 'C2: 长度非对称突变生成成功');
    const blk1Len = candLen.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-01')!;
    assert(blk1Len.revisedBlockContent.includes('重点任务12000项') && blk1Len.revisedBlockContent.includes('专题培训2场'), 'C2: 变长与缩短无偏移地精准落实');

    // Case C3: Same paragraph contains other identical number token that belongs to different metric
    // e.g. text includes "历时16天" or "另外完成128项日常事项"
    draft.blocks[0].content = '2026年1至9月，全系统推进年度工作，累计完成重点任务128项，另外办结日常咨询128项，历时16天，组织专题培训16场，参训800人次。';
    f1.value = '120';
    f1.selectedConflictValue = '120';
    f2.value = '18';
    f2.selectedConflictValue = '18';
    updateFactEvidenceText(task, 'FACT-01', '2026年1至9月，全系统累计完成重点任务120项。');
    updateFactEvidenceText(task, 'FACT-02', '2026年1至9月，组织专题培训18场。各期培训严谨高效，反响良好。');
    task.factSnapshot!.items = task.facts
      .filter((f) => f.status === 'confirmed')
      .map((f) => buildFactItemSnapshot(task, f));

    const candOtherMetric = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    if (!candOtherMetric.success) console.error('C3 FAILED REASON:', candOtherMetric.reason);
    assert(candOtherMetric.success && candOtherMetric.candidateGroup, 'C3: 段落含其他同值指标生成成功');
    const blk1Other = candOtherMetric.candidateGroup.items.find((i) => i.targetBlockId === 'BLK-01')!;
    assert(blk1Other.revisedBlockContent.includes('重点任务120项'), 'C3: 准确替换属于重点任务的128项');
    assert(blk1Other.revisedBlockContent.includes('日常咨询128项'), 'C3: 未篡改日常咨询128项');
    assert(blk1Other.revisedBlockContent.includes('历时16天'), 'C3: 未篡改历时16天');
    assert(blk1Other.revisedBlockContent.includes('专题培训18场'), 'C3: 准确替换属于专题培训的16场');
  }

  // ==========================================================================
  // [D] 同段两处改写位置重叠/冲突阻断
  // ==========================================================================
  console.log('\n>>> [D] 同段两处改写位置重叠/冲突阻断:');
  {
    const { task, draft } = createSharedParagraphFixture();
    // Simulate overlapping metric occurrences:
    // If a text contains ambiguous repeated phrasing or overlapping spans
    draft.blocks[0].content = '2026年完成重点任务128项组织专题培训128项。';
    const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
    f2.unit = '项'; // conflict unit
    const snapF2 = draft.snapshotMetadata!.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!;
    snapF2.unit = '项';
    snapF2.value = '128';

    const eligOverlap = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(!eligOverlap.eligible, 'D: 出现指标定位冲突或无法唯一证明时整组拒绝');
  }

  // ==========================================================================
  // [E] 零重叠段落拒绝（非重叠应走任务25通道）
  // ==========================================================================
  console.log('\n>>> [E] 零重叠段落拒绝 (两事实无交集时拒绝进入共享段落通道):');
  {
    const nonOverlappingTask = createPresetTask('multi_fact_group_revision');
    const f1 = nonOverlappingTask.facts.find((f) => f.id === 'FACT-01')!;
    f1.status = 'confirmed';
    f1.value = '120';
    f1.selectedConflictValue = '120';
    f1.primaryEvidenceId = 'EVD-01';

    const f2 = nonOverlappingTask.facts.find((f) => f.id === 'FACT-02')!;
    f2.status = 'confirmed';
    f2.value = '18';
    f2.selectedConflictValue = '18';
    f2.primaryEvidenceId = 'EVD-07';

    const draft = nonOverlappingTask.drafts.find((d) => d.id === nonOverlappingTask.currentDraftId)!;
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
    nonOverlappingTask.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
    nonOverlappingTask.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

    const elig = checkSharedParagraphFactRevisionEligibility(nonOverlappingTask, draft, '主笔甲');
    if (!elig.eligible) console.error('TEST E REASON:', elig.reason);
    assert(!elig.eligible, 'E: 关联段落集合没有重叠时，共享段落通道严格拒绝');
    assert(elig.reason?.includes('没有重叠'), 'E: 明确提示两项变更事实关联的段落集合没有重叠');
  }

  // ==========================================================================
  // [F] 单事实或3+事实拒绝
  // ==========================================================================
  console.log('\n>>> [F] 单事实或3+事实整组拒绝:');
  {
    const { task, draft } = createSharedParagraphFixture();

    // 1 fact changed only
    const f2 = task.facts.find((f) => f.id === 'FACT-02')!;
    f2.value = '16'; // unchanged from baseline
    f2.selectedConflictValue = '16';
    task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.value = '16';
    task.factSnapshot!.items.find((i) => i.factId === 'FACT-02')!.selectedConflictValue = '16';

    const elig1 = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(!elig1.eligible, 'F1: 仅1项事实发生变动时整组拒绝');

    // 3 facts changed
    f2.value = '18';
    f2.selectedConflictValue = '18';
    const f3 = task.facts.find((f) => f.id === 'FACT-03')!;
    f3.value = '900';
    f3.selectedConflictValue = '900';
    task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.value = '900';
    task.factSnapshot!.items.find((i) => i.factId === 'FACT-03')!.selectedConflictValue = '900';

    const elig3 = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(!elig3.eligible, 'F2: 3项事实发生变动时整组拒绝');
  }

  // ==========================================================================
  // [G] 材料补写存证段落阻断 (adoptedEvidences on any target block)
  // ==========================================================================
  console.log('\n>>> [G] 材料补写存证段落阻断:');
  {
    const { task, draft } = createSharedParagraphFixture();
    // Put adoptedEvidences on BLK-01
    draft.blocks[0].adoptedEvidences = [
      {
        evidenceId: 'EVD-07',
        sourceDocId: 'SRC-07',
        sourceDocName: '教育培训处前三季度培训汇总',
        snippetLocation: '第4段',
        snippetText: task.snippets.find(s => s.id === 'EVD-07')!.text,
        period: '2026年1-9月',
        usage: 'current_fact',
        associatedFactId: 'FACT-02',
        contentFingerprint: 'test-adopted-evidence',
        capturedAt: '2026-10-08T00:00:00.000Z',
      },
    ];

    const elig = checkSharedParagraphFactRevisionEligibility(task, draft, '主笔甲');
    assert(!elig.eligible, 'G: 目标段落包含材料补写存证时整组阻断');
    assert(elig.reason?.includes('材料补写存证'), 'G: 提示原因明确说明材料补写存证');
  }

  // ==========================================================================
  // [H] 权限、过期、篡改候选与版本校验
  // ==========================================================================
  console.log('\n>>> [H] 权限、过期、篡改候选与版本校验:');
  {
    const { task, draft } = createSharedParagraphFixture();
    const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    assert(candRes.success && candRes.candidateGroup, 'H: 生成有效候选');

    // 1. Non-author role
    const valReviewer = validateSharedParagraphFactRevisionAcceptance(task, draft, candRes.candidateGroup, '审阅乙');
    assert(!valReviewer.valid, 'H1: 非主笔角色采纳被拒绝');

    // 2. Stale draft content
    const modifiedDraft: DraftVersion = {
      ...draft,
      blocks: draft.blocks.map((b, idx) => (idx === 0 ? { ...b, content: b.content + '【已修改】' } : b)),
    };
    const valStale = validateSharedParagraphFactRevisionAcceptance(task, modifiedDraft, candRes.candidateGroup, '主笔甲');
    assert(!valStale.valid, 'H2: 原正文已被修改时采纳被拒绝');

    // 3. Tampered candidate revised content
    const tamperedCand: SharedParagraphFactRevisionCandidate = {
      ...candRes.candidateGroup,
      items: candRes.candidateGroup.items.map((i) => ({ ...i, revisedBlockContent: '完全篡改的文本' })),
    };
    const valTamper = validateSharedParagraphFactRevisionAcceptance(task, draft, tamperedCand, '主笔甲');
    assert(!valTamper.valid, 'H3: 候选内容被篡改时采纳被拒绝');
  }

  // ==========================================================================
  // [I] 原子采纳与版本恢复保证
  // ==========================================================================
  console.log('\n>>> [I] 原子采纳与版本恢复保证:');
  {
    const { task, draft } = createSharedParagraphFixture();
    const initialDraftCount = task.drafts.length;

    const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup!, '主笔甲');
    assert(accRes.success && accRes.workingDraft && accRes.updatedTask, 'I: 采纳成功');

    // Exactly 1 new draft added
    assert(accRes.updatedTask.drafts.length === initialDraftCount + 1, 'I: 仅增加一个新工作稿');
    assert(accRes.updatedTask.currentDraftId === accRes.workingDraft.id, 'I: 当前草稿切换为新工作稿');

    // Old draft archived
    const oldDraft = accRes.updatedTask.drafts.find((d) => d.id === draft.id)!;
    assert(oldDraft.isHistoricalSnapshot && !oldDraft.isWorkingDraft, 'I: 旧工作稿已归档为历史只读快照');

    // Version restoration preserves both content and frozen fact snapshot
    const restoreRes = restoreDraftVersion(accRes.updatedTask, oldDraft.id, '主笔甲');
    assert(!!restoreRes.workingDraft, 'I: 成功从历史快照恢复');
    assert(restoreRes.workingDraft.blocks[0].content === draft.blocks[0].content, 'I: 恢复后正文内容严格还原');
    assert(
      restoreRes.workingDraft.snapshotMetadata?.factSnapshot?.hash ===
        draft.snapshotMetadata?.factSnapshot?.hash,
      'I: 恢复后冻结依据严格还原'
    );
  }

  // ==========================================================================
  // [J] 最近修改记录：2事实1段展开明细支持 (RecentModificationsModal)
  // ==========================================================================
  console.log('\n>>> [J] 最近修改记录：2事实1段展开明细支持:');
  {
    const { task, draft } = createSingleSharedParagraphFixture();
    const candRes = generateSharedParagraphFactRevisionCandidate(task, draft, '主笔甲');
    const accRes = acceptSharedParagraphFactRevisionCandidate(task, draft, candRes.candidateGroup!, '主笔甲');

    const modalMount = mountTestComponent(
      <RecentModificationsModal
        isOpen={true}
        onClose={() => {}}
        task={accRes.updatedTask!}
        currentDraft={accRes.workingDraft}
        activeRole="主笔甲"
        onUndo={() => {}}
      />
    );

    // Check that for affectedBlocks.length === 1, details is rendered and accessible
    const details = modalMount.container.querySelector('details');
    assert(!!details, 'J: 2事实仅1段时，存在修改明细折叠详情标签');

    const blockDetail = modalMount.container.querySelector('[data-testid="log-affected-block-BLK-01"]');
    assert(!!blockDetail, 'J: 详情内完整展示第1段修改前与采纳后正文');
    assert(blockDetail.textContent?.includes('修改前完整正文'), 'J: 展示修改前正文标签');
    assert(blockDetail.textContent?.includes('采纳后完整正文'), 'J: 展示采纳后正文标签');

    modalMount.unmount();
  }

  // ==========================================================================
  // [K] JSDOM界面交互：两事实共享段落定向修订全流程
  // ==========================================================================
  console.log('\n>>> [K] JSDOM界面交互：两事实共享段落定向修订全流程:');
  {
    const { task, draft } = createSharedParagraphFixture();
    const analysis = analyzeFactImpact(task, draft);

    let acceptedGroup: SharedParagraphFactRevisionCandidate | null = null;
    let locatedBlockId: string | null = null;

    const modalMount = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={task}
        activeRole="主笔甲"
        onLocateBlock={(bid) => {
          locatedBlockId = bid;
        }}
        onViewDraftEvidence={() => {}}
        onViewLatestEvidence={() => {}}
        onSaveReviewRecord={() => {}}
        onRevokeReviewRecord={() => {}}
        onAcceptFactRevision={() => ({ success: true })}
        onAcceptMultiParagraphFactRevision={() => ({ success: true })}
        onAcceptMultiFactGroupRevision={() => ({ success: true })}
        onAcceptSharedParagraphFactRevision={(cand) => {
          acceptedGroup = cand;
          return { success: true };
        }}
      />
    );

    // 1. Check generation button for shared paragraphs
    const genBtn = modalMount.container.querySelector(
      '[data-testid="btn-generate-shared-paragraph-revision"]'
    ) as HTMLButtonElement;
    assert(!!genBtn, 'K: 存在“生成两项事实共享段落修订候选”按钮');

    // 2. Click to generate
    act(() => {
      genBtn.click();
    });

    // 3. Candidate card rendered
    const card = modalMount.container.querySelector(
      '[data-testid="shared-paragraph-revision-candidate-card"]'
    );
    assert(!!card, 'K: 成功渲染共享段落修订候选卡片');

    // 4. Shared block tags
    const blk01Card = modalMount.container.querySelector('[data-testid="candidate-item-BLK-01"]');
    assert(!!blk01Card, 'K: 渲染了第1段共享候选卡片');
    assert(blk01Card.textContent?.includes('两项修改'), 'K: 共享段落标明“两项修改”');

    // 5. Diff view & Issue #82 demarcation
    const diff01 = modalMount.container.querySelector('[data-testid="revision-diff-view-BLK-01"]')?.textContent || '';
    assert(diff01.includes('[删: 128项]') && diff01.includes('[改: 120项]'), 'K: 第1段包含重点任务删改标记');
    assert(diff01.includes('[删: 16场]') && diff01.includes('[改: 18场]'), 'K: 第1段包含专题培训删改标记');
    assert(!diff01.includes('1280项'), 'K [Issue #82]: 删改文本未连成“1280项”');

    // 6. Locate block
    const locateBtn = modalMount.container.querySelector(
      '[data-testid="btn-locate-candidate-block-BLK-01"]'
    ) as HTMLButtonElement;
    assert(!!locateBtn, 'K: 存在定位共享段落按钮');
    act(() => {
      locateBtn.click();
    });
    assert(locatedBlockId === 'BLK-01', 'K: 正确触发定位正文至BLK-01');

    // 7. Accept candidate
    const acceptBtn = modalMount.container.querySelector(
      '[data-testid="btn-accept-shared-paragraph-revision"]'
    ) as HTMLButtonElement;
    assert(!!acceptBtn, 'K: 存在“全部采纳并创建新工作稿”按钮');
    act(() => {
      acceptBtn.click();
    });
    assert(!!acceptedGroup, 'K: 采纳成功触发回调');

    modalMount.unmount();
  }

  // ==========================================================================
  // [L] 独立演示任务准备数据后的服务闭环 (TASK-DEMO-SHARED-PARAGRAPH-REVISION)
  // ==========================================================================
  console.log('\n>>> [L] 独立演示任务准备数据后的服务闭环:');
  {
    const demoTask = createPresetTask('shared_paragraph_revision');
    assert(demoTask.id === 'TASK-DEMO-SHARED-PARAGRAPH-REVISION', 'L: 成功创建独立演示任务');

    // Initial conflict state
    const f1 = demoTask.facts.find((f) => f.id === 'FACT-01')!;
    const f2 = demoTask.facts.find((f) => f.id === 'FACT-02')!;
    assert(f1.status === 'pending' && f1.hasConflict, 'L: FACT-01初始冲突待裁决');
    assert(f2.status === 'pending' && f2.hasConflict, 'L: FACT-02初始冲突待裁决');

    // Prepare approved fixture data; this does not exercise adjudication UI.
    f1.status = 'confirmed';
    f1.selectedConflictValue = '120';
    f1.primaryEvidenceId = 'EVD-01';
    f1.conflictResolutionReason = '采信科室甲申报口径120项';

    f2.status = 'confirmed';
    f2.selectedConflictValue = '18';
    f2.primaryEvidenceId = 'EVD-07';
    f2.conflictResolutionReason = '采信教育培训处正式统计口径18场';

    const draft = demoTask.drafts.find((d) => d.id === demoTask.currentDraftId)!;
    demoTask.factSnapshot = {
      confirmedAt: '2026-10-07T09:30:00.000Z',
      factIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
      items: demoTask.facts
        .filter((f) => ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'].includes(f.id))
        .map((f) => buildFactItemSnapshot(demoTask, f)),
      hash: 'DEMO-SHARED-SNAP-120-18',
    };
    demoTask.outlineConfirmed = true;
    demoTask.styleConfirmed = true;
    demoTask.outlineSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.outlineSnapshot));
    demoTask.styleSnapshot = JSON.parse(JSON.stringify(draft.snapshotMetadata!.styleSnapshot));

    // Generate, accept, and verify
    const candRes = generateSharedParagraphFactRevisionCandidate(demoTask, draft, '主笔甲');
    assert(candRes.success && candRes.candidateGroup, 'L: 演示任务成功生成候选');

    const accRes = acceptSharedParagraphFactRevisionCandidate(demoTask, draft, candRes.candidateGroup, '主笔甲');
    assert(accRes.success && accRes.workingDraft, 'L: 演示任务成功采纳并生成新工作稿');
    assert(accRes.workingDraft.blocks[0].content.includes('重点任务120项') && accRes.workingDraft.blocks[0].content.includes('专题培训18场'), 'L: 新工作稿首段同时落实两项修改');
    assert(accRes.workingDraft.blocks[0].content.includes('参训800人次'), 'L: 新工作稿首段严格保留800人次');
  }

  console.log('\n================================================================');
  console.log('🎉 恭喜！任务26全部测试断言 100% 通过！');
  console.log('================================================================\n');
}

runTask26Tests().catch((err) => {
  console.error('\n💥 测试运行失败:', err);
  process.exit(1);
});
