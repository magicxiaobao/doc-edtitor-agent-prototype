import {
  Task,
  DraftVersion,
  Fact,
  FactItemSnapshot,
  EvidenceSnippet,
  SourceDocument,
} from '../types';
import { findDraftFact } from './factLifecycleService';

export type FactDifferenceType =
  | 'value'           // 数值变化
  | 'unit'            // 单位变化
  | 'period'          // 统计期间变化
  | 'metric_scope'    // 统计口径变化
  | 'primary_evidence'// 主出处变更
  | 'status_pending'  // 当前撤销为待确认
  | 'status_excluded' // 当前已在任务中排除
  | 'status_gap'      // 当前标记为材料缺口
  | 'status_deleted'  // 任务中已删除此事实
  | 'conflict_unresolved' // 当前存在未裁决冲突
  | 'missing_baseline';   // 缺少快照冻结项，需人工核实

export interface FactDifferenceTag {
  type: FactDifferenceType;
  label: string;
  description?: string;
}

export interface ReferencingBlockInfo {
  blockId: string;
  blockOrder: number;
  sectionId: string;
  sectionTitle: string;
  contentExcerpt: string;
  viaMaterialSupplement: boolean;
}

export interface FactImpactItem {
  factId: string;
  metric: string;
  hasDifference: boolean;
  differenceTags: FactDifferenceTag[];
  diffCategorySummary: string; // e.g. "数值变化 · 统计口径变化"

  // Draft frozen snapshot values (baseline)
  draftSnapshotValue: string; // e.g. "128 项"
  draftPeriod: string;
  draftMetricScope: string;
  draftEvidenceId?: string;
  draftDocName: string;
  draftLocation: string;
  hasFrozenSnapshot: boolean;

  // Latest task fact values
  latestConfirmedValue: string; // e.g. "120 项" or "任务中已删除此事实"
  latestPeriod: string;
  latestMetricScope: string;
  latestEvidenceId?: string;
  latestDocName: string;
  latestLocation: string;
  latestStatus: 'confirmed' | 'pending' | 'excluded' | 'gap' | 'deleted';
  latestStatusLabel: string;
  hasConflict: boolean;
  unresolvedConflict: boolean;

  // Referencing blocks in current draft
  referencingBlocks: ReferencingBlockInfo[];
  affectedBlocksCount: number;

  // Raw references
  latestFact?: Fact;
  snapshotItem?: FactItemSnapshot;
}

export interface UnreferencedNewFactItem {
  factId: string;
  metric: string;
  value: string;
  unit: string;
  period: string;
  status: string;
  statusLabel: string;
}

export interface MaterialEvidenceScopeLimitation {
  unlinkedCount: number;
  blocksWithUnlinkedEvidence: { blockId: string; blockOrder: number }[];
  notice: string;
}

export interface FactImpactAnalysisResult {
  hasDraft: boolean;
  hasSnapshotBaseline: boolean;
  statusMessage: string;

  // Unique de-duplicated counts
  changedFactsCount: number;
  affectedBlocksCount: number;

  // Lists
  impactItems: FactImpactItem[];           // Changed facts only
  allReferencedItems: FactImpactItem[];     // All referenced facts (for inspector / diagnostics)
  missingBaselineFactIds: string[];        // References outside the approved snapshot; not proof of a change
  unreferencedNewFacts: UnreferencedNewFactItem[]; // Newly added facts not referenced in current draft

  // Material evidence scope limitation
  materialEvidenceScope?: MaterialEvidenceScopeLimitation;

  // Unique affected block IDs
  affectedBlockIds: string[];
}

/**
 * Pure service to analyze differences between the currently selected draft's
 * frozen fact snapshot and the task's latest facts, identifying affected blocks
 * strictly via Fact ID and Block ID references (never by string text guessing).
 */
export function analyzeFactImpact(
  task: Task,
  currentDraft: DraftVersion | undefined
): FactImpactAnalysisResult {
  // 1. Check if draft exists
  if (!currentDraft || !currentDraft.blocks || currentDraft.blocks.length === 0) {
    return {
      hasDraft: false,
      hasSnapshotBaseline: false,
      statusMessage: '尚无稿件可比较',
      changedFactsCount: 0,
      affectedBlocksCount: 0,
      impactItems: [],
      allReferencedItems: [],
      missingBaselineFactIds: [],
      unreferencedNewFacts: [],
      affectedBlockIds: [],
    };
  }

  const factSnapshot = currentDraft.snapshotMetadata?.factSnapshot;
  const snapshotItems = factSnapshot?.items || [];
  const hasSnapshotBaseline = Boolean(factSnapshot && Array.isArray(factSnapshot.items));

  // 2. Collect all fact IDs referenced by blocks or present in snapshot
  const referencedFactIdsSet = new Set<string>();

  // Check each block's explicit referencedFactIds and adoptedEvidences.associatedFactId
  currentDraft.blocks.forEach((block) => {
    (block.referencedFactIds || []).forEach((id) => referencedFactIdsSet.add(id));
    (block.adoptedEvidences || []).forEach((ev) => {
      if (ev.associatedFactId) {
        referencedFactIdsSet.add(ev.associatedFactId);
      }
    });
  });

  // Also include fact IDs from the draft's snapshot items
  snapshotItems.forEach((item) => referencedFactIdsSet.add(item.factId));

  const factIdsToCheck = Array.from(referencedFactIdsSet);

  // Helper to resolve snippet / doc names for latest fact
  const resolveDocAndLocation = (evidenceId: string | undefined) => {
    if (!evidenceId) return { docName: '未指定出处材料', location: '段落索引' };
    const snip = task.snippets.find((s) => s.id === evidenceId);
    if (!snip) return { docName: '出处已不可用', location: '段落索引' };
    const doc = task.documents.find((d) => d.id === snip.sourceDocId);
    return {
      docName: snip.docName || doc?.name || '未知材料文档',
      location: snip.location || '段落索引',
    };
  };

  const allItems: FactImpactItem[] = [];

  for (const factId of factIdsToCheck) {
    const snapItem = snapshotItems.find((i) => i.factId === factId);
    const latestFact = task.facts.find((f) => f.id === factId);
    const resolvedFact = findDraftFact(task, currentDraft, factId);

    const metric = snapItem?.metric || latestFact?.metric || resolvedFact?.metric || `未命名事实(${factId})`;

    // Find all blocks referencing this fact
    const referencingBlocks: ReferencingBlockInfo[] = [];
    currentDraft.blocks.forEach((block, idx) => {
      const isDirectRef = (block.referencedFactIds || []).includes(factId);
      const isAdoptedRef = (block.adoptedEvidences || []).some((ev) => ev.associatedFactId === factId);

      if (isDirectRef || isAdoptedRef) {
        const sec = task.outline.find((s) => s.id === block.sectionId) ||
          currentDraft.snapshotMetadata?.outlineSections?.find((s) => s.id === block.sectionId);
        
        const cleanContent = block.content.trim();
        const excerpt = cleanContent.length > 60 ? cleanContent.slice(0, 60) + '…' : cleanContent;

        referencingBlocks.push({
          blockId: block.id,
          blockOrder: block.order || idx + 1,
          sectionId: block.sectionId,
          sectionTitle: sec?.title || '正文章节',
          contentExcerpt: excerpt,
          viaMaterialSupplement: !isDirectRef && isAdoptedRef,
        });
      }
    });

    const differenceTags: FactDifferenceTag[] = [];

    if (!hasSnapshotBaseline) {
      // Draft has no snapshot at all
      differenceTags.push({
        type: 'missing_baseline',
        label: '缺少比较基准，需人工核实',
        description: '当前稿件未保存冻结事实快照，无法验证历史依据一致性',
      });
    } else if (!snapItem) {
      // Snapshot exists, but this specific fact was not in the snapshot
      if (latestFact?.status === 'confirmed') {
        differenceTags.push({
          type: 'missing_baseline',
          label: '缺少快照基准，需人工核实',
          description: '当前稿件快照未收录此核准事实，需人工核实',
        });
      } else if (!latestFact) {
        differenceTags.push({
          type: 'status_deleted',
          label: '核准状态变更：任务中已删除此事实',
          description: '任务事实清单中已删除此项，稿件仍在引用已删除事实',
        });
      } else if (latestFact.status === 'pending') {
        differenceTags.push({
          type: 'status_pending',
          label: '核准状态变更：当前撤销为待确认',
          description: '任务最新事实已被撤销核准，处于待确认状态',
        });
      } else if (latestFact.status === 'excluded') {
        differenceTags.push({
          type: 'status_excluded',
          label: '核准状态变更：已在任务中排除',
          description: '该事实已被任务标记排除，不应作为核准依据',
        });
      }
      // If latestFact.status === 'gap' and never was in snapshot, it is a declared material gap, not a discrepancy
    } else {
      // snapItem exists: compare against latestFact
      if (!latestFact) {
        differenceTags.push({
          type: 'status_deleted',
          label: '核准状态变更：任务中已删除此事实',
          description: '任务事实清单中已删除此项，稿件仍在引用已删除事实',
        });
      } else {
        // Task-wide approval invalidation is shown by the preparation gate;
        // it does not mean every unchanged fact has changed its own status.
        if (latestFact.status === 'pending') {
          differenceTags.push({
            type: 'status_pending',
            label: '核准状态变更：当前撤销为待确认',
            description: '任务最新事实已被撤销核准，处于待确认状态',
          });
        } else if (latestFact.status === 'excluded') {
          differenceTags.push({
            type: 'status_excluded',
            label: '核准状态变更：已在任务中排除',
            description: '该事实已被任务标记排除，不应作为核准依据',
          });
        } else if (latestFact.status === 'gap') {
          differenceTags.push({
            type: 'status_gap',
            label: '核准状态变更：标记为材料缺口',
            description: '该事实已在任务中被变更为材料缺口状态',
          });
        }

        if (latestFact.hasConflict && !latestFact.selectedConflictValue) {
          differenceTags.push({
            type: 'conflict_unresolved',
            label: '核准状态变更：存在未裁决冲突',
            description: '任务中该指标存在待裁决冲突，尚未确定最终采信值',
          });
        }

        // Compare specific fields against snapshot item
        // 1. Numerical Value
        const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
        const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
        if (snapValue !== latestValue) {
          differenceTags.push({
            type: 'value',
            label: '数值变化',
            description: `本稿采用值：${snapValue}，任务最新值：${latestValue}`,
          });
        }

        // 2. Unit
        const snapUnit = (snapItem.unit || '').trim();
        const latestUnit = (latestFact.unit || '').trim();
        if (snapUnit !== latestUnit) {
          differenceTags.push({
            type: 'unit',
            label: '单位变化',
            description: `本稿单位：${snapUnit}，任务最新单位：${latestUnit}`,
          });
        }

        // 3. Period
        const snapPeriod = (snapItem.period || '').trim();
        const latestPeriod = (latestFact.period || '').trim();
        if (snapPeriod !== latestPeriod) {
          differenceTags.push({
            type: 'period',
            label: '统计期间变化',
            description: `本稿期间：${snapPeriod}，任务最新期间：${latestPeriod}`,
          });
        }

        // 4. Metric Scope
        const snapScope = (snapItem.metricScope || '').trim();
        const latestScope = (latestFact.metricScope || '').trim();
        if (snapScope !== latestScope) {
          differenceTags.push({
            type: 'metric_scope',
            label: '统计口径变化',
            description: `本稿口径：${snapScope || '未指定'}，最新口径：${latestScope || '未指定'}`,
          });
        }

        // 5. Primary Evidence
        if (
          (snapItem.primaryEvidenceId || '') !== (latestFact.primaryEvidenceId || '')
        ) {
          differenceTags.push({
            type: 'primary_evidence',
            label: '主出处变更',
            description: `主出处发生变化（本稿：${snapItem.primaryEvidenceId}，最新：${latestFact.primaryEvidenceId}）`,
          });
        }
      }
    }

    const hasDifference = differenceTags.length > 0;
    const diffCategorySummary = differenceTags.map((d) => d.label).join(' · ') || '口径一致';

    // Format Draft frozen information
    const draftSnapshotValue = snapItem
      ? `${snapItem.selectedConflictValue || snapItem.value} ${snapItem.unit}`
      : hasSnapshotBaseline
      ? '快照未记录'
      : '缺少比较基准';
    const draftPeriod = snapItem?.period || (hasSnapshotBaseline ? '未记录期间' : '基准缺失');
    const draftMetricScope = snapItem?.metricScope || (hasSnapshotBaseline ? '无单独口径' : '基准缺失');
    const draftEvidenceId = snapItem?.primaryEvidenceId;

    let draftDocName = '未保存当时出处原文';
    let draftLocation = '快照未记录';
    if (snapItem?.provenance && (!draftEvidenceId || snapItem.provenance.evidenceId === draftEvidenceId)) {
      draftDocName = snapItem.provenance.sourceDocName;
      draftLocation = snapItem.provenance.location || '段落索引';
    }

    // Format Latest task information
    let latestConfirmedValue = '任务中已删除此事实';
    let latestPeriod = '已删除';
    let latestMetricScope = '已删除';
    let latestEvidenceId: string | undefined = undefined;
    let latestDocName = '已删除';
    let latestLocation = '-';
    let latestStatus: 'confirmed' | 'pending' | 'excluded' | 'gap' | 'deleted' = 'deleted';
    let latestStatusLabel = '已删除';
    let hasConflict = false;
    let unresolvedConflict = false;

    if (latestFact) {
      latestStatus = latestFact.status;
      hasConflict = Boolean(latestFact.hasConflict);
      unresolvedConflict = Boolean(latestFact.hasConflict && !latestFact.selectedConflictValue);

      if (latestFact.status === 'confirmed') {
        latestConfirmedValue = `${latestFact.selectedConflictValue || latestFact.value} ${latestFact.unit}`;
        latestStatusLabel = '最新已核准';
      } else if (latestFact.status === 'pending') {
        latestConfirmedValue = `待确认 (${latestFact.selectedConflictValue || latestFact.value} ${latestFact.unit})`;
        latestStatusLabel = '待确认';
      } else if (latestFact.status === 'excluded') {
        latestConfirmedValue = `已排除 (${latestFact.selectedConflictValue || latestFact.value} ${latestFact.unit})`;
        latestStatusLabel = '已排除';
      } else {
        latestConfirmedValue = '材料缺口';
        latestStatusLabel = '材料缺口';
      }

      if (unresolvedConflict) {
        latestStatusLabel = '存在未裁决冲突';
        latestConfirmedValue = '冲突未裁决，暂无采信值';
      }

      latestPeriod = latestFact.period;
      latestMetricScope = latestFact.metricScope || '标准口径';
      latestEvidenceId = latestFact.primaryEvidenceId;
      const res = resolveDocAndLocation(latestEvidenceId);
      latestDocName = res.docName;
      latestLocation = res.location;
    }

    allItems.push({
      factId,
      metric,
      hasDifference,
      differenceTags,
      diffCategorySummary,
      draftSnapshotValue,
      draftPeriod,
      draftMetricScope,
      draftEvidenceId,
      draftDocName,
      draftLocation,
      hasFrozenSnapshot: Boolean(snapItem),
      latestConfirmedValue,
      latestPeriod,
      latestMetricScope,
      latestEvidenceId,
      latestDocName,
      latestLocation,
      latestStatus,
      latestStatusLabel,
      hasConflict,
      unresolvedConflict,
      referencingBlocks,
      affectedBlocksCount: referencingBlocks.length,
      latestFact,
      snapshotItem: snapItem,
    });
  }

  // Filter only items with differences
  const impactItems = allItems.filter((i) => i.hasDifference);
  const missingBaselineFactIds = allItems.filter(i => !i.hasFrozenSnapshot && i.referencingBlocks.length > 0).map(i => i.factId);

  // De-duplicated count of unique changed facts
  const changedFactsCount = impactItems.length;

  // De-duplicated count of unique affected blocks that reference at least one changed fact
  const affectedBlockIdsSet = new Set<string>();
  impactItems.forEach((item) => {
    item.referencingBlocks.forEach((b) => affectedBlockIdsSet.add(b.blockId));
  });
  const affectedBlockIds = Array.from(affectedBlockIdsSet);
  const affectedBlocksCount = affectedBlockIds.length;

  // 3. Identify newly added facts in task.facts that are NOT referenced in current draft
  const unreferencedNewFacts: UnreferencedNewFactItem[] = [];
  task.facts.forEach((f) => {
    if (!referencedFactIdsSet.has(f.id) && !f.isHistoricOnly) {
      unreferencedNewFacts.push({
        factId: f.id,
        metric: f.metric,
        value: f.selectedConflictValue || f.value,
        unit: f.unit,
        period: f.period,
        status: f.status,
        statusLabel:
          f.status === 'confirmed'
            ? '已核准'
            : f.status === 'pending'
            ? '待确认'
            : f.status === 'excluded'
            ? '已排除'
            : '材料缺口',
      });
    }
  });

  // 4. Material evidence scope limitations (unlinked evidence records in blocks)
  let materialEvidenceScope: MaterialEvidenceScopeLimitation | undefined = undefined;
  const unlinkedBlocks: { blockId: string; blockOrder: number }[] = [];
  let totalUnlinked = 0;

  currentDraft.blocks.forEach((block, idx) => {
    const unlinked = (block.adoptedEvidences || []).filter((e) => !e.associatedFactId);
    if (unlinked.length > 0) {
      totalUnlinked += unlinked.length;
      unlinkedBlocks.push({ blockId: block.id, blockOrder: block.order || idx + 1 });
    }
  });

  if (totalUnlinked > 0) {
    materialEvidenceScope = {
      unlinkedCount: totalUnlinked,
      blocksWithUnlinkedEvidence: unlinkedBlocks,
      notice: `当前正文中存在 ${totalUnlinked} 条未关联具体事实编号的材料补写存证（来自材料原文摘录）。因未绑定结构化事实编号，本检查无法自动比对指标数值，需主笔结合材料原文人工核对。`,
    };
  }

  // 5. Overall status message
  let statusMessage = '未发现已关联事实的差异';
  if (!hasSnapshotBaseline) {
    statusMessage = '缺少比较基准，需人工核实';
  } else if (changedFactsCount > 0) {
    statusMessage = `${changedFactsCount}项事实发生变更 · ${affectedBlocksCount}段需复核`;
  }

  return {
    hasDraft: true,
    hasSnapshotBaseline,
    statusMessage,
    changedFactsCount,
    affectedBlocksCount,
    impactItems,
    allReferencedItems: allItems,
    missingBaselineFactIds,
    unreferencedNewFacts,
    materialEvidenceScope,
    affectedBlockIds,
  };
}
