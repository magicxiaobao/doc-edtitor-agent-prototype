import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  UserRole, 
  FinalizationValidationResult,
  AuditIssue,
  SnapshotMetadata,
  DraftCandidate
} from '../types';
import { runDocumentAudit } from './mockAuditService';
import { checkPermission } from './permissionService';
import { computeContentHash } from './mockDraftService';

/**
 * Compute deterministic hash of draft blocks to detect manual edits
 */
export function computeDraftBlocksHash(blocks: ParagraphBlock[] = []): string {
  const combined = blocks.map((b) => `${b.id}::${b.sectionId}::${b.content}`).join('||');
  return computeContentHash(combined);
}

export interface CandidateAcceptanceValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates whether a generated candidate can be safely accepted into the current task/draft.
 * Enforces task isolation, valid run ID, unmodified baseline text hash, and valid upstream approvals.
 */
export function validateCandidateAcceptance(
  task: Task,
  currentDraft: DraftVersion | undefined,
  pendingCandidate: DraftCandidate,
  activeCompletedRunId: string | null,
  activeRole: UserRole
): CandidateAcceptanceValidationResult {
  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    return { valid: false, reason: perm.reason || '当前身份无权采纳新候选稿' };
  }

  // Strict isolation: candidate must match current task
  if (pendingCandidate.taskId !== task.id) {
    return { valid: false, reason: '安全隔离拦截：候选稿生成自其他任务，禁止跨任务采纳！' };
  }

  // Run ID validation: must strictly match currently valid completed run (cancelled or expired runs strictly rejected)
  if (!activeCompletedRunId || pendingCandidate.runId !== activeCompletedRunId) {
    return { valid: false, reason: '生成运行已失效：该候选生成自已取消或过期的运行！' };
  }

  // Baseline validation: check if draft changed (ID mismatch)
  if (currentDraft && pendingCandidate.baseDraftId && currentDraft.id !== pendingCandidate.baseDraftId) {
    return { valid: false, reason: '基准冲突：当前草稿版本已发生变更，旧生成候选已失效！请重新生成。' };
  }

  // Baseline validation: check if draft content was manually modified after generation started!
  if (currentDraft && pendingCandidate.baseDraftContentHash) {
    const currentHash = computeDraftBlocksHash(currentDraft.blocks);
    if (currentHash !== pendingCandidate.baseDraftContentHash) {
      return {
        valid: false,
        reason: '基准正文已变更：在此候选生成后，正文已被人工编辑修改，采纳旧候选将覆盖人工修改！候选已失效，请重新生成或先保存快照。',
      };
    }
  }

  // Upstream approvals validation: verify upstream approvals are still valid
  const isUpstreamStillApproved =
    task.outlineConfirmed === true &&
    task.styleConfirmed === true &&
    !!task.factSnapshot &&
    !!task.styleSnapshot &&
    !!task.outlineSnapshot;

  if (!isUpstreamStillApproved) {
    return {
      valid: false,
      reason: '上游依据审批状态已失效（事实快照缺失、文风未核准或大纲审批已撤销），旧候选已失效！',
    };
  }

  // Check fact snapshot consistency
  const curFactTime = task.factSnapshot?.confirmedAt || '';
  const candFactTime = pendingCandidate.upstreamApprovalVersion?.factSnapshotConfirmedAt || '';
  const curFactHash = task.factSnapshot?.hash || '';
  const candFactHash = pendingCandidate.upstreamApprovalVersion?.factSnapshotHash || '';
  if (curFactTime !== candFactTime || (curFactHash && candFactHash && curFactHash !== candFactHash)) {
    return {
      valid: false,
      reason: '上游事实依据版本已变更：事实快照已更新，候选稿依据已失效，请重新生成！',
    };
  }

  // Check style snapshot consistency (time and hash)
  const curStyleTime = task.styleSnapshot?.confirmedAt || '';
  const candStyleTime = pendingCandidate.upstreamApprovalVersion?.styleConfirmedAt || '';
  const curStyleHash = task.styleSnapshot?.hash || '';
  const candStyleHash = pendingCandidate.upstreamApprovalVersion?.styleHash || '';
  if (curStyleTime !== candStyleTime || (curStyleHash && candStyleHash && curStyleHash !== candStyleHash)) {
    return {
      valid: false,
      reason: '上游文风依据版本已变更：文风规范已重新核准，候选稿依据已失效，请重新生成！',
    };
  }

  // Check outline snapshot consistency (time and hash)
  const curOutlineTime = task.outlineSnapshot?.confirmedAt || '';
  const candOutlineTime = pendingCandidate.upstreamApprovalVersion?.outlineConfirmedAt || '';
  const curOutlineHash = task.outlineSnapshot?.hash || '';
  const candOutlineHash = pendingCandidate.upstreamApprovalVersion?.outlineHash || '';
  if (curOutlineTime !== candOutlineTime || (curOutlineHash && candOutlineHash && curOutlineHash !== candOutlineHash)) {
    return {
      valid: false,
      reason: '上游大纲依据版本已变更：大纲结构已重新核准，候选稿依据已失效，请重新生成！',
    };
  }

  return { valid: true };
}

/**
 * Adopts a candidate draft by archiving the previous draft as a historical snapshot
 * and creating a brand-new working draft, fulfilling the promise of auto-archiving.
 */
export function acceptDraftCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidate: DraftCandidate,
  activeRole: UserRole
): { updatedTask: Task; workingDraft: DraftVersion; archivedDraft?: DraftVersion } {
  const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作稿·已采纳新候选)`;
  let archivedDraft: DraftVersion | undefined;

  // 采纳前保存旧稿快照，再创建新工作稿：旧稿自动归档为只读历史快照，冻结审阅记录
  if (currentDraft) {
    archivedDraft = {
      ...currentDraft,
      isWorkingDraft: false,
      isHistoricalSnapshot: true,
      summary: currentDraft.summary
        ? `${currentDraft.summary}（采纳新候选前自动归档历史快照）`
        : '采纳新候选前系统自动归档的历史快照',
      frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments || [])),
    };
  }

  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: currentDraft
      ? `基于【${currentDraft.versionNumber}】归档后采纳新候选生成的工作稿`
      : '采纳新起草候选生成的工作稿',
    blocks: JSON.parse(JSON.stringify(candidate.blocks)),
    isFinal: false,
    isHistoricalSnapshot: false,
    isWorkingDraft: true,
    sourceDraftId: currentDraft?.id,
    snapshotMetadata: candidate.snapshotMetadata || currentDraft?.snapshotMetadata,
    auditRecords: currentDraft?.auditRecords ? JSON.parse(JSON.stringify(currentDraft.auditRecords)) : [],
  };

  const updatedDrafts = currentDraft
    ? [newWorkingDraft, ...task.drafts.map((d) => (d.id === currentDraft.id ? archivedDraft! : d))]
    : [newWorkingDraft, ...task.drafts];

  const updatedTask: Task = {
    ...task,
    drafts: updatedDrafts,
    currentDraftId: newWorkingDraft.id,
    isFinalized: false,
    status: '起草中',
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, workingDraft: newWorkingDraft, archivedDraft };
}

/**
 * Requirement 1: Unified Draft Modification Service
 * - Covers: manual editing, suggestion adoption, review implementation,
 *   audit correction, candidate adoption, version restore, demo injection.
 * - Working drafts are mutable.
 * - Historical snapshots and finalized versions are IMMUTABLE.
 * - Modifying a snapshot/finalized draft automatically forks a new working draft
 *   and records the sourceDraftId.
 * - When targetDraftId is explicitly specified and does not exist, strictly returns
 *   error without falling back to first draft!
 */
export function applyDraftContentChange(
  task: Task,
  targetDraftId: string | undefined,
  blockUpdater: (blocks: ParagraphBlock[]) => ParagraphBlock[],
  changeDescription: string,
  activeRole: UserRole,
  newSnapshotMetadata?: SnapshotMetadata
): { updatedTask: Task; workingDraft: DraftVersion; forkedNewDraft: boolean } {
  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    throw new Error(perm.reason || '权限受限：仅主笔甲可修改正文草稿');
  }

  let targetDraft: DraftVersion | undefined;
  if (targetDraftId) {
    targetDraft = task.drafts.find((d) => d.id === targetDraftId);
    if (!targetDraft) {
      throw new Error(`未找到指定版本【${targetDraftId}】，拒绝修改！`);
    }
  } else {
    targetDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    if (!targetDraft) {
      throw new Error('当前任务尚无正文草稿');
    }
  }

  const isImmutable = targetDraft.isFinal === true || targetDraft.isHistoricalSnapshot === true;

  if (isImmutable) {
    // Fork a new working draft and record sourceDraftId
    const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作草稿·基于${targetDraft.isFinal ? '定稿' : '历史快照'}修改)`;
    const newBlocks = blockUpdater(JSON.parse(JSON.stringify(targetDraft.blocks)));

    const newWorkingDraft: DraftVersion = {
      id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      versionNumber: nextVersionNumber,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: `基于【${targetDraft.versionNumber}】继续编辑生成的新工作草稿（${changeDescription}）`,
      blocks: newBlocks,
      isFinal: false,
      isHistoricalSnapshot: false,
      isWorkingDraft: true,
      sourceDraftId: targetDraft.id, // 记录来源版本ID
      snapshotMetadata: newSnapshotMetadata || targetDraft.snapshotMetadata,
      auditRecords: targetDraft.auditRecords ? JSON.parse(JSON.stringify(targetDraft.auditRecords)) : [],
    };

    const updatedTask: Task = {
      ...task,
      drafts: [newWorkingDraft, ...task.drafts],
      currentDraftId: newWorkingDraft.id,
      isFinalized: false, // 清除定稿锁定
      status: '起草中',
      updatedAt: new Date().toISOString(),
    };

    return { updatedTask, workingDraft: newWorkingDraft, forkedNewDraft: true };
  } else {
    // Modify existing working draft
    const updatedBlocks = blockUpdater(JSON.parse(JSON.stringify(targetDraft.blocks)));
    const updatedDraft: DraftVersion = {
      ...targetDraft,
      blocks: updatedBlocks,
      summary: targetDraft.summary ? `${targetDraft.summary}；${changeDescription}` : changeDescription,
      snapshotMetadata: newSnapshotMetadata || targetDraft.snapshotMetadata,
      isWorkingDraft: true,
      isHistoricalSnapshot: false,
      isFinal: false,
    };

    const updatedTask: Task = {
      ...task,
      drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
      currentDraftId: updatedDraft.id,
      updatedAt: new Date().toISOString(),
    };

    return { updatedTask, workingDraft: updatedDraft, forkedNewDraft: false };
  }
}

/**
 * Requirement 2: Strict Finalization Validation
 * Shared between UI button disabled state, card indicators, and execution handler.
 * - Checks unclosed review comments associated with this draft/lineage:
 *   'pending', 'accepted_pending_implementation', 'need_discussion'
 *   (待落实和待沟通都不能当作已完成!)
 * - Checks upstream fact/style/outline approval validity
 * - Checks actual text blocking audit errors
 * - Checks draft mutability (cannot re-finalize an already finalized snapshot)
 */
export function validateFinalizationConditions(
  task: Task,
  draftId?: string,
  activeRole?: UserRole
): FinalizationValidationResult {
  const role = activeRole || '主笔甲';
  let targetDraft: DraftVersion | undefined;
  if (draftId) {
    targetDraft = task.drafts.find((d) => d.id === draftId);
    if (!targetDraft) {
      return {
        canFinalize: false,
        reasons: [`未找到指定版本【${draftId}】，拒绝定稿！`],
        checks: {
          hasDraftText: false,
          isAuthor: role === '主笔甲',
          isUpstreamValid: false,
          pendingConflictsResolved: false,
          commentsClosed: false,
          criticalAuditPassed: false,
          isWorkingDraft: false,
        },
      };
    }
  } else {
    targetDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  }

  const reasons: string[] = [];

  // 1. Has draft text
  const hasDraftText = !!targetDraft && targetDraft.blocks.length > 0;
  if (!hasDraftText) {
    reasons.push('当前任务尚无正文草稿，无法执行定稿');
  }

  // 2. Draft is a mutable working draft (cannot re-finalize immutable snapshot)
  const isWorkingDraft = !!targetDraft && !targetDraft.isFinal && !targetDraft.isHistoricalSnapshot;
  if (targetDraft && targetDraft.isFinal) {
    reasons.push('当前版本已是正式定稿归档快照，不可重复定稿；如需继续修改请编辑生成新工作稿');
  } else if (targetDraft && targetDraft.isHistoricalSnapshot) {
    reasons.push('当前版本属于历史快照，只读不可篡改；定稿必须基于当前工作草稿执行');
  }

  // 3. User is primary author (主笔甲)
  const isAuthor = role === '主笔甲';
  if (!isAuthor) {
    reasons.push(`权限受限：当前操作身份为【${role}】，定稿锁定公文仅允许“主笔甲”执行`);
  }

  // 4. Upstream fact snapshot, style, outline approved and evidence consistent
  let isUpstreamValid =
    task.outlineConfirmed === true &&
    task.styleConfirmed === true &&
    !!task.factSnapshot &&
    !!task.styleSnapshot &&
    !!task.outlineSnapshot;

  if (!isUpstreamValid) {
    reasons.push('前序审批已失效（事实快照缺失、文风快照缺失、大纲快照缺失或审批已撤销），无法定稿');
  } else {
    // 必须具备完整冻结事实快照依据（缺少冻结快照则严禁定稿）
    if (!targetDraft?.snapshotMetadata?.factSnapshot || !task.factSnapshot) {
      isUpstreamValid = false;
      reasons.push('草稿缺少冻结事实快照依据（历史依据不完整或未关联核准事实快照），禁止定稿');
    } else {
      const curSnap = task.factSnapshot;
      const draftSnap = targetDraft.snapshotMetadata.factSnapshot;
      const isItemsIdentical = JSON.stringify(curSnap.items) === JSON.stringify(draftSnap.items);
      const isConfirmedAtIdentical = (!curSnap.confirmedAt || !draftSnap.confirmedAt) ? true : curSnap.confirmedAt === draftSnap.confirmedAt;
      const isHashIdentical = (!curSnap.hash || !draftSnap.hash) ? true : curSnap.hash === draftSnap.hash;

      // 确认时间相同不能抵消内容差异！内容不同或审批版本不同均必须严密阻断
      if (!isItemsIdentical || !isConfirmedAtIdentical || !isHashIdentical) {
        isUpstreamValid = false;
        reasons.push('当前草稿生成依据与最新核准的事实快照不一致（事实依据内容或审批版本已变更，旧稿需重新起草或同步依据后方可定稿）');
      }
    }

    // 校验文风规范依据完整性与一致性：要求当前审批快照与稿件冻结快照均存在
    if (!task.styleSnapshot || !targetDraft?.snapshotMetadata?.styleSnapshot) {
      isUpstreamValid = false;
      reasons.push('文风规范审批依据缺失（任务未生成核准文风快照或草稿未冻结文风依据），禁止定稿');
    } else {
      const curStyle = task.styleSnapshot;
      const draftStyle = targetDraft.snapshotMetadata.styleSnapshot;
      const isRulesIdentical = JSON.stringify(curStyle.activeRuleIds) === JSON.stringify(draftStyle.activeRuleIds);
      const isTimeIdentical = (!curStyle.confirmedAt || !draftStyle.confirmedAt) ? true : curStyle.confirmedAt === draftStyle.confirmedAt;
      const isHashIdentical = (!curStyle.hash || !draftStyle.hash) ? true : curStyle.hash === draftStyle.hash;
      if (!isRulesIdentical || !isTimeIdentical || !isHashIdentical) {
        isUpstreamValid = false;
        reasons.push('当前草稿文风依据与最新核准的文风规范不一致，无法定稿');
      }
    }

    // 校验大纲结构依据完整性与一致性：要求当前审批快照与稿件冻结快照均存在
    if (!task.outlineSnapshot || !targetDraft?.snapshotMetadata?.outlineSnapshot) {
      isUpstreamValid = false;
      reasons.push('大纲结构审批依据缺失（任务未生成核准大纲快照或草稿未冻结大纲依据），禁止定稿');
    } else {
      const curOutline = task.outlineSnapshot;
      const draftOutline = targetDraft.snapshotMetadata.outlineSnapshot;
      const isSectionsIdentical = JSON.stringify(curOutline.sections) === JSON.stringify(draftOutline.sections);
      const isTimeIdentical = (!curOutline.confirmedAt || !draftOutline.confirmedAt) ? true : curOutline.confirmedAt === draftOutline.confirmedAt;
      const isHashIdentical = (!curOutline.hash || !draftOutline.hash) ? true : curOutline.hash === draftOutline.hash;
      if (!isSectionsIdentical || !isTimeIdentical || !isHashIdentical) {
        isUpstreamValid = false;
        reasons.push('当前草稿大纲结构与最新核准的大纲审批版本不一致，无法定稿');
      }
    }
  }

  // 5. Fact conflicts resolved or excluded
  const pendingConflicts = task.facts.filter(
    (f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded'
  );
  const pendingConflictsResolved = pendingConflicts.length === 0;
  if (!pendingConflictsResolved) {
    reasons.push(`存在 ${pendingConflicts.length} 项未裁决的事实指标口径冲突，无法定稿`);
  }

  // 6. Review comments closed:
  // Requirement 2: 待处理(pending)、待落实(accepted_pending_implementation)和待沟通(need_discussion)按版本关联检查，都不能定稿！
  const unclosedComments = task.reviewComments.filter((c) => {
    const isUnclosed =
      c.status === 'pending' ||
      c.status === 'accepted_pending_implementation' ||
      c.status === 'need_discussion';
    if (!isUnclosed) return false;

    // Check version association
    if (c.type === 'overall') return true;
    if (!c.targetVersionId) return true;
    if (targetDraft) {
      if (c.targetVersionId === targetDraft.id) return true;
      if (targetDraft.sourceDraftId && c.targetVersionId === targetDraft.sourceDraftId) {
        // If proposed on ancestor draft, and not implemented/rejected, still applies
        return true;
      }
      // If comment was proposed on current draft lineage
      return true;
    }
    return true;
  });

  const commentsClosed = unclosedComments.length === 0;
  if (!commentsClosed) {
    const pendingCount = unclosedComments.filter((c) => c.status === 'pending').length;
    const pendingImplCount = unclosedComments.filter((c) => c.status === 'accepted_pending_implementation').length;
    const needDiscussionCount = unclosedComments.filter((c) => c.status === 'need_discussion').length;

    const detailParts: string[] = [];
    if (pendingCount > 0) detailParts.push(`${pendingCount}条待处理`);
    if (pendingImplCount > 0) detailParts.push(`${pendingImplCount}条决定采纳待落实`);
    if (needDiscussionCount > 0) detailParts.push(`${needDiscussionCount}条待沟通`);

    reasons.push(`尚有未闭环的审阅意见（${detailParts.join('、')}），必须全部落实修改或拒绝说明后方可定稿`);
  }

  // 7. Critical blocking audit issues in the ACTUAL CURRENT TEXT
  let criticalAuditPassed = true;
  if (targetDraft && targetDraft.blocks.length > 0) {
    const liveIssues = runDocumentAudit(task, targetDraft.blocks, targetDraft.id);
    const blockingErrors = liveIssues.filter((i) => i.isBlocking && i.status === 'unresolved');
    if (blockingErrors.length > 0) {
      criticalAuditPassed = false;
      reasons.push(`正文中存在 ${blockingErrors.length} 项阻断级核校偏差（如指标冲突、单位混淆等），必须修正后方可定稿`);
    }
  }

  const canFinalize =
    hasDraftText &&
    isWorkingDraft &&
    isAuthor &&
    isUpstreamValid &&
    pendingConflictsResolved &&
    commentsClosed &&
    criticalAuditPassed;

  return {
    canFinalize,
    reasons,
    checks: {
      hasDraftText,
      isAuthor,
      isUpstreamValid,
      pendingConflictsResolved,
      commentsClosed,
      criticalAuditPassed,
      isWorkingDraft,
    },
  };
}

/**
 * Requirement 1 & 2: Finalizes the working draft into an immutable snapshot
 */
export function finalizeDraft(
  task: Task,
  draftId: string,
  activeRole: UserRole
): { success: boolean; error?: string; updatedTask?: Task; finalDraft?: DraftVersion } {
  const validation = validateFinalizationConditions(task, draftId, activeRole);
  if (!validation.canFinalize) {
    return { success: false, error: validation.reasons.join('；') };
  }

  let currentDraft: DraftVersion | undefined;
  if (draftId) {
    currentDraft = task.drafts.find((d) => d.id === draftId);
    if (!currentDraft) {
      return { success: false, error: `未找到指定版本【${draftId}】，拒绝定稿！` };
    }
  } else {
    currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    if (!currentDraft) {
      return { success: false, error: '未找到当前工作草稿，无法定稿' };
    }
  }
  const finalDraft: DraftVersion = {
    id: `DRAFT-FINAL-${Date.now()}`,
    versionNumber: '定稿 v2.0 (最终核定版)',
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: '经主笔核定、审阅意见全部闭环并完成事实口径核校后的正式定稿文件',
    blocks: JSON.parse(JSON.stringify(currentDraft.blocks)),
    isFinal: true,
    isHistoricalSnapshot: true,
    isWorkingDraft: false,
    finalizedAt: new Date().toISOString(),
    sourceDraftId: currentDraft.id,
    snapshotMetadata: currentDraft.snapshotMetadata,
    auditRecords: currentDraft.auditRecords,
    frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments)), // 冻结定稿时刻的审阅记录快照
  };

  const updatedTask: Task = {
    ...task,
    drafts: [finalDraft, ...task.drafts],
    currentDraftId: finalDraft.id,
    isFinalized: true,
    status: '已定稿',
    updatedAt: new Date().toISOString(),
  };

  return { success: true, updatedTask, finalDraft };
}
