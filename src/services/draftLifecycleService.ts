import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  UserRole, 
  FinalizationValidationResult,
  AuditIssue,
  SnapshotMetadata,
  DraftCandidate,
  RevisionSuggestion,
  ParagraphModificationLog,
  ModificationSource,
  ReviewCommentSnapshotBeforeChange,
  ReviewCommentSnapshotAfterChange,
  ReviewComment
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

  // 采纳候选版本处理：
  // 仅归档可编辑工作稿。若当前版本已经是历史快照或定稿快照，完整保留原版本属性与原冻结审阅记录，
  // 禁止用当前意见覆盖已冻结的审阅快照，只创建新工作稿并记录来源版本。
  if (currentDraft) {
    const isAlreadyImmutable = currentDraft.isHistoricalSnapshot === true || currentDraft.isFinal === true;
    if (isAlreadyImmutable) {
      // 保持原有历史/定稿快照完全不变，不重复归档或覆盖 frozenReviewComments
      archivedDraft = currentDraft;
    } else {
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
  }

  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: currentDraft
      ? `基于【${currentDraft.versionNumber}】${currentDraft.isFinal ? '定稿' : currentDraft.isHistoricalSnapshot ? '历史快照' : '归档'}后采纳新候选生成的工作稿`
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
  const nowIso = new Date().toISOString();

  // Helper to process updated blocks: increments revisionSeq on actually changed blocks
  const processUpdatedBlocks = (
    origBlocks: ParagraphBlock[],
    newBlocks: ParagraphBlock[]
  ): ParagraphBlock[] => {
    return newBlocks.map((b) => {
      const orig = origBlocks.find((o) => o.id === b.id);
      if (!orig) {
        // Newly added block
        return {
          ...b,
          updatedAt: b.updatedAt || nowIso,
          revisionSeq: typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) && b.revisionSeq > 0 ? b.revisionSeq : 1,
        };
      }

      const origSeq = typeof orig.revisionSeq === 'number' && Number.isFinite(orig.revisionSeq) && orig.revisionSeq > 0 ? orig.revisionSeq : 0;
      const isContentChanged = b.content !== orig.content;

      if (isContentChanged) {
        // Block content actually changed: automatically increment revision sequence
        const explicitSeq = typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : undefined;
        const nextSeq = (explicitSeq !== undefined && explicitSeq > origSeq) ? explicitSeq : origSeq + 1;
        const nextUpdatedAt = (b.updatedAt && b.updatedAt !== orig.updatedAt) ? b.updatedAt : nowIso;
        return {
          ...b,
          updatedAt: nextUpdatedAt,
          revisionSeq: nextSeq,
        };
      }

      // Content did not change
      return {
        ...b,
        revisionSeq: typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : origSeq,
      };
    });
  };

  if (isImmutable) {
    // Fork a new working draft and record sourceDraftId
    const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作草稿·基于${targetDraft.isFinal ? '定稿' : '历史快照'}修改)`;
    const rawNewBlocks = blockUpdater(JSON.parse(JSON.stringify(targetDraft.blocks)));
    const newBlocks = processUpdatedBlocks(targetDraft.blocks, rawNewBlocks);

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
    const rawUpdatedBlocks = blockUpdater(JSON.parse(JSON.stringify(targetDraft.blocks)));
    const updatedBlocks = processUpdatedBlocks(targetDraft.blocks, rawUpdatedBlocks);
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

/**
 * Unified Snapshot Creation Service:
 * Explicitly saves a read-only immutable snapshot of the current working draft,
 * freezing current snapshotMetadata and deeply freezing current reviewComments (frozenReviewComments).
 */
export function createDraftSnapshot(
  task: Task,
  draftId: string | undefined,
  summary: string,
  activeRole: UserRole
): { updatedTask: Task; snapshotDraft: DraftVersion } {
  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    throw new Error(perm.reason || '当前身份无权保存版本快照');
  }

  let targetDraft: DraftVersion | undefined;
  if (draftId) {
    targetDraft = task.drafts.find((d) => d.id === draftId);
    if (!targetDraft) {
      throw new Error(`未找到指定版本【${draftId}】，无法保存快照！`);
    }
  } else {
    targetDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    if (!targetDraft) {
      throw new Error('当前任务尚无正文草稿，无法保存快照！');
    }
  }

  const snapshotVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (只读快照·手动保存)`;
  const snapshotDraft: DraftVersion = {
    id: `DRAFT-SNAP-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: snapshotVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: summary.trim() || `主笔手动保存的历史版本快照（基于【${targetDraft.versionNumber}】）`,
    blocks: JSON.parse(JSON.stringify(targetDraft.blocks)),
    isFinal: false,
    isHistoricalSnapshot: true,
    isWorkingDraft: false,
    sourceDraftId: targetDraft.id,
    snapshotMetadata: targetDraft.snapshotMetadata ? JSON.parse(JSON.stringify(targetDraft.snapshotMetadata)) : undefined,
    auditRecords: targetDraft.auditRecords ? JSON.parse(JSON.stringify(targetDraft.auditRecords)) : [],
    frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments || [])),
  };

  const updatedTask: Task = {
    ...task,
    drafts: [snapshotDraft, ...task.drafts],
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, snapshotDraft };
}

/**
 * Unified Draft Version Restore Service:
 * Restores an older version by forking a brand-new working draft,
 * recording sourceDraftId, copying blocks and snapshotMetadata,
 * and preserving existing history drafts and snapshots unmodified!
 */
export function restoreDraftVersion(
  task: Task,
  restoreDraftId: string,
  activeRole: UserRole
): { updatedTask: Task; workingDraft: DraftVersion } {
  const perm = checkPermission(activeRole, 'restore_version');
  if (!perm.allowed) {
    throw new Error(perm.reason || '当前身份无权恢复历史版本');
  }

  const sourceDraft = task.drafts.find((d) => d.id === restoreDraftId);
  if (!sourceDraft) {
    throw new Error(`未找到待恢复的历史版本【${restoreDraftId}】！`);
  }

  const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作草稿·恢复自${sourceDraft.versionNumber})`;
  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: `基于历史版本【${sourceDraft.versionNumber}】恢复生成的新工作草稿`,
    blocks: JSON.parse(JSON.stringify(sourceDraft.blocks)),
    isFinal: false,
    isHistoricalSnapshot: false,
    isWorkingDraft: true,
    sourceDraftId: sourceDraft.id,
    snapshotMetadata: sourceDraft.snapshotMetadata ? JSON.parse(JSON.stringify(sourceDraft.snapshotMetadata)) : undefined,
    auditRecords: sourceDraft.auditRecords ? JSON.parse(JSON.stringify(sourceDraft.auditRecords)) : [],
  };

  const updatedTask: Task = {
    ...task,
    drafts: [newWorkingDraft, ...task.drafts],
    currentDraftId: newWorkingDraft.id,
    isFinalized: false,
    status: '起草中',
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, workingDraft: newWorkingDraft };
}

/**
 * Unified Submit for Review Service:
 * Associates the specific version and updates task status to '审阅中'.
 * Optionally creates an immutable baseline snapshot for the review round.
 */
export function submitDraftForReview(
  task: Task,
  draftId: string | undefined,
  activeRole: UserRole,
  createBaselineSnapshot: boolean = true
): { updatedTask: Task; workingDraft: DraftVersion; baselineSnapshot?: DraftVersion } {
  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    throw new Error(perm.reason || '仅主笔甲可提交文稿进入审阅阶段');
  }

  let targetDraft: DraftVersion | undefined;
  if (draftId) {
    targetDraft = task.drafts.find((d) => d.id === draftId);
  } else {
    targetDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  }
  if (!targetDraft) {
    throw new Error('当前任务尚无正文草稿，无法提交审阅！');
  }

  let updatedDrafts = [...task.drafts];
  let baselineSnapshot: DraftVersion | undefined;

  if (createBaselineSnapshot && !targetDraft.isHistoricalSnapshot && !targetDraft.isFinal) {
    baselineSnapshot = {
      id: `DRAFT-SNAP-REV-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      versionNumber: `v${(task.drafts.length + 1).toFixed(1)} (提交审阅基准快照)`,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: `提交审阅时自动保存的只读基准快照（基于【${targetDraft.versionNumber}】）`,
      blocks: JSON.parse(JSON.stringify(targetDraft.blocks)),
      isFinal: false,
      isHistoricalSnapshot: true,
      isWorkingDraft: false,
      sourceDraftId: targetDraft.id,
      snapshotMetadata: targetDraft.snapshotMetadata ? JSON.parse(JSON.stringify(targetDraft.snapshotMetadata)) : undefined,
      auditRecords: targetDraft.auditRecords ? JSON.parse(JSON.stringify(targetDraft.auditRecords)) : [],
      frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments || [])),
    };
    updatedDrafts = [baselineSnapshot, ...updatedDrafts];
  }

  const reviewBaseId = baselineSnapshot?.id || targetDraft.id;
  const nextRound = (task.currentReviewRound || 0) + 1;

  const updatedTask: Task = {
    ...task,
    drafts: updatedDrafts,
    currentStage: 'review',
    status: '审阅中',
    reviewBaseDraftId: reviewBaseId,
    currentReviewRound: nextRound,
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, workingDraft: targetDraft, baselineSnapshot };
}

export const MAX_MODIFICATION_LOGS = 20;

export interface ParagraphSuggestionValidationParams {
  task: Task;
  currentDraft: DraftVersion | undefined;
  suggestion: RevisionSuggestion;
  pendingTextToAdopt: string;
  activeCompletedRunId: string | null;
  activeRole: UserRole;
  isGenerating?: boolean;
}

export interface ParagraphSuggestionValidationResult {
  valid: boolean;
  reason?: string;
  targetBlock?: ParagraphBlock;
  isFineTuned: boolean;
  isZeroDiff: boolean;
  isModifiedAfter: boolean;
  isTaskMismatch: boolean;
  isDraftVersionMismatch: boolean;
  isSupersededRun: boolean;
  isTargetBlockMissing: boolean;
}

/**
 * Shared validation function for paragraph suggestion adoption.
 * Used across UI button states, tooltips, warnings, and actual adoption execution.
 */
export function validateParagraphSuggestionAcceptance(
  params: ParagraphSuggestionValidationParams
): ParagraphSuggestionValidationResult {
  const {
    task,
    currentDraft,
    suggestion,
    pendingTextToAdopt,
    activeCompletedRunId,
    activeRole,
    isGenerating,
  } = params;

  const targetBlock = currentDraft?.blocks.find((b) => b.id === suggestion.targetBlockId);
  const isTargetBlockMissing = !targetBlock;
  const isTaskMismatch = Boolean(suggestion.taskId && suggestion.taskId !== task.id);
  const isDraftVersionMismatch = Boolean(
    suggestion.sourceDraftId &&
    currentDraft &&
    suggestion.sourceDraftId !== currentDraft.id
  );
  const isModifiedAfter = Boolean(targetBlock && targetBlock.content !== suggestion.baseContent);
  const isZeroDiff = Boolean(targetBlock && pendingTextToAdopt === targetBlock.content);
  const isSupersededRun = Boolean(
    !activeCompletedRunId ||
    !suggestion.runId ||
    activeCompletedRunId !== suggestion.runId
  );
  const isFineTuned = Boolean(
    pendingTextToAdopt !== suggestion.suggestedText
  );

  const perm = checkPermission(activeRole, 'adopt_revision');
  if (!perm.allowed) {
    return {
      valid: false,
      reason: perm.reason || `权限受限：当前身份为【${activeRole}】，仅主笔甲可采纳修改正文`,
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isGenerating) {
    return {
      valid: false,
      reason: '新建议生成中或请求进行中，不可采纳旧建议',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isTaskMismatch) {
    return {
      valid: false,
      reason: '建议失效：该修改建议属于其他公文任务，不可跨任务采纳',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isDraftVersionMismatch) {
    return {
      valid: false,
      reason: '建议失效：该修改建议基于其他草稿版本生成，当前工作版本已变更，不可采纳',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isSupersededRun) {
    const runReason = !activeCompletedRunId
      ? '建议已失效：没有已完成的有效运行记录（请求未完成或已被取消），不可采纳建议'
      : (!suggestion.runId || activeCompletedRunId !== suggestion.runId)
      ? '建议已失效：该建议所属运行ID与当前有效运行ID不一致（已生成新建议或已重置）'
      : '建议已失效：运行记录失效，不可采纳';
    return {
      valid: false,
      reason: runReason,
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (currentDraft && (currentDraft.isHistoricalSnapshot || currentDraft.isFinal)) {
    return {
      valid: false,
      reason: '当前版本为只读历史快照或已定稿，不可直接采纳修改；请先创建新工作稿',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isTargetBlockMissing) {
    return {
      valid: false,
      reason: '建议已失效：未在当前版本找到该建议的目标段落，可能已被删除或重构',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isModifiedAfter) {
    return {
      valid: false,
      reason: '目标段落基准自建议生成后已被人工编辑修改，基准变动导致建议已失效，无法采纳覆盖',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (suggestion.isUnsupportedPrompt) {
    return {
      valid: false,
      reason: '未支持的自定义指令，无法采纳',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  if (isZeroDiff) {
    return {
      valid: false,
      reason: '待采纳文本与当前段落正文完全一致（零差异），无需替换且不能标记审阅意见为已落实',
      targetBlock,
      isFineTuned,
      isZeroDiff,
      isModifiedAfter,
      isTaskMismatch,
      isDraftVersionMismatch,
      isSupersededRun,
      isTargetBlockMissing,
    };
  }

  return {
    valid: true,
    targetBlock,
    isFineTuned,
    isZeroDiff,
    isModifiedAfter,
    isTaskMismatch,
    isDraftVersionMismatch,
    isSupersededRun,
    isTargetBlockMissing,
  };
}

export interface AdoptParagraphSuggestionResult {
  updatedTask: Task;
  workingDraft: DraftVersion;
  logEntry: ParagraphModificationLog;
  targetBlock: ParagraphBlock;
}

/**
 * Unified service for adopting a paragraph suggestion (AI original or fine-tuned).
 * Enforces role permission, task/version boundaries, run ID, target block baseline check,
 * and zero-difference check.
 * Updates review comments if applicable, captures prior comment state, and appends to modificationLogs.
 */
export function adoptParagraphSuggestion(
  params: ParagraphSuggestionValidationParams
): AdoptParagraphSuggestionResult {
  const validation = validateParagraphSuggestionAcceptance(params);
  if (!validation.valid || !validation.targetBlock) {
    throw new Error(validation.reason || '无法采纳修改建议');
  }

  const { task, currentDraft, suggestion, pendingTextToAdopt, activeRole } = params;
  const draftIdToUse = currentDraft?.id || task.currentDraftId;
  const targetBlock = validation.targetBlock;
  const isFineTuned = validation.isFineTuned;
  const finalContent = pendingTextToAdopt; // 原样写入最终待采纳文本，不进行 trim()

  const isReviewerReplacement = Boolean(
    suggestion.isReviewerReplacement ||
    suggestion.sourceCommentType === 'replacement' ||
    (suggestion.diffExplanation && suggestion.diffExplanation.includes('替换稿'))
  );

  const actionDescription = isReviewerReplacement
    ? isFineTuned
      ? `采纳第${targetBlock.order}段【${suggestion.sourceCommentReviewer || '审阅人'}】审阅替换稿（人工微调）`
      : `采纳第${targetBlock.order}段【${suggestion.sourceCommentReviewer || '审阅人'}】审阅替换稿`
    : isFineTuned
    ? `采纳第${targetBlock.order}段微调建议`
    : suggestion.action === 'custom'
    ? `执行第${targetBlock.order}段自定义改写【${suggestion.customPrompt?.slice(0, 16) || ''}】`
    : `采纳第${targetBlock.order}段修改建议（${suggestion.action}）`;

  // Apply content modification to draft
  const { updatedTask: taskWithModifiedDraft, workingDraft } = applyDraftContentChange(
    task,
    draftIdToUse,
    (blocks) =>
      blocks.map((b) =>
        b.id === targetBlock.id
          ? { ...b, content: finalContent }
          : b
      ),
    actionDescription,
    activeRole
  );

  // 采纳日志从实际写入结果取得时间戳与序号
  const writtenBlock = workingDraft.blocks.find((b) => b.id === targetBlock.id) || targetBlock;
  const appliedBlockUpdatedAt = writtenBlock.updatedAt || new Date().toISOString();
  const appliedRevisionSeq = typeof writtenBlock.revisionSeq === 'number' && Number.isFinite(writtenBlock.revisionSeq)
    ? writtenBlock.revisionSeq
    : ((targetBlock.revisionSeq || 0) + 1);

  // If associated with a review comment, record previous comment state and update ONLY this comment
  let previousCommentState: ReviewCommentSnapshotBeforeChange | undefined;
  let postAdoptionCommentState: ReviewCommentSnapshotAfterChange | undefined;
  let updatedComments = taskWithModifiedDraft.reviewComments;

  if (suggestion.sourceCommentId) {
    const existingCmt = taskWithModifiedDraft.reviewComments.find((c) => c.id === suggestion.sourceCommentId);
    if (existingCmt) {
      previousCommentState = {
        status: existingCmt.status,
        authorReply: existingCmt.authorReply,
        decisionReason: existingCmt.decisionReason,
        resolutionType: existingCmt.resolutionType,
        implementationDraftId: existingCmt.implementationDraftId,
        implementationVersionNumber: existingCmt.implementationVersionNumber,
        implementationBlockId: existingCmt.implementationBlockId,
        implementedAt: existingCmt.implementedAt,
      };

      const adoptedReply = isReviewerReplacement
        ? isFineTuned
          ? `主笔已采纳微调后的审阅替换稿并更新第${targetBlock.order}段正文。`
          : `主笔已采纳审阅替换稿并更新第${targetBlock.order}段正文。`
        : isFineTuned
        ? `主笔已采纳微调后的建议并更新第${targetBlock.order}段正文。`
        : `主笔已采纳修改建议并更新第${targetBlock.order}段正文。`;
      const adoptedDecisionReason = isReviewerReplacement
        ? isFineTuned
          ? `审阅替换稿微调采纳（原建议：${suggestion.diffExplanation}）`
          : `审阅替换稿采纳（${suggestion.diffExplanation}）`
        : isFineTuned
        ? `人工微调采纳（原建议：${suggestion.diffExplanation}）`
        : suggestion.diffExplanation;
      const implementedAt = new Date().toISOString();

      updatedComments = taskWithModifiedDraft.reviewComments.map((cmt) => {
        if (cmt.id === suggestion.sourceCommentId) {
          const updatedCmt: ReviewComment = {
            ...cmt,
            status: 'implemented' as const,
            authorReply: adoptedReply,
            decisionReason: adoptedDecisionReason,
            resolutionType: 'text_modified' as const,
            implementationDraftId: workingDraft.id,
            implementationVersionNumber: workingDraft.versionNumber,
            implementationBlockId: targetBlock.id,
            implementedAt,
          };

          postAdoptionCommentState = {
            status: updatedCmt.status,
            authorReply: updatedCmt.authorReply,
            decisionReason: updatedCmt.decisionReason,
            resolutionType: updatedCmt.resolutionType,
            implementationDraftId: updatedCmt.implementationDraftId,
            implementationVersionNumber: updatedCmt.implementationVersionNumber,
            implementationBlockId: updatedCmt.implementationBlockId,
            implementedAt: updatedCmt.implementedAt,
            currentBlockId: updatedCmt.currentBlockId,
            targetBlockId: updatedCmt.targetBlockId,
            reboundAt: updatedCmt.rebindRecord?.reboundAt,
          };

          return updatedCmt;
        }
        return cmt;
      });
    }
  }

  // Determine modification source with clear reviewer replacement distinction
  const logSource: ModificationSource = isReviewerReplacement
    ? isFineTuned
      ? 'reviewer_replacement_fine_tuned'
      : 'reviewer_replacement'
    : isFineTuned
    ? 'ai_suggestion_fine_tuned'
    : 'ai_suggestion';

  // Create modification log entry
  const logEntry: ParagraphModificationLog = {
    id: `MOD-LOG-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
    taskId: task.id,
    draftId: workingDraft.id,
    blockId: targetBlock.id,
    blockOrder: targetBlock.order,
    timestamp: new Date().toISOString(),
    source: logSource,
    sourceDescription: actionDescription,
    beforeContent: targetBlock.content,
    afterContent: finalContent,
    aiOriginalSuggestedText: suggestion.suggestedText,
    reviewerOriginalReplacementText: isReviewerReplacement ? suggestion.suggestedText : undefined,
    isReviewerReplacement,
    isFineTuned,
    associatedCommentId: suggestion.sourceCommentId,
    associatedCommentReviewer: suggestion.sourceCommentReviewer,
    previousCommentState,
    postAdoptionCommentState,
    appliedBlockUpdatedAt,
    appliedRevisionSeq,
    status: 'applied',
  };

  const currentLogs = task.modificationLogs || [];
  const updatedLogs = [logEntry, ...currentLogs].slice(0, MAX_MODIFICATION_LOGS);

  const finalUpdatedTask: Task = {
    ...taskWithModifiedDraft,
    reviewComments: updatedComments,
    modificationLogs: updatedLogs,
    updatedAt: new Date().toISOString(),
  };

  return {
    updatedTask: finalUpdatedTask,
    workingDraft,
    logEntry,
    targetBlock: writtenBlock,
  };
}

export interface ValidateUndoEligibilityResult {
  canUndo: boolean;
  reason?: string;
  log?: ParagraphModificationLog;
  targetBlock?: ParagraphBlock;
  associatedComment?: ReviewComment;
}

/**
 * Validates whether a specific modification log is eligible for safe undo.
 * Enforces role permissions, working draft mutability, draft ID match,
 * latest applied operation condition, target block existence, unmodified text check,
 * and review comment state consistency.
 */
export function validateUndoEligibility(
  task: Task,
  currentDraft: DraftVersion | undefined,
  logId: string,
  activeRole: UserRole
): ValidateUndoEligibilityResult {
  const perm = checkPermission(activeRole, 'adopt_revision');
  if (!perm.allowed) {
    return { canUndo: false, reason: `权限受限：当前身份为【${activeRole}】，仅主笔甲可执行正文撤销` };
  }

  if (!currentDraft) {
    return { canUndo: false, reason: '未找到当前文稿，无法执行撤销' };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || task.isFinalized) {
    return { canUndo: false, reason: '当前文稿已归档/定稿或为只读历史快照，禁止撤销正文修改' };
  }

  const logs = task.modificationLogs || [];
  const log = logs.find((l) => l.id === logId);
  if (!log) {
    return { canUndo: false, reason: '未找到指定的修改记录' };
  }

  if (log.draftId !== currentDraft.id) {
    return { canUndo: false, reason: '稿件版本已切换（该修改属于其他版本），不支持跨版本撤销' };
  }

  if (log.status === 'undone') {
    return { canUndo: false, reason: '该操作此前已被撤销，不可重复撤销' };
  }

  // Must be the latest applied operation on this specific working draft
  const latestAppliedOnDraft = logs.find((l) => l.draftId === currentDraft.id && l.status === 'applied');
  if (latestAppliedOnDraft && latestAppliedOnDraft.id !== log.id) {
    return { canUndo: false, reason: '该操作不是当前工作稿的最近一次局部采纳（已有后续修改操作），不可跨历史操作跳跃撤销' };
  }

  const targetBlock = currentDraft.blocks.find((b) => b.id === log.blockId);
  if (!targetBlock) {
    return { canUndo: false, reason: '目标段落已在正文中删除或合并，无法安全恢复原内容' };
  }

  if (targetBlock.content !== log.afterContent) {
    return { canUndo: false, reason: '目标段落在此次采纳后已被后续人工编辑或修改，正文已变动，不可覆盖后续最新正文' };
  }

  // 必须具有采纳时的段落安全存证。旧日志缺少安全依据时保留展示，保守禁用撤销。
  if (!log.appliedBlockUpdatedAt) {
    return { canUndo: false, reason: '该修改记录缺少段落安全存证依据（段落时间戳缺失），为保护数据一致性，已保守禁用撤销' };
  }

  if (targetBlock.updatedAt !== log.appliedBlockUpdatedAt) {
    return { canUndo: false, reason: '目标段落在此次采纳后已被后续人工编辑修改（段落时间戳已更新），即使正文内容相同，亦不可覆盖后续操作' };
  }

  // 必须具有采纳时的修改序号安全存证。旧日志或段落缺少安全依据时保留展示，保守禁用撤销。
  if (typeof log.appliedRevisionSeq !== 'number' || !Number.isFinite(log.appliedRevisionSeq)) {
    return { canUndo: false, reason: '该修改记录缺少修改序号安全存证依据（采纳序号缺失），为保护数据一致性，已保守禁用撤销' };
  }

  if (typeof targetBlock.revisionSeq !== 'number' || !Number.isFinite(targetBlock.revisionSeq)) {
    return { canUndo: false, reason: '目标段落缺少修改序号安全存证依据（段落序号缺失），为保护数据一致性，已保守禁用撤销' };
  }

  if (targetBlock.revisionSeq !== log.appliedRevisionSeq) {
    return { canUndo: false, reason: '目标段落在此次采纳后已有后续修改序号，不可跨操作撤销' };
  }

  // If associated with a review comment, verify the comment has not been subsequently handled
  let associatedComment: ReviewComment | undefined;
  if (log.associatedCommentId) {
    associatedComment = task.reviewComments.find((c) => c.id === log.associatedCommentId);
    if (!associatedComment) {
      return { canUndo: false, reason: '关联审阅意见已不存在，无法校验意见状态' };
    }

    // 必须具有采纳后的意见状态存证。旧日志缺少安全依据时保留展示，保守禁用撤销。
    if (!log.postAdoptionCommentState) {
      return { canUndo: false, reason: '该记录关联审阅意见但缺少采纳后意见快照存证，为保护审阅沟通记录，已保守禁用撤销' };
    }

    const postState = log.postAdoptionCommentState;
    if (associatedComment.status !== postState.status) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后已被重新处理（意见状态已改变），为保护后续审阅沟通记录，阻断撤销' };
    }
    if (associatedComment.authorReply !== postState.authorReply) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后回复说明已被修改，为保护后续回复内容，阻断撤销' };
    }
    if (associatedComment.decisionReason !== postState.decisionReason) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后处理说明已被修改，为保护后续审阅决定，阻断撤销' };
    }
    if (associatedComment.resolutionType !== postState.resolutionType) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后处理方式已被修改，阻断撤销' };
    }
    if (
      associatedComment.implementationBlockId !== postState.implementationBlockId ||
      associatedComment.implementationDraftId !== postState.implementationDraftId
    ) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后已被重新指定或另行落实，阻断撤销' };
    }
    if (
      associatedComment.currentBlockId !== postState.currentBlockId ||
      associatedComment.rebindRecord?.reboundAt !== postState.reboundAt
    ) {
      return { canUndo: false, reason: '关联审阅意见在此次采纳后已被重新绑定段落，为保护最新定位存证，阻断撤销' };
    }
  }

  return {
    canUndo: true,
    log,
    targetBlock,
    associatedComment,
  };
}

export interface UndoSafeParagraphModificationResult {
  updatedTask: Task;
  workingDraft: DraftVersion;
  undoneLog: ParagraphModificationLog;
  targetBlock: ParagraphBlock;
}

/**
 * Unified service to safely undo a paragraph modification.
 * Restores target block content, reverts associated review comment state (if applicable),
 * and marks the modification log as undone without deleting the evidentiary record.
 */
export function undoSafeParagraphModification(
  task: Task,
  currentDraft: DraftVersion | undefined,
  logId: string,
  activeRole: UserRole
): UndoSafeParagraphModificationResult {
  const validation = validateUndoEligibility(task, currentDraft, logId, activeRole);
  if (!validation.canUndo || !validation.log || !validation.targetBlock) {
    throw new Error(validation.reason || '无法撤销该修改');
  }

  const log = validation.log;
  const targetBlock = validation.targetBlock;
  const draftIdToUse = currentDraft?.id || task.currentDraftId;

  // Restore target block content back to beforeContent
  const { updatedTask: taskWithRevertedDraft, workingDraft } = applyDraftContentChange(
    task,
    draftIdToUse,
    (blocks) =>
      blocks.map((b) =>
        b.id === targetBlock.id
          ? {
              ...b,
              content: log.beforeContent,
              updatedAt: new Date().toISOString(),
              revisionSeq: (b.revisionSeq || 0) + 1,
            }
          : b
      ),
    `撤销第${log.blockOrder || targetBlock.order}段采纳修改（恢复原正文）`,
    activeRole
  );

  // Restore associated review comment state if applicable
  let updatedComments = taskWithRevertedDraft.reviewComments;
  if (log.associatedCommentId && log.previousCommentState) {
    const prev = log.previousCommentState;
    updatedComments = taskWithRevertedDraft.reviewComments.map((cmt) => {
      if (cmt.id === log.associatedCommentId) {
        return {
          ...cmt,
          status: prev.status,
          authorReply: prev.authorReply,
          decisionReason: prev.decisionReason,
          resolutionType: prev.resolutionType,
          implementationDraftId: prev.implementationDraftId,
          implementationVersionNumber: prev.implementationVersionNumber,
          implementationBlockId: prev.implementationBlockId,
          implementedAt: prev.implementedAt,
        };
      }
      return cmt;
    });
  }

  // Update log entry status to 'undone' (keep record intact for evidentiary purposes)
  const updatedLogs = (taskWithRevertedDraft.modificationLogs || []).map((l) => {
    if (l.id === log.id) {
      const undoneItem: ParagraphModificationLog = {
        ...l,
        status: 'undone' as const,
        undoneAt: new Date().toISOString(),
        undoneBy: activeRole,
        undoReason: '主笔安全撤销最近局部采纳修改（已精准恢复原正文与关联意见状态）',
      };
      return undoneItem;
    }
    return l;
  });

  const finalUpdatedTask: Task = {
    ...taskWithRevertedDraft,
    reviewComments: updatedComments,
    modificationLogs: updatedLogs,
    updatedAt: new Date().toISOString(),
  };

  const undoneLog = updatedLogs.find((l) => l.id === log.id)!;

  return {
    updatedTask: finalUpdatedTask,
    workingDraft,
    undoneLog,
    targetBlock,
  };
}

/**
 * Returns recent modification logs for a specific draft or all drafts,
 * sorted latest first.
 */
export function getRecentModificationLogs(task: Task, draftId?: string): ParagraphModificationLog[] {
  const allLogs = task.modificationLogs || [];
  const safeLogs = allLogs.filter((l) => l && typeof l === 'object');
  if (!draftId) return safeLogs;
  return safeLogs.filter((l) => l.draftId === draftId);
}

/**
 * Returns the latest applied log that may be eligible for undo on the given draft.
 */
export function getLatestAppliedLogForDraft(task: Task, draftId: string): ParagraphModificationLog | undefined {
  const logs = task.modificationLogs || [];
  return logs.find((l) => l && typeof l === 'object' && l.draftId === draftId && l.status === 'applied');
}

