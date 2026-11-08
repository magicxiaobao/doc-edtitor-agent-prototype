import {
  Task,
  DraftVersion,
  ReviewComment,
  ReviewCommentStatus,
} from '../types';
import {
  getApplicableReviewDraftIds,
  getApplicableReviewComments,
} from './draftLifecycleService';
import { getFormalReviewBaseline } from './revisionReviewHandoffService';

export interface UnattributedCommentInfo {
  comment: ReviewComment;
  reason: string;
}

export interface ReviewStageCommentCounts {
  applicableTotalCount: number;
  applicableUnclosedCount: number;
  currentRoundOriginalCount: number;
  currentRoundUnclosedCount: number;
  canFinalizeComments: boolean;
}

/**
 * Returns all formal review baseline snapshots applicable to the current working draft.
 * Pure function: Does not mutate task or drafts.
 *
 * Rules:
 * 1. Only list formal baselines within the scope of the current working draft (getApplicableReviewDraftIds).
 * 2. Uses stable baseline ID as key; does not traverse all descendants of common ancestors.
 * 3. Ordinary save snapshots, finalized drafts, or editable working drafts are NOT formal baselines.
 * 4. Preserves each distinct baseline even if two baselines share the same submittedReviewRound.
 * 5. Returns drafts in chronological order.
 */
export function getFormalReviewBaselines(
  task: Task,
  currentDraft?: DraftVersion
): DraftVersion[] {
  const activeDraft = currentDraft || task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  if (!activeDraft) return [];

  const applicableIds = getApplicableReviewDraftIds(task, activeDraft);
  const formalBaselines: DraftVersion[] = [];
  const seenIds = new Set<string>();

  for (const draft of task.drafts) {
    if (seenIds.has(draft.id)) continue;
    if (!applicableIds.has(draft.id)) continue;

    // Must be an immutable snapshot and NOT a working draft or final version
    if (draft.isWorkingDraft || !draft.isHistoricalSnapshot || draft.isFinal) {
      continue;
    }

    const formalCheck = getFormalReviewBaseline(task, activeDraft, draft);
    if (formalCheck.isFormalBaseline && formalCheck.reviewBaseDraft?.id === draft.id) {
      seenIds.add(draft.id);
      formalBaselines.push(draft);
    }
  }

  // Sort chronologically ascending (older submissions first: R1 -> R2 -> ...)
  return formalBaselines.sort((a, b) => {
    const roundA = Number.isSafeInteger(a.submittedReviewRound) ? a.submittedReviewRound! : 0;
    const roundB = Number.isSafeInteger(b.submittedReviewRound) ? b.submittedReviewRound! : 0;
    if (roundA !== roundB && roundA > 0 && roundB > 0) {
      return roundA - roundB;
    }
    const timeA = new Date(a.createdAt).getTime() || 0;
    const timeB = new Date(b.createdAt).getTime() || 0;
    return timeA - timeB;
  });
}

/**
 * Formats display name for a review round.
 * Strict rule: If submittedReviewRound is missing or invalid, displays "轮次未知".
 * NEVER borrows task.currentReviewRound or guesses from array order/version numbers.
 */
export function getRoundDisplayName(draft: DraftVersion | undefined): string {
  if (!draft) return '轮次未知';
  if (Number.isSafeInteger(draft.submittedReviewRound) && draft.submittedReviewRound! > 0) {
    return `第 ${draft.submittedReviewRound} 轮 (R${draft.submittedReviewRound})`;
  }
  return '轮次未知';
}

/**
 * Helper to deduplicate review comments by ID while preserving order.
 */
function deduplicateComments(comments: ReviewComment[]): ReviewComment[] {
  const seenIds = new Set<string>();
  const unique: ReviewComment[] = [];
  for (const c of comments) {
    if (!c || !c.id || seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    unique.push(c);
  }
  return unique;
}

/**
 * Returns comments originally attributed to the specified baseline snapshot.
 * Strict rule: Attribution is determined strictly by the original comment.targetVersionId.
 * Does NOT use rebindRecord.targetDraftId, createdAt, or task.currentReviewRound.
 * Deduplicates by stable comment.id.
 */
export function getBaselineAttributedComments(
  task: Task,
  baselineId: string
): ReviewComment[] {
  if (!baselineId || !Array.isArray(task.reviewComments)) return [];
  const matched = task.reviewComments.filter((c) => c.targetVersionId === baselineId);
  return deduplicateComments(matched);
}

/**
 * Identifies comments in task.reviewComments that cannot be attributed to any formal review baseline
 * within the current lineage, while correctly isolating unrelated other formal branch comments.
 *
 * Rules:
 * 1. Deduplicates comments by ID.
 * 2. Unrelated formal branch comments (whose targetVersionId is a formal baseline of another branch
 *    and not rebound to the current draft/lineage) are ISOLATED from the current draft and not shown.
 * 3. Comments originally proposed against a foreign formal baseline but rebound to the current working draft
 *    remain visible with accurate provenance (mentioning origin baseline, not called an informal/unsent draft).
 * 4. Comments targeting an informal/unsubmitted draft (e.g., initial working draft) are preserved and labeled accordingly.
 * 5. Comments targeting a missing/removed baseline are preserved and labeled as missing source.
 */
export function getUnattributedReviewComments(
  task: Task,
  formalBaselines: DraftVersion[],
  currentDraft?: DraftVersion
): UnattributedCommentInfo[] {
  if (!Array.isArray(task.reviewComments)) return [];
  const formalBaselineIds = new Set(formalBaselines.map((b) => b.id));
  const activeDraft = currentDraft || task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const applicableDraftIds = activeDraft ? getApplicableReviewDraftIds(task, activeDraft) : undefined;

  const uniqueComments = deduplicateComments(task.reviewComments);
  const unattributed: UnattributedCommentInfo[] = [];

  for (const comment of uniqueComments) {
    // If it's directly attributed to one of the formal baselines in this lineage, skip
    if (formalBaselineIds.has(comment.targetVersionId)) {
      continue;
    }

    const originDraft = task.drafts.find((d) => d.id === comment.targetVersionId);
    const isForeignFormalBaseline = Boolean(
      originDraft &&
      !originDraft.isWorkingDraft &&
      originDraft.isHistoricalSnapshot &&
      !originDraft.isFinal &&
      (originDraft.id.startsWith('DRAFT-SNAP-REV-') || (Number.isSafeInteger(originDraft.submittedReviewRound) && originDraft.submittedReviewRound! > 0))
    );

    const isReboundToCurrentLineage = Boolean(
      comment.rebindRecord?.targetDraftId &&
      applicableDraftIds &&
      applicableDraftIds.has(comment.rebindRecord.targetDraftId)
    );

    // If it belongs to a formal baseline of an unrelated other branch and is NOT rebound to current lineage, isolate it completely
    if (isForeignFormalBaseline && !isReboundToCurrentLineage) {
      continue;
    }

    // Determine accurate description
    let reason: string;
    if (isForeignFormalBaseline && isReboundToCurrentLineage) {
      const originName = originDraft?.versionNumber || comment.targetVersionNumber || comment.targetVersionId;
      reason = `原始针对其他送审基准【${originName}】提出，已重新绑定至本稿处理`;
    } else if (originDraft) {
      reason = `针对未送审草稿【${comment.targetVersionNumber || originDraft.versionNumber || comment.targetVersionId}】提出，非正式送审基准`;
    } else {
      reason = `来源送审基准【${comment.targetVersionId}】在当前草稿列表中缺失或已被移除`;
    }

    unattributed.push({ comment, reason });
  }

  return unattributed;
}

/**
 * Computes comment statistics for the review stage workspace:
 * Distinguishes:
 * 1. Current round original comments count (and unclosed) - strictly requires a genuine formal review baseline!
 *    Fallback working drafts cannot acquire formal round original counts (remains 0).
 * 2. Current working draft applicable unclosed comments count (and total applicable)
 * Deduplicates comments by ID.
 */
export function getReviewStageCommentCounts(
  task: Task,
  currentDraft?: DraftVersion,
  reviewBaseDraft?: DraftVersion
): ReviewStageCommentCounts {
  const activeDraft = currentDraft || task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const rawApplicableComments = activeDraft ? getApplicableReviewComments(task, activeDraft) : [];
  const applicableComments = deduplicateComments(rawApplicableComments);

  const isUnclosed = (status: ReviewCommentStatus) =>
    status === 'pending' || status === 'accepted_pending_implementation' || status === 'need_discussion';

  const applicableUnclosedCount = applicableComments.filter((c) => isUnclosed(c.status)).length;

  // Strict check: reviewBaseDraft must be a formal baseline (not a fallback working draft)
  const isFormalBase = Boolean(
    reviewBaseDraft &&
    !reviewBaseDraft.isWorkingDraft &&
    reviewBaseDraft.isHistoricalSnapshot &&
    !reviewBaseDraft.isFinal &&
    (reviewBaseDraft.id.startsWith('DRAFT-SNAP-REV-') || (Number.isSafeInteger(reviewBaseDraft.submittedReviewRound) && reviewBaseDraft.submittedReviewRound! > 0))
  );

  const rawRoundComments = (isFormalBase && reviewBaseDraft)
    ? (task.reviewComments || []).filter((c) => c.targetVersionId === reviewBaseDraft.id)
    : [];
  const currentRoundOriginalComments = deduplicateComments(rawRoundComments);
  const currentRoundOriginalCount = currentRoundOriginalComments.length;
  const currentRoundUnclosedCount = currentRoundOriginalComments.filter((c) => isUnclosed(c.status)).length;

  return {
    applicableTotalCount: applicableComments.length,
    applicableUnclosedCount,
    currentRoundOriginalCount,
    currentRoundUnclosedCount,
    canFinalizeComments: applicableUnclosedCount === 0,
  };
}
