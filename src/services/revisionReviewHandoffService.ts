import {
  Task,
  DraftVersion,
  UserRole,
  PostRevisionEvidenceInfo,
  PostRevisionFactInfo,
  PostRevisionBlockInfo,
  PostRevisionVerificationCredential,
  PostRevisionVerificationRecord,
  PostRevisionVerificationOverview,
  RevisionReviewHandoffSummary,
  RevisionReviewHandoffBlockDetail,
} from '../types';
import { checkPermission } from './permissionService';
import {
  evaluatePostRevisionVerification,
  isValidVerificationCredential,
} from './postRevisionVerificationService';
import { getApplicableReviewDraftIds } from './draftLifecycleService';

/**
 * Resolves whether the task has a formal review baseline snapshot.
 * Distinguishes genuine baseline snapshots from fallback working drafts.
 */
export function getFormalReviewBaseline(
  task: Task,
  currentDraft?: DraftVersion,
  explicitReviewBaseDraft?: DraftVersion
): { reviewBaseDraft?: DraftVersion; isFormalBaseline: boolean; isFallback: boolean } {
  const base = explicitReviewBaseDraft || (task.reviewBaseDraftId ? task.drafts.find((d) => d.id === task.reviewBaseDraftId) : undefined);
  if (!base) {
    const fallback = currentDraft || task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    return { reviewBaseDraft: fallback, isFormalBaseline: false, isFallback: true };
  }

  const activeDraft = currentDraft || task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const isApplicable = activeDraft ? getApplicableReviewDraftIds(task, activeDraft).has(base.id) : true;

  if (isApplicable && (base.isHistoricalSnapshot || base.summary?.includes('提交审阅') || base.id === task.reviewBaseDraftId)) {
    return { reviewBaseDraft: base, isFormalBaseline: true, isFallback: false };
  }

  return { reviewBaseDraft: activeDraft, isFormalBaseline: false, isFallback: true };
}

/**
 * Determines whether the current working draft text has actually been modified from the baseline.
 * CRITICAL RULE: Changes ONLY to verification records, review comments, or notes MUST NOT be treated as text changes!
 */
export function isDraftContentModifiedFromBaseline(
  baseDraft: DraftVersion | undefined,
  currentDraft: DraftVersion | undefined
): boolean {
  if (!baseDraft || !currentDraft) return false;
  if (baseDraft.id === currentDraft.id) return false;

  if (baseDraft.blocks.length !== currentDraft.blocks.length) return true;

  for (let i = 0; i < baseDraft.blocks.length; i++) {
    const bBlock = baseDraft.blocks[i];
    const cBlock = currentDraft.blocks.find((b) => b.id === bBlock.id);
    if (!cBlock) return true;
    if (bBlock.content !== cBlock.content) return true;
  }

  return false;
}

/**
 * Computes a fingerprint representing the submission preview context.
 * Used to detect whether draft content, facts, review round, or verification records changed
 * between opening the submit confirmation modal and clicking confirm.
 */
export function computeSubmitReviewFreshnessHash(
  task: Task,
  draft: DraftVersion | string,
  activeRole: UserRole = '主笔甲'
): string {
  const actualDraft = typeof draft === 'string' ? task.drafts.find((d) => d.id === draft) : draft;
  if (!actualDraft) return '';

  const draftContentKey = (actualDraft.blocks || [])
    .map((b) => `${b.id}:${b.content}:${b.revisionSeq ?? 0}`)
    .join('|');
  const verifRecordsKey = (actualDraft.postRevisionVerificationRecords || [])
    .map((r) => `${r.blockId}:${r.status}:${r.notes || ''}:${r.deferredReason || ''}:${r.revocation?.reason || ''}`)
    .join('|');
  const factsKey = (task.facts || [])
    .map((f) => `${f.id}:${f.value}:${f.status}:${f.selectedConflictValue || ''}`)
    .join('|');

  return [
    task.id,
    actualDraft.id,
    activeRole,
    task.currentReviewRound || 0,
    draftContentKey,
    verifRecordsKey,
    factsKey,
    actualDraft.postRevisionVerificationCredential?.operationId || '',
  ].join('##');
}

export interface SubmitReviewValidationResult {
  valid: boolean;
  reason?: string;
  isStale?: boolean;
}

/**
 * Validates the submission context before finalizing submitDraftForReview.
 * Supports both options-object signature and positional arguments signature.
 */
export function validateSubmitReviewContext(
  paramsOrTask:
    | Task
    | {
        task: Task;
        currentDraft?: DraftVersion | string;
        activeRole?: UserRole;
        previewSnapshotHash?: string;
      },
  draftOrId?: DraftVersion | string,
  activeRoleArg?: UserRole,
  previewSnapshotHashArg?: string
): SubmitReviewValidationResult {
  let task: Task;
  let currentDraft: DraftVersion | undefined;
  let activeRole: UserRole;
  let previewSnapshotHash: string | undefined;

  if ('task' in paramsOrTask) {
    task = paramsOrTask.task;
    const d = paramsOrTask.currentDraft;
    currentDraft = typeof d === 'string' ? task.drafts.find((item) => item.id === d) : d;
    activeRole = paramsOrTask.activeRole || '主笔甲';
    previewSnapshotHash = paramsOrTask.previewSnapshotHash;
  } else {
    task = paramsOrTask;
    currentDraft = typeof draftOrId === 'string' ? task.drafts.find((item) => item.id === draftOrId) : draftOrId;
    activeRole = activeRoleArg || '主笔甲';
    previewSnapshotHash = previewSnapshotHashArg;
  }

  if (!currentDraft) {
    return { valid: false, reason: '当前无有效工作稿可送审' };
  }

  if (activeRole !== '主笔甲' && activeRole !== task.primaryAuthor) {
    return {
      valid: false,
      reason: `只有主笔角色（${task.primaryAuthor || '主笔甲'}）有权提交文稿进入审阅阶段，当前身份【${activeRole}】无权操作`,
    };
  }

  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    return { valid: false, reason: perm.reason || '当前身份无权提交审阅' };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || !currentDraft.isWorkingDraft) {
    return { valid: false, reason: '历史版本与定稿为只读归档，不可重复提交审阅' };
  }

  if (previewSnapshotHash) {
    const currentHash = computeSubmitReviewFreshnessHash(task, currentDraft, activeRole);
    if (currentHash !== previewSnapshotHash) {
      return {
        valid: false,
        isStale: true,
        reason: '文稿正文、事实依据或核对情况已发生变化，请查阅最新交接摘要后重新确认提交',
      };
    }
  }

  return { valid: true };
}

/**
 * Builds the complete revision review handoff summary from the review baseline draft.
 * Pure function: does not mutate task, drafts, or comments.
 */
export function buildRevisionReviewHandoffSummary(
  task: Task,
  reviewBaseDraft: DraftVersion | undefined,
  currentDraft?: DraftVersion
): RevisionReviewHandoffSummary {
  const disclaimer = '主笔人工核对记录仅供审阅参考，不代表审阅通过、系统核验无误或可以最终定稿。';

  const formalCheck = getFormalReviewBaseline(task, currentDraft, reviewBaseDraft);
  if (!formalCheck.isFormalBaseline || !formalCheck.reviewBaseDraft) {
    const fallbackSummaryText = '尚未提交本轮审阅 / 当前仅为工作稿参考';
    return {
      hasFormalBaseline: false,
      isFallbackOnly: true,
      reviewRound: task.currentReviewRound || 1,
      baseDraftId: reviewBaseDraft?.id,
      baseDraftVersionNumber: reviewBaseDraft?.versionNumber,
      hasCredential: false,
      isSourceReferenceOnly: false,
      isAdoptedSourceReferenceOnly: false,
      factsCount: 0,
      uniqueBlocksCount: 0,
      verifiedCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      invalidatedCount: 0,
      isAllVerified: false,
      statusSummaryText: fallbackSummaryText,
      statusMessage: fallbackSummaryText,
      disclaimer,
      facts: [],
      blocks: [],
      isCurrentDraftContentModified: false,
    };
  }

  const base = formalCheck.reviewBaseDraft;
  const isCurrentDraftContentModified = isDraftContentModifiedFromBaseline(base, currentDraft);

  const cred = base.postRevisionVerificationCredential;
  const isSourceReferenceOnly = Boolean(!cred && base.sourcePostRevisionVerificationCredential);

  if (!cred || !isValidVerificationCredential(cred) || cred.taskId !== task.id) {
    const hasDegraded = Boolean(base.postRevisionVerificationRecovery || (cred && !isValidVerificationCredential(cred)));
    const statusSummaryText = isSourceReferenceOnly
      ? '本轮送审基准源自历史恢复稿（仅保留历史来源稿事实修订追溯参考，未携带活动事实修订凭据）'
      : hasDegraded
      ? '本轮送审基准修订凭据异常，已安全降级处理'
      : '本轮送审基准未包含事实修订凭据';

    return {
      hasFormalBaseline: true,
      isFallbackOnly: false,
      reviewRound: base.submittedReviewRound || task.currentReviewRound || 1,
      submittedAt: base.createdAt,
      submittedBy: base.author,
      baseDraftId: base.id,
      baseDraftVersionNumber: base.versionNumber,
      hasCredential: false,
      isSourceReferenceOnly,
      isAdoptedSourceReferenceOnly: isSourceReferenceOnly,
      factsCount: 0,
      uniqueBlocksCount: 0,
      verifiedCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      invalidatedCount: 0,
      isAllVerified: false,
      statusSummaryText,
      statusMessage: statusSummaryText,
      disclaimer,
      facts: [],
      blocks: [],
      isCurrentDraftContentModified,
      degradedNotice: hasDegraded ? '修订核对数据格式异常已降级隔离，正文与审阅功能正常可用' : undefined,
    };
  }

  // Evaluate post-revision verification on base snapshot
  const evalOverview: PostRevisionVerificationOverview =
    base.frozenPostRevisionVerificationOverview &&
    base.frozenPostRevisionVerificationOverview.hasCredential &&
    base.frozenPostRevisionVerificationOverview.operationId === cred.operationId
      ? JSON.parse(JSON.stringify(base.frozenPostRevisionVerificationOverview))
      : evaluatePostRevisionVerification(task, base);

  // Build block details deduplicated by stable block ID
  const blocks: RevisionReviewHandoffBlockDetail[] = [];
  const evalMap = new Map(evalOverview.blockEvaluations.map((e) => [e.blockId, e]));
  const recordMap = new Map((base.postRevisionVerificationRecords || []).map((r) => [r.blockId, r]));

  for (const credBlock of cred.blocks) {
    const baseBlock = base.blocks.find((b) => b.id === credBlock.blockId);
    const submittedContent = baseBlock?.content ?? credBlock.afterContent;
    const hasEditedAfterAdoption = baseBlock ? baseBlock.content !== credBlock.afterContent : false;

    const associatedFactNames = credBlock.associatedFactIds.map((fid) => {
      const f = cred.facts.find((fact) => fact.factId === fid);
      return f ? `${f.metric}（${f.fromValue}${f.unit}➔${f.toValue}${f.unit}）` : fid;
    });

    const ev = evalMap.get(credBlock.blockId);
    const rec = recordMap.get(credBlock.blockId);

    const status = ev?.displayStatus || (rec ? (rec.status as any) : 'pending');
    const statusLabel = ev?.displayStatusLabel || (status === 'verified' ? '已记录核对' : status === 'deferred' ? '暂缓处理' : '待核对');

    blocks.push({
      blockId: credBlock.blockId,
      blockOrder: credBlock.blockOrder,
      sectionTitle: credBlock.sectionTitle || baseBlock?.sectionId,
      associatedFactIds: [...credBlock.associatedFactIds],
      associatedFactNames,
      beforeContent: credBlock.beforeContent,
      afterContent: credBlock.afterContent,
      submittedContent,
      hasEditedAfterAdoption,
      status,
      statusLabel,
      notes: rec?.notes,
      verifiedBy: rec?.verifiedBy,
      verifiedAt: rec?.verifiedAt,
      deferredBy: rec?.deferredBy,
      deferredAt: rec?.deferredAt,
      deferredReason: rec?.deferredReason,
      invalidatedReason: ev?.invalidatedReason,
      events: rec ? [...(rec.events || rec.history || [])] : [],
    });
  }

  const factsCount = cred.facts.length;
  const uniqueBlocksCount = cred.blocks.length;

  return {
    hasFormalBaseline: true,
    isFallbackOnly: false,
    reviewRound: base.submittedReviewRound || task.currentReviewRound || 1,
    submittedAt: base.createdAt,
    submittedBy: base.author,
    baseDraftId: base.id,
    baseDraftVersionNumber: base.versionNumber,
    hasCredential: true,
    isSourceReferenceOnly: false,
    isAdoptedSourceReferenceOnly: false,
    factsCount,
    uniqueBlocksCount,
    verifiedCount: evalOverview.verifiedCount,
    pendingCount: evalOverview.pendingCount,
    deferredCount: evalOverview.deferredCount,
    invalidatedCount: evalOverview.invalidatedCount,
    isAllVerified: evalOverview.isAllVerified,
    statusSummaryText: evalOverview.statusSummaryText || `本次修订核对：${evalOverview.verifiedCount}/${uniqueBlocksCount}段已记录 · ${evalOverview.pendingCount}段待处理`,
    statusMessage: evalOverview.statusSummaryText || `本次修订核对：${evalOverview.verifiedCount}/${uniqueBlocksCount}段已记录 · ${evalOverview.pendingCount}段待处理`,
    disclaimer,
    facts: JSON.parse(JSON.stringify(cred.facts)),
    blocks,
    isCurrentDraftContentModified,
  };
}
