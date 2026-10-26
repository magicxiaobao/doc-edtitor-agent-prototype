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

/** Stable semantic context: approval timestamps and unrelated facts are excluded. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function getFactReviewContext(task: Task, draft: DraftVersion, block: ParagraphBlock): string {
  const factIds = [...new Set([...block.referencedFactIds,
    ...(block.adoptedEvidences || []).flatMap(e => e.associatedFactId ? [e.associatedFactId] : [])])].sort();
  return canonical({taskId:task.id,draftId:draft.id,blockId:block.id,content:block.content,
    revisionSeq:block.revisionSeq ?? 0,referencedFactIds:[...new Set(block.referencedFactIds)].sort(),
    adoptedEvidences:[...(block.adoptedEvidences || [])].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)),
    adoptedMaterialSources:[...(block.adoptedEvidences||[])].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)).map(e=>{
      const snippet=task.snippets.find(s=>s.id===e.evidenceId);
      const source=task.documents.find(d=>d.id===snippet?.sourceDocId);
      return {id:e.evidenceId,snippet:snippet||null,source:source?{id:source.id,name:source.name,
        period:source.period,usage:source.usage,excluded:Boolean(source.excluded)}:null};
    }),
    taskPeriod:[task.startDate,task.endDate],draftPeriod:[draft.snapshotMetadata?.startDate,draft.snapshotMetadata?.endDate],
    hasBaseline:Boolean(draft.snapshotMetadata?.factSnapshot),
    facts:factIds.map(id => {
      const f=task.facts.find(f=>f.id===id);
      const snapshot=draft.snapshotMetadata?.factSnapshot?.items.find(i=>i.factId===id);
      const snippet=task.snippets.find(s=>s.id===f?.primaryEvidenceId);
      const doc=task.documents.find(d=>d.id===snippet?.sourceDocId);
      return {id, snapshot, latest:f ? {metric:f.metric,value:f.value,unit:f.unit,period:f.period,
        metricScope:f.metricScope,status:f.status,primaryEvidenceId:f.primaryEvidenceId,
        hasConflict:f.hasConflict,selectedConflictValue:f.selectedConflictValue,
        conflictResolutionReason:f.conflictResolutionReason,conflictCandidates:f.conflictCandidates,
        isHistoricOnly:f.isHistoricOnly,isAuthorSupplemented:f.isAuthorSupplemented} : null,
        snippet:snippet || null, source:doc ? {id:doc.id,name:doc.name,period:doc.period,
          usage:doc.usage,excluded:Boolean(doc.excluded)} : null};
    })});
}

const strings=(v:unknown):v is string[] => Array.isArray(v)&&v.every(x=>typeof x==='string');
export function isValidFactReviewRecord(value: unknown): value is ParagraphFactReviewRecord {
  if(!value || typeof value!=='object')return false;
  const r=value as ParagraphFactReviewRecord;
  if(!['id','taskId','draftId','blockId','sectionId','sectionTitle','notes','paragraphContentAtReview']
    .every(k=>typeof (r as unknown as Record<string,unknown>)[k]==='string'))return false;
  if(!r.id||!r.taskId||!r.draftId||!r.blockId||!r.notes.trim())return false;
  if(!['reviewed','deferred','revoked'].includes(r.status)||!['主笔甲','审阅乙','审阅丁','供稿丙'].includes(r.reviewedBy))return false;
  if(typeof r.reviewedAt!=='string'||!Number.isFinite(Date.parse(r.reviewedAt))||!Number.isFinite(r.blockOrder)
    ||!Number.isFinite(r.paragraphRevisionSeqAtReview)||!strings(r.referencedFactIdsAtReview)
    ||!strings(r.adoptedEvidenceIdsAtReview)||!Array.isArray(r.factsSummaryAtReview))return false;
  if(r.contextFingerprint!==undefined&&typeof r.contextFingerprint!=='string')return false;
  if(!r.factsSummaryAtReview.every(f=>f&&typeof f==='object'&&
    ['factId','metric','snapshotValue','snapshotPeriod','snapshotMetricScope','snapshotDocName','snapshotLocation',
      'latestConfirmedValue','latestPeriod','latestMetricScope','latestStatus','latestDocName','latestLocation']
      .every(k=>typeof (f as unknown as Record<string,unknown>)[k]==='string')
      &&typeof f.hasFrozenSnapshot==='boolean'&&typeof f.hasConflict==='boolean'))return false;
  if(r.status==='revoked'&&!r.revocation)return false;
  if(r.revocation!==undefined&&(!r.revocation||typeof r.revocation.reason!=='string'||!r.revocation.reason.trim()
    ||typeof r.revocation.revokedAt!=='string'||!Number.isFinite(Date.parse(r.revocation.revokedAt))
    ||r.revocation.revokedBy!=='主笔甲'))return false;
  return true;
}

function recordsOf(draft:DraftVersion) {
  return Array.isArray(draft.factReviewRecords) ? draft.factReviewRecords.filter(isValidFactReviewRecord) : [];
}

function contextDifferenceReason(previous:string,current:string):string {
  try {
    const before=JSON.parse(previous),after=JSON.parse(current);
    for(const [field,label] of [['referencedFactIds','段落事实引用关系'],['adoptedEvidences','材料补写存证关联'],
      ['adoptedMaterialSources','材料补写所用原文或来源'],['hasBaseline','稿件冻结基准'],
      ['taskPeriod','任务统计期间'],['draftPeriod','稿件统计期间']] as const) {
      if(canonical(before[field])!==canonical(after[field]))return `${label}已变动，需重新核对`;
    }
    for(const fact of after.facts||[]) {
      const old=before.facts?.find((f:{id:string})=>f.id===fact.id);
      const metric=fact.latest?.metric||old?.latest?.metric||fact.snapshot?.metric||fact.id;
      if(!old)return `事实【${metric}】的引用范围已变化，需重新核对`;
      if(canonical(old.snapshot)!==canonical(fact.snapshot))return `事实【${metric}】的稿件冻结基准或原文已变动，需重新核对`;
      if(!old.latest||!fact.latest) {
        if(canonical(old.latest)!==canonical(fact.latest))return `事实【${metric}】已删除或重新出现，需重新核对`;
      } else {
        for(const [field,label] of [['value','最新数值或单位'],['selectedConflictValue','最新数值或单位'],
          ['unit','最新数值或单位'],['period','最新统计期间'],['metricScope','最新统计口径'],
          ['status','核准状态'],['primaryEvidenceId','主出处'],['hasConflict','冲突状态'],
          ['conflictResolutionReason','裁决理由'],['conflictCandidates','冲突候选']] as const) {
          if(canonical(old.latest[field])!==canonical(fact.latest[field]))return `事实【${metric}】${label}已变动，需重新核对`;
        }
      }
      if(canonical(old.snippet)!==canonical(fact.snippet))return `事实【${metric}】主出处原文或定位已变动/缺失，需重新核对`;
      if(canonical(old.source)!==canonical(fact.source))return `事实【${metric}】来源材料信息已变动/缺失，需重新核对`;
    }
  } catch {return '旧记录未保存可比较的核对依据，需重新核对';}
  return '相关事实或依据范围已变动，需重新核对';
}

export function isValidFrozenFactReviewOverview(v: unknown): v is DraftFactReviewOverview {
  if(!v||typeof v!=='object')return false;
  const o=v as DraftFactReviewOverview;
  return ['totalAffectedBlocks','reviewedCount','pendingCount','deferredCount','invalidatedCount','unreviewedCount']
    .every(k=>Number.isFinite((o as unknown as Record<string,number>)[k]))&&Array.isArray(o.blockEvaluations)
    &&o.blockEvaluations.every(b=>b&&typeof b.blockId==='string'&&typeof b.sectionTitle==='string'
      &&Number.isFinite(b.blockOrder)&&typeof b.sectionId==='string'&&strings(b.limitations)
      &&Array.isArray(b.changedFacts)&&b.changedFacts.every((f:FactImpactItem)=>f&&
        ['factId','metric','draftSnapshotValue','draftPeriod','draftMetricScope','draftDocName','draftLocation',
          'latestConfirmedValue','latestPeriod','latestMetricScope','latestStatus','latestDocName','latestLocation']
          .every(k=>typeof (f as unknown as Record<string,unknown>)[k]==='string')
        &&Array.isArray(f.differenceTags)&&f.differenceTags.every(t=>t&&typeof t.type==='string'&&typeof t.label==='string')
        &&Array.isArray(f.referencingBlocks)&&typeof f.hasFrozenSnapshot==='boolean')
      &&['pending','reviewed','deferred','invalidated'].includes(b.displayStatus)
      &&(b.invalidatedReason===undefined||typeof b.invalidatedReason==='string')
      &&typeof b.displayStatusLabel==='string'&&typeof b.isPending==='boolean'&&typeof b.isReviewed==='boolean'
      &&(!b.record||isValidFactReviewRecord(b.record)));
}

export function checkReviewRecordApplicability(
  task: Task, draft: DraftVersion, block: ParagraphBlock,
  record: ParagraphFactReviewRecord, _currentBlockImpacts: FactImpactItem[]
): {isValid:boolean;invalidatedReason?:string} {
  let reason='';
  if(!isValidFactReviewRecord(record))reason='复核记录不完整，需重新核对';
  else if(record.taskId!==task.id||record.draftId!==draft.id||record.blockId!==block.id)reason='复核记录不属于当前任务、版本或段落';
  else if(record.status==='revoked')reason='复核记录已被撤回，需重新核对';
  else if(block.content!==record.paragraphContentAtReview)reason='段落正文在复核后已发生修改';
  else if((block.revisionSeq??0)!==record.paragraphRevisionSeqAtReview)reason='段落修订版本已递增（正文发生过编辑或安全撤销）';
  else if(!record.contextFingerprint)reason='旧记录未保存完整核对依据，需重新核对';
  else {
    const current=getFactReviewContext(task,draft,block);
    if(current!==record.contextFingerprint)reason=contextDifferenceReason(record.contextFingerprint,current);
  }
  return reason?{isValid:false,invalidatedReason:reason}:{isValid:true};
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

  // The saved conclusion belongs to that moment, independent of live task differences.
  if ((draft.isHistoricalSnapshot || draft.isFinal) && isValidFrozenFactReviewOverview(draft.frozenFactReviewOverview)) {
    return JSON.parse(JSON.stringify(draft.frozenFactReviewOverview));
  }
  // Analyze impact
  const analysis = analyzeFactImpact(task, draft);
  const isHistorical=Boolean(draft.isHistoricalSnapshot||draft.isFinal);
  const existingRecords=recordsOf(draft).filter(r=>r.taskId===task.id&&(isHistorical||r.draftId===draft.id));
  const affectedBlockIds=[...new Set([...analysis.affectedBlockIds,...existingRecords.map(r=>r.blockId)])];

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
      const applicability = isHistorical ? {isValid:false,invalidatedReason:'旧快照未保存当时的复核状态，仅展示历史留痕，不能推断当时已通过'} : checkReviewRecordApplicability(task, draft, block, record, blockImpacts);
      if (!applicability.isValid) {
        displayStatus = 'invalidated';
        displayStatusLabel = isHistorical ? '当时复核状态无法还原' : '原复核已失效，需重新核对';
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
  expectedContextFingerprint?: string;
}): { updatedTask: Task; workingDraft: DraftVersion; newRecord: ParagraphFactReviewRecord } {
  const { task, targetDraftId, targetBlockId, status, notes, activeRole, expectedContextFingerprint } = params;

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

  if(task.currentDraftId!==draft.id)throw new Error('稿件已切换，请重新核对当前工作稿');
  if(expectedContextFingerprint!==undefined&&expectedContextFingerprint!==getFactReviewContext(task,draft,block))
    throw new Error('正文或依据已变化，请重新核对后再次填写说明');

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
  const hasPriorRecord=recordsOf(draft).some(r=>r.taskId===task.id&&r.draftId===draft.id&&r.blockId===block.id);
  if(!analysis.affectedBlockIds.includes(block.id)&&!hasPriorRecord)
    throw new Error('该段当前没有可复核的事实差异，请重新查看影响范围');
  const factsSummary = buildFactsSummaryForBlock(task, draft, analysis.allReferencedItems, targetBlockId);

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
    contextFingerprint:getFactReviewContext(task,draft,block),
  };

  // Append a new event: previous notes and revocation evidence stay inspectable.
  const existingRecords = recordsOf(draft);
  const updatedRecords = [
    newRecord,
    ...existingRecords,
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
  expectedRecordId?: string;
  expectedContextFingerprint?: string;
}): { updatedTask: Task; workingDraft: DraftVersion } {
  const { task, targetDraftId, targetBlockId, reason, activeRole,expectedRecordId,expectedContextFingerprint } = params;

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
  const block=draft.blocks.find(b=>b.id===targetBlockId);
  if(!block||task.currentDraftId!==draft.id)throw new Error('稿件或段落已切换，请重新核对');
  if(expectedContextFingerprint!==undefined&&expectedContextFingerprint!==getFactReviewContext(task,draft,block))
    throw new Error('正文或依据已变化，请重新核对后撤回');
  const existingRecords = recordsOf(draft);
  const targetRecord = existingRecords.find((r) => r.blockId === targetBlockId&&r.taskId===task.id&&r.draftId===draft.id);
  if(targetRecord?.status==='revoked')throw new Error('该记录已撤回，不能覆盖原撤回说明');
  if(expectedRecordId!==undefined&&targetRecord?.id!==expectedRecordId)throw new Error('复核记录已更新，请重新查看后撤回');
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
    r.id === targetRecord.id ? updatedRecord : r
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
