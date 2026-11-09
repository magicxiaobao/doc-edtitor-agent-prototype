import {
  ReviewComment,
  ReviewCommentAuditEvent,
  ReviewCommentActionType,
  ReviewCommentStatus,
  UserRole,
  ModificationSource,
  ReviewCommentSnapshotBeforeChange,
  ReviewCommentSnapshotAfterChange,
  Task,
  DraftVersion,
} from '../types';

/**
 * Creates a unique stable event ID.
 */
export function createAuditEventId(): string {
  return `RCAE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a unique stable operation ID.
 */
export function createAuditOperationId(): string {
  return `OP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sanitizes and normalizes an event list from arbitrary or persisted storage.
 * - Safely handles undefined, null, or corrupted non-object elements
 * - Ensures sequence number stability
 * - Sorts stably by `seq` ascending
 */
export function getCommentAuditTrail(comment?: Partial<ReviewComment> | null): ReviewCommentAuditEvent[] {
  if (!comment) return [];
  const rawList = comment.events || comment.auditTrail;
  if (!Array.isArray(rawList)) return [];

  const validEvents: ReviewCommentAuditEvent[] = [];
  rawList.forEach((e: any, idx: number) => {
    if (!e || typeof e !== 'object') return;
    if (typeof e.eventId !== 'string' || !e.eventId) return;
    if (typeof e.actionType !== 'string') return;

    // Isolate damaged events with safe fallback representation without crashing
    const seq = typeof e.seq === 'number' && Number.isFinite(e.seq) ? e.seq : (idx + 1);
    validEvents.push({
      eventId: e.eventId,
      operationId: typeof e.operationId === 'string' ? e.operationId : `OP-REC-${e.eventId}`,
      seq,
      taskId: typeof e.taskId === 'string' ? e.taskId : '',
      commentId: typeof e.commentId === 'string' ? e.commentId : (comment.id || ''),
      actionType: e.actionType as ReviewCommentActionType,
      actionLabel: typeof e.actionLabel === 'string' ? e.actionLabel : getActionTypeLabel(e.actionType),
      operatorRole: typeof e.operatorRole === 'string' ? e.operatorRole : '主笔甲',
      operatorName: typeof e.operatorName === 'string' ? e.operatorName : (e.operatorRole || '主笔甲'),
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
      draftId: typeof e.draftId === 'string' ? e.draftId : '',
      draftVersionNumber: typeof e.draftVersionNumber === 'string' ? e.draftVersionNumber : undefined,
      originalVersionId: typeof e.originalVersionId === 'string' ? e.originalVersionId : (comment.targetVersionId || ''),
      originalVersionNumber: typeof e.originalVersionNumber === 'string' ? e.originalVersionNumber : comment.targetVersionNumber,
      originalBlockId: typeof e.originalBlockId === 'string' ? e.originalBlockId : comment.targetBlockId,
      originalBlockOrder: typeof e.originalBlockOrder === 'number' ? e.originalBlockOrder : comment.targetBlockOrder,
      targetDraftId: typeof e.targetDraftId === 'string' ? e.targetDraftId : undefined,
      targetBlockId: typeof e.targetBlockId === 'string' ? e.targetBlockId : undefined,
      targetBlockOrder: typeof e.targetBlockOrder === 'number' ? e.targetBlockOrder : undefined,
      authorReply: typeof e.authorReply === 'string' ? e.authorReply : undefined,
      decisionReason: typeof e.decisionReason === 'string' ? e.decisionReason : undefined,
      notes: typeof e.notes === 'string' ? e.notes : undefined,
      beforeStatus: typeof e.beforeStatus === 'string' ? e.beforeStatus : 'pending',
      afterStatus: typeof e.afterStatus === 'string' ? e.afterStatus : (comment.status || 'pending'),
      beforeSnapshot: e.beforeSnapshot,
      afterSnapshot: e.afterSnapshot,
      modificationLogId: typeof e.modificationLogId === 'string' ? e.modificationLogId : undefined,
      blockId: typeof e.blockId === 'string' ? e.blockId : undefined,
      beforeContent: typeof e.beforeContent === 'string' ? e.beforeContent : undefined,
      afterContent: typeof e.afterContent === 'string' ? e.afterContent : undefined,
      implementationSource: typeof e.implementationSource === 'string' ? e.implementationSource : undefined,
      implementationLabel: typeof e.implementationLabel === 'string' ? e.implementationLabel : undefined,
      undoneEventId: typeof e.undoneEventId === 'string' ? e.undoneEventId : undefined,
      undoneOperationId: typeof e.undoneOperationId === 'string' ? e.undoneOperationId : undefined,
      undoneModificationLogId: typeof e.undoneModificationLogId === 'string' ? e.undoneModificationLogId : undefined,
      undoReason: typeof e.undoReason === 'string' ? e.undoReason : undefined,
    });
  });

  return validEvents.sort((a, b) => a.seq - b.seq);
}

/**
 * Appends a new audit event immutably to a review comment.
 * Includes replay protection and deduplication for fast rapid double submissions.
 */
export function appendCommentAuditEvent(
  comment: ReviewComment,
  eventInput: Omit<ReviewCommentAuditEvent, 'seq' | 'eventId'> & { eventId?: string; seq?: number }
): ReviewComment {
  const existingEvents = getCommentAuditTrail(comment);

  // Rapid double-submission or identical replay protection
  if (eventInput.operationId) {
    const existingOp = existingEvents.find((e) => e.operationId === eventInput.operationId);
    if (existingOp) {
      return comment; // Already recorded under same operationId!
    }
  }

  // De-duplicate if last event is identical in action, draft, and status within 2500ms
  const lastEvent = existingEvents[existingEvents.length - 1];
  if (lastEvent) {
    const isSameAction = lastEvent.actionType === eventInput.actionType;
    const isSameAfterStatus = lastEvent.afterStatus === eventInput.afterStatus;
    const isSameDraft = lastEvent.draftId === eventInput.draftId;
    const isSameTargetBlock = lastEvent.targetBlockId === eventInput.targetBlockId;
    const isSameNotes = (lastEvent.notes || '') === (eventInput.notes || '');
    const isRecent = Math.abs(new Date(eventInput.timestamp).getTime() - new Date(lastEvent.timestamp).getTime()) < 2500;

    if (isSameAction && isSameAfterStatus && isSameDraft && isSameTargetBlock && isSameNotes && isRecent) {
      return comment; // Suppress duplicate click
    }
  }

  const nextSeq = existingEvents.length + 1;
  const newEvent: ReviewCommentAuditEvent = {
    ...eventInput,
    eventId: eventInput.eventId || createAuditEventId(),
    operationId: eventInput.operationId || createAuditOperationId(),
    seq: typeof eventInput.seq === 'number' ? eventInput.seq : nextSeq,
    actionLabel: eventInput.actionLabel || getActionTypeLabel(eventInput.actionType),
  };

  const updatedEvents = [...existingEvents, newEvent];

  return {
    ...comment,
    events: updatedEvents,
    auditTrail: updatedEvents,
  };
}

/**
 * Creates and appends a decision audit event (accept_pending, discuss, reject).
 */
export function recordCommentDecisionAuditEvent(
  comment: ReviewComment,
  params: {
    taskId: string;
    draft: DraftVersion;
    actionType: 'accept_pending' | 'discuss' | 'reject';
    operatorRole: UserRole;
    reasonOrReply: string;
    newStatus: ReviewCommentStatus;
    operationId?: string;
  }
): ReviewComment {
  const { taskId, draft, actionType, operatorRole, reasonOrReply, newStatus, operationId } = params;

  const targetBlockId = comment.currentBlockId || comment.targetBlockId;
  const targetBlock = draft.blocks.find((b) => b.id === targetBlockId);

  const beforeSnapshot: ReviewCommentSnapshotBeforeChange = {
    status: comment.status,
    authorReply: comment.authorReply,
    decisionReason: comment.decisionReason,
    resolutionType: comment.resolutionType,
    implementationDraftId: comment.implementationDraftId,
    implementationVersionNumber: comment.implementationVersionNumber,
    implementationBlockId: comment.implementationBlockId,
    implementedAt: comment.implementedAt,
  };

  const afterSnapshot: ReviewCommentSnapshotAfterChange = {
    status: newStatus,
    authorReply: actionType === 'discuss' ? reasonOrReply : comment.authorReply,
    decisionReason: actionType !== 'discuss' ? reasonOrReply : comment.decisionReason,
    resolutionType: actionType === 'accept_pending' ? 'strategy_decided' : actionType === 'reject' ? 'rejected' : 'communicated',
    currentBlockId: comment.currentBlockId,
    targetBlockId: comment.targetBlockId,
    reboundAt: comment.rebindRecord?.reboundAt,
  };

  return appendCommentAuditEvent(comment, {
    operationId: operationId || createAuditOperationId(),
    taskId,
    commentId: comment.id,
    actionType,
    actionLabel: getActionTypeLabel(actionType),
    operatorRole,
    operatorName: operatorRole,
    timestamp: new Date().toISOString(),
    draftId: draft.id,
    draftVersionNumber: draft.versionNumber,
    originalVersionId: comment.targetVersionId,
    originalVersionNumber: comment.targetVersionNumber,
    originalBlockId: comment.targetBlockId,
    originalBlockOrder: comment.targetBlockOrder,
    targetDraftId: draft.id,
    targetBlockId,
    targetBlockOrder: comment.currentBlockOrder || targetBlock?.order || comment.targetBlockOrder,
    authorReply: actionType === 'discuss' ? reasonOrReply : comment.authorReply,
    decisionReason: actionType !== 'discuss' ? reasonOrReply : comment.decisionReason,
    notes: reasonOrReply,
    beforeStatus: comment.status,
    afterStatus: newStatus,
    beforeSnapshot,
    afterSnapshot,
  });
}

/**
 * Creates and appends a rebind audit event.
 */
export function recordCommentRebindAuditEvent(
  comment: ReviewComment,
  params: {
    taskId: string;
    draft: DraftVersion;
    newBlockId: string;
    newBlockOrder: number;
    operatorRole: UserRole;
    reason?: string;
    operationId?: string;
  }
): ReviewComment {
  const { taskId, draft, newBlockId, newBlockOrder, operatorRole, reason, operationId } = params;

  return appendCommentAuditEvent(comment, {
    operationId: operationId || createAuditOperationId(),
    taskId,
    commentId: comment.id,
    actionType: 'rebind',
    actionLabel: '人工重新指定目标段落',
    operatorRole,
    operatorName: operatorRole,
    timestamp: new Date().toISOString(),
    draftId: draft.id,
    draftVersionNumber: draft.versionNumber,
    originalVersionId: comment.targetVersionId,
    originalVersionNumber: comment.targetVersionNumber,
    originalBlockId: comment.targetBlockId,
    originalBlockOrder: comment.targetBlockOrder,
    targetDraftId: draft.id,
    targetBlockId: newBlockId,
    targetBlockOrder: newBlockOrder,
    notes: reason || '主笔人工重新指定意见目标段落',
    beforeStatus: comment.status,
    afterStatus: comment.status, // Rebind does not alter decision status
  });
}

/**
 * Creates and appends an implementation audit event (direct, suggestion, reviewer replacement, or coordination).
 */
export function recordCommentImplementationAuditEvent(
  comment: ReviewComment,
  params: {
    taskId: string;
    draft: DraftVersion;
    blockId: string;
    blockOrder?: number;
    beforeContent: string;
    afterContent: string;
    modificationLogId: string;
    implementationSource: ModificationSource | string;
    implementationLabel: string;
    operatorRole: UserRole;
    authorReply?: string;
    decisionReason?: string;
    operationId?: string;
  }
): ReviewComment {
  const {
    taskId,
    draft,
    blockId,
    blockOrder,
    beforeContent,
    afterContent,
    modificationLogId,
    implementationSource,
    implementationLabel,
    operatorRole,
    authorReply,
    decisionReason,
    operationId,
  } = params;

  const beforeSnapshot: ReviewCommentSnapshotBeforeChange = {
    status: comment.status,
    authorReply: comment.authorReply,
    decisionReason: comment.decisionReason,
    resolutionType: comment.resolutionType,
    implementationDraftId: comment.implementationDraftId,
    implementationVersionNumber: comment.implementationVersionNumber,
    implementationBlockId: comment.implementationBlockId,
    implementedAt: comment.implementedAt,
  };

  const afterSnapshot: ReviewCommentSnapshotAfterChange = {
    status: 'implemented',
    authorReply,
    decisionReason: decisionReason || authorReply,
    resolutionType: 'text_modified',
    implementationDraftId: draft.id,
    implementationVersionNumber: draft.versionNumber,
    implementationBlockId: blockId,
    implementedAt: new Date().toISOString(),
    currentBlockId: comment.currentBlockId,
    targetBlockId: comment.targetBlockId,
    reboundAt: comment.rebindRecord?.reboundAt,
  };

  return appendCommentAuditEvent(comment, {
    operationId: operationId || createAuditOperationId(),
    taskId,
    commentId: comment.id,
    actionType: 'implement',
    actionLabel: '落实正文修改',
    operatorRole,
    operatorName: operatorRole,
    timestamp: new Date().toISOString(),
    draftId: draft.id,
    draftVersionNumber: draft.versionNumber,
    originalVersionId: comment.targetVersionId,
    originalVersionNumber: comment.targetVersionNumber,
    originalBlockId: comment.targetBlockId,
    originalBlockOrder: comment.targetBlockOrder,
    targetDraftId: draft.id,
    targetBlockId: blockId,
    targetBlockOrder: blockOrder,
    authorReply,
    decisionReason: decisionReason || authorReply,
    notes: authorReply,
    beforeStatus: comment.status,
    afterStatus: 'implemented',
    beforeSnapshot,
    afterSnapshot,
    modificationLogId,
    blockId,
    beforeContent,
    afterContent,
    implementationSource,
    implementationLabel,
  });
}

/**
 * Creates and appends an undo audit event for safe undo of comment implementation.
 */
export function recordCommentUndoAuditEvent(
  comment: ReviewComment,
  params: {
    taskId: string;
    draft: DraftVersion;
    undoneModificationLogId: string;
    restoredStatus: ReviewCommentStatus;
    operatorRole: UserRole;
    undoReason?: string;
    operationId?: string;
  }
): ReviewComment {
  const { taskId, draft, undoneModificationLogId, restoredStatus, operatorRole, undoReason, operationId } = params;

  const existingEvents = getCommentAuditTrail(comment);
  // Find the latest implementation event matching this modificationLogId or latest implementation
  const undoneEvent = [...existingEvents]
    .reverse()
    .find((e) => e.actionType === 'implement' && (e.modificationLogId === undoneModificationLogId || !undoneModificationLogId));

  const targetBlockId = comment.currentBlockId || comment.targetBlockId;
  const targetBlock = draft.blocks.find((b) => b.id === targetBlockId);

  return appendCommentAuditEvent(comment, {
    operationId: operationId || createAuditOperationId(),
    taskId,
    commentId: comment.id,
    actionType: 'undo',
    actionLabel: '安全撤销正文落实',
    operatorRole,
    operatorName: operatorRole,
    timestamp: new Date().toISOString(),
    draftId: draft.id,
    draftVersionNumber: draft.versionNumber,
    originalVersionId: comment.targetVersionId,
    originalVersionNumber: comment.targetVersionNumber,
    originalBlockId: comment.targetBlockId,
    originalBlockOrder: comment.targetBlockOrder,
    targetDraftId: draft.id,
    targetBlockId,
    targetBlockOrder: comment.currentBlockOrder || targetBlock?.order || comment.targetBlockOrder,
    notes: undoReason || '主笔安全撤销最近正文落实（原意见恢复至落实前状态）',
    beforeStatus: comment.status,
    afterStatus: restoredStatus,
    undoneEventId: undoneEvent?.eventId,
    undoneOperationId: undoneEvent?.operationId,
    undoneModificationLogId,
    undoReason: undoReason || '主笔安全撤销最近正文落实',
  });
}

/**
 * Maps actionType to human-readable label.
 */
export function getActionTypeLabel(actionType: ReviewCommentActionType | string): string {
  switch (actionType) {
    case 'accept_pending':
      return '决定采纳待落实';
    case 'discuss':
      return '标记待沟通';
    case 'reject':
      return '拒绝意见并说明';
    case 'rebind':
      return '人工重新指定目标段落';
    case 'implement':
      return '落实正文修改';
    case 'undo':
      return '安全撤销正文落实';
    default:
      return '处理操作';
  }
}

/**
 * Human readable status labels.
 */
export function getCommentStatusLabel(status: ReviewCommentStatus | string): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'accepted_pending_implementation':
      return '决定采纳待落实';
    case 'implemented':
      return '已落实正文';
    case 'rejected':
      return '已拒绝并说明';
    case 'need_discussion':
      return '待沟通';
    default:
      return status;
  }
}
