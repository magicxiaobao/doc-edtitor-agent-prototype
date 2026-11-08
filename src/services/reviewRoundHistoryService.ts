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
 * Returns comments originally attributed to the specified baseline snapshot.
 * Strict rule: Attribution is determined strictly by the original comment.targetVersionId.
 * Does NOT use rebindRecord.targetDraftId, createdAt, or task.currentReviewRound.
 */
export function getBaselineAttributedComments(
  task: Task,
  baselineId: string
): ReviewComment[] {
  if (!baselineId || !Array.isArray(task.reviewComments)) return [];
  return task.reviewComments.filter((c) => c.targetVersionId === baselineId);
}

/**
 * Identifies comments in task.reviewComments that cannot be attributed to any formal review baseline.
 * Strict rule: Non-formal draft comments or missing source baseline comments are NOT silently dropped.
 */
export function getUnattributedReviewComments(
  task: Task,
  formalBaselines: DraftVersion[]
): UnattributedCommentInfo[] {
  if (!Array.isArray(task.reviewComments)) return [];
  const formalBaselineIds = new Set(formalBaselines.map((b) => b.id));
  const unattributed: UnattributedCommentInfo[] = [];

  for (const comment of task.reviewComments) {
    if (!formalBaselineIds.has(comment.targetVersionId)) {
      const draftExists = task.drafts.some((d) => d.id === comment.targetVersionId);
      const reason = draftExists
        ? `针对未送审草稿【${comment.targetVersionNumber || comment.targetVersionId}】提出，非正式送审基准`
        : `来源送审基准【${comment.targetVersionId}】在当前草稿列表中缺失或已被移除`;
      unattributed.push({ comment, reason });
    }
  }

  return unattributed;
}

/**
 * Computes comment statistics for the review stage workspace:
 * Distinguishes:
 * 1. Current round original comments count (and unclosed)
 * 2. Current working draft applicable unclosed comments count (and total applicable)
 */
export function getReviewStageCommentCounts(
  task: Task,
  currentDraft?: DraftVersion,
  reviewBaseDraft?: DraftVersion
): ReviewStageCommentCounts {
  const applicableComments = currentDraft ? getApplicableReviewComments(task, currentDraft) : [];
  const isUnclosed = (status: ReviewCommentStatus) =>
    status === 'pending' || status === 'accepted_pending_implementation' || status === 'need_discussion';

  const applicableUnclosedCount = applicableComments.filter((c) => isUnclosed(c.status)).length;

  const currentRoundOriginalComments = reviewBaseDraft
    ? (task.reviewComments || []).filter((c) => c.targetVersionId === reviewBaseDraft.id)
    : [];
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
