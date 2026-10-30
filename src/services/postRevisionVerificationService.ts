import {
  Task,
  DraftVersion,
  ParagraphBlock,
  UserRole,
  PostRevisionEvidenceInfo,
  PostRevisionFactInfo,
  PostRevisionBlockInfo,
  PostRevisionVerificationCredential,
  PostRevisionVerificationRecord,
  PostRevisionVerificationEvent,
  PostRevisionBlockEvaluation,
  PostRevisionVerificationOverview,
} from '../types';
import { checkPermission } from './permissionService';

/**
 * Validates structure of a PostRevisionVerificationRecord.
 */
export function isValidVerificationRecord(record: unknown): record is PostRevisionVerificationRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.taskId === 'string' &&
    typeof r.draftId === 'string' &&
    typeof r.operationId === 'string' &&
    typeof r.blockId === 'string' &&
    typeof r.blockOrder === 'number' &&
    (r.status === 'verified' || r.status === 'deferred' || r.status === 'revoked') &&
    typeof r.paragraphContentAtVerification === 'string' &&
    typeof r.paragraphRevisionSeqAtVerification === 'number' &&
    Array.isArray(r.referencedFactIdsAtVerification) &&
    Array.isArray(r.history)
  );
}

/**
 * Validates structure of a PostRevisionVerificationCredential.
 */
export function isValidVerificationCredential(cred: unknown): cred is PostRevisionVerificationCredential {
  if (!cred || typeof cred !== 'object') return false;
  const c = cred as Record<string, unknown>;
  return (
    typeof c.operationId === 'string' &&
    Boolean(c.operationId) &&
    typeof c.taskId === 'string' &&
    typeof c.sourceDraftId === 'string' &&
    typeof c.targetDraftId === 'string' &&
    typeof c.operatorRole === 'string' &&
    typeof c.createdAt === 'string' &&
    Array.isArray(c.facts) &&
    c.facts.length > 0 &&
    c.facts.every(
      (f: any) =>
        f &&
        typeof f.factId === 'string' &&
        typeof f.metric === 'string' &&
        typeof f.unit === 'string' &&
        typeof f.fromValue === 'string' &&
        typeof f.toValue === 'string' &&
        Array.isArray(f.referencingBlockIds)
    ) &&
    Array.isArray(c.blocks) &&
    c.blocks.length > 0 &&
    c.blocks.every(
      (b: any) =>
        b &&
        typeof b.blockId === 'string' &&
        typeof b.blockOrder === 'number' &&
        typeof b.beforeContent === 'string' &&
        typeof b.afterContent === 'string' &&
        typeof b.appliedRevisionSeq === 'number' &&
        Array.isArray(b.associatedFactIds)
    )
  );
}

export function isValidFrozenPostRevisionVerificationOverview(ov: unknown): ov is PostRevisionVerificationOverview {
  if (!ov || typeof ov !== 'object') return false;
  const o = ov as Record<string, unknown>;
  return (
    typeof o.hasCredential === 'boolean' &&
    typeof o.totalBlocks === 'number' &&
    typeof o.verifiedCount === 'number' &&
    typeof o.pendingCount === 'number' &&
    typeof o.deferredCount === 'number' &&
    typeof o.invalidatedCount === 'number' &&
    typeof o.isAllVerified === 'boolean' &&
    Array.isArray(o.blockEvaluations) &&
    Array.isArray(o.facts)
  );
}

/**
 * Builds the frozen revision verification credential at adoption time.
 */
export function buildPostRevisionVerificationCredential(params: {
  taskId: string;
  sourceDraftId: string;
  targetDraftId: string;
  operationId: string;
  operatorRole: UserRole;
  facts: PostRevisionFactInfo[];
  blocks: PostRevisionBlockInfo[];
  contextFingerprint?: string;
}): PostRevisionVerificationCredential {
  const normalizedFacts = params.facts.map((f) => ({
    ...f,
    beforeEvidenceSnapshot: f.beforeEvidenceSnapshot || f.fromEvidence,
    afterEvidenceSnapshot: f.afterEvidenceSnapshot || f.toEvidence,
  }));
  return {
    taskId: params.taskId,
    sourceDraftId: params.sourceDraftId,
    targetDraftId: params.targetDraftId,
    operationId: params.operationId,
    operatorRole: params.operatorRole,
    createdAt: new Date().toISOString(),
    facts: JSON.parse(JSON.stringify(normalizedFacts)),
    blocks: JSON.parse(JSON.stringify(params.blocks)),
    contextFingerprint: params.contextFingerprint,
  };
}

/**
 * Evaluates the post-revision verification state of a draft.
 * - Compares with credential.
 * - Detects invalidated records due to subsequent text modifications, revisionSeq increments,
 *   fact reference alterations, or unadjudicated fact conflicts.
 */
export function evaluatePostRevisionVerification(
  task: Task,
  draft: DraftVersion | undefined
): PostRevisionVerificationOverview {
  if (!draft) {
    return {
      hasCredential: false,
      message: '尚无稿件可核对',
      totalBlocks: 0,
      totalBlocksCount: 0,
      statusSummaryText: '本次修订核对：0/0段已记录 · 0段待处理',
      verifiedCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      invalidatedCount: 0,
      isAllVerified: false,
      blockEvaluations: [],
      facts: [],
    };
  }

  // If this draft is historical or finalized with frozen overview, return the frozen overview directly
  if (
    (draft.isHistoricalSnapshot || draft.isFinal) &&
    draft.frozenPostRevisionVerificationOverview &&
    isValidFrozenPostRevisionVerificationOverview(draft.frozenPostRevisionVerificationOverview)
  ) {
    const frozen = JSON.parse(JSON.stringify(draft.frozenPostRevisionVerificationOverview));
    frozen.totalBlocksCount = frozen.totalBlocksCount ?? frozen.totalBlocks;
    frozen.statusSummaryText =
      frozen.statusSummaryText ||
      `本次修订核对：${frozen.verifiedCount}/${frozen.totalBlocks}段已记录 · ${frozen.pendingCount}段待处理`;
    return frozen;
  }

  const cred = draft.postRevisionVerificationCredential;
  if (!cred || !isValidVerificationCredential(cred)) {
    return {
      hasCredential: false,
      message: '本稿未保存修订后核对清单，无法还原本次范围',
      totalBlocks: 0,
      totalBlocksCount: 0,
      statusSummaryText: '本次修订核对：未保存清单',
      verifiedCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      invalidatedCount: 0,
      isAllVerified: false,
      blockEvaluations: [],
      facts: [],
      sourceDraftId: draft.sourcePostRevisionVerificationCredential?.sourceDraftId,
      targetDraftId: draft.sourcePostRevisionVerificationCredential?.targetDraftId,
      operationId: draft.sourcePostRevisionVerificationCredential?.operationId,
    };
  }

  const records = draft.postRevisionVerificationRecords || [];
  const recordMap = new Map<string, PostRevisionVerificationRecord>();
  for (const rec of records) {
    if (rec && rec.blockId) {
      recordMap.set(rec.blockId, rec);
    }
  }

  const blockEvaluations: PostRevisionBlockEvaluation[] = [];

  for (const credBlock of cred.blocks) {
    const currentBlock = draft.blocks.find((b) => b.id === credBlock.blockId);
    const rec = recordMap.get(credBlock.blockId);

    // Associated facts for this block
    const associatedFacts = cred.facts.filter((f) => credBlock.associatedFactIds.includes(f.factId));

    // Check whether any associated facts in task currently have conflict or are unconfirmed or changed
    let hasFactConflictOrDifference = false;
    let factDifferenceNotice: string | undefined = undefined;

    for (const f of associatedFacts) {
      const taskFact = task.facts.find((tf) => tf.id === f.factId);
      if (!taskFact) {
        hasFactConflictOrDifference = true;
        factDifferenceNotice = `关联事实【${f.metric}】已在任务事实清单中缺失，需重新核对`;
        break;
      }
      if ((taskFact.status as string) === 'conflict' || (taskFact.hasConflict && !taskFact.selectedConflictValue)) {
        hasFactConflictOrDifference = true;
        factDifferenceNotice = `关联事实【${f.metric}】存在未裁决冲突（${taskFact.metricScope || '多方数据口径不一致'}），需先处理事实差异`;
        break;
      }
      if (taskFact.status !== 'confirmed') {
        hasFactConflictOrDifference = true;
        factDifferenceNotice = `关联事实【${f.metric}】处于未核准状态，需先核准事实`;
        break;
      }
      if (taskFact.value !== f.toValue) {
        hasFactConflictOrDifference = true;
        factDifferenceNotice = `关联事实【${f.metric}】数值已再次变更为“${taskFact.value}${taskFact.unit}”，与采纳值“${f.toValue}${f.unit}”不一致，需先处理事实差异`;
        break;
      }
    }

    if (!currentBlock) {
      blockEvaluations.push({
        blockId: credBlock.blockId,
        blockOrder: credBlock.blockOrder,
        sectionTitle: credBlock.sectionTitle,
        credBlock,
        currentBlock: undefined,
        record: rec,
        displayStatus: 'block_missing',
        displayStatusLabel: '段落已删除',
        invalidatedReason: '原目标段落已在正文中被删除',
        invalidationReason: '原目标段落已在正文中被删除',
        needsFactHandling: hasFactConflictOrDifference,
        isPending: true,
        isVerified: false,
        associatedFacts,
        associatedFactIds: credBlock.associatedFactIds,
        hasCurrentContentDiff: true,
        associatedFactsHaveDifferenceOrConflict: hasFactConflictOrDifference,
        factDifferenceNotice,
      });
      continue;
    }

    const hasCurrentContentDiff = currentBlock.content !== credBlock.afterContent;

    if (!rec || rec.status === 'revoked') {
      blockEvaluations.push({
        blockId: credBlock.blockId,
        blockOrder: credBlock.blockOrder,
        sectionTitle: credBlock.sectionTitle,
        credBlock,
        currentBlock,
        record: rec,
        displayStatus: 'pending',
        displayStatusLabel: '待核对',
        invalidationReason: undefined,
        needsFactHandling: hasFactConflictOrDifference,
        isPending: true,
        isVerified: false,
        associatedFacts,
        associatedFactIds: credBlock.associatedFactIds,
        hasCurrentContentDiff,
        associatedFactsHaveDifferenceOrConflict: hasFactConflictOrDifference,
        factDifferenceNotice,
      });
    } else if (rec.status === 'deferred') {
      blockEvaluations.push({
        blockId: credBlock.blockId,
        blockOrder: credBlock.blockOrder,
        sectionTitle: credBlock.sectionTitle,
        credBlock,
        currentBlock,
        record: rec,
        displayStatus: 'deferred',
        displayStatusLabel: '暂缓处理',
        invalidationReason: undefined,
        needsFactHandling: hasFactConflictOrDifference,
        isPending: true, // "暂缓核对：原因必填，继续计入待处理"
        isVerified: false,
        associatedFacts,
        associatedFactIds: credBlock.associatedFactIds,
        hasCurrentContentDiff,
        associatedFactsHaveDifferenceOrConflict: hasFactConflictOrDifference,
        factDifferenceNotice,
      });
    } else if (rec.status === 'verified') {
      // Check invalidation rules
      let invalidatedReason: string | undefined = undefined;

      // 1. Content changed since verification
      if (currentBlock.content !== rec.paragraphContentAtVerification) {
        invalidatedReason = '段落正文内容已被修改，原核对结论失效';
      }
      // 2. RevisionSeq changed (even if text was reverted to exact same characters)
      else if (
        (currentBlock.revisionSeq ?? 0) !== (rec.paragraphRevisionSeqAtVerification ?? 0)
      ) {
        invalidatedReason = '段落版本序列号已变更(revisionSeq已更新)，原结论失效';
      }
      // 3. Referenced facts altered
      else if (
        !areStringArraysIdentical(
          currentBlock.referencedFactIds || [],
          rec.referencedFactIdsAtVerification || []
        )
      ) {
        invalidatedReason = '段落关联事实引用发生变动，原核对结论失效';
      }
      // 4. Associated fact unadjudicated conflict or unconfirmed
      else if (hasFactConflictOrDifference) {
        invalidatedReason = factDifferenceNotice || '关联事实重提冲突或未核准，需先前往处理事实';
      }

      if (invalidatedReason) {
        blockEvaluations.push({
          blockId: credBlock.blockId,
          blockOrder: credBlock.blockOrder,
          sectionTitle: credBlock.sectionTitle,
          credBlock,
          currentBlock,
          record: rec,
          displayStatus: 'invalidated',
          displayStatusLabel: '原核对已失效',
          invalidatedReason,
          invalidationReason: invalidatedReason,
          needsFactHandling: hasFactConflictOrDifference,
          isPending: true,
          isVerified: false,
          associatedFacts,
          associatedFactIds: credBlock.associatedFactIds,
          hasCurrentContentDiff,
          associatedFactsHaveDifferenceOrConflict: hasFactConflictOrDifference,
          factDifferenceNotice,
        });
      } else {
        blockEvaluations.push({
          blockId: credBlock.blockId,
          blockOrder: credBlock.blockOrder,
          sectionTitle: credBlock.sectionTitle,
          credBlock,
          currentBlock,
          record: rec,
          displayStatus: 'verified',
          displayStatusLabel: '已记录核对',
          invalidationReason: undefined,
          needsFactHandling: false,
          isPending: false,
          isVerified: true,
          associatedFacts,
          associatedFactIds: credBlock.associatedFactIds,
          hasCurrentContentDiff,
          associatedFactsHaveDifferenceOrConflict: false,
          factDifferenceNotice,
        });
      }
    }
  }

  const totalBlocks = cred.blocks.length;
  const verifiedCount = blockEvaluations.filter((ev) => ev.displayStatus === 'verified').length;
  const deferredCount = blockEvaluations.filter((ev) => ev.displayStatus === 'deferred').length;
  const invalidatedCount = blockEvaluations.filter((ev) => ev.displayStatus === 'invalidated').length;
  const pendingCount = totalBlocks - verifiedCount; // All non-verified count towards pending
  const isAllVerified = totalBlocks > 0 && verifiedCount === totalBlocks;
  const statusSummaryText = `本次修订核对：${verifiedCount}/${totalBlocks}段已记录 · ${pendingCount}段待处理`;

  return {
    hasCredential: true,
    totalBlocks,
    totalBlocksCount: totalBlocks,
    statusSummaryText,
    verifiedCount,
    pendingCount,
    deferredCount,
    invalidatedCount,
    isAllVerified,
    blockEvaluations,
    facts: cred.facts,
    sourceDraftId: cred.sourceDraftId,
    targetDraftId: cred.targetDraftId,
    operationId: cred.operationId,
    operatorRole: cred.operatorRole,
    createdAt: cred.createdAt,
  };
}

function areStringArraysIdentical(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

export interface VerificationActionParams {
  task: Task;
  draftId: string;
  operationId: string;
  blockId: string;
  activeRole: UserRole;
  notes?: string;
  reason?: string;
  baselineState?: {
    paragraphContent: string;
    revisionSeq: number;
    referencedFactIds: string[];
  };
}

export interface VerificationActionResult {
  success: boolean;
  reason?: string;
  error?: string; // 错误信息别名
  updatedTask?: Task;
  updatedRecord?: PostRevisionVerificationRecord;
}

function parseActionArgs(
  arg1: Task | VerificationActionParams,
  arg2?: DraftVersion,
  arg3?: any
): { params: VerificationActionParams; rawDraft?: DraftVersion } {
  if (
    arg1 &&
    typeof arg1 === 'object' &&
    ('draftId' in arg1 || 'activeRole' in arg1) &&
    !('currentDraftId' in arg1)
  ) {
    const p = arg1 as VerificationActionParams;
    const task = p.task;
    const rawDraft = task?.drafts?.find((d) => d.id === p.draftId);
    return { params: p, rawDraft };
  }
  const task = arg1 as Task;
  const draft = arg2 as DraftVersion;
  const opts = (arg3 || {}) as Record<string, any>;
  const activeRole = (opts.role || opts.activeRole || opts.operator) as UserRole;
  const params: VerificationActionParams = {
    task,
    draftId: draft?.id || opts.draftId || task?.currentDraftId || '',
    operationId: opts.operationId || draft?.postRevisionVerificationCredential?.operationId || '',
    blockId: opts.blockId || '',
    activeRole,
    notes: opts.notes,
    reason: opts.reason,
    baselineState: opts.baselineState,
  };
  return { params, rawDraft: draft };
}

/**
 * Validates permission, draft, credential, and block consistency for any verification write action.
 */
function validateVerificationPreconditions(
  params: VerificationActionParams
): { valid: boolean; reason?: string; draft?: DraftVersion; block?: ParagraphBlock; credBlock?: PostRevisionBlockInfo } {
  const { task, draftId, operationId, blockId, activeRole } = params;

  // 1. Author role verification (strict: "当前有效主笔身份，禁止缺省或未知角色静默成为主笔。")
  if (!activeRole || typeof activeRole !== 'string' || !activeRole.trim()) {
    return { valid: false, reason: '角色未指定或未知，只有主笔有权操作' };
  }

  if (activeRole !== '主笔甲' && activeRole !== task.primaryAuthor) {
    return {
      valid: false,
      reason: `只有主笔角色（${task.primaryAuthor || '主笔甲'}）有权签署或更新事实修订核对记录，当前身份【${activeRole}】无权操作`,
    };
  }

  const perm = checkPermission(activeRole, 'edit_draft');
  if (!perm.allowed) {
    return { valid: false, reason: perm.reason || '当前身份无权编辑稿件核对留痕' };
  }

  // 2. Draft check
  const draft = task.drafts.find((d) => d.id === draftId);
  if (!draft) {
    return { valid: false, reason: `未找到指定草稿【${draftId}】` };
  }

  if (draft.isHistoricalSnapshot || draft.isFinal || !draft.isWorkingDraft) {
    return { valid: false, reason: '历史快照和最终定稿为只读归档，不可修改核对记录' };
  }

  if (task.currentDraftId !== draft.id) {
    return { valid: false, reason: '仅可在当前活动工作稿上签署核对记录' };
  }

  // 3. Credential check
  const cred = draft.postRevisionVerificationCredential;
  if (!cred || !isValidVerificationCredential(cred)) {
    return { valid: false, reason: '当前草稿缺少有效的修订核对凭据，无法执行核对操作' };
  }

  if (cred.operationId !== operationId) {
    return { valid: false, reason: `操作批次不匹配（凭据操作ID为【${cred.operationId}】，提交为【${operationId}】）` };
  }

  if (cred.taskId !== task.id) {
    return { valid: false, reason: `任务ID不匹配，严禁跨任务签署核对记录` };
  }

  if (cred.targetDraftId !== draft.id) {
    return { valid: false, reason: `目标草稿ID不匹配，严禁跨稿件签署核对记录` };
  }

  // 4. Block check
  const credBlock = cred.blocks.find((b) => b.blockId === blockId);
  if (!credBlock) {
    return { valid: false, reason: `段落【${blockId}】不在本次凭据范围内，禁止签署` };
  }

  const block = draft.blocks.find((b) => b.id === blockId);
  if (!block) {
    return { valid: false, reason: `段落【${blockId}】已在当前正文中被删除，无法签署` };
  }

  // 5. Baseline freshness check
  if (params.baselineState) {
    if (block.content !== params.baselineState.paragraphContent) {
      return { valid: false, reason: '提交核对时正文内容已被修改，请重新核对当前正文后提交' };
    }
    if ((block.revisionSeq ?? 0) !== (params.baselineState.revisionSeq ?? 0)) {
      return { valid: false, reason: '提交核对时段落修改序号(revisionSeq)已变动，请重新确认后提交' };
    }
    if (!areStringArraysIdentical(block.referencedFactIds || [], params.baselineState.referencedFactIds || [])) {
      return { valid: false, reason: '提交核对时段落事实引用关系已发生变动，请重新确认后提交' };
    }
  }

  return { valid: true, draft, block, credBlock };
}

/**
 * Records author manual verification for a block.
 * Supports both signatures:
 *   recordPostRevisionVerification(params: VerificationActionParams)
 *   recordPostRevisionVerification(task: Task, draft: DraftVersion, options: any)
 */
export function recordPostRevisionVerification(
  arg1: Task | VerificationActionParams,
  arg2?: DraftVersion,
  arg3?: any
): VerificationActionResult {
  const { params, rawDraft } = parseActionArgs(arg1, arg2, arg3);
  const { notes, activeRole } = params;

  if (!notes || notes.trim().length === 0) {
    const msg = '核对说明不能为空，请填写详细核对说明';
    return { success: false, reason: msg, error: msg };
  }

  const check = validateVerificationPreconditions(params);
  if (!check.valid || !check.draft || !check.block || !check.credBlock) {
    return { success: false, reason: check.reason, error: check.reason };
  }

  const { task, draftId, operationId, blockId } = params;
  const draft = check.draft;
  const block = check.block;
  const credBlock = check.credBlock;

  // Verify associated facts: cannot mark verified if related facts have unresolved conflict or are unconfirmed
  const cred = draft.postRevisionVerificationCredential!;
  const associatedFacts = cred.facts.filter((f) => credBlock.associatedFactIds.includes(f.factId));
  for (const f of associatedFacts) {
    const taskFact = task.facts.find((tf) => tf.id === f.factId);
    const hasUnresolvedConflict =
      !taskFact || (taskFact.status as string) === 'conflict' || (taskFact.hasConflict && !taskFact.selectedConflictValue);
    if (!taskFact || hasUnresolvedConflict || taskFact.status !== 'confirmed') {
      const msg = `关联事实【${f.metric}】存在未裁决冲突或未核准变动，需先前往处理事实差异，无法记录核对完成`;
      return { success: false, reason: msg, error: msg };
    }
  }

  const now = new Date().toISOString();
  const existingRecords = draft.postRevisionVerificationRecords || [];
  const existingIndex = existingRecords.findIndex((r) => r.blockId === blockId);

  const event: PostRevisionVerificationEvent = {
    id: `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    action: 'verify',
    type: 'recorded',
    operator: activeRole,
    timestamp: now,
    notes: notes.trim(),
  };

  let updatedRecord: PostRevisionVerificationRecord;

  if (existingIndex >= 0) {
    const prev = existingRecords[existingIndex];
    const prevHistory = prev.events || prev.history || [];
    updatedRecord = {
      ...prev,
      status: 'verified',
      verifiedBy: activeRole,
      verifiedAt: now,
      notes: notes.trim(),
      paragraphContentAtVerification: block.content,
      paragraphRevisionSeqAtVerification: block.revisionSeq ?? 0,
      referencedFactIdsAtVerification: [...block.referencedFactIds],
      history: [...prevHistory, event],
      events: [...prevHistory, event],
      revocation: undefined,
    };
  } else {
    updatedRecord = {
      id: `PRV-REC-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      taskId: task.id,
      draftId,
      operationId,
      blockId,
      blockOrder: block.order,
      sectionTitle: credBlock.sectionTitle,
      status: 'verified',
      verifiedBy: activeRole,
      verifiedAt: now,
      notes: notes.trim(),
      paragraphContentAtVerification: block.content,
      paragraphRevisionSeqAtVerification: block.revisionSeq ?? 0,
      referencedFactIdsAtVerification: [...block.referencedFactIds],
      history: [event],
      events: [event],
    };
  }

  const nextRecords =
    existingIndex >= 0
      ? existingRecords.map((r, i) => (i === existingIndex ? updatedRecord : r))
      : [...existingRecords, updatedRecord];

  draft.postRevisionVerificationRecords = nextRecords;
  if (rawDraft) {
    rawDraft.postRevisionVerificationRecords = nextRecords;
  }

  const updatedDraft: DraftVersion = {
    ...draft,
    postRevisionVerificationRecords: nextRecords,
  };

  const updatedTask: Task = {
    ...task,
    drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
    updatedAt: now,
  };

  return { success: true, updatedTask, updatedRecord };
}

/**
 * Defers verification for a block.
 * Supports both signatures:
 *   deferPostRevisionVerification(params: VerificationActionParams)
 *   deferPostRevisionVerification(task: Task, draft: DraftVersion, options: any)
 */
export function deferPostRevisionVerification(
  arg1: Task | VerificationActionParams,
  arg2?: DraftVersion,
  arg3?: any
): VerificationActionResult {
  const { params, rawDraft } = parseActionArgs(arg1, arg2, arg3);
  const { reason, activeRole } = params;

  if (!reason || reason.trim().length === 0) {
    const msg = '暂缓原因不能为空，请填写具体原因';
    return { success: false, reason: msg, error: msg };
  }

  const check = validateVerificationPreconditions(params);
  if (!check.valid || !check.draft || !check.block || !check.credBlock) {
    return { success: false, reason: check.reason, error: check.reason };
  }

  const { task, draftId, operationId, blockId } = params;
  const draft = check.draft;
  const block = check.block;
  const credBlock = check.credBlock;

  const now = new Date().toISOString();
  const existingRecords = draft.postRevisionVerificationRecords || [];
  const existingIndex = existingRecords.findIndex((r) => r.blockId === blockId);

  const event: PostRevisionVerificationEvent = {
    id: `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    action: 'defer',
    type: 'deferred',
    operator: activeRole,
    timestamp: now,
    reason: reason.trim(),
  };

  let updatedRecord: PostRevisionVerificationRecord;

  if (existingIndex >= 0) {
    const prev = existingRecords[existingIndex];
    const prevHistory = prev.events || prev.history || [];
    updatedRecord = {
      ...prev,
      status: 'deferred',
      deferredBy: activeRole,
      deferredAt: now,
      deferredReason: reason.trim(),
      paragraphContentAtVerification: block.content,
      paragraphRevisionSeqAtVerification: block.revisionSeq ?? 0,
      referencedFactIdsAtVerification: [...block.referencedFactIds],
      history: [...prevHistory, event],
      events: [...prevHistory, event],
    };
  } else {
    updatedRecord = {
      id: `PRV-REC-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      taskId: task.id,
      draftId,
      operationId,
      blockId,
      blockOrder: block.order,
      sectionTitle: credBlock.sectionTitle,
      status: 'deferred',
      deferredBy: activeRole,
      deferredAt: now,
      deferredReason: reason.trim(),
      paragraphContentAtVerification: block.content,
      paragraphRevisionSeqAtVerification: block.revisionSeq ?? 0,
      referencedFactIdsAtVerification: [...block.referencedFactIds],
      history: [event],
      events: [event],
    };
  }

  const nextRecords =
    existingIndex >= 0
      ? existingRecords.map((r, i) => (i === existingIndex ? updatedRecord : r))
      : [...existingRecords, updatedRecord];

  draft.postRevisionVerificationRecords = nextRecords;
  if (rawDraft) {
    rawDraft.postRevisionVerificationRecords = nextRecords;
  }

  const updatedDraft: DraftVersion = {
    ...draft,
    postRevisionVerificationRecords: nextRecords,
  };

  const updatedTask: Task = {
    ...task,
    drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
    updatedAt: now,
  };

  return { success: true, updatedTask, updatedRecord };
}

/**
 * Revokes a previously recorded verification.
 * Supports both signatures:
 *   revokePostRevisionVerification(params: VerificationActionParams)
 *   revokePostRevisionVerification(task: Task, draft: DraftVersion, options: any)
 */
export function revokePostRevisionVerification(
  arg1: Task | VerificationActionParams,
  arg2?: DraftVersion,
  arg3?: any
): VerificationActionResult {
  const { params, rawDraft } = parseActionArgs(arg1, arg2, arg3);
  const { reason, activeRole } = params;

  if (!reason || reason.trim().length === 0) {
    const msg = '撤回原因不能为空，请填写具体原因';
    return { success: false, reason: msg, error: msg };
  }

  const check = validateVerificationPreconditions(params);
  if (!check.valid || !check.draft || !check.block) {
    return { success: false, reason: check.reason, error: check.reason };
  }

  const { task, blockId } = params;
  const draft = check.draft;

  const existingRecords = draft.postRevisionVerificationRecords || [];
  const existing = existingRecords.find((r) => r.blockId === blockId);

  if (!existing || existing.status === 'revoked') {
    const msg = '该段落尚无有效核对记录，无法撤回';
    return { success: false, reason: msg, error: msg };
  }

  const now = new Date().toISOString();
  const event: PostRevisionVerificationEvent = {
    id: `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    action: 'revoke',
    type: 'revoked',
    operator: activeRole,
    timestamp: now,
    reason: reason.trim(),
  };

  const prevHistory = existing.events || existing.history || [];
  const updatedRecord: PostRevisionVerificationRecord = {
    ...existing,
    status: 'revoked',
    history: [...prevHistory, event],
    events: [...prevHistory, event],
    revocation: {
      revokedAt: now,
      revokedBy: activeRole,
      reason: reason.trim(),
    },
  };

  const nextRecords = existingRecords.map((r) => (r.blockId === blockId ? updatedRecord : r));

  draft.postRevisionVerificationRecords = nextRecords;
  if (rawDraft) {
    rawDraft.postRevisionVerificationRecords = nextRecords;
  }

  const updatedDraft: DraftVersion = {
    ...draft,
    postRevisionVerificationRecords: nextRecords,
  };

  const updatedTask: Task = {
    ...task,
    drafts: task.drafts.map((d) => (d.id === updatedDraft.id ? updatedDraft : d)),
    updatedAt: now,
  };

  return { success: true, updatedTask, updatedRecord };
}

/**
 * Freezes revision verification credentials and records when saving a snapshot or finalizing.
 */
export function freezePostRevisionVerification(
  task: Task,
  draft: DraftVersion
): Pick<
  DraftVersion,
  | 'postRevisionVerificationCredential'
  | 'postRevisionVerificationRecords'
  | 'sourcePostRevisionVerificationCredential'
  | 'sourcePostRevisionVerificationRecords'
  | 'frozenPostRevisionVerificationOverview'
  | 'postRevisionVerificationRecovery'
> {
  return JSON.parse(
    JSON.stringify({
      postRevisionVerificationCredential: draft.postRevisionVerificationCredential,
      postRevisionVerificationRecords: draft.postRevisionVerificationRecords,
      sourcePostRevisionVerificationCredential:
        draft.sourcePostRevisionVerificationCredential || draft.postRevisionVerificationCredential,
      sourcePostRevisionVerificationRecords: draft.sourcePostRevisionVerificationRecords,
      frozenPostRevisionVerificationOverview: evaluatePostRevisionVerification(task, draft),
      postRevisionVerificationRecovery: draft.postRevisionVerificationRecovery,
    })
  );
}

/**
 * Extract verified source records for provenance when restoring or forking.
 */
export function sourcePostRevisionVerification(
  draft: DraftVersion | undefined
): PostRevisionVerificationRecord[] {
  if (!draft) return [];
  const records = [
    ...(draft.postRevisionVerificationRecords || []),
    ...(draft.sourcePostRevisionVerificationRecords || []),
  ];
  return JSON.parse(JSON.stringify(records)).filter(isValidVerificationRecord);
}
