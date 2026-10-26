import {
  Task,
  DraftVersion,
  ParagraphBlock,
  UserRole,
  ParagraphFactReviewRecord,
  FactEvidenceSummaryAtReview,
  BlockFactReviewEvaluation,
  DraftFactReviewOverview,
  FactReviewDisplayStatus,
} from '../types';
import { FactImpactItem, analyzeFactImpact } from './factImpactService';
import { checkPermission } from './permissionService';

export type {
  BlockFactReviewEvaluation,
  DraftFactReviewOverview,
  ParagraphFactReviewRecord,
  FactEvidenceSummaryAtReview,
  FactReviewDisplayStatus,
};

/**
 * Builds a frozen snapshot of fact evidence differences for a block at review time.
 */
export function buildFactsSummaryForBlock(
  task: Task,
  draft: DraftVersion,
  impactItems: FactImpactItem[],
  blockId: string
): FactEvidenceSummaryAtReview[] {
  const blockImpacts = impactItems.filter((item) =>
    item.referencingBlocks.some((b) => b.blockId === blockId)
  );

  return blockImpacts.map((item) => {
    // Current task latest fact snippet text if available
    let latestSnippetText = '';
    if (item.latestEvidenceId) {
      const snip = task.snippets.find((s) => s.id === item.latestEvidenceId);
      if (snip) {
        latestSnippetText = snip.text;
      }
    }

    return {
      factId: item.factId,
      metric: item.metric,
      snapshotValue: item.draftSnapshotValue,
      snapshotPeriod: item.draftPeriod,
      snapshotMetricScope: item.draftMetricScope,
      snapshotPrimaryEvidenceId: item.draftEvidenceId,
      snapshotDocName: item.draftDocName,
      snapshotLocation: item.draftLocation,
      snapshotProvenanceText: item.snapshotItem?.provenance?.text || '',
      hasFrozenSnapshot: item.hasFrozenSnapshot,

      latestConfirmedValue: item.latestConfirmedValue,
      latestPeriod: item.latestPeriod,
      latestMetricScope: item.latestMetricScope,
      latestPrimaryEvidenceId: item.latestEvidenceId,
      latestStatus: item.latestStatus,
      latestDocName: item.latestDocName,
      latestLocation: item.latestLocation,
      latestSnippetText,
      hasConflict: item.hasConflict,
      selectedConflictValue: item.latestFact?.selectedConflictValue,
    };
  });
}

/**
 * Evaluates whether an existing review record is still applicable or has been invalidated.
 * Strictly checks:
 * 1. Current block text content vs recorded content
 * 2. Current block revisionSeq vs recorded revisionSeq (protects against undo/redo silent recovery)
 * 3. Current block referenced fact IDs & adopted evidences
 * 4. Draft frozen snapshot baseline items
 * 5. Task latest fact metrics, values, units, periods, scopes, statuses, conflicts, primary evidences & snippet text
 * 6. Whether any NEW fact differences now affect this block
 */
export function checkReviewRecordApplicability(
  task: Task,
  draft: DraftVersion,
  block: ParagraphBlock,
  record: ParagraphFactReviewRecord,
  currentBlockImpacts: FactImpactItem[]
): { isValid: boolean; invalidatedReason?: string } {
  // If record was explicitly revoked, it is not an active valid record
  if (record.status === 'revoked') {
    return {
      isValid: false,
      invalidatedReason: `复核记录已被撤回（撤回人：${record.revocation?.revokedBy || '主笔'}，原因：${record.revocation?.reason || '人工撤回'}）`,
    };
  }

  // 1. Check paragraph content
  if (block.content !== record.paragraphContentAtReview) {
    return {
      isValid: false,
      invalidatedReason: '段落正文在复核后已发生修改',
    };
  }

  // 2. Check paragraph revision sequence (protects against edit-then-revert or undo)
  const currentSeq = typeof block.revisionSeq === 'number' && Number.isFinite(block.revisionSeq) ? block.revisionSeq : 0;
  const recordedSeq = typeof record.paragraphRevisionSeqAtReview === 'number' && Number.isFinite(record.paragraphRevisionSeqAtReview) ? record.paragraphRevisionSeqAtReview : 0;
  if (currentSeq !== recordedSeq) {
    return {
      isValid: false,
      invalidatedReason: '段落修订版本已递增（正文发生过编辑或安全撤销）',
    };
  }

  // 3. Check paragraph fact references
  const currentFactRefs = (block.referencedFactIds || []).slice().sort();
  const recordedFactRefs = (record.referencedFactIdsAtReview || []).slice().sort();
  if (
    currentFactRefs.length !== recordedFactRefs.length ||
    !currentFactRefs.every((id, idx) => id === recordedFactRefs[idx])
  ) {
    return {
      isValid: false,
      invalidatedReason: '段落事实引用关系已发生调整',
    };
  }

  // 4. Check draft frozen fact baseline
  const draftSnapshotItems = draft.snapshotMetadata?.factSnapshot?.items || [];
  for (const fSummary of record.factsSummaryAtReview) {
    const snapItem = draftSnapshotItems.find((i) => i.factId === fSummary.factId);
    if (fSummary.hasFrozenSnapshot) {
      if (!snapItem) {
        return {
          isValid: false,
          invalidatedReason: `稿件冻结基准中事实【${fSummary.metric}】已被移除`,
        };
      }
      const curSnapVal = `${snapItem.selectedConflictValue || snapItem.value} ${snapItem.unit}`;
      if (curSnapVal !== fSummary.snapshotValue) {
        return {
          isValid: false,
          invalidatedReason: `稿件冻结基准已更新（【${fSummary.metric}】由 ${fSummary.snapshotValue} 变更为 ${curSnapVal}）`,
        };
      }
      if ((snapItem.period || '').trim() !== (fSummary.snapshotPeriod || '').trim()) {
        return {
          isValid: false,
          invalidatedReason: `稿件冻结基准中【${fSummary.metric}】统计期间已更新`,
        };
      }
      if ((snapItem.metricScope || '').trim() !== (fSummary.snapshotMetricScope || '').trim()) {
        return {
          isValid: false,
          invalidatedReason: `稿件冻结基准中【${fSummary.metric}】统计口径已更新`,
        };
      }
    }
  }

  // 5. Check latest task facts
  for (const fSummary of record.factsSummaryAtReview) {
    const latestFact = task.facts.find((f) => f.id === fSummary.factId);
    if (!latestFact) {
      return {
        isValid: false,
        invalidatedReason: `任务中已删除事实【${fSummary.metric}】`,
      };
    }

    if (latestFact.status !== fSummary.latestStatus) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】最新状态已由【${fSummary.latestStatus}】变更为【${latestFact.status}】`,
      };
    }

    const curLatestVal = `${latestFact.selectedConflictValue || latestFact.value} ${latestFact.unit}`;
    if (latestFact.status === 'confirmed' && curLatestVal !== fSummary.latestConfirmedValue) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】最新数值或单位已变动（现为 ${curLatestVal}）`,
      };
    }

    if ((latestFact.period || '').trim() !== (fSummary.latestPeriod || '').trim()) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】最新统计期间已变动`,
      };
    }

    if ((latestFact.metricScope || '').trim() !== (fSummary.latestMetricScope || '').trim()) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】最新统计口径已变动`,
      };
    }

    if ((latestFact.primaryEvidenceId || '') !== (fSummary.latestPrimaryEvidenceId || '')) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】主出处已变更为 ${latestFact.primaryEvidenceId || '无'}`,
      };
    }

    if (Boolean(latestFact.hasConflict) !== Boolean(fSummary.hasConflict)) {
      return {
        isValid: false,
        invalidatedReason: `事实【${fSummary.metric}】冲突状态已发生变动`,
      };
    }

    // Check snippet text change in task.snippets
    if (fSummary.latestSnippetText && latestFact.primaryEvidenceId) {
      const snip = task.snippets.find((s) => s.id === latestFact.primaryEvidenceId);
      if (snip && snip.text !== fSummary.latestSnippetText) {
        return {
          isValid: false,
          invalidatedReason: `事实【${fSummary.metric}】主出处材料原文已发生修改`,
        };
      }
    }
  }

  // 6. Check if new fact differences have emerged that affect this block
  const recordedFactIdSet = new Set(record.factsSummaryAtReview.map((f) => f.factId));
  const newUnreviewedImpacts = currentBlockImpacts.filter(
    (item) => !recordedFactIdSet.has(item.factId)
  );
  if (newUnreviewedImpacts.length > 0) {
    const newMetrics = newUnreviewedImpacts.map((i) => i.metric).join('、');
    return {
      isValid: false,
      invalidatedReason: `该段落关联的事实依据出现新差异（${newMetrics}），需重新核对全部差异`,
    };
  }

  return { isValid: true };
}

/**
 * Computes complete fact review evaluation for the entire draft.
 */
export function evaluateDraftFactReviews(
  task: Task,
  draft: DraftVersion | undefined
): DraftFactReviewOverview {
  if (!draft || !draft.blocks || draft.blocks.length === 0) {
    return {
      totalAffectedBlocks: 0,
      reviewedCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      invalidatedCount: 0,
      unreviewedCount: 0,
      blockEvaluations: [],
    };
  }

  // Analyze impact
  const analysis = analyzeFactImpact(task, draft);
  const affectedBlockIds = analysis.affectedBlockIds;
  const existingRecords = draft.factReviewRecords || [];

  const blockEvaluations: BlockFactReviewEvaluation[] = [];
  let reviewedCount = 0;
  let deferredCount = 0;
  let invalidatedCount = 0;
  let unreviewedCount = 0;

  for (const blockId of affectedBlockIds) {
    const block = draft.blocks.find((b) => b.id === blockId);
    if (!block) continue;

    const blockImpacts = analysis.impactItems.filter((item) =>
      item.referencingBlocks.some((b) => b.blockId === blockId)
    );

    const sec = task.outline.find((s) => s.id === block.sectionId) ||
      draft.snapshotMetadata?.outlineSections?.find((s) => s.id === block.sectionId);

    // Find the latest review record for this block
    const record = existingRecords.find((r) => r.blockId === blockId);

    // Limitations detection
    const limitations: string[] = [];
    if (!analysis.hasSnapshotBaseline) {
      limitations.push('稿件缺少冻结事实快照基准，无法自动比对历史采用值');
    }
    blockImpacts.forEach((imp) => {
      if (!imp.hasFrozenSnapshot) {
        limitations.push(`事实【${imp.metric}】未收录于本稿快照，缺少冻结基准`);
      }
      if (imp.latestStatus === 'deleted') {
        limitations.push(`事实【${imp.metric}】在任务中已被删除`);
      }
      if (imp.unresolvedConflict) {
        limitations.push(`事实【${imp.metric}】存在未裁决冲突`);
      }
    });
    const unlinkedEv = (block.adoptedEvidences || []).filter((e) => !e.associatedFactId);
    if (unlinkedEv.length > 0) {
      limitations.push(`段落包含 ${unlinkedEv.length} 条未绑定事实编号的材料补写存证，需结合原文核对`);
    }

    let displayStatus: FactReviewDisplayStatus = 'pending';
    let displayStatusLabel = '待复核';
    let invalidatedReason: string | undefined = undefined;
    let isPending = true;
    let isReviewed = false;

    if (!record || record.status === 'revoked') {
      displayStatus = 'pending';
      displayStatusLabel = '待复核';
      isPending = true;
      isReviewed = false;
      unreviewedCount++;
    } else {
      const applicability = checkReviewRecordApplicability(task, draft, block, record, blockImpacts);
      if (!applicability.isValid) {
        displayStatus = 'invalidated';
        displayStatusLabel = '原复核已失效，需重新核对';
        invalidatedReason = applicability.invalidatedReason;
        isPending = true;
        isReviewed = false;
        invalidatedCount++;
      } else if (record.status === 'deferred') {
        displayStatus = 'deferred';
        displayStatusLabel = '暂缓处理';
        isPending = true;
        isReviewed = false;
        deferredCount++;
      } else if (record.status === 'reviewed') {
        displayStatus = 'reviewed';
        displayStatusLabel = '已记录人工复核';
        isPending = false;
        isReviewed = true;
        reviewedCount++;
      }
    }

    blockEvaluations.push({
      blockId,
      blockOrder: block.order,
      sectionId: block.sectionId,
      sectionTitle: sec?.title || '正文章节',
      changedFacts: blockImpacts,
      record,
      displayStatus,
      displayStatusLabel,
      invalidatedReason,
      limitations,
      isPending,
      isReviewed,
    });
  }

  // Sort by blockOrder ascending
  blockEvaluations.sort((a, b) => a.blockOrder - b.blockOrder);

  const totalAffectedBlocks = blockEvaluations.length;
  const pendingCount = totalAffectedBlocks - reviewedCount;

  return {
    totalAffectedBlocks,
    reviewedCount,
    pendingCount,
    deferredCount,
    invalidatedCount,
    unreviewedCount,
    blockEvaluations,
  };
}

/**
 * Saves a fact review record for a specific block on the current working draft.
 * Strictly verifies role permissions, draft mutability, notes non-emptiness,
 * and guards against stale object submissions across task/draft/block switches.
 */
export function saveFactReviewRecord(params: {
  task: Task;
  targetDraftId: string;
  targetBlockId: string;
  status: 'reviewed' | 'deferred';
  notes: string;
  activeRole: UserRole;
}): { updatedTask: Task; workingDraft: DraftVersion; newRecord: ParagraphFactReviewRecord } {
  const { task, targetDraftId, targetBlockId, status, notes, activeRole } = params;

  // 1. Role validation
  if (activeRole !== '主笔甲') {
    throw new Error(`权限受限：仅主笔甲可记录人工复核（当前角色为【${activeRole}】）`);
  }

  // 2. Draft existence and mutability
  const draft = task.drafts.find((d) => d.id === targetDraftId);
  if (!draft) {
    throw new Error(`提交失败：未找到目标稿件版本【${targetDraftId}】，可能已被切换或删除！`);
  }
  if (draft.isHistoricalSnapshot || draft.isFinal) {
    throw new Error('只读版本：历史快照与正式定稿不可修改或新增复核记录');
  }

  // 3. Block existence
  const block = draft.blocks.find((b) => b.id === targetBlockId);
  if (!block) {
    throw new Error(`提交失败：目标段落【${targetBlockId}】不存在！`);
  }

  // 4. Notes validation
  const cleanNotes = (notes || '').trim();
  if (!cleanNotes) {
    if (status === 'reviewed') {
      throw new Error('核对说明不可为空，请填写具体核对说明！');
    } else {
      throw new Error('暂缓原因不可为空，请填写具体暂缓原因！');
    }
  }

  // 5. Build context snapshot
  const analysis = analyzeFactImpact(task, draft);
  const factsSummary = buildFactsSummaryForBlock(task, draft, analysis.impactItems, targetBlockId);

  const sec = task.outline.find((s) => s.id === block.sectionId) ||
    draft.snapshotMetadata?.outlineSections?.find((s) => s.id === block.sectionId);

  const newRecord: ParagraphFactReviewRecord = {
    id: `FR-REC-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    taskId: task.id,
    draftId: draft.id,
    blockId: targetBlockId,
    blockOrder: block.order,
    sectionId: block.sectionId,
    sectionTitle: sec?.title || '正文章节',
    status,
    reviewedBy: activeRole,
    reviewedAt: new Date().toISOString(),
    notes: cleanNotes,
    paragraphContentAtReview: block.content,
    paragraphRevisionSeqAtReview: typeof block.revisionSeq === 'number' && Number.isFinite(block.revisionSeq) ? block.revisionSeq : 0,
    referencedFactIdsAtReview: [...(block.referencedFactIds || [])],
    adoptedEvidenceIdsAtReview: (block.adoptedEvidences || []).map((e) => e.evidenceId),
    factsSummaryAtReview: factsSummary,
  };

  // Replace or append record for this block
  const existingRecords = draft.factReviewRecords || [];
  const updatedRecords = [
    newRecord,
    ...existingRecords.filter((r) => r.blockId !== targetBlockId),
  ];

  const updatedDraft: DraftVersion = {
    ...draft,
    factReviewRecords: updatedRecords,
  };

  const updatedTask: Task = {
    ...task,
    drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, workingDraft: updatedDraft, newRecord };
}

/**
 * Revokes an existing fact review record for a specific block,
 * preserving original notes and recording revocation metadata.
 */
export function revokeFactReviewRecord(params: {
  task: Task;
  targetDraftId: string;
  targetBlockId: string;
  reason: string;
  activeRole: UserRole;
}): { updatedTask: Task; workingDraft: DraftVersion } {
  const { task, targetDraftId, targetBlockId, reason, activeRole } = params;

  // 1. Role validation
  if (activeRole !== '主笔甲') {
    throw new Error(`权限受限：仅主笔甲可撤回复核（当前角色为【${activeRole}】）`);
  }

  // 2. Draft existence and mutability
  const draft = task.drafts.find((d) => d.id === targetDraftId);
  if (!draft) {
    throw new Error(`撤回失败：未找到目标稿件版本【${targetDraftId}】！`);
  }
  if (draft.isHistoricalSnapshot || draft.isFinal) {
    throw new Error('只读版本：历史快照与正式定稿不可撤回复核记录');
  }

  // 3. Reason validation
  const cleanReason = (reason || '').trim();
  if (!cleanReason) {
    throw new Error('撤回原因不可为空，请填写撤回原因！');
  }

  // 4. Find existing record
  const existingRecords = draft.factReviewRecords || [];
  const targetRecord = existingRecords.find((r) => r.blockId === targetBlockId);
  if (!targetRecord) {
    throw new Error(`未找到段落【${targetBlockId}】的有效复核记录，无法撤回！`);
  }

  const updatedRecord: ParagraphFactReviewRecord = {
    ...targetRecord,
    status: 'revoked',
    revocation: {
      revokedAt: new Date().toISOString(),
      revokedBy: activeRole,
      reason: cleanReason,
    },
  };

  const updatedRecords = existingRecords.map((r) =>
    r.blockId === targetBlockId ? updatedRecord : r
  );

  const updatedDraft: DraftVersion = {
    ...draft,
    factReviewRecords: updatedRecords,
  };

  const updatedTask: Task = {
    ...task,
    drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, workingDraft: updatedDraft };
}
