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
import { getFactReviewContext } from './factReviewService';
import { arePeriodsStrictlyIdentical } from './factLifecycleService';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim());
const sequence = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const time = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));

function validEvidence(v: unknown): v is PostRevisionEvidenceInfo {
  return object(v) && ['evidenceId', 'sourceDocId', 'sourceDocName', 'snippetText', 'period'].every(k => text(v[k])) &&
    (v.location === undefined || typeof v.location === 'string') && (v.capturedAt === undefined || time(v.capturedAt));
}
function validEvent(v: unknown): boolean {
  if (!object(v) || !text(v.id) || !time(v.timestamp) || v.operator !== '主笔甲') return false;
  const types = { verify: 'recorded', defer: 'deferred', revoke: 'revoked' };
  if (!['verify', 'defer', 'revoke'].includes(String(v.action))) return false;
  return text(v.action === 'verify' ? v.notes : v.reason) &&
    (v.type === undefined || v.type === types[v.action as keyof typeof types]);
}
export function isValidVerificationRecord(v: unknown): v is PostRevisionVerificationRecord {
  if (!object(v) || !['id', 'taskId', 'draftId', 'operationId', 'blockId'].every(k => text(v[k])) ||
    !sequence(v.blockOrder) || !sequence(v.paragraphRevisionSeqAtVerification) ||
    typeof v.paragraphContentAtVerification !== 'string' || !strings(v.referencedFactIdsAtVerification) ||
    !Array.isArray(v.history) || !Array.isArray(v.events) || !v.history.length ||
    !v.history.every(validEvent) || !v.events.every(validEvent) || JSON.stringify(v.history) !== JSON.stringify(v.events) ||
    (v.contextFingerprint !== undefined && !text(v.contextFingerprint)) ||
    (v.sectionTitle !== undefined && typeof v.sectionTitle !== 'string')) return false;
  if (v.adoptedEvidencesAtVerification !== undefined && (!Array.isArray(v.adoptedEvidencesAtVerification) ||
    !v.adoptedEvidencesAtVerification.every(e => object(e) && ['evidenceId','sourceDocId','sourceDocName','snippetText','period','contentFingerprint'].every(k => text(e[k])) &&
      ['current_fact','style_ref'].includes(String(e.usage)) && (e.associatedFactId === undefined || text(e.associatedFactId))))) return false;
  if (v.status === 'verified') return v.verifiedBy === '主笔甲' && time(v.verifiedAt) && text(v.notes);
  if (v.status === 'deferred') return v.deferredBy === '主笔甲' && time(v.deferredAt) && text(v.deferredReason);
  return v.status === 'revoked' && object(v.revocation) && v.revocation.revokedBy === '主笔甲' &&
    time(v.revocation.revokedAt) && text(v.revocation.reason);
}
export function isValidVerificationCredential(v: unknown): v is PostRevisionVerificationCredential {
  if (!object(v) || !['operationId','taskId','sourceDraftId','targetDraftId'].every(k => text(v[k])) ||
    v.operatorRole !== '主笔甲' || !time(v.createdAt) || !Array.isArray(v.facts) || !v.facts.length ||
    !Array.isArray(v.blocks) || !v.blocks.length) return false;
  const factIds = new Set<string>(), blockIds = new Set<string>();
  for (const f of v.facts) {
    if (!object(f) || !['factId','metric','unit','period','fromValue','toValue'].every(k => text(f[k])) ||
      factIds.has(f.factId as string) || !strings(f.referencingBlockIds) || !f.referencingBlockIds.length ||
      !validEvidence(f.fromEvidence) || !validEvidence(f.toEvidence) ||
      (f.beforeEvidenceSnapshot !== undefined && !validEvidence(f.beforeEvidenceSnapshot)) ||
      (f.afterEvidenceSnapshot !== undefined && !validEvidence(f.afterEvidenceSnapshot))) return false;
    factIds.add(f.factId as string);
  }
  for (const b of v.blocks) {
    if (!object(b) || !text(b.blockId) || blockIds.has(b.blockId) || !sequence(b.blockOrder) ||
      !sequence(b.appliedRevisionSeq) || typeof b.beforeContent !== 'string' || typeof b.afterContent !== 'string' ||
      (b.sectionTitle !== undefined && typeof b.sectionTitle !== 'string') ||
      !strings(b.associatedFactIds) || !b.associatedFactIds.length || !b.associatedFactIds.every(id => factIds.has(id))) return false;
    blockIds.add(b.blockId);
  }
  // Both directions must describe exactly the same stable-ID relation.
  const facts = v.facts as unknown as PostRevisionFactInfo[], blocks = v.blocks as unknown as PostRevisionBlockInfo[];
  return facts.every(f => f.referencingBlockIds.every(id => blockIds.has(id)) &&
    blocks.every(b => f.referencingBlockIds.includes(b.blockId) === b.associatedFactIds.includes(f.factId)));
}
export function isValidFrozenPostRevisionVerificationOverview(v: unknown): v is PostRevisionVerificationOverview {
  if (!object(v) || typeof v.hasCredential !== 'boolean' || typeof v.isAllVerified !== 'boolean' ||
    !['totalBlocks','verifiedCount','pendingCount','deferredCount','invalidatedCount'].every(k => sequence(v[k])) ||
    !Array.isArray(v.facts) || !Array.isArray(v.blockEvaluations)) return false;
  if (!v.hasCredential) return v.totalBlocks === 0 && v.verifiedCount === 0 && v.pendingCount === 0 &&
    v.deferredCount === 0 && v.invalidatedCount === 0 && !v.isAllVerified && !v.facts.length && !v.blockEvaluations.length;
  const evaluations = v.blockEvaluations, facts = v.facts;
  const credential = { taskId: 'frozen', sourceDraftId: v.sourceDraftId, targetDraftId: v.targetDraftId,
    operationId: v.operationId, operatorRole: v.operatorRole, createdAt: v.createdAt, facts: v.facts,
    blocks: evaluations.map(e => object(e) ? e.credBlock : null) };
  if (!isValidVerificationCredential(credential) || v.totalBlocks !== evaluations.length) return false;
  if (!evaluations.every(e => object(e) && text(e.blockId) && object(e.credBlock) && e.blockId === e.credBlock.blockId &&
    ['pending','verified','deferred','invalidated','block_missing'].includes(String(e.displayStatus)) &&
    Array.isArray(e.associatedFacts) && e.associatedFacts.every(f => object(f) &&
      JSON.stringify(f) === JSON.stringify(facts.find(fact => object(fact) && fact.factId === f.factId))) &&
    strings(e.associatedFactIds) && typeof e.displayStatusLabel === 'string' &&
    (e.currentBlock === undefined || (object(e.currentBlock) && typeof e.currentBlock.content === 'string' &&
      typeof e.currentBlock.sectionId === 'string' && strings(e.currentBlock.referencedFactIds))) &&
    (e.record === undefined || (isValidVerificationRecord(e.record) && e.record.draftId === v.targetDraftId &&
      e.record.operationId === v.operationId && e.record.blockId === e.blockId)) &&
    (e.displayStatus !== 'verified' || (object(e.record) && e.record.status === 'verified')))) return false;
  const count = (status: string) => evaluations.filter(e => (e as Record<string,unknown>).displayStatus === status).length;
  return v.verifiedCount === count('verified') && v.deferredCount === count('deferred') && v.invalidatedCount === count('invalidated') &&
    v.pendingCount === (v.totalBlocks as number) - count('verified') && v.isAllVerified === (count('verified') === v.totalBlocks);
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

/** Shared semantic context with Task22; this does not alter Task22 review eligibility. */
export function getPostRevisionVerificationContext(task: Task, draft: DraftVersion, block: ParagraphBlock): string {
  return getFactReviewContext(task, draft, block);
}

function factProblem(task: Task, draft: DraftVersion, block: ParagraphBlock | undefined, credBlock: PostRevisionBlockInfo): string | undefined {
  const items = draft.snapshotMetadata?.factSnapshot?.items;
  if (!items) return '所选稿件缺少采纳时事实基准，需先处理事实差异';
  const ids = new Set([...credBlock.associatedFactIds, ...(block?.referencedFactIds || []),
    ...(block?.adoptedEvidences || []).flatMap(e => e.associatedFactId ? [e.associatedFactId] : [])]);
  for (const id of ids) {
    const f = task.facts.find(f => f.id === id), adopted = items.find(i => i.factId === id);
    if (!f || !adopted || f.status !== 'confirmed' || f.isHistoricOnly || (f.hasConflict && !f.selectedConflictValue))
      return `关联事实【${f?.metric || id}】缺失、未核准或存在未裁决冲突，需先处理事实差异`;
    if (['metric','value','unit','period','metricScope','primaryEvidenceId'].some(k =>
      f[k as keyof typeof f] !== adopted[k as keyof typeof adopted]) ||
      f.selectedConflictValue !== adopted.selectedConflictValue || Boolean(f.hasConflict) !== Boolean(adopted.hasConflict))
      return `关联事实【${f.metric}】与本稿采纳基准不同，需先处理事实差异`;
    const snippet = task.snippets.find(s => s.id === f.primaryEvidenceId);
    const doc = task.documents.find(d => d.id === snippet?.sourceDocId), frozen = adopted.provenance;
    const receipt = draft.postRevisionVerificationCredential?.facts.find(info => info.factId === id);
    if (receipt && (receipt.toValue !== adopted.value || receipt.metric !== adopted.metric || receipt.unit !== adopted.unit ||
      !arePeriodsStrictlyIdentical(receipt.period, adopted.period) || receipt.toEvidence.evidenceId !== adopted.primaryEvidenceId ||
      receipt.toEvidence.snippetText !== frozen?.text || receipt.toEvidence.sourceDocId !== frozen?.sourceDocId))
      return `关联事实【${f.metric}】核对凭据与本稿采用依据不一致，需先核实凭据`;
    if (!snippet || !doc || doc.excluded || doc.usage !== 'current_fact' || !frozen ||
      snippet.id !== frozen.evidenceId || snippet.sourceDocId !== frozen.sourceDocId || snippet.docName !== frozen.sourceDocName ||
      snippet.location !== frozen.location || snippet.text !== frozen.text ||
      !arePeriodsStrictlyIdentical(snippet.period, f.period) || !arePeriodsStrictlyIdentical(doc.period, f.period))
      return `关联事实【${f.metric}】出处缺失、已排除或原文与采纳存证不同，需先处理事实差异`;
  }
  return undefined;
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
    isValidFrozenPostRevisionVerificationOverview(draft.frozenPostRevisionVerificationOverview) &&
    (!draft.frozenPostRevisionVerificationOverview.hasCredential ||
      (isValidVerificationCredential(draft.postRevisionVerificationCredential) &&
        draft.postRevisionVerificationCredential.taskId === task.id &&
        draft.frozenPostRevisionVerificationOverview.operationId === draft.postRevisionVerificationCredential.operationId &&
        draft.frozenPostRevisionVerificationOverview.targetDraftId === draft.postRevisionVerificationCredential.targetDraftId))
  ) {
    const frozen = JSON.parse(JSON.stringify(draft.frozenPostRevisionVerificationOverview));
    frozen.totalBlocksCount = frozen.totalBlocksCount ?? frozen.totalBlocks;
    frozen.statusSummaryText =
      frozen.statusSummaryText ||
      `本次修订核对：${frozen.verifiedCount}/${frozen.totalBlocks}段已记录 · ${frozen.pendingCount}段待处理`;
    return frozen;
  }

  const cred = draft.postRevisionVerificationCredential;
  if (draft.isHistoricalSnapshot || draft.isFinal || !cred || !isValidVerificationCredential(cred) || cred.taskId !== task.id ||
    (!(draft.isHistoricalSnapshot || draft.isFinal) && cred.targetDraftId !== draft.id)) {
    return {
      hasCredential: false,
      message: draft.isHistoricalSnapshot || draft.isFinal
        ? '历史版本未保留完整核对结论，无法还原保存时的核对状态'
        : '本稿未保存修订后核对清单，无法还原本次范围',
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
    if (
      rec &&
      rec.blockId &&
      rec.taskId === task.id &&
      rec.draftId === draft.id &&
      rec.operationId === cred.operationId &&
      isValidVerificationRecord(rec)
    ) {
      recordMap.set(rec.blockId, rec);
    }
  }

  const blockEvaluations: PostRevisionBlockEvaluation[] = [];

  for (const credBlock of cred.blocks) {
    const currentBlock = draft.blocks.find((b) => b.id === credBlock.blockId);
    const rec = recordMap.get(credBlock.blockId);

    // Associated facts for this block
    const associatedFacts = cred.facts.filter((f) => credBlock.associatedFactIds.includes(f.factId));

    const factDifferenceNotice = factProblem(task, draft, currentBlock, credBlock);
    const hasFactConflictOrDifference = Boolean(factDifferenceNotice);

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
      // 4. Adopted evidence (material supplement) on paragraph block changed
      else if (
        Boolean(currentBlock.adoptedEvidences && currentBlock.adoptedEvidences.length > 0) !==
          Boolean(rec.adoptedEvidencesAtVerification && rec.adoptedEvidencesAtVerification.length > 0) ||
        (currentBlock.adoptedEvidences &&
          rec.adoptedEvidencesAtVerification &&
          JSON.stringify(currentBlock.adoptedEvidences) !== JSON.stringify(rec.adoptedEvidencesAtVerification))
      ) {
        invalidatedReason = '段落材料补写存证关联发生变动，原核对结论失效';
      }
      // 5. Associated fact unadjudicated conflict or unconfirmed or altered
      else if (hasFactConflictOrDifference) {
        invalidatedReason = factDifferenceNotice || '关联事实或出处发生变动，需先前往处理事实差异';
      }

      if (!invalidatedReason && (!rec.contextFingerprint || rec.contextFingerprint !== getPostRevisionVerificationContext(task, draft, currentBlock))) {
        invalidatedReason = '原核对上下文不完整或相关事实、裁决与出处已变化，需重新核对';
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
    contextFingerprint?: string;
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


  if (params.baselineState?.contextFingerprint &&
    params.baselineState.contextFingerprint !== getPostRevisionVerificationContext(task, draft, block)) {
    return { valid: false, reason: '核对期间相关事实、出处或段落关联已变化，请重新核对后提交' };
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
  const { params } = parseActionArgs(arg1, arg2, arg3);
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
  const problem = factProblem(task, draft, block, credBlock);
  if (problem) return { success: false, reason: problem, error: problem };

  const now = new Date().toISOString();
  const existingRecords = draft.postRevisionVerificationRecords || [];
  const existingIndex = existingRecords.findIndex(
    (r) => r.blockId === blockId && r.taskId === task.id && r.draftId === draftId && r.operationId === operationId
  );

  const event: PostRevisionVerificationEvent = {
    id: `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    action: 'verify',
    type: 'recorded',
    operator: activeRole,
    timestamp: now,
    notes: notes.trim(),
  };

  const adoptedEvidencesAtVerification = block.adoptedEvidences
    ? JSON.parse(JSON.stringify(block.adoptedEvidences))
    : undefined;

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
      adoptedEvidencesAtVerification,
      contextFingerprint: getPostRevisionVerificationContext(task, draft, block),
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
      adoptedEvidencesAtVerification,
      contextFingerprint: getPostRevisionVerificationContext(task, draft, block),
      history: [event],
      events: [event],
    };
  }

  const nextRecords =
    existingIndex >= 0
      ? existingRecords.map((r, i) => (i === existingIndex ? updatedRecord : r))
      : [...existingRecords, updatedRecord];

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
  const { params } = parseActionArgs(arg1, arg2, arg3);
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
  const existingIndex = existingRecords.findIndex(
    (r) => r.blockId === blockId && r.taskId === task.id && r.draftId === draftId && r.operationId === operationId
  );

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
  const { params } = parseActionArgs(arg1, arg2, arg3);
  const { reason, activeRole } = params;

  if (!reason || reason.trim().length === 0) {
    const msg = '撤回原因不能为空，请填写具体原因';
    return { success: false, reason: msg, error: msg };
  }

  const check = validateVerificationPreconditions(params);
  if (!check.valid || !check.draft || !check.block) {
    return { success: false, reason: check.reason, error: check.reason };
  }

  const { task, draftId, operationId, blockId } = params;
  const draft = check.draft;

  const existingRecords = draft.postRevisionVerificationRecords || [];
  const existing = existingRecords.find(
    (r) => r.blockId === blockId && r.taskId === task.id && r.draftId === draftId && r.operationId === operationId
  );

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

  const nextRecords = existingRecords.map((r) =>
    r.blockId === blockId && r.taskId === task.id && r.draftId === draftId && r.operationId === operationId
      ? updatedRecord
      : r
  );

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
