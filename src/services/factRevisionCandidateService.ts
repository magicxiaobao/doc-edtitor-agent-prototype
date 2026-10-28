import {
  Task,
  DraftVersion,
  ParagraphBlock,
  FactItemSnapshot,
  FactSnapshot,
  StyleSnapshot,
  OutlineSnapshot,
  FactRevisionCandidate,
  MultiParagraphFactRevisionCandidate,
  MultiFactGroupRevisionCandidate,
  FactRevisionItem,
  FactRevisionLogItem,
  ParagraphRevisionCandidateItem,
  MultiParagraphRevisionLogItem,
  ParagraphModificationLog,
  UserRole,
} from '../types';
import { analyzeFactImpact, FactImpactAnalysisResult, FactImpactItem } from './factImpactService';
import {
  computeDraftBlocksHash,
  freezeReviewComments,
  freezeFactReviews,
  sourceFactReviews,
  getReviewBaselineIds,
} from './draftLifecycleService';
import { buildFactItemSnapshot, confirmFact, extractClausePeriod, arePeriodsStrictlyIdentical,
  parsePeriodDateRange } from './factLifecycleService';

export interface FactRevisionEligibilityResult {
  eligible: boolean;
  reason?: string;
  targetFactId?: string;
  targetFactItem?: FactImpactItem;
  unconfirmedUpstream?: 'fact' | 'style' | 'outline';
}

export interface FactRevisionCandidateResult {
  success: boolean;
  reason?: string;
  candidate?: FactRevisionCandidate;
}

export interface FactRevisionAcceptanceResult {
  success: boolean;
  reason?: string;
  updatedTask?: Task;
  newWorkingDraft?: DraftVersion;
  archivedDraft?: DraftVersion;
}

export interface MultiParagraphFactRevisionEligibilityResult {
  eligible: boolean;
  reason?: string;
  targetFactId?: string;
  targetFactItem?: FactImpactItem;
  referencingBlocks?: ParagraphBlock[];
  targetBlockIds?: string[];
  unconfirmedUpstream?: 'fact' | 'style' | 'outline';
  blockingReasons?: string[];
}

export interface MultiParagraphFactRevisionCandidateResult {
  success: boolean;
  reason?: string;
  candidateGroup?: MultiParagraphFactRevisionCandidate;
}

export interface MultiParagraphFactRevisionAcceptanceResult {
  success: boolean;
  reason?: string;
  updatedTask?: Task;
  newWorkingDraft?: DraftVersion;
  archivedDraft?: DraftVersion;
  modificationLog?: ParagraphModificationLog;
}

export interface MultiFactGroupRevisionEligibilityResult {
  eligible: boolean;
  reason?: string;
  targetFactIds?: string[];
  targetFactItems?: FactImpactItem[];
  referencingBlocksByFact?: Record<string, ParagraphBlock[]>;
  allReferencingBlocks?: ParagraphBlock[];
  unconfirmedUpstream?: 'fact' | 'style' | 'outline';
  blockingReasons?: string[];
}

export interface MultiFactGroupRevisionCandidateResult {
  success: boolean;
  reason?: string;
  candidateGroup?: MultiFactGroupRevisionCandidate;
}

export interface MultiFactGroupRevisionAcceptanceResult {
  success: boolean;
  reason?: string;
  updatedTask?: Task;
  newWorkingDraft?: DraftVersion;
  archivedDraft?: DraftVersion;
  modificationLog?: ParagraphModificationLog;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metricValueOffset(text: string, metric: string, value: string, unit: string): number | undefined {
  if (!metric || !unit || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  // This batch supports explicit metric labels, not inferred aliases. Match the
  // whole quantity immediately governed by that label, with a complete unit.
  const re = new RegExp(`${escapeRegex(metric)}\\s*(?:为|共|计|达到|达|已完成|完成)?\\s*(${escapeRegex(value)})\\s*${escapeRegex(unit)}(?=\\s*(?:[，,。；;！？!?、）)\\]】]|$))`, 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const before = text.slice(0, match.index!);
  const sentenceStart = Math.max(...['。', '；', ';', '！', '!', '？', '?', '\n'].map(mark => before.lastIndexOf(mark))) + 1;
  const governingPrefix = text.slice(sentenceStart, match.index!);
  // Do not turn a planned, predicted, conditional or negated occurrence of an
  // actual-performance metric into evidence for an accomplished quantity.
  if (/(?:计划|规划|预计|预期|预测|预估|目标|预算|拟|将|力争|争取|希望|建议|应|需|须|假设|假定|如果|若|测算|估计|可能|或许|未|没有|不|非|无|至多|至少|超过|近似|约)/.test(governingPrefix)) {
    return undefined;
  }
  return match.index! + match[0].indexOf(value, metric.length);
}

function supportedMetricPeriod(text: string, quantity: string, period: string, fallbackYear: string, offset: number): boolean {
  const cutoffPattern = /截至\s*(?:(\d{4})年)?(\d{1,2})月(?:末|底)/g;
  const cutoffs = [...text.matchAll(cutoffPattern)];
  const range = parsePeriodDateRange(period);
  if (cutoffs.length) {
    if (!range) return false;
    const end = range.end;
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    if (cutoffs.some(match => Number(match[2]) !== end.getUTCMonth() + 1 ||
        (match[1] && Number(match[1]) !== end.getUTCFullYear()) || end.getUTCDate() !== lastDay)) return false;
  }
  // Only a verified end-of-period cutoff may be removed from range extraction.
  const periodText = text.replace(cutoffPattern, cutoff => ' '.repeat(cutoff.length));
  const extracted = extractClausePeriod(periodText, quantity, fallbackYear, offset);
  return !extracted.isAmbiguous && (!extracted.period || arePeriodsStrictlyIdentical(extracted.period, period));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function hasUniqueBlockIds(draft: DraftVersion): boolean {
  const ids = draft.blocks.map(block => block?.id);
  return ids.every(id => typeof id === 'string' && id.trim().length > 0) && new Set(ids).size === ids.length;
}

// Capturing a new approval may refresh provenance time without changing its meaning.
function semanticFact(item: FactItemSnapshot) {
  const { capturedAt: _time, ...provenance } = item.provenance || {};
  return { ...item, hasConflict: Boolean(item.hasConflict), provenance: item.provenance ? provenance : undefined };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
function validFactBasis(snapshot: FactSnapshot | undefined): snapshot is FactSnapshot {
  return Boolean(snapshot && typeof snapshot.hash === 'string' && snapshot.hash &&
    typeof snapshot.confirmedAt === 'string' && snapshot.confirmedAt && strings(snapshot.factIds) &&
    Array.isArray(snapshot.items) && snapshot.items.length && snapshot.items.every(item => item &&
      ['factId', 'metric', 'value', 'unit', 'period', 'metricScope', 'primaryEvidenceId'].every(
        field => typeof (item as unknown as Record<string, unknown>)[field] === 'string') &&
      (item.selectedConflictValue === undefined || typeof item.selectedConflictValue === 'string') &&
      item.provenance && ['evidenceId', 'sourceDocId', 'sourceDocName', 'text'].every(
        field => typeof (item.provenance as unknown as Record<string, unknown>)[field] === 'string') &&
      ['location', 'period', 'capturedAt'].every(field => {
        const value = (item.provenance as unknown as Record<string, unknown>)[field];
        return value === undefined || typeof value === 'string';
      })));
}
function validStyleBasis(snapshot: StyleSnapshot | undefined): snapshot is StyleSnapshot {
  return Boolean(snapshot && typeof snapshot.hash === 'string' && snapshot.hash &&
    typeof snapshot.confirmedAt === 'string' && snapshot.confirmedAt && strings(snapshot.activeRuleIds));
}
function validOutlineBasis(snapshot: OutlineSnapshot | undefined): snapshot is OutlineSnapshot {
  return Boolean(snapshot && typeof snapshot.hash === 'string' && snapshot.hash &&
    typeof snapshot.confirmedAt === 'string' && snapshot.confirmedAt && Array.isArray(snapshot.sections) &&
    snapshot.sections.every(s => s && typeof s.sectionId === 'string' && typeof s.title === 'string' &&
      Number.isFinite(s.suggestedWordCount) && strings(s.assignedFactIds)));
}

export function getFactRevisionContext(task: Task, draft: DraftVersion): string {
  const evidenceIds = new Set([
    ...task.facts.filter(f => f.status === 'confirmed').map(f => f.primaryEvidenceId),
    ...draft.blocks.flatMap(b => (b.adoptedEvidences || []).map(e => e.evidenceId)),
  ]);
  const snippets = task.snippets.filter(s => evidenceIds.has(s.id));
  const sourceIds = new Set(snippets.map(s => s.sourceDocId));
  return canonical({ taskId: task.id, currentDraftId: task.currentDraftId, draftId: draft.id,
    requirements: [task.title, task.docType, task.usage, task.audience, task.startDate, task.endDate,
      task.targetWordCount, task.mandatoryCoverage, task.deadline, task.primaryAuthor],
    blocks: draft.blocks, baseline: draft.snapshotMetadata, facts: task.facts,
    snippets, documents: task.documents.filter(d => sourceIds.has(d.id)),
    factSnapshot: task.factSnapshot, styleConfirmed: task.styleConfirmed,
    styleSnapshot: task.styleSnapshot, styleRules: task.styleRules,
    outlineConfirmed: task.outlineConfirmed, outlineSnapshot: task.outlineSnapshot, outline: task.outline });
}

function completeBasisError(task: Task, draft: DraftVersion, targetFactIdOrIds: string | string[]): string | undefined {
  const targetIds = Array.isArray(targetFactIdOrIds) ? targetFactIdOrIds : [targetFactIdOrIds];
  const baseline = draft.snapshotMetadata!;
  if (baseline.taskTitle !== task.title || baseline.startDate !== task.startDate ||
      baseline.endDate !== task.endDate || baseline.targetWordCount !== task.targetWordCount) {
    return '任务标题、统计期间或目标字数已变化，超出本批定向修订范围。';
  }
  // Legacy style snapshots do not store rule text. A different approval cannot be
  // certified equivalent from matching IDs alone, so this batch fails closed.
  if (baseline.styleSnapshot!.hash !== task.styleSnapshot!.hash ||
      baseline.styleSnapshot!.confirmedAt !== task.styleSnapshot!.confirmedAt) {
    return '文风审批已变化，旧稿未保存规则全文，无法证明内容一致；请使用重新起草路径。';
  }
  const liveSections = task.outline.map(s => ({ sectionId: s.id, title: s.title,
    suggestedWordCount: s.suggestedWordCount, assignedFactIds: s.assignedFactIds || [] }));
  if (canonical(liveSections) !== canonical(task.outlineSnapshot!.sections) ||
      canonical(task.outlineSnapshot!.sections) !== canonical(baseline.outlineSnapshot!.sections)) {
    return '大纲结构、章节篇幅或事实分配发生实质变化，超出本批范围。';
  }
  const outlineContent = (sections: Task['outline']) => sections.map(({ confirmed: _confirmed, ...s }) => s);
  if (canonical(outlineContent(task.outline)) !== canonical(outlineContent(baseline.outlineSections))) {
    return '章节要求或大纲内容发生变化，超出本批定向修订范围。';
  }
  const facts = task.facts.filter(f => f.status === 'confirmed' && !f.isHistoricOnly);
  const oldItems = baseline.factSnapshot!.items;
  const items = task.factSnapshot!.items;
  const ids = (list: string[]) => [...list].sort();
  const equalIds = (a: string[], b: string[]) => new Set(a).size === a.length &&
    new Set(b).size === b.length && canonical(ids(a)) === canonical(ids(b));
  if (!equalIds(facts.map(f => f.id), items.map(i => i.factId)) ||
      !equalIds(items.map(i => i.factId), task.factSnapshot!.factIds) ||
      !equalIds(oldItems.map(i => i.factId), baseline.factSnapshot!.factIds) ||
      !equalIds(items.map(i => i.factId), oldItems.map(i => i.factId))) {
    return '核准事实集合新增、删除或快照收录不完整，不能仅修订一段便推进整稿依据。';
  }
  for (const fact of facts) {
    const latest = items.find(i => i.factId === fact.id)!;
    const old = oldItems.find(i => i.factId === fact.id)!;
    const checked = confirmFact(task, fact.id, '主笔甲');
    if (!checked.success) return `事实【${fact.metric}】来源不合格：${checked.error}`;
    const snippet = task.snippets.find(s => s.id === fact.primaryEvidenceId);
    const doc = task.documents.find(d => d.id === snippet?.sourceDocId);
    if (!snippet?.text.trim() || !doc || doc.usage !== 'current_fact' || doc.excluded ||
        doc.parseStatus !== 'parsed' || !snippet.location.trim()) {
      return `事实【${fact.metric}】缺少可用本期原文出处。`;
    }
    const compact = (text: string) => text.replace(/\s+/g, '');
    if (!compact(doc.content).includes(compact(snippet.text))) {
      return `事实【${fact.metric}】原文片段与当前材料内容不对应，请重新核实出处。`;
    }
    if (canonical(semanticFact(latest)) !== canonical(semanticFact(buildFactItemSnapshot(task, fact)))) {
      return `事实【${fact.metric}】核准快照与当前事实或出处原文不一致，请重新确认事实清单。`;
    }
    if (!old.provenance?.text || old.provenance.evidenceId !== old.primaryEvidenceId) {
      return `事实【${fact.metric}】缺少完整历史冻结出处，不能证明旧稿采用依据。`;
    }
    if (!targetIds.includes(fact.id) && canonical(semanticFact(old)) !== canonical(semanticFact(latest))) {
      return `非目标事实【${fact.metric}】的指标、裁决或出处仍有变化，超出本批范围。`;
    }
    if (targetIds.includes(fact.id) && old.metric !== latest.metric) {
      return `目标指标名称【${fact.metric}】已变化，无法证明是同一数值指标。`;
    }
  }
  for (const block of draft.blocks) {
    for (const evidence of block.adoptedEvidences || []) {
      const snippet = task.snippets.find(s => s.id === evidence.evidenceId);
      const doc = task.documents.find(d => d.id === snippet?.sourceDocId);
      if (!evidence.associatedFactId || !facts.some(f => f.id === evidence.associatedFactId) ||
          !snippet || !doc || doc.excluded || doc.usage !== 'current_fact' ||
          evidence.sourceDocId !== snippet.sourceDocId || evidence.snippetText !== snippet.text ||
          evidence.snippetLocation !== snippet.location || evidence.period !== snippet.period) {
        return '稿件包含无法可靠关联或已经变化的材料补写存证，本批无法更新整稿依据。';
      }
    }
  }
  return undefined;
}

/**
 * Checks whether the current draft and target block meet the strict batch 1 criteria
 * for targeted fact revision candidate generation:
 * - Working draft, author role
 * - Full frozen baseline on draft; task latest facts, style, outline formally approved
 * - Exactly one fact changed across the entire draft, and that fact references only one block
 * - Numerical value change with consistent unit, period, and metric scope
 * - Latest fact confirmed, conflicts resolved, valid source document and snippet
 * - No untracked material supplementation or structural outline/style changes
 */
export function checkFactRevisionEligibility(
  task: Task,
  currentDraft: DraftVersion | undefined,
  targetBlockId: string,
  activeRole: UserRole
): FactRevisionEligibilityResult {
  // 1. Operator role: Must be primary author
  if (activeRole !== '主笔甲') {
    return {
      eligible: false,
      reason: `权限受限：当前操作身份为【${activeRole}】，定向修订仅允许主笔甲执行。`,
    };
  }

  // 2. Draft existence and mutability
  if (!currentDraft || !currentDraft.blocks || currentDraft.blocks.length === 0) {
    return {
      eligible: false,
      reason: '当前尚无可比较或可编辑的草稿版本。',
    };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return {
      eligible: false,
      reason: '当前选中的版本属于只读历史快照或已定稿版本，不可生成定向修订；请在当前可编辑工作稿中操作。',
    };
  }
  if (!hasUniqueBlockIds(currentDraft)) {
    return { eligible: false, reason: '稿件存在缺失或重复的稳定段落ID，无法唯一定位正文，已拒绝修订。' };
  }
  if (currentDraft.id !== task.currentDraftId || !task.drafts.some(d => d.id === currentDraft.id)) {
    return { eligible: false, reason: '所选稿不是任务当前工作稿，请返回当前工作稿操作。' };
  }
  if (canonical(currentDraft) !== canonical(task.drafts.find(d => d.id === currentDraft.id))) {
    return { eligible: false, reason: '所选稿参数已陈旧，与任务中保存的当前稿不一致，请重新打开当前稿。' };
  }

  // 3. Target block exists in current draft
  const targetBlock = currentDraft.blocks.find((b) => b.id === targetBlockId);
  if (!targetBlock) {
    return {
      eligible: false,
      reason: '目标段落不存在或已在当前草稿中被删除。',
    };
  }

  // 4. Draft baseline snapshots integrity
  const draftFactSnap = currentDraft.snapshotMetadata?.factSnapshot;
  const draftStyleSnap = currentDraft.snapshotMetadata?.styleSnapshot;
  const draftOutlineSnap = currentDraft.snapshotMetadata?.outlineSnapshot;

  if (!validFactBasis(draftFactSnap) || !validStyleBasis(draftStyleSnap) || !validOutlineBasis(draftOutlineSnap) ||
      !Array.isArray(currentDraft.snapshotMetadata?.outlineSections) ||
      !currentDraft.snapshotMetadata.outlineSections.every(s => s && typeof s.id === 'string' && typeof s.title === 'string')) {
    return {
      eligible: false,
      reason: '草稿缺少完整冻结依据基准（事实快照、文风快照或大纲快照缺失），无法验证依据一致性。',
    };
  }

  // 5. Task upstream formal confirmations
  if (!validFactBasis(task.factSnapshot)) {
    return {
      eligible: false,
      reason: '任务事实清单尚未正式核准确认，请先前往事实清单完成核准。',
      unconfirmedUpstream: 'fact',
    };
  }

  if (!task.styleConfirmed || !validStyleBasis(task.styleSnapshot)) {
    return {
      eligible: false,
      reason: '任务文风规范尚未正式核准确认，请先核准文风。',
      unconfirmedUpstream: 'style',
    };
  }

  if (!task.outlineConfirmed || !validOutlineBasis(task.outlineSnapshot)) {
    return {
      eligible: false,
      reason: '任务大纲结构尚未正式核准确认，请先核准大纲。',
      unconfirmedUpstream: 'outline',
    };
  }

  // 6. Compare rule IDs here; completeBasisError also requires the frozen style approval.
  const curStyleRules = [...(task.styleSnapshot.activeRuleIds || [])].sort().join(',');
  const draftStyleRules = [...(draftStyleSnap.activeRuleIds || [])].sort().join(',');
  if (curStyleRules !== draftStyleRules) {
    return {
      eligible: false,
      reason: '任务文风规范发生了实质变化（启用规则不一致），超出本批单事实定向修订范围，请重新起草或调整文风。',
    };
  }

  // 7. Substantive outline verification (compare sections structure and content)
  const curSections = task.outlineSnapshot.sections || [];
  const draftSections = draftOutlineSnap.sections || [];
  if (
    curSections.length !== draftSections.length ||
    curSections.some(
      (s, i) =>
        s.sectionId !== draftSections[i]?.sectionId ||
        s.title !== draftSections[i]?.title ||
        JSON.stringify(s.assignedFactIds || []) !== JSON.stringify(draftSections[i]?.assignedFactIds || [])
    )
  ) {
    return {
      eligible: false,
      reason: '任务大纲结构或章节要求发生了实质变化，超出本批单段落修订范围，请人工编辑或重新起草。',
    };
  }

  // 8. Analyze fact impact across the entire draft
  const analysis: FactImpactAnalysisResult = analyzeFactImpact(task, currentDraft);

  // Negative condition: New unreferenced facts or missing baselines
  const unreferencedApproved = analysis.unreferencedNewFacts.filter(f => f.status === 'confirmed');
  if (unreferencedApproved.length > 0) {
    return {
      eligible: false,
      reason: `任务事实清单中存在 ${unreferencedApproved.length} 项未被所选稿件引用的核准事实，存在尚未处理的依据差异，无法执行单段微调。`,
    };
  }

  const missingBaselineConfirmedFacts = (analysis.missingBaselineFactIds || []).filter(
    (id) => task.facts.find((f) => f.id === id)?.status === 'confirmed'
  );
  if (missingBaselineConfirmedFacts.length > 0) {
    return {
      eligible: false,
      reason: '草稿引用的核准事实中存在缺少冻结基准的事项，无法验证历史依据一致性。',
    };
  }

  // Negative condition: changed facts count must be exactly 1
  if (analysis.changedFactsCount === 0) {
    return {
      eligible: false,
      reason: '未发现已关联事实的数值变化，本批没有可生成的定向修订。',
    };
  }

  if (analysis.changedFactsCount > 1) {
    return {
      eligible: false,
      reason: `整份稿件存在多项事实变更（共 ${analysis.changedFactsCount} 项），超出本批单事实单段落定向修订支持范围，请人工编辑或重新起草。`,
    };
  }

  const changedFactItem = analysis.impactItems[0];
  if (!changedFactItem) {
    return {
      eligible: false,
      reason: '未检测到具体的变更事实项。',
    };
  }

  // Check that the changed fact only affects ONE block and it matches targetBlockId
  if (changedFactItem.referencingBlocks.length !== 1) {
    return {
      eligible: false,
      reason: `目标事实【${changedFactItem.metric}】关联了多个段落（共 ${changedFactItem.referencingBlocks.length} 个段落），本批仅支持单事实单段落定向修订。`,
    };
  }

  if (changedFactItem.referencingBlocks[0].blockId !== targetBlockId) {
    return {
      eligible: false,
      reason: `当前选中的第${targetBlock.order}段并非受变更事实【${changedFactItem.metric}】影响的段落。`,
    };
  }

  // 9. Inspect difference tags for unsupported changes
  for (const tag of changedFactItem.differenceTags) {
    if (tag.type === 'unit') {
      return {
        eligible: false,
        reason: `指标单位发生变化（${changedFactItem.draftSnapshotValue} → ${changedFactItem.latestConfirmedValue}），超出本批单数值定向修订范围。`,
      };
    }
    if (tag.type === 'period') {
      return {
        eligible: false,
        reason: `统计期间发生变化（${changedFactItem.draftPeriod} → ${changedFactItem.latestPeriod}），超出本批定向修订范围。`,
      };
    }
    if (tag.type === 'metric_scope') {
      return {
        eligible: false,
        reason: `统计口径发生变化（${changedFactItem.draftMetricScope} → ${changedFactItem.latestMetricScope}），超出本批定向修订范围。`,
      };
    }
    if (tag.type === 'status_pending') {
      return {
        eligible: false,
        reason: '最新事实已被撤销核准（待确认），尚未正式核准，无法采纳。',
      };
    }
    if (tag.type === 'status_excluded') {
      return {
        eligible: false,
        reason: '最新事实已被任务排除，不应作为核准依据。',
      };
    }
    if (tag.type === 'status_gap') {
      return {
        eligible: false,
        reason: '最新事实已标记为材料缺口，缺少充足材料支撑。',
      };
    }
    if (tag.type === 'status_deleted') {
      return {
        eligible: false,
        reason: '任务事实清单中已删除此事实，草稿仍在引用已删除项。',
      };
    }
    if (tag.type === 'conflict_unresolved') {
      return {
        eligible: false,
        reason: '最新事实存在未裁决冲突，尚未确定最终采信口径与数值。',
      };
    }
    if (tag.type === 'missing_baseline') {
      return {
        eligible: false,
        reason: '缺少快照冻结项基准，需人工核实。',
      };
    }
  }

  // Must have 'value' difference tag
  const hasValueDifference = changedFactItem.differenceTags.some((t) => t.type === 'value');
  if (!hasValueDifference) {
    return {
      eligible: false,
      reason: '事实数值未发生变动，无需生成数值修订候选。',
    };
  }

  // 10. Verify latest fact status and evidence validity
  const latestFact = task.facts.find((f) => f.id === changedFactItem.factId);
  if (!latestFact || latestFact.status !== 'confirmed') {
    return {
      eligible: false,
      reason: `最新事实【${changedFactItem.metric}】尚未核准（状态：${latestFact?.status || '缺失'}），无法采纳。`,
    };
  }

  if (latestFact.hasConflict && !latestFact.selectedConflictValue) {
    return {
      eligible: false,
      reason: `最新事实【${latestFact.metric}】存在未裁决冲突，尚未确定最终采信值。`,
    };
  }

  // Primary evidence snippet and source doc validity
  const snippet = task.snippets.find((s) => s.id === latestFact.primaryEvidenceId);
  if (!snippet) {
    return {
      eligible: false,
      reason: '最新事实关联的主出处材料不存在或已失效，无有效原文来源。',
    };
  }

  const doc = task.documents.find((d) => d.id === snippet.sourceDocId);
  if (!doc || (doc as any).isDeleted) {
    return {
      eligible: false,
      reason: '最新事实关联的材料文档已删除或失效，无有效原文出处。',
    };
  }

  if (!snippet.text || !snippet.text.trim()) {
    return {
      eligible: false,
      reason: '最新事实关联的主出处材料未包含有效原文摘要。',
    };
  }

  // 11. Material supplementation reliability check on target block
  if (targetBlock.adoptedEvidences && targetBlock.adoptedEvidences.length > 0) {
    return { eligible: false, reason: '目标段落包含材料补写存证，本批无法证明仅改数值即可同步补写依据。' };
  }

  const basisError = completeBasisError(task, currentDraft, changedFactItem.factId);
  if (basisError) return { eligible: false, reason: basisError };
  const adoptedValue = (latestFact.selectedConflictValue || latestFact.value).trim();
  const evidenceOffset = metricValueOffset(snippet.text, latestFact.metric, adoptedValue, latestFact.unit);
  if (evidenceOffset === undefined) {
    return { eligible: false, reason: '最新原文无法明确支持该指标的核准数值与完整单位，请人工核实。' };
  }
  if (!supportedMetricPeriod(snippet.text, `${adoptedValue}${latestFact.unit}`, latestFact.period, task.startDate, evidenceOffset)) {
    return { eligible: false, reason: '最新原文中的指标统计期间不符或归属不明，请人工核实。' };
  }

  return {
    eligible: true,
    targetFactId: changedFactItem.factId,
    targetFactItem: changedFactItem,
  };
}

/**
 * Generates a deterministic, minimal-scope revision candidate for the target paragraph:
 * - Precisely locates the numerical expression belonging to the target metric
 * - Disambiguates by unit and metric keywords
 * - Replaces ONLY the verified number, keeping units, punctuation, and all other text untouched
 * - Does not guess or fabricate text
 */
export function generateFactRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  targetBlockId: string,
  activeRole: UserRole,
  options?: { runId?: string }
): FactRevisionCandidateResult {
  const eligibility = checkFactRevisionEligibility(task, currentDraft, targetBlockId, activeRole);
  if (!eligibility.eligible || !eligibility.targetFactItem) {
    return {
      success: false,
      reason: eligibility.reason || '准入校验未通过',
    };
  }

  const currentBlock = currentDraft!.blocks.find((b) => b.id === targetBlockId)!;
  const changedItem = eligibility.targetFactItem;
  const latestFact = task.facts.find((f) => f.id === changedItem.factId)!;
  const snapItem = currentDraft!.snapshotMetadata!.factSnapshot!.items.find(
    (i) => i.factId === latestFact.id
  )!;

  const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
  const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
  const unit = (snapItem.unit || latestFact.unit || '').trim();
  const metric = (snapItem.metric || latestFact.metric || '').trim();

  if (!snapValue || !latestValue || snapValue === latestValue) {
    return {
      success: false,
      reason: '事实数值未发生实质变动，无需生成修订候选。',
    };
  }

  const text = currentBlock.content;

  const offset = metricValueOffset(text, metric, snapValue, unit);
  if (offset === undefined) {
    return { success: false,
      reason: '正文未找到唯一、完整且明确属于目标指标的冻结数值和单位，可能存在多处相同数值、语义归属不明或正文已偏离当时冻结值，请人工编辑。' };
  }
  const chosenMatch = { idx: offset };
  if (!supportedMetricPeriod(text, `${snapValue}${unit}`, snapItem.period, task.startDate, offset)) {
    return { success: false, reason: '正文指标明示的统计期间与冻结依据不符或归属不明，本批拒绝生成。' };
  }

  // 4. Perform minimal deterministic replacement
  const revisedContent =
    text.slice(0, chosenMatch.idx) + latestValue + text.slice(chosenMatch.idx + snapValue.length);

  // Safety check: verify ONLY the verified snapValue was replaced by latestValue
  const prefixMatch = revisedContent.slice(0, chosenMatch.idx) === text.slice(0, chosenMatch.idx);
  const suffixMatch =
    revisedContent.slice(chosenMatch.idx + latestValue.length) ===
    text.slice(chosenMatch.idx + snapValue.length);
  const replacedValueMatch =
    revisedContent.slice(chosenMatch.idx, chosenMatch.idx + latestValue.length) === latestValue &&
    text.slice(chosenMatch.idx, chosenMatch.idx + snapValue.length) === snapValue;

  const isMinimalDiff = prefixMatch && suffixMatch && replacedValueMatch;

  if (!isMinimalDiff) {
    return {
      success: false,
      reason: '改写结果偏离最小范围修改原则，已安全拦截。',
    };
  }

  const runId = options?.runId || `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const candidateId = `FACT-REV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const toSnip = latestFact.primaryEvidenceId
    ? task.snippets.find((s) => s.id === latestFact.primaryEvidenceId)
    : undefined;

  const candidate: FactRevisionCandidate = {
    id: candidateId,
    runId,
    taskId: task.id,
    sourceDraftId: currentDraft!.id,
    sourceDraftVersionNumber: currentDraft!.versionNumber,
    targetBlockId: currentBlock.id,
    targetBlockOrder: currentBlock.order,
    targetSectionTitle:
      task.outline.find((o) => o.id === currentBlock.sectionId)?.title ||
      currentDraft!.snapshotMetadata?.outlineSections?.find((o) => o.id === currentBlock.sectionId)?.title ||
      '正文章节',
    targetFactId: latestFact.id,
    createdAt: new Date().toISOString(),

    originalBlockContent: currentBlock.content,
    originalRevisionSeq:
      typeof currentBlock.revisionSeq === 'number' && Number.isFinite(currentBlock.revisionSeq)
        ? currentBlock.revisionSeq
        : 0,
    originalReferencedFactIds: [...currentBlock.referencedFactIds],
    originalAdoptedEvidences: currentBlock.adoptedEvidences
      ? JSON.parse(JSON.stringify(currentBlock.adoptedEvidences))
      : undefined,

    revisedBlockContent: revisedContent,
    baseDraftContentHash: computeDraftBlocksHash(currentDraft!.blocks),
    contextFingerprint: getFactRevisionContext(task, currentDraft!),

    metric,
    unit,
    fromValue: snapValue,
    toValue: latestValue,

    fromEvidenceId: snapItem.primaryEvidenceId,
    fromDocName: snapItem.provenance!.sourceDocName,
    fromLocation: snapItem.provenance!.location || '未保存定位',

    toEvidenceId: latestFact.primaryEvidenceId,
    toDocName: toSnip?.docName || '最新出处材料',
    toLocation: toSnip?.location || '段落索引',

    upstreamContext: {
      factSnapshotConfirmedAt: task.factSnapshot?.confirmedAt,
      factSnapshotHash: task.factSnapshot?.hash,
      styleConfirmedAt: task.styleSnapshot?.confirmedAt,
      styleHash: task.styleSnapshot?.hash,
      outlineConfirmedAt: task.outlineSnapshot?.confirmedAt,
      outlineHash: task.outlineSnapshot?.hash,
    },

    explanation: `经核实，指标【${metric}】已核准采信 ${latestValue}${unit}（原稿采用：${snapValue}${unit}）。已针对第${currentBlock.order}段执行最小范围定向修订，保留原文单位及前后表述。`,
  };

  return {
    success: true,
    candidate,
  };
}

/**
 * Validates candidate adoption preconditions:
 * - Isolation: Task ID, Run ID, source draft ID
 * - Freshness: Draft blocks unchanged, target block content and revisionSeq untouched
 * - Eligibility: Upstream approvals unchanged, no new fact/evidence discrepancies
 */
export function validateFactRevisionAcceptance(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidate: FactRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): { valid: boolean; reason?: string } {
  if (activeRole !== '主笔甲') {
    return { valid: false, reason: '权限受限：仅主笔甲有权采纳修订并创建新工作稿！' };
  }

  if (candidate.taskId !== task.id) {
    return { valid: false, reason: '安全隔离拦截：修订候选生成自其他任务，禁止跨任务采纳！' };
  }

  if (!activeRunId || candidate.runId !== activeRunId) {
    return { valid: false, reason: '候选已失效：该候选生成自已取消或过期的运行！' };
  }

  if (!currentDraft || currentDraft.id !== candidate.sourceDraftId) {
    return { valid: false, reason: '版本已变更：当前草稿已切换，旧候选已失效！' };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return { valid: false, reason: '当前版本已是只读快照或定稿，禁止直接采纳写入！' };
  }

  // Duplicate adoption prevention: must still be current draft of task
  if (currentDraft.id !== task.currentDraftId) {
    return { valid: false, reason: '当前草稿已不是任务当前可编辑工作稿，禁止重复采纳！' };
  }

  // Target block verification
  const targetBlock = currentDraft.blocks.find((b) => b.id === candidate.targetBlockId);
  if (!targetBlock) {
    return { valid: false, reason: '目标段落已在当前草稿中被删除，候选已失效！' };
  }

  if (targetBlock.content !== candidate.originalBlockContent) {
    return {
      valid: false,
      reason: '基准正文已变更：目标段落正文已被人工编辑修改，采纳候选将覆盖人工修改！已安全拦截。',
    };
  }

  const currentSeq =
    typeof targetBlock.revisionSeq === 'number' && Number.isFinite(targetBlock.revisionSeq)
      ? targetBlock.revisionSeq
      : 0;
  if (currentSeq !== candidate.originalRevisionSeq) {
    return {
      valid: false,
      reason: '目标段落修订版本号已递增，表明发生过其他修改，候选已失效！',
    };
  }

  // Target block references check
  const curRefIds = [...targetBlock.referencedFactIds].sort().join(',');
  const origRefIds = [...candidate.originalReferencedFactIds].sort().join(',');
  if (curRefIds !== origRefIds) {
    return { valid: false, reason: '目标段落的事实引用关系已发生变动，候选已失效！' };
  }

  // Whole draft hash check: ensure other paragraphs were not modified
  const currentDraftHash = computeDraftBlocksHash(currentDraft.blocks);
  if (currentDraftHash !== candidate.baseDraftContentHash) {
    return {
      valid: false,
      reason: '草稿其他段落已被人工编辑修改，整稿基准已发生变更，候选已失效！请重新生成。',
    };
  }

  // Fact freshness check: verify target fact in task hasn't changed since candidate generation
  const currentFact = task.facts.find((f) => f.id === candidate.targetFactId);
  const currentFactValue = (currentFact?.selectedConflictValue || currentFact?.value || '').trim();
  if (!currentFact || currentFactValue !== candidate.toValue || currentFact.primaryEvidenceId !== candidate.toEvidenceId) {
    return {
      valid: false,
      reason: '目标事实最新核准数值或出处已再次变更，候选已失效！请重新生成。',
    };
  }

  // Upstream approval context check
  if (
    candidate.upstreamContext.factSnapshotConfirmedAt !== task.factSnapshot?.confirmedAt ||
    (candidate.upstreamContext.factSnapshotHash &&
      task.factSnapshot?.hash &&
      candidate.upstreamContext.factSnapshotHash !== task.factSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务事实核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidate.upstreamContext.styleConfirmedAt !== task.styleSnapshot?.confirmedAt ||
    (candidate.upstreamContext.styleHash &&
      task.styleSnapshot?.hash &&
      candidate.upstreamContext.styleHash !== task.styleSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务文风核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidate.upstreamContext.outlineConfirmedAt !== task.outlineSnapshot?.confirmedAt ||
    (candidate.upstreamContext.outlineHash &&
      task.outlineSnapshot?.hash &&
      candidate.upstreamContext.outlineHash !== task.outlineSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务大纲核准版本已变更，候选已失效！请重新生成。',
    };
  }

  // Full re-check of eligibility
  const eligibility = checkFactRevisionEligibility(task, currentDraft, candidate.targetBlockId, activeRole);
  if (!eligibility.eligible) {
    return {
      valid: false,
      reason: `采纳校验失败：${eligibility.reason}`,
    };
  }

  if (!candidate.contextFingerprint || candidate.contextFingerprint !== getFactRevisionContext(task, currentDraft)) {
    return { valid: false, reason: '正文、修订、引用、原文或审批上下文已变化，旧候选已失效，请重新生成。' };
  }
  const regenerated = generateFactRevisionCandidate(task, currentDraft, candidate.targetBlockId, activeRole, { runId: candidate.runId });
  if (!regenerated.candidate) return { valid: false, reason: regenerated.reason || '候选无法重新验证' };
  const payload = ({ id: _id, createdAt: _time, ...c }: FactRevisionCandidate) => c;
  if (canonical(payload(candidate)) !== canonical(payload(regenerated.candidate))) {
    return { valid: false, reason: '候选正文、目标事实或依据对照与当前可验证修订不一致，请重新生成。' };
  }

  return { valid: true };
}

/**
 * Atomically adopts the fact revision candidate:
 * 1. Archives old draft as historical snapshot with frozen old text, snapshot, and reviews
 * 2. Creates new working draft with ONLY target block changed and updated snapshotMetadata
 * 3. Initializes review records to empty, preserving old conclusions as source references
 * 4. Updates task.drafts and task.currentDraftId in a single atomic transaction
 */
export function acceptFactRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidate: FactRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): FactRevisionAcceptanceResult {
  const validation = validateFactRevisionAcceptance(task, currentDraft, candidate, activeRole, activeRunId);
  if (!validation.valid) {
    return {
      success: false,
      reason: validation.reason || '采纳校验失败',
    };
  }

  const draftToArchive = currentDraft!;

  // 1. Archive previous draft as immutable historical snapshot
  const archivedDraft: DraftVersion = {
    ...JSON.parse(JSON.stringify(draftToArchive)),
    isWorkingDraft: false,
    isHistoricalSnapshot: true,
    summary: draftToArchive.summary
      ? `${draftToArchive.summary}（采纳事实定向修订前系统自动归档历史快照）`
      : '采纳事实定向修订前系统自动归档的历史快照',
    frozenReviewComments: freezeReviewComments(task, draftToArchive),
    ...freezeFactReviews(task, draftToArchive),
  };

  // 2. Build updated blocks for new working draft
  const nextBlocks: ParagraphBlock[] = draftToArchive.blocks.map((b) => {
    if (b.id === candidate.targetBlockId) {
      // Update target block content and increment revisionSeq
      const nextSeq =
        (typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : 0) + 1;

      return {
        ...b,
        content: candidate.revisedBlockContent,
        revisionSeq: nextSeq,
        updatedAt: new Date().toISOString(),
        adoptedEvidences: b.adoptedEvidences ? JSON.parse(JSON.stringify(b.adoptedEvidences)) : undefined,
      };
    }
    // Deep copy other blocks without modification
    return JSON.parse(JSON.stringify(b));
  });

  const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作稿·已采纳事实定向修订)`;

  // 3. Create brand-new working draft bound to the verified latest approved snapshot
  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: `基于【${draftToArchive.versionNumber}】归档后采纳事实【${candidate.metric}】定向修订生成的工作稿`,
    blocks: nextBlocks,
    isFinal: false,
    isHistoricalSnapshot: false,
    isWorkingDraft: true,
    sourceDraftId: draftToArchive.id,
    reviewBaselineIds: getReviewBaselineIds(task, draftToArchive),
    snapshotMetadata: {
      ...draftToArchive.snapshotMetadata!,
      factSnapshot: JSON.parse(JSON.stringify(task.factSnapshot)),
      styleSnapshot: JSON.parse(JSON.stringify(task.styleSnapshot)),
      outlineSnapshot: JSON.parse(JSON.stringify(task.outlineSnapshot)),
    },
    auditRecords: [], // Cleared so new draft undergoes fresh audit gate check
    factReviewRecords: [], // Initialized to empty, does NOT auto-sign "reviewed"
    sourceFactReviewRecords: sourceFactReviews(draftToArchive), // Retained for provenance inspection
  };

  // 4. Update task atomically
  const updatedDrafts = [
    newWorkingDraft,
    ...task.drafts.map((d) => (d.id === draftToArchive.id ? archivedDraft : d)),
  ];

  const updatedTask: Task = {
    ...task,
    drafts: updatedDrafts,
    currentDraftId: newWorkingDraft.id,
    isFinalized: false,
    status: '起草中',
    updatedAt: new Date().toISOString(),
    modificationLogs: [{
      id: `MOD-LOG-${candidate.id}`, taskId: task.id, draftId: newWorkingDraft.id,
      blockId: candidate.targetBlockId, blockOrder: candidate.targetBlockOrder,
      timestamp: new Date().toISOString(), source: 'fact_change_revision' as const,
      sourceDescription: `事实【${candidate.metric}】定向修订：${candidate.fromValue}${candidate.unit} → ${candidate.toValue}${candidate.unit}；出处 ${candidate.fromEvidenceId} → ${candidate.toEvidenceId}；来源版本 ${draftToArchive.id}`,
      beforeContent: candidate.originalBlockContent, afterContent: candidate.revisedBlockContent,
      appliedBlockUpdatedAt: nextBlocks.find(b => b.id === candidate.targetBlockId)!.updatedAt,
      appliedRevisionSeq: nextBlocks.find(b => b.id === candidate.targetBlockId)!.revisionSeq,
      status: 'applied' as const, undoUnavailableReason: '本次同时更新整稿依据，请通过版本历史恢复完整正文与依据，不能单独撤销正文。',
    }, ...(task.modificationLogs || [])].slice(0, 20),
  };

  return {
    success: true,
    updatedTask,
    newWorkingDraft,
    archivedDraft,
  };
}

/**
 * Checks whether the current draft meets the strict batch 2 criteria
 * for targeted multi-paragraph fact revision candidate generation:
 * - Working draft, author role
 * - Full frozen baseline on draft; task latest facts, style, outline formally approved
 * - Exactly one fact changed across the entire draft, and that fact references at least 2 blocks
 * - Numerical value change with consistent unit, period, and metric scope
 * - Latest fact confirmed, conflicts resolved, valid source document and snippet
 * - Each referencing block satisfies deterministic rewrite conditions
 * - Blocks with material supplementation evidence block the entire group
 */
export function checkMultiParagraphFactRevisionEligibility(
  task: Task,
  currentDraft: DraftVersion | undefined,
  roleOrFactId: UserRole | string,
  maybeOptionsOrRole?: UserRole | string | { targetFactId?: string },
  maybeOptions?: { targetFactId?: string }
): MultiParagraphFactRevisionEligibilityResult {
  const isRole = (val: any): val is UserRole => ['主笔甲', '审阅乙', '审阅丁', '供稿丙'].includes(val);
  let activeRole: UserRole | undefined;
  let targetFactId: string | undefined = undefined;

  if (isRole(roleOrFactId)) {
    activeRole = roleOrFactId;
    if (typeof maybeOptionsOrRole === 'string') {
      targetFactId = maybeOptionsOrRole;
    } else if (maybeOptionsOrRole && typeof maybeOptionsOrRole === 'object') {
      targetFactId = maybeOptionsOrRole.targetFactId;
    }
  } else {
    targetFactId = roleOrFactId;
    if (isRole(maybeOptionsOrRole)) {
      activeRole = maybeOptionsOrRole;
    }
    if (maybeOptions && maybeOptions.targetFactId) {
      targetFactId = maybeOptions.targetFactId;
    }
  }
  const options = targetFactId ? { targetFactId } : undefined;

  // 1. Operator role: Must be primary author
  if (activeRole !== '主笔甲') {
    return {
      eligible: false,
      reason: `权限受限：当前操作身份为【${activeRole}】，多段落定向修订仅允许主笔甲执行。`,
    };
  }

  // 2. Draft existence and mutability
  if (!currentDraft || !currentDraft.blocks || currentDraft.blocks.length === 0) {
    return {
      eligible: false,
      reason: '当前尚无可比较或可编辑的草稿版本。',
    };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return {
      eligible: false,
      reason: '当前选中的版本属于只读历史快照或已定稿版本，不可生成定向修订；请在当前可编辑工作稿中操作。',
    };
  }
  if (!hasUniqueBlockIds(currentDraft)) {
    return { eligible: false, reason: '稿件存在缺失或重复的稳定段落ID，无法唯一定位正文，整组修订已拒绝。' };
  }
  if (currentDraft.id !== task.currentDraftId || !task.drafts.some((d) => d.id === currentDraft.id)) {
    return { eligible: false, reason: '所选稿不是任务当前工作稿，请返回当前工作稿操作。' };
  }
  if (canonical(currentDraft) !== canonical(task.drafts.find((d) => d.id === currentDraft.id))) {
    return { eligible: false, reason: '所选稿参数已陈旧，与任务中保存的当前稿不一致，请重新打开当前稿。' };
  }

  // 3. Draft baseline snapshots integrity
  const draftFactSnap = currentDraft.snapshotMetadata?.factSnapshot;
  const draftStyleSnap = currentDraft.snapshotMetadata?.styleSnapshot;
  const draftOutlineSnap = currentDraft.snapshotMetadata?.outlineSnapshot;

  if (
    !validFactBasis(draftFactSnap) ||
    !validStyleBasis(draftStyleSnap) ||
    !validOutlineBasis(draftOutlineSnap) ||
    !Array.isArray(currentDraft.snapshotMetadata?.outlineSections) ||
    !currentDraft.snapshotMetadata.outlineSections.every(
      (s) => s && typeof s.id === 'string' && typeof s.title === 'string'
    )
  ) {
    return {
      eligible: false,
      reason: '草稿缺少完整冻结依据基准（事实快照、文风快照或大纲快照缺失），无法验证依据一致性。',
    };
  }

  // 4. Task upstream formal confirmations
  if (!validFactBasis(task.factSnapshot)) {
    return {
      eligible: false,
      reason: '任务事实清单尚未正式核准确认，请先前往事实清单完成核准。',
      unconfirmedUpstream: 'fact',
    };
  }

  if (!task.styleConfirmed || !validStyleBasis(task.styleSnapshot)) {
    return {
      eligible: false,
      reason: '任务文风规范尚未正式核准确认，请先核准文风。',
      unconfirmedUpstream: 'style',
    };
  }

  if (!task.outlineConfirmed || !validOutlineBasis(task.outlineSnapshot)) {
    return {
      eligible: false,
      reason: '任务大纲结构尚未正式核准确认，请先核准大纲。',
      unconfirmedUpstream: 'outline',
    };
  }

  // 5. Compare rule IDs
  const curStyleRules = [...(task.styleSnapshot.activeRuleIds || [])].sort().join(',');
  const draftStyleRules = [...(draftStyleSnap.activeRuleIds || [])].sort().join(',');
  if (curStyleRules !== draftStyleRules) {
    return {
      eligible: false,
      reason: '任务文风规范发生了实质变化（启用规则不一致），超出本批定向修订范围，请重新起草或调整文风。',
    };
  }

  // 6. Substantive outline verification
  const curSections = task.outlineSnapshot.sections || [];
  const draftSections = draftOutlineSnap.sections || [];
  if (
    curSections.length !== draftSections.length ||
    curSections.some(
      (s, i) =>
        s.sectionId !== draftSections[i]?.sectionId ||
        s.title !== draftSections[i]?.title ||
        JSON.stringify(s.assignedFactIds || []) !== JSON.stringify(draftSections[i]?.assignedFactIds || [])
    )
  ) {
    return {
      eligible: false,
      reason: '任务大纲结构或章节要求发生了实质变化，超出本批定向修订范围，请人工编辑或重新起草。',
    };
  }

  // 7. Analyze fact impact across the entire draft
  const analysis: FactImpactAnalysisResult = analyzeFactImpact(task, currentDraft);

  const unreferencedApproved = analysis.unreferencedNewFacts.filter((f) => f.status === 'confirmed');
  if (unreferencedApproved.length > 0) {
    return {
      eligible: false,
      reason: `任务事实清单中存在 ${unreferencedApproved.length} 项未被所选稿件引用的核准事实，存在尚未处理的依据差异，无法执行定向修订。`,
    };
  }

  const missingBaselineConfirmedFacts = (analysis.missingBaselineFactIds || []).filter(
    (id) => task.facts.find((f) => f.id === id)?.status === 'confirmed'
  );
  if (missingBaselineConfirmedFacts.length > 0) {
    return {
      eligible: false,
      reason: '草稿引用的核准事实中存在缺少冻结基准的事项，无法验证历史依据一致性。',
    };
  }

  if (analysis.changedFactsCount === 0) {
    return {
      eligible: false,
      reason: '未发现已关联事实的数值变化，本批没有可生成的定向修订。',
    };
  }

  if (analysis.changedFactsCount > 1) {
    return {
      eligible: false,
      reason: `整份稿件存在多项事实变更（共 ${analysis.changedFactsCount} 项），超出本批单事实定向修订支持范围，请人工编辑或重新起草。`,
    };
  }

  const changedFactItem = analysis.impactItems[0];
  if (!changedFactItem) {
    return {
      eligible: false,
      reason: '未检测到具体的变更事实项。',
    };
  }

  if (options?.targetFactId && options.targetFactId !== changedFactItem.factId) {
    return {
      eligible: false,
      reason: `当前选中的事实【${options.targetFactId}】并非当前变更的事实【${changedFactItem.metric}】。`,
    };
  }

  // 8. Inspect difference tags for unsupported changes
  for (const tag of changedFactItem.differenceTags) {
    if (tag.type === 'unit') {
      const msg = `指标单位发生变化（${changedFactItem.draftSnapshotValue} → ${changedFactItem.latestConfirmedValue}），超出本批定向修订范围。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
    if (tag.type === 'period') {
      const msg = `统计期间发生变化（${changedFactItem.draftPeriod} → ${changedFactItem.latestPeriod}），超出本批定向修订范围。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
    if (tag.type === 'metric_scope') {
      const msg = `统计口径发生变化（${changedFactItem.draftMetricScope} → ${changedFactItem.latestMetricScope}），超出本批定向修订范围。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
    if (tag.type === 'status_pending') {
      return {
        eligible: false,
        reason: '最新事实已被撤销核准（待确认），尚未正式核准，无法采纳。',
      };
    }
    if (tag.type === 'status_excluded') {
      return {
        eligible: false,
        reason: '最新事实已被任务排除，不应作为核准依据。',
      };
    }
    if (tag.type === 'status_gap') {
      return {
        eligible: false,
        reason: '最新事实已标记为材料缺口，缺少充足材料支撑。',
      };
    }
    if (tag.type === 'status_deleted') {
      return {
        eligible: false,
        reason: '任务事实清单中已删除此事实，草稿仍在引用已删除项。',
      };
    }
    if (tag.type === 'conflict_unresolved') {
      return {
        eligible: false,
        reason: '最新事实存在未裁决冲突，尚未确定最终采信口径与数值。',
      };
    }
    if (tag.type === 'missing_baseline') {
      return {
        eligible: false,
        reason: '缺少快照冻结项基准，需人工核实。',
      };
    }
  }

  const hasValueDifference = changedFactItem.differenceTags.some((t) => t.type === 'value');
  if (!hasValueDifference) {
    return {
      eligible: false,
      reason: '事实数值未发生变动，无需生成数值修订候选。',
    };
  }

  // 9. Verify latest fact status and evidence validity
  const latestFact = task.facts.find((f) => f.id === changedFactItem.factId);
  if (!latestFact || latestFact.status !== 'confirmed') {
    return {
      eligible: false,
      reason: `最新事实【${changedFactItem.metric}】尚未核准（状态：${latestFact?.status || '缺失'}），无法采纳。`,
    };
  }

  if (latestFact.hasConflict && !latestFact.selectedConflictValue) {
    return {
      eligible: false,
      reason: `最新事实【${latestFact.metric}】存在未裁决冲突，尚未确定最终采信值。`,
    };
  }

  const snippet = task.snippets.find((s) => s.id === latestFact.primaryEvidenceId);
  if (!snippet) {
    return {
      eligible: false,
      reason: '最新事实关联的主出处材料不存在或已失效，无有效原文来源。',
    };
  }

  const doc = task.documents.find((d) => d.id === snippet.sourceDocId);
  if (!doc || (doc as any).isDeleted) {
    return {
      eligible: false,
      reason: '最新事实关联的材料文档已删除或失效，无有效原文出处。',
    };
  }

  if (!snippet.text || !snippet.text.trim()) {
    return {
      eligible: false,
      reason: '最新事实关联的主出处材料未包含有效原文摘要。',
    };
  }

  // 10. Collect all referencing blocks strictly by Fact ID and Block ID references
  // Deduplicate repeated references within the same block by block.id
  const referencingBlocks: ParagraphBlock[] = [];
  const seenBlockIds = new Set<string>();
  for (const block of currentDraft.blocks) {
    const isDirectRef = (block.referencedFactIds || []).includes(changedFactItem.factId);
    const isAdoptedRef = (block.adoptedEvidences || []).some(
      (e) => e.associatedFactId === changedFactItem.factId
    );
    if ((isDirectRef || isAdoptedRef) && !seenBlockIds.has(block.id)) {
      seenBlockIds.add(block.id);
      referencingBlocks.push(block);
    }
  }

  // Check if any referencing block contains unsupported material supplementation
  for (const block of referencingBlocks) {
    if (block.adoptedEvidences && block.adoptedEvidences.length > 0) {
      const msg = `关联段落（第${block.order}段 [${block.id}]）包含材料补写存证，本批不支持材料补写存证的自动更新，整组修订已阻断。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
  }

  if (referencingBlocks.length < 2) {
    const msg = `目标事实【${changedFactItem.metric}】仅关联 ${referencingBlocks.length} 个段落，多段落修订要求关联至少 2 个段落；单段落请使用单段定向修订路径。`;
    return {
      eligible: false,
      reason: msg,
      blockingReasons: [msg],
    };
  }

  const basisError = completeBasisError(task, currentDraft, changedFactItem.factId);
  if (basisError) return { eligible: false, reason: basisError, blockingReasons: [basisError] };

  const adoptedValue = (latestFact.selectedConflictValue || latestFact.value).trim();
  const evidenceOffset = metricValueOffset(snippet.text, latestFact.metric, adoptedValue, latestFact.unit);
  if (evidenceOffset === undefined) {
    const msg = '最新原文无法明确支持该指标的核准数值与完整单位，请人工核实。';
    return { eligible: false, reason: msg, blockingReasons: [msg] };
  }
  if (
    !supportedMetricPeriod(
      snippet.text,
      `${adoptedValue}${latestFact.unit}`,
      latestFact.period,
      task.startDate,
      evidenceOffset
    )
  ) {
    const msg = '最新原文中的指标统计期间不符或归属不明，请人工核实。';
    return { eligible: false, reason: msg, blockingReasons: [msg] };
  }

  const snapItem = currentDraft.snapshotMetadata!.factSnapshot!.items.find(
    (i) => i.factId === latestFact.id
  )!;
  const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
  const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
  const unit = (snapItem.unit || latestFact.unit || '').trim();
  const metric = (snapItem.metric || latestFact.metric || '').trim();

  if (!snapValue || !latestValue || snapValue === latestValue) {
    return {
      eligible: false,
      reason: '事实数值未发生实质变动，无需生成修订候选。',
    };
  }

  // 11. Verify deterministic rewrite conditions on each referencing block
  for (const block of referencingBlocks) {
    // Blocking condition: Any referencing block containing material supplementation evidence blocks the entire group
    if (block.adoptedEvidences && block.adoptedEvidences.length > 0) {
      const msg = `关联段落（第${block.order}段 [${block.id}]）包含材料补写存证，本批不支持材料补写存证的自动更新，整组修订已阻断。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }

    const text = block.content;
    const offset = metricValueOffset(text, metric, snapValue, unit);
    if (offset === undefined) {
      const msg = `关联段落（第${block.order}段 [${block.id}]）正文未找到唯一、完整且明确属于目标指标【${metric}】的冻结数值（${snapValue}）和单位（${unit}），可能存在多处相同数值、语义归属不明、包含否定/计划/目标限定或正文已偏离当时冻结值，整组拒绝采纳。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }

    if (!supportedMetricPeriod(text, `${snapValue}${unit}`, snapItem.period, task.startDate, offset)) {
      const msg = `关联段落（第${block.order}段 [${block.id}]）正文指标明示的统计期间与冻结依据不符或归属不明，整组拒绝采纳。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }

    const revisedContent =
      text.slice(0, offset) + latestValue + text.slice(offset + snapValue.length);

    const prefixMatch = revisedContent.slice(0, offset) === text.slice(0, offset);
    const suffixMatch =
      revisedContent.slice(offset + latestValue.length) === text.slice(offset + snapValue.length);
    const replacedValueMatch =
      revisedContent.slice(offset, offset + latestValue.length) === latestValue &&
      text.slice(offset, offset + snapValue.length) === snapValue;

    if (!prefixMatch || !suffixMatch || !replacedValueMatch) {
      const msg = `关联段落（第${block.order}段 [${block.id}]）改写结果偏离最小范围修改原则，已安全拦截。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
  }

  return {
    eligible: true,
    targetFactId: changedFactItem.factId,
    targetFactItem: changedFactItem,
    referencingBlocks,
    targetBlockIds: referencingBlocks.map((b) => b.id),
  };
}

/**
 * Generates deterministic multi-paragraph revision candidates for all referencing blocks.
 * If ANY block fails validation, the entire group is rejected and no partial result is returned.
 */
export function generateMultiParagraphFactRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  roleOrFactId: UserRole | string,
  maybeOptionsOrRole?: UserRole | string | { targetFactId?: string; runId?: string },
  maybeOptions?: { targetFactId?: string; runId?: string }
): MultiParagraphFactRevisionCandidateResult {
  const isRole = (val: any): val is UserRole => ['主笔甲', '审阅乙', '审阅丁', '供稿丙'].includes(val);
  let activeRole: UserRole | undefined;
  let targetFactId: string | undefined = undefined;
  let runId: string | undefined = undefined;

  if (isRole(roleOrFactId)) {
    activeRole = roleOrFactId;
    if (typeof maybeOptionsOrRole === 'string') {
      targetFactId = maybeOptionsOrRole;
    } else if (maybeOptionsOrRole && typeof maybeOptionsOrRole === 'object') {
      targetFactId = maybeOptionsOrRole.targetFactId;
      runId = maybeOptionsOrRole.runId;
    }
  } else {
    targetFactId = roleOrFactId;
    if (isRole(maybeOptionsOrRole)) {
      activeRole = maybeOptionsOrRole;
    }
    if (maybeOptions) {
      if (maybeOptions.targetFactId) targetFactId = maybeOptions.targetFactId;
      if (maybeOptions.runId) runId = maybeOptions.runId;
    }
  }
  const options = { targetFactId, runId };

  if (!activeRole) {
    return { success: false, reason: '未提供有效操作身份，不能默认以主笔身份生成多段落修订候选。' };
  }

  const eligibility = checkMultiParagraphFactRevisionEligibility(task, currentDraft, activeRole, options);
  if (!eligibility.eligible || !eligibility.targetFactItem || !eligibility.referencingBlocks) {
    return {
      success: false,
      reason: eligibility.reason || '多段落准入校验未通过',
    };
  }

  const changedItem = eligibility.targetFactItem;
  const referencingBlocks = eligibility.referencingBlocks;
  const latestFact = task.facts.find((f) => f.id === changedItem.factId)!;
  const snapItem = currentDraft!.snapshotMetadata!.factSnapshot!.items.find(
    (i) => i.factId === latestFact.id
  )!;

  const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
  const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
  const unit = (snapItem.unit || latestFact.unit || '').trim();
  const metric = (snapItem.metric || latestFact.metric || '').trim();

  const items: ParagraphRevisionCandidateItem[] = referencingBlocks.map((block) => {
    const text = block.content;
    const offset = metricValueOffset(text, metric, snapValue, unit)!;
    const revisedContent = text.slice(0, offset) + latestValue + text.slice(offset + snapValue.length);

    return {
      targetBlockId: block.id,
      targetBlockOrder: block.order,
      targetSectionTitle:
        task.outline.find((o) => o.id === block.sectionId)?.title ||
        currentDraft!.snapshotMetadata?.outlineSections?.find((o) => o.id === block.sectionId)?.title ||
        '正文章节',
      originalBlockContent: block.content,
      originalRevisionSeq:
        typeof block.revisionSeq === 'number' && Number.isFinite(block.revisionSeq) ? block.revisionSeq : 0,
      originalReferencedFactIds: [...block.referencedFactIds],
      revisedBlockContent: revisedContent,
      diffExplanation: `指标【${metric}】数值由 ${snapValue}${unit} 更新为 ${latestValue}${unit}`,
    };
  });

  const finalRunId = runId || options?.runId || `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const candidateGroupId = `FACT-REV-GROUP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const toSnip = latestFact.primaryEvidenceId
    ? task.snippets.find((s) => s.id === latestFact.primaryEvidenceId)
    : undefined;

  const candidateGroup: MultiParagraphFactRevisionCandidate = {
    id: candidateGroupId,
    runId: finalRunId,
    taskId: task.id,
    sourceDraftId: currentDraft!.id,
    sourceDraftVersionNumber: currentDraft!.versionNumber,
    targetFactId: latestFact.id,
    metric,
    unit,
    fromValue: snapValue,
    toValue: latestValue,
    period: latestFact.period,

    fromEvidenceId: snapItem.primaryEvidenceId,
    fromDocName: snapItem.provenance!.sourceDocName,
    fromLocation: snapItem.provenance!.location || '未保存定位',

    toEvidenceId: latestFact.primaryEvidenceId,
    toDocName: toSnip?.docName || '最新出处材料',
    toLocation: toSnip?.location || '段落索引',

    items,
    targetBlockIds: items.map((i) => i.targetBlockId),

    baseDraftContentHash: computeDraftBlocksHash(currentDraft!.blocks),
    contextFingerprint: getFactRevisionContext(task, currentDraft!),

    upstreamContext: {
      factSnapshotConfirmedAt: task.factSnapshot?.confirmedAt,
      factSnapshotHash: task.factSnapshot?.hash,
      styleConfirmedAt: task.styleSnapshot?.confirmedAt,
      styleHash: task.styleSnapshot?.hash,
      outlineConfirmedAt: task.outlineSnapshot?.confirmedAt,
      outlineHash: task.outlineSnapshot?.hash,
    },

    createdAt: new Date().toISOString(),
    explanation: `经核实，指标【${metric}】已核准采信 ${latestValue}${unit}（原稿采用：${snapValue}${unit}）。已针对全部 ${items.length} 个关联段落执行一致性定向修订，保留原文单位及前后表述。`,
  };

  return {
    success: true,
    candidateGroup,
  };
}

/**
 * Validates multi-paragraph candidate adoption preconditions:
 * - Isolation: Task ID, Run ID, source draft ID
 * - Freshness: Draft blocks unchanged, all target blocks' content, revisionSeq, and references untouched
 * - Group integrity: Referencing block set unchanged (no additions or removals since generation)
 * - Eligibility: Upstream approvals unchanged, no new fact/evidence discrepancies
 */
export function validateMultiParagraphFactRevisionAcceptance(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidateGroup: MultiParagraphFactRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): { valid: boolean; reason?: string } {
  if (activeRole !== '主笔甲') {
    return { valid: false, reason: '权限受限：仅主笔甲有权采纳修订并创建新工作稿！' };
  }

  if (candidateGroup.taskId !== task.id) {
    return { valid: false, reason: '安全隔离拦截：修订候选生成自其他任务，禁止跨任务采纳！' };
  }

  if (!activeRunId || candidateGroup.runId !== activeRunId) {
    return { valid: false, reason: '候选已失效：该候选生成自已取消或过期的运行！' };
  }

  if (!currentDraft || currentDraft.id !== candidateGroup.sourceDraftId) {
    return { valid: false, reason: '版本已变更：当前草稿已切换，旧候选已失效！' };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return { valid: false, reason: '当前版本已是只读快照或定稿，禁止直接采纳写入！' };
  }

  if (currentDraft.id !== task.currentDraftId) {
    return { valid: false, reason: '当前草稿已不是任务当前可编辑工作稿，禁止重复采纳！' };
  }

  // Validate each target block
  for (const item of candidateGroup.items) {
    const currentBlock = currentDraft.blocks.find((b) => b.id === item.targetBlockId);
    if (!currentBlock) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）已在当前草稿中被删除，候选已失效！`,
      };
    }

    if (currentBlock.content !== item.originalBlockContent) {
      return {
        valid: false,
        reason: `基准正文已变更：目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）正文已被人工编辑修改，采纳候选将覆盖人工修改！已安全拦截。`,
      };
    }

    const currentSeq =
      typeof currentBlock.revisionSeq === 'number' && Number.isFinite(currentBlock.revisionSeq)
        ? currentBlock.revisionSeq
        : 0;
    if (currentSeq !== item.originalRevisionSeq) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）修订版本号已递增，表明发生过其他修改，候选已失效！`,
      };
    }

    const curRefIds = [...currentBlock.referencedFactIds].sort().join(',');
    const origRefIds = [...item.originalReferencedFactIds].sort().join(',');
    if (curRefIds !== origRefIds) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）事实引用关系已发生变动，候选已失效！`,
      };
    }
  }

  // Validate the completeness of the referencing blocks set (no added or omitted references)
  const currentReferencingBlockIds = currentDraft.blocks
    .filter(
      (b) =>
        (b.referencedFactIds || []).includes(candidateGroup.targetFactId) ||
        (b.adoptedEvidences || []).some((e) => e.associatedFactId === candidateGroup.targetFactId)
    )
    .map((b) => b.id)
    .sort()
    .join(',');
  const candidateBlockIds = [...candidateGroup.targetBlockIds].sort().join(',');
  if (currentReferencingBlockIds !== candidateBlockIds) {
    return {
      valid: false,
      reason: '当前草稿关联段落集合发生变动（存在新增或遗漏的引用段落），候选已失效！请重新生成。',
    };
  }

  // Whole draft hash check: ensure other paragraphs were not modified
  const currentDraftHash = computeDraftBlocksHash(currentDraft.blocks);
  if (currentDraftHash !== candidateGroup.baseDraftContentHash) {
    return {
      valid: false,
      reason: '草稿非目标段落已被人工编辑修改，整稿基准已发生变更，候选已失效！请重新生成。',
    };
  }

  // Fact freshness check
  const currentFact = task.facts.find((f) => f.id === candidateGroup.targetFactId);
  const currentFactValue = (currentFact?.selectedConflictValue || currentFact?.value || '').trim();
  if (
    !currentFact ||
    currentFactValue !== candidateGroup.toValue ||
    currentFact.primaryEvidenceId !== candidateGroup.toEvidenceId
  ) {
    return {
      valid: false,
      reason: '目标事实最新核准数值或出处已再次变更，候选已失效！请重新生成。',
    };
  }

  // Upstream approval context check
  if (
    candidateGroup.upstreamContext.factSnapshotConfirmedAt !== task.factSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.factSnapshotHash &&
      task.factSnapshot?.hash &&
      candidateGroup.upstreamContext.factSnapshotHash !== task.factSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务事实核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidateGroup.upstreamContext.styleConfirmedAt !== task.styleSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.styleHash &&
      task.styleSnapshot?.hash &&
      candidateGroup.upstreamContext.styleHash !== task.styleSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务文风核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidateGroup.upstreamContext.outlineConfirmedAt !== task.outlineSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.outlineHash &&
      task.outlineSnapshot?.hash &&
      candidateGroup.upstreamContext.outlineHash !== task.outlineSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务大纲核准版本已变更，候选已失效！请重新生成。',
    };
  }

  // Full re-check of eligibility
  const eligibility = checkMultiParagraphFactRevisionEligibility(task, currentDraft, activeRole, {
    targetFactId: candidateGroup.targetFactId,
  });
  if (!eligibility.eligible) {
    return {
      valid: false,
      reason: `采纳校验失败：${eligibility.reason}`,
    };
  }

  if (
    !candidateGroup.contextFingerprint ||
    candidateGroup.contextFingerprint !== getFactRevisionContext(task, currentDraft)
  ) {
    return {
      valid: false,
      reason: '正文、修订、引用、原文或审批上下文已变化，旧候选已失效，请重新生成。',
    };
  }

  const regenerated = generateMultiParagraphFactRevisionCandidate(task, currentDraft, activeRole, {
    targetFactId: candidateGroup.targetFactId,
    runId: candidateGroup.runId,
  });
  if (!regenerated.candidateGroup) {
    return { valid: false, reason: regenerated.reason || '多段落候选无法重新验证' };
  }

  const payload = ({ id: _id, createdAt: _time, ...c }: MultiParagraphFactRevisionCandidate) => c;
  if (canonical(payload(candidateGroup)) !== canonical(payload(regenerated.candidateGroup))) {
    return {
      valid: false,
      reason: '候选正文、目标事实或依据对照与当前可验证修订不一致，请重新生成。',
    };
  }

  return { valid: true };
}

/**
 * Atomically adopts the multi-paragraph fact revision candidate group:
 * 1. Archives old draft as historical snapshot with frozen old text, snapshot, and reviews
 * 2. Creates a single new working draft with ONLY target blocks changed and updated snapshotMetadata
 * 3. Initializes review records to empty, preserving old conclusions as source references
 * 4. Writes a single consolidated atomic modification log with shared operation ID
 * 5. Updates task.drafts and task.currentDraftId in a single atomic transaction
 */
export function acceptMultiParagraphFactRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidateGroup: MultiParagraphFactRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): MultiParagraphFactRevisionAcceptanceResult {
  const validation = validateMultiParagraphFactRevisionAcceptance(
    task,
    currentDraft,
    candidateGroup,
    activeRole,
    activeRunId
  );
  if (!validation.valid) {
    return {
      success: false,
      reason: validation.reason || '采纳校验失败',
    };
  }

  const draftToArchive = currentDraft!;

  // 1. Archive previous draft as immutable historical snapshot
  const archivedDraft: DraftVersion = {
    ...JSON.parse(JSON.stringify(draftToArchive)),
    isWorkingDraft: false,
    isHistoricalSnapshot: true,
    summary: draftToArchive.summary
      ? `${draftToArchive.summary}（采纳事实多段落定向修订前系统自动归档历史快照）`
      : '采纳事实多段落定向修订前系统自动归档的历史快照',
    frozenReviewComments: freezeReviewComments(task, draftToArchive),
    ...freezeFactReviews(task, draftToArchive),
  };

  // 2. Build updated blocks for new working draft
  const targetItemMap = new Map(candidateGroup.items.map((item) => [item.targetBlockId, item]));
  const nextBlocks: ParagraphBlock[] = draftToArchive.blocks.map((b) => {
    const item = targetItemMap.get(b.id);
    if (item) {
      const nextSeq =
        (typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : 0) + 1;
      return {
        ...b,
        content: item.revisedBlockContent,
        revisionSeq: nextSeq,
        updatedAt: new Date().toISOString(),
        adoptedEvidences: b.adoptedEvidences ? JSON.parse(JSON.stringify(b.adoptedEvidences)) : undefined,
      };
    }
    return JSON.parse(JSON.stringify(b));
  });

  const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作稿·已采纳事实多段落定向修订)`;

  // 3. Create brand-new working draft bound to the verified latest approved snapshot
  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: `基于【${draftToArchive.versionNumber}】归档后采纳事实【${candidateGroup.metric}】多段落（共${candidateGroup.items.length}段）定向修订生成的工作稿`,
    blocks: nextBlocks,
    isFinal: false,
    isHistoricalSnapshot: false,
    isWorkingDraft: true,
    sourceDraftId: draftToArchive.id,
    reviewBaselineIds: getReviewBaselineIds(task, draftToArchive),
    snapshotMetadata: {
      ...draftToArchive.snapshotMetadata!,
      factSnapshot: JSON.parse(JSON.stringify(task.factSnapshot)),
      styleSnapshot: JSON.parse(JSON.stringify(task.styleSnapshot)),
      outlineSnapshot: JSON.parse(JSON.stringify(task.outlineSnapshot)),
    },
    auditRecords: [], // Cleared so new draft undergoes fresh audit gate check
    factReviewRecords: [], // Initialized to empty, does NOT auto-sign "reviewed"
    sourceFactReviewRecords: sourceFactReviews(draftToArchive), // Retained for provenance inspection
  };

  // 4. Build single consolidated atomic modification log
  const modLog: ParagraphModificationLog = {
    id: `MOD-LOG-${candidateGroup.id}`,
    taskId: task.id,
    draftId: newWorkingDraft.id,
    blockId: candidateGroup.targetBlockIds.join(','),
    blockOrder: candidateGroup.items[0]?.targetBlockOrder,
    timestamp: new Date().toISOString(),
    source: 'fact_change_revision' as const,
    sourceDescription: `事实【${candidateGroup.metric}】多段落定向修订（共影响${candidateGroup.items.length}段：${candidateGroup.items.map((i) => `第${i.targetBlockOrder}段`).join('、')}）：${candidateGroup.fromValue}${candidateGroup.unit} → ${candidateGroup.toValue}${candidateGroup.unit}；出处 ${candidateGroup.fromEvidenceId} → ${candidateGroup.toEvidenceId}；来源版本 ${draftToArchive.id}`,
    beforeContent: candidateGroup.items.map((i) => `[第${i.targetBlockOrder}段] ${i.originalBlockContent}`).join('\n\n'),
    afterContent: candidateGroup.items.map((i) => `[第${i.targetBlockOrder}段] ${i.revisedBlockContent}`).join('\n\n'),
    affectedBlocks: candidateGroup.items.map((i) => ({
      blockId: i.targetBlockId,
      blockOrder: i.targetBlockOrder,
      sectionTitle: i.targetSectionTitle,
      beforeContent: i.originalBlockContent,
      afterContent: i.revisedBlockContent,
      appliedRevisionSeq: nextBlocks.find((b) => b.id === i.targetBlockId)!.revisionSeq,
    })),
    affectedBlockIds: candidateGroup.targetBlockIds,
    targetFactId: candidateGroup.targetFactId,
    metric: candidateGroup.metric,
    fromValue: candidateGroup.fromValue,
    toValue: candidateGroup.toValue,
    unit: candidateGroup.unit,
    fromEvidenceId: candidateGroup.fromEvidenceId,
    toEvidenceId: candidateGroup.toEvidenceId,
    sourceDraftId: draftToArchive.id,
    status: 'applied' as const,
    undoUnavailableReason: '本次为多段落一致修订且同时更新整稿依据，禁止单独撤销正文；请通过版本历史恢复完整正文与依据。',
  };

  // 5. Update task atomically
  const updatedDrafts = [
    newWorkingDraft,
    ...task.drafts.map((d) => (d.id === draftToArchive.id ? archivedDraft : d)),
  ];

  const updatedTask: Task = {
    ...task,
    drafts: updatedDrafts,
    currentDraftId: newWorkingDraft.id,
    isFinalized: false,
    status: '起草中',
    updatedAt: new Date().toISOString(),
    modificationLogs: [modLog, ...(task.modificationLogs || [])].slice(0, 20),
  };

  return {
    success: true,
    updatedTask,
    newWorkingDraft,
    archivedDraft,
    modificationLog: modLog,
  };
}

/**
 * Checks whether the current draft meets the strict batch 1 criteria for two-fact group revision:
 * - Operator role: Author ('主笔甲')
 * - Current editable working draft with unique block IDs
 * - Exactly two facts changed across the draft
 * - Neither fact has unsupported changes (unit, period, metric scope, unconfirmed, unresolved conflict)
 * - Referencing blocks for both facts are strictly non-overlapping ({blocks1} ∩ {blocks2} === ∅)
 * - Target blocks have no material supplementation evidences
 * - Every block satisfies deterministic rewrite conditions
 */
export function checkMultiFactGroupRevisionEligibility(
  task: Task,
  currentDraft: DraftVersion | undefined,
  activeRole: UserRole,
  options?: { runId?: string }
): MultiFactGroupRevisionEligibilityResult {
  // 1. Operator role: Must be primary author
  if (activeRole !== '主笔甲') {
    return {
      eligible: false,
      reason: `权限受限：当前操作身份为【${activeRole}】，多事实成组定向修订仅允许主笔甲执行。`,
    };
  }

  // 2. Draft existence and mutability
  if (!currentDraft || !currentDraft.blocks || currentDraft.blocks.length === 0) {
    return {
      eligible: false,
      reason: '当前尚无可比较或可编辑的草稿版本。',
    };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return {
      eligible: false,
      reason: '当前选中的版本属于只读历史快照或已定稿版本，不可生成定向修订；请在当前可编辑工作稿中操作。',
    };
  }
  if (!hasUniqueBlockIds(currentDraft)) {
    return { eligible: false, reason: '稿件存在缺失或重复的稳定段落ID，无法唯一定位正文，已拒绝修订。' };
  }
  if (currentDraft.id !== task.currentDraftId || !task.drafts.some((d) => d.id === currentDraft.id)) {
    return { eligible: false, reason: '所选稿不是任务当前工作稿，请返回当前工作稿操作。' };
  }
  if (canonical(currentDraft) !== canonical(task.drafts.find((d) => d.id === currentDraft.id))) {
    return { eligible: false, reason: '所选稿参数已陈旧，与任务中保存的当前稿不一致，请重新打开当前稿。' };
  }

  // 3. Draft baseline snapshots integrity
  const draftFactSnap = currentDraft.snapshotMetadata?.factSnapshot;
  const draftStyleSnap = currentDraft.snapshotMetadata?.styleSnapshot;
  const draftOutlineSnap = currentDraft.snapshotMetadata?.outlineSnapshot;

  if (
    !validFactBasis(draftFactSnap) ||
    !validStyleBasis(draftStyleSnap) ||
    !validOutlineBasis(draftOutlineSnap) ||
    !Array.isArray(currentDraft.snapshotMetadata?.outlineSections) ||
    !currentDraft.snapshotMetadata.outlineSections.every(
      (s) => s && typeof s.id === 'string' && typeof s.title === 'string'
    )
  ) {
    return {
      eligible: false,
      reason: '草稿缺少完整冻结依据基准（事实快照、文风快照或大纲快照缺失），无法验证依据一致性。',
    };
  }

  // 4. Task upstream formal confirmations
  if (!validFactBasis(task.factSnapshot)) {
    return {
      eligible: false,
      reason: '任务事实清单尚未正式核准确认，请先前往事实清单完成核准。',
      unconfirmedUpstream: 'fact',
    };
  }

  if (!task.styleConfirmed || !validStyleBasis(task.styleSnapshot)) {
    return {
      eligible: false,
      reason: '任务文风规范尚未正式核准确认，请先核准文风。',
      unconfirmedUpstream: 'style',
    };
  }

  if (!task.outlineConfirmed || !validOutlineBasis(task.outlineSnapshot)) {
    return {
      eligible: false,
      reason: '任务大纲结构尚未正式核准确认，请先核准大纲。',
      unconfirmedUpstream: 'outline',
    };
  }

  // 5. Compare rule IDs
  const curStyleRules = [...(task.styleSnapshot.activeRuleIds || [])].sort().join(',');
  const draftStyleRules = [...(draftStyleSnap.activeRuleIds || [])].sort().join(',');
  if (curStyleRules !== draftStyleRules) {
    return {
      eligible: false,
      reason: '任务文风规范发生了实质变化（启用规则不一致），超出本批定向修订范围，请重新起草或调整文风。',
    };
  }

  // 6. Substantive outline verification
  const curSections = task.outlineSnapshot.sections || [];
  const draftSections = draftOutlineSnap.sections || [];
  if (
    curSections.length !== draftSections.length ||
    curSections.some(
      (s, i) =>
        s.sectionId !== draftSections[i]?.sectionId ||
        s.title !== draftSections[i]?.title ||
        JSON.stringify(s.assignedFactIds || []) !== JSON.stringify(draftSections[i]?.assignedFactIds || [])
    )
  ) {
    return {
      eligible: false,
      reason: '任务大纲结构或章节要求发生了实质变化，超出本批定向修订范围，请人工编辑或重新起草。',
    };
  }

  // 7. Analyze fact impact across the entire draft
  const analysis: FactImpactAnalysisResult = analyzeFactImpact(task, currentDraft);

  const unreferencedApproved = analysis.unreferencedNewFacts.filter((f) => f.status === 'confirmed');
  if (unreferencedApproved.length > 0) {
    return {
      eligible: false,
      reason: `任务事实清单中存在 ${unreferencedApproved.length} 项未被所选稿件引用的核准事实，存在尚未处理的依据差异，无法执行成组修订。`,
    };
  }

  const missingBaselineConfirmedFacts = (analysis.missingBaselineFactIds || []).filter(
    (id) => task.facts.find((f) => f.id === id)?.status === 'confirmed'
  );
  if (missingBaselineConfirmedFacts.length > 0) {
    return {
      eligible: false,
      reason: '草稿引用的核准事实中存在缺少冻结基准的事项，无法验证历史依据一致性。',
    };
  }

  if (analysis.changedFactsCount === 0) {
    return {
      eligible: false,
      reason: '未发现已关联事实的数值变化，本批没有可生成的定向修订。',
    };
  }

  if (analysis.changedFactsCount === 1) {
    return {
      eligible: false,
      reason: '当前仅有 1 项事实发生数值变化，本批多事实成组定向修订要求有且仅有两项事实变动；单事实请使用单事实定向修订通道。',
    };
  }

  if (analysis.changedFactsCount > 2) {
    return {
      eligible: false,
      reason: `整份稿件存在多项事实变更（共 ${analysis.changedFactsCount} 项），超出本批两项事实成组修订支持范围，请人工编辑或重新起草。`,
    };
  }

  const impactItems = analysis.impactItems;
  if (impactItems.length !== 2) {
    return {
      eligible: false,
      reason: `检测到的变更事实项数量异常（共 ${impactItems.length} 项），无法生成两项事实成组修订。`,
    };
  }

  const blockingReasons: string[] = [];

  // Inspect difference tags on both items
  for (const item of impactItems) {
    for (const tag of item.differenceTags) {
      if (tag.type === 'unit') {
        const msg = `指标【${item.metric}】单位发生变化（${item.draftSnapshotValue} → ${item.latestConfirmedValue}），超出本批数值定向修订范围。`;
        blockingReasons.push(msg);
      }
      if (tag.type === 'period') {
        const msg = `指标【${item.metric}】统计期间发生变化（${item.draftPeriod} → ${item.latestPeriod}），超出本批定向修订范围。`;
        blockingReasons.push(msg);
      }
      if (tag.type === 'metric_scope') {
        const msg = `指标【${item.metric}】统计口径发生变化（${item.draftMetricScope} → ${item.latestMetricScope}），超出本批定向修订范围。`;
        blockingReasons.push(msg);
      }
      if (tag.type === 'status_pending') {
        blockingReasons.push(`最新事实【${item.metric}】已被撤销核准（待确认），尚未正式核准，无法采纳。`);
      }
      if (tag.type === 'status_excluded') {
        blockingReasons.push(`最新事实【${item.metric}】已被任务排除，不应作为核准依据。`);
      }
      if (tag.type === 'status_gap') {
        blockingReasons.push(`最新事实【${item.metric}】已标记为材料缺口，缺少充足材料支撑。`);
      }
      if (tag.type === 'status_deleted') {
        blockingReasons.push(`任务事实清单中已删除事实【${item.metric}】，草稿仍在引用已删除项。`);
      }
      if (tag.type === 'conflict_unresolved') {
        blockingReasons.push(`最新事实【${item.metric}】存在未裁决冲突，尚未确定最终采信口径与数值。`);
      }
      if (tag.type === 'missing_baseline') {
        blockingReasons.push(`事实【${item.metric}】缺少快照冻结项基准，需人工核实。`);
      }
    }
    const hasVal = item.differenceTags.some((t) => t.type === 'value');
    if (!hasVal) {
      blockingReasons.push(`事实【${item.metric}】数值未发生变动，无需生成数值修订候选。`);
    }
  }

  if (blockingReasons.length > 0) {
    return {
      eligible: false,
      reason: blockingReasons[0],
      blockingReasons,
    };
  }

  // Verify latest facts in task.facts
  for (const item of impactItems) {
    const latestFact = task.facts.find((f) => f.id === item.factId);
    if (!latestFact || latestFact.status !== 'confirmed') {
      const msg = `最新事实【${item.metric}】尚未核准（状态：${latestFact?.status || '缺失'}），无法采纳。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    if (latestFact.hasConflict && !latestFact.selectedConflictValue) {
      const msg = `最新事实【${latestFact.metric}】存在未裁决冲突，尚未确定最终采信值。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    const snippet = task.snippets.find((s) => s.id === latestFact.primaryEvidenceId);
    if (!snippet) {
      const msg = `最新事实【${latestFact.metric}】关联的主出处材料不存在或已失效，无有效原文来源。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    const doc = task.documents.find((d) => d.id === snippet.sourceDocId);
    if (!doc || (doc as any).isDeleted) {
      const msg = `最新事实【${latestFact.metric}】关联的材料文档已删除或失效，无有效原文出处。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    if (!snippet.text || !snippet.text.trim()) {
      const msg = `最新事实【${latestFact.metric}】关联的主出处材料未包含有效原文摘要。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
  }

  // Complete basis error for the 2 target facts
  const targetFactIds = [impactItems[0].factId, impactItems[1].factId];
  const basisErr = completeBasisError(task, currentDraft, targetFactIds);
  if (basisErr) {
    return { eligible: false, reason: basisErr, blockingReasons: [basisErr] };
  }

  // Check snippet text supports adopted value & unit & period
  for (const item of impactItems) {
    const latestFact = task.facts.find((f) => f.id === item.factId)!;
    const snippet = task.snippets.find((s) => s.id === latestFact.primaryEvidenceId)!;
    const adoptedValue = (latestFact.selectedConflictValue || latestFact.value).trim();
    const evidenceOffset = metricValueOffset(snippet.text, latestFact.metric, adoptedValue, latestFact.unit);
    if (evidenceOffset === undefined) {
      const msg = `最新原文无法明确支持事实【${latestFact.metric}】的核准数值与完整单位，请人工核实。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    if (!supportedMetricPeriod(snippet.text, `${adoptedValue}${latestFact.unit}`, latestFact.period, task.startDate, evidenceOffset)) {
      const msg = `最新原文中事实【${latestFact.metric}】的统计期间不符或归属不明，请人工核实。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
  }

  // Collect referencing blocks for each fact
  const referencingBlocksByFact: Record<string, ParagraphBlock[]> = {};
  for (const item of impactItems) {
    const blocks: ParagraphBlock[] = [];
    const seen = new Set<string>();
    for (const b of currentDraft.blocks) {
      const isDirect = (b.referencedFactIds || []).includes(item.factId);
      const isAdopted = (b.adoptedEvidences || []).some((e) => e.associatedFactId === item.factId);
      if ((isDirect || isAdopted) && !seen.has(b.id)) {
        seen.add(b.id);
        blocks.push(b);
      }
    }
    if (blocks.length === 0) {
      const msg = `事实【${item.metric}】在正文中未找到关联段落，无法生成定向修订。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }
    referencingBlocksByFact[item.factId] = blocks;
  }

  const blocks1 = referencingBlocksByFact[impactItems[0].factId];
  const blocks2 = referencingBlocksByFact[impactItems[1].factId];

  // Check non-overlapping rule: {blocks1} ∩ {blocks2} === ∅
  const ids1 = new Set(blocks1.map((b) => b.id));
  const ids2 = new Set(blocks2.map((b) => b.id));
  const overlap = blocks1.filter((b) => ids2.has(b.id));
  if (overlap.length > 0) {
    const overlapStr = overlap.map((b) => `第${b.order}段 [${b.id}]`).join('、');
    const msg = `两项变更事实共同关联了同一段落（${overlapStr}），两项事实关联的段落集合存在重叠，超出本批互不重叠支持范围，请人工编辑或重新起草。`;
    return {
      eligible: false,
      reason: msg,
      blockingReasons: [msg],
    };
  }

  // Check material supplementation on all target blocks
  const allBlocks = [...blocks1, ...blocks2];
  for (const b of allBlocks) {
    if (b.adoptedEvidences && b.adoptedEvidences.length > 0) {
      const msg = `关联段落（第${b.order}段 [${b.id}]）包含材料补写存证，本批不支持材料补写存证的自动更新，整组修订已阻断。`;
      return {
        eligible: false,
        reason: msg,
        blockingReasons: [msg],
      };
    }
  }

  // Deterministic rewrite check for each block
  for (const item of impactItems) {
    const latestFact = task.facts.find((f) => f.id === item.factId)!;
    const snapItem = draftFactSnap.items.find((i) => i.factId === latestFact.id)!;
    const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
    const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
    const unit = (snapItem.unit || latestFact.unit || '').trim();
    const metric = (snapItem.metric || latestFact.metric || '').trim();

    if (!snapValue || !latestValue || snapValue === latestValue) {
      const msg = `事实【${metric}】数值未发生实质变动，无需生成修订候选。`;
      return { eligible: false, reason: msg, blockingReasons: [msg] };
    }

    const blocksForThisFact = referencingBlocksByFact[item.factId];
    for (const b of blocksForThisFact) {
      const text = b.content;
      const offset = metricValueOffset(text, metric, snapValue, unit);
      if (offset === undefined) {
        const msg = `关联段落（第${b.order}段 [${b.id}]）正文未找到唯一、完整且明确属于目标指标【${metric}】的冻结数值（${snapValue}）和单位（${unit}），可能存在多处相同数值、语义归属不明、包含否定/计划/目标限定或正文已偏离当时冻结值，整组拒绝采纳。`;
        return { eligible: false, reason: msg, blockingReasons: [msg] };
      }

      if (!supportedMetricPeriod(text, `${snapValue}${unit}`, snapItem.period, task.startDate, offset)) {
        const msg = `关联段落（第${b.order}段 [${b.id}]）正文指标【${metric}】明示的统计期间与冻结依据不符或归属不明，整组拒绝采纳。`;
        return { eligible: false, reason: msg, blockingReasons: [msg] };
      }

      const revisedContent = text.slice(0, offset) + latestValue + text.slice(offset + snapValue.length);
      const prefixMatch = revisedContent.slice(0, offset) === text.slice(0, offset);
      const suffixMatch = revisedContent.slice(offset + latestValue.length) === text.slice(offset + snapValue.length);
      const replacedValueMatch =
        revisedContent.slice(offset, offset + latestValue.length) === latestValue &&
        text.slice(offset, offset + snapValue.length) === snapValue;

      if (!prefixMatch || !suffixMatch || !replacedValueMatch) {
        const msg = `关联段落（第${b.order}段 [${b.id}]）改写结果偏离最小范围修改原则，已安全拦截。`;
        return { eligible: false, reason: msg, blockingReasons: [msg] };
      }
    }
  }

  const allReferencingBlocks = [...allBlocks].sort((a, b) => a.order - b.order);

  return {
    eligible: true,
    targetFactIds,
    targetFactItems: impactItems,
    referencingBlocksByFact,
    allReferencingBlocks,
  };
}

/**
 * Generates deterministic multi-fact group revision candidates for all referencing blocks.
 * If ANY block or fact fails validation, the entire group is rejected and no partial result is returned.
 */
export function generateMultiFactGroupRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  roleOrOptions?: UserRole | { runId?: string },
  maybeOptions?: { runId?: string }
): MultiFactGroupRevisionCandidateResult {
  const isRole = (val: any): val is UserRole => ['主笔甲', '审阅乙', '审阅丁', '供稿丙'].includes(val);
  let activeRole: UserRole | undefined;
  let runId: string | undefined;

  if (isRole(roleOrOptions)) {
    activeRole = roleOrOptions;
    runId = maybeOptions?.runId;
  } else if (roleOrOptions && typeof roleOrOptions === 'object') {
    runId = roleOrOptions.runId;
  }

  if (!activeRole) {
    return { success: false, reason: '未提供有效操作身份，不能默认以主笔身份生成多事实成组修订候选。' };
  }

  const eligibility = checkMultiFactGroupRevisionEligibility(task, currentDraft, activeRole, { runId });
  if (!eligibility.eligible || !eligibility.targetFactItems || !eligibility.referencingBlocksByFact) {
    return {
      success: false,
      reason: eligibility.reason || '多事实成组修订准入校验未通过',
    };
  }

  const impactItems = eligibility.targetFactItems;
  const referencingBlocksByFact = eligibility.referencingBlocksByFact;

  const facts: FactRevisionItem[] = impactItems.map((item) => {
    const latestFact = task.facts.find((f) => f.id === item.factId)!;
    const snapItem = currentDraft!.snapshotMetadata!.factSnapshot!.items.find((i) => i.factId === latestFact.id)!;
    const snapValue = (snapItem.selectedConflictValue || snapItem.value || '').trim();
    const latestValue = (latestFact.selectedConflictValue || latestFact.value || '').trim();
    const unit = (snapItem.unit || latestFact.unit || '').trim();
    const metric = (snapItem.metric || latestFact.metric || '').trim();
    const toSnip = latestFact.primaryEvidenceId ? task.snippets.find((s) => s.id === latestFact.primaryEvidenceId) : undefined;
    const blocks = referencingBlocksByFact[item.factId];

    return {
      factId: item.factId,
      metric,
      unit,
      period: latestFact.period,
      fromValue: snapValue,
      toValue: latestValue,
      fromEvidenceId: snapItem.primaryEvidenceId,
      fromDocName: snapItem.provenance!.sourceDocName,
      fromLocation: snapItem.provenance!.location || '未保存定位',
      toEvidenceId: latestFact.primaryEvidenceId,
      toDocName: toSnip?.docName || '最新出处材料',
      toLocation: toSnip?.location || '段落索引',
      referencingBlockIds: blocks.map((b) => b.id),
    };
  });

  const allItems: ParagraphRevisionCandidateItem[] = [];

  for (const factItem of facts) {
    const blocks = referencingBlocksByFact[factItem.factId];
    for (const block of blocks) {
      const text = block.content;
      const offset = metricValueOffset(text, factItem.metric, factItem.fromValue, factItem.unit)!;
      const revisedContent = text.slice(0, offset) + factItem.toValue + text.slice(offset + factItem.fromValue.length);

      allItems.push({
        targetBlockId: block.id,
        targetBlockOrder: block.order,
        targetSectionTitle:
          task.outline.find((o) => o.id === block.sectionId)?.title ||
          currentDraft!.snapshotMetadata?.outlineSections?.find((o) => o.id === block.sectionId)?.title ||
          '正文章节',
        originalBlockContent: block.content,
        originalRevisionSeq:
          typeof block.revisionSeq === 'number' && Number.isFinite(block.revisionSeq) ? block.revisionSeq : 0,
        originalReferencedFactIds: [...block.referencedFactIds],
        revisedBlockContent: revisedContent,
        diffExplanation: `事实【${factItem.metric}】数值由 ${factItem.fromValue}${factItem.unit} 更新为 ${factItem.toValue}${factItem.unit}`,
      });
    }
  }

  // Sort items strictly by targetBlockOrder
  allItems.sort((a, b) => a.targetBlockOrder - b.targetBlockOrder);

  const finalRunId = runId || `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const candidateGroupId = `FACT-GROUP-REV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const candidateGroup: MultiFactGroupRevisionCandidate = {
    id: candidateGroupId,
    runId: finalRunId,
    taskId: task.id,
    sourceDraftId: currentDraft!.id,
    sourceDraftVersionNumber: currentDraft!.versionNumber,
    facts,
    targetFactIds: facts.map((f) => f.factId),
    items: allItems,
    targetBlockIds: allItems.map((i) => i.targetBlockId),
    baseDraftContentHash: computeDraftBlocksHash(currentDraft!.blocks),
    contextFingerprint: getFactRevisionContext(task, currentDraft!),
    upstreamContext: {
      factSnapshotConfirmedAt: task.factSnapshot?.confirmedAt,
      factSnapshotHash: task.factSnapshot?.hash,
      styleConfirmedAt: task.styleSnapshot?.confirmedAt,
      styleHash: task.styleSnapshot?.hash,
      outlineConfirmedAt: task.outlineSnapshot?.confirmedAt,
      outlineHash: task.outlineSnapshot?.hash,
    },
    createdAt: new Date().toISOString(),
    explanation: `经核实，已核准采信2项事实变更：【${facts[0].metric}】由 ${facts[0].fromValue}${facts[0].unit} 更新为 ${facts[0].toValue}${facts[0].unit}（涉及${facts[0].referencingBlockIds.length}段），【${facts[1].metric}】由 ${facts[1].fromValue}${facts[1].unit} 更新为 ${facts[1].toValue}${facts[1].unit}（涉及${facts[1].referencingBlockIds.length}段）。已针对全部 ${allItems.length} 个关联段落执行一致性定向修订，保留原文单位及未变更内容。`,
  };

  return {
    success: true,
    candidateGroup,
  };
}

/**
 * Validates two-fact group candidate adoption preconditions:
 * - Author role, task ID, run ID, source draft ID
 * - Target blocks' content, revisionSeq, and references unchanged
 * - Group integrity: referencing block sets for both facts unchanged
 * - Upstream approval context unchanged
 * - Strict non-overlapping invariant satisfied
 */
export function validateMultiFactGroupRevisionAcceptance(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidateGroup: MultiFactGroupRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): { valid: boolean; reason?: string } {
  if (activeRole !== '主笔甲') {
    return { valid: false, reason: '权限受限：仅主笔甲有权采纳修订并创建新工作稿！' };
  }

  // Candidate payloads must be complete before traversing nested collections.
  // Exact semantic equality is still checked against fresh derivation below.
  if (!candidateGroup ||
      !['id', 'runId', 'taskId', 'sourceDraftId', 'baseDraftContentHash', 'contextFingerprint'].every(
        key => typeof (candidateGroup as unknown as Record<string, unknown>)[key] === 'string' &&
          Boolean((candidateGroup as unknown as Record<string, unknown>)[key])) ||
      !strings(candidateGroup.targetFactIds) || !strings(candidateGroup.targetBlockIds) ||
      !Array.isArray(candidateGroup.facts) || candidateGroup.facts.length !== 2 ||
      !candidateGroup.facts.every(f => f &&
        ['factId', 'metric', 'unit', 'period', 'fromValue', 'toValue'].every(
          key => typeof (f as unknown as Record<string, unknown>)[key] === 'string') &&
        strings(f.referencingBlockIds)) ||
      !Array.isArray(candidateGroup.items) || !candidateGroup.items.length ||
      !candidateGroup.items.every(item => item &&
        typeof item.targetBlockId === 'string' && typeof item.originalBlockContent === 'string' &&
        typeof item.revisedBlockContent === 'string' && Number.isFinite(item.originalRevisionSeq) &&
        strings(item.originalReferencedFactIds)) ||
      !candidateGroup.upstreamContext || typeof candidateGroup.upstreamContext !== 'object' ||
      Array.isArray(candidateGroup.upstreamContext)) {
    return { valid: false, reason: '成组候选结构不完整或格式异常，请重新生成候选。' };
  }

  if (candidateGroup.taskId !== task.id) {
    return { valid: false, reason: '安全隔离拦截：修订候选生成自其他任务，禁止跨任务采纳！' };
  }

  if (!activeRunId || candidateGroup.runId !== activeRunId) {
    return { valid: false, reason: '候选已失效：该候选生成自已取消或过期的运行！' };
  }

  if (!currentDraft || currentDraft.id !== candidateGroup.sourceDraftId) {
    return { valid: false, reason: '版本已变更：当前草稿已切换，旧候选已失效！' };
  }

  if (currentDraft.isHistoricalSnapshot || currentDraft.isFinal || currentDraft.isWorkingDraft === false) {
    return { valid: false, reason: '当前版本已是只读快照或定稿，禁止直接采纳写入！' };
  }

  if (currentDraft.id !== task.currentDraftId) {
    return { valid: false, reason: '当前草稿已不是任务当前可编辑工作稿，禁止重复采纳！' };
  }

  // Validate candidateGroup facts structure
  if (!Array.isArray(candidateGroup.facts) || candidateGroup.facts.length !== 2) {
    return { valid: false, reason: '成组候选事实集合异常，必须包含且仅包含2项事实！' };
  }

  // Validate each target block in candidateGroup.items
  for (const item of candidateGroup.items) {
    const currentBlock = currentDraft.blocks.find((b) => b.id === item.targetBlockId);
    if (!currentBlock) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）已在当前草稿中被删除，候选已失效！`,
      };
    }

    if (currentBlock.content !== item.originalBlockContent) {
      return {
        valid: false,
        reason: `基准正文已变更：目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）正文已被人工编辑修改，采纳候选将覆盖人工修改！已安全拦截。`,
      };
    }

    const currentSeq =
      typeof currentBlock.revisionSeq === 'number' && Number.isFinite(currentBlock.revisionSeq)
        ? currentBlock.revisionSeq
        : 0;
    if (currentSeq !== item.originalRevisionSeq) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）修订版本号已递增，表明发生过其他修改，候选已失效！`,
      };
    }

    const curRefIds = [...currentBlock.referencedFactIds].sort().join(',');
    const origRefIds = [...item.originalReferencedFactIds].sort().join(',');
    if (curRefIds !== origRefIds) {
      return {
        valid: false,
        reason: `目标段落（第${item.targetBlockOrder}段 [${item.targetBlockId}]）事实引用关系已发生变动，候选已失效！`,
      };
    }
  }

  // Validate referencing blocks set for each fact
  for (const factItem of candidateGroup.facts) {
    const currentReferencingBlockIds = currentDraft.blocks
      .filter(
        (b) =>
          (b.referencedFactIds || []).includes(factItem.factId) ||
          (b.adoptedEvidences || []).some((e) => e.associatedFactId === factItem.factId)
      )
      .map((b) => b.id)
      .sort()
      .join(',');
    const candidateBlockIds = [...factItem.referencingBlockIds].sort().join(',');
    if (currentReferencingBlockIds !== candidateBlockIds) {
      return {
        valid: false,
        reason: `事实【${factItem.metric}】关联段落集合发生变动（存在新增或遗漏的引用段落），候选已失效！请重新生成。`,
      };
    }
  }

  // Validate all target block IDs match exactly
  const allCurrentTargetBlockIds = currentDraft.blocks
    .filter(
      (b) =>
        candidateGroup.targetFactIds.some(
          (fid) => (b.referencedFactIds || []).includes(fid) || (b.adoptedEvidences || []).some((e) => e.associatedFactId === fid)
        )
    )
    .map((b) => b.id)
    .sort()
    .join(',');
  const allCandidateBlockIds = [...candidateGroup.targetBlockIds].sort().join(',');
  if (allCurrentTargetBlockIds !== allCandidateBlockIds) {
    return {
      valid: false,
      reason: '当前草稿关联段落集合发生变动，候选已失效！请重新生成。',
    };
  }

  // Whole draft hash check: ensure other paragraphs were not modified
  const currentDraftHash = computeDraftBlocksHash(currentDraft.blocks);
  if (currentDraftHash !== candidateGroup.baseDraftContentHash) {
    return {
      valid: false,
      reason: '草稿非目标段落已被人工编辑修改，整稿基准已发生变更，候选已失效！请重新生成。',
    };
  }

  // Fact freshness check for both facts
  for (const factItem of candidateGroup.facts) {
    const currentFact = task.facts.find((f) => f.id === factItem.factId);
    const currentFactValue = (currentFact?.selectedConflictValue || currentFact?.value || '').trim();
    if (
      !currentFact ||
      currentFactValue !== factItem.toValue ||
      currentFact.primaryEvidenceId !== factItem.toEvidenceId
    ) {
      return {
        valid: false,
        reason: `目标事实【${factItem.metric}】最新核准数值或出处已再次变更，候选已失效！请重新生成。`,
      };
    }
  }

  // Upstream approval context check
  if (
    candidateGroup.upstreamContext.factSnapshotConfirmedAt !== task.factSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.factSnapshotHash &&
      task.factSnapshot?.hash &&
      candidateGroup.upstreamContext.factSnapshotHash !== task.factSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务事实核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidateGroup.upstreamContext.styleConfirmedAt !== task.styleSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.styleHash &&
      task.styleSnapshot?.hash &&
      candidateGroup.upstreamContext.styleHash !== task.styleSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务文风核准版本已变更，候选已失效！请重新生成。',
    };
  }

  if (
    candidateGroup.upstreamContext.outlineConfirmedAt !== task.outlineSnapshot?.confirmedAt ||
    (candidateGroup.upstreamContext.outlineHash &&
      task.outlineSnapshot?.hash &&
      candidateGroup.upstreamContext.outlineHash !== task.outlineSnapshot.hash)
  ) {
    return {
      valid: false,
      reason: '任务大纲核准版本已变更，候选已失效！请重新生成。',
    };
  }

  // Full re-check of eligibility
  const eligibility = checkMultiFactGroupRevisionEligibility(task, currentDraft, activeRole);
  if (!eligibility.eligible) {
    return {
      valid: false,
      reason: `采纳校验失败：${eligibility.reason}`,
    };
  }

  if (
    !candidateGroup.contextFingerprint ||
    candidateGroup.contextFingerprint !== getFactRevisionContext(task, currentDraft)
  ) {
    return {
      valid: false,
      reason: '正文、修订、引用、原文或审批上下文已变化，旧候选已失效，请重新生成。',
    };
  }

  const regenerated = generateMultiFactGroupRevisionCandidate(task, currentDraft, activeRole, {
    runId: candidateGroup.runId,
  });
  if (!regenerated.candidateGroup) {
    return { valid: false, reason: regenerated.reason || '多事实成组候选无法重新验证' };
  }

  const payload = ({ id: _id, createdAt: _time, ...c }: MultiFactGroupRevisionCandidate) => c;
  if (canonical(payload(candidateGroup)) !== canonical(payload(regenerated.candidateGroup))) {
    return {
      valid: false,
      reason: '候选正文、目标事实或依据对照与当前可验证修订不一致，请重新生成。',
    };
  }

  return { valid: true };
}

/**
 * Atomically adopts the two-fact group revision candidate:
 * 1. Archives old draft as historical snapshot with frozen old text, snapshot, and reviews
 * 2. Creates a single new working draft with ONLY target blocks changed and updated snapshotMetadata
 * 3. Initializes review records to empty, preserving old conclusions as source references
 * 4. Writes a single consolidated atomic modification log with shared operation ID and affectedFacts
 * 5. Updates task.drafts and task.currentDraftId in a single atomic transaction
 */
export function acceptMultiFactGroupRevisionCandidate(
  task: Task,
  currentDraft: DraftVersion | undefined,
  candidateGroup: MultiFactGroupRevisionCandidate,
  activeRole: UserRole,
  activeRunId?: string | null
): MultiFactGroupRevisionAcceptanceResult {
  const validation = validateMultiFactGroupRevisionAcceptance(
    task,
    currentDraft,
    candidateGroup,
    activeRole,
    activeRunId
  );
  if (!validation.valid) {
    return {
      success: false,
      reason: validation.reason || '采纳校验失败',
    };
  }

  const draftToArchive = currentDraft!;

  // 1. Archive previous draft as immutable historical snapshot
  const archivedDraft: DraftVersion = {
    ...JSON.parse(JSON.stringify(draftToArchive)),
    isWorkingDraft: false,
    isHistoricalSnapshot: true,
    summary: draftToArchive.summary
      ? `${draftToArchive.summary}（采纳两项事实成组定向修订前系统自动归档历史快照）`
      : '采纳两项事实成组定向修订前系统自动归档的历史快照',
    frozenReviewComments: freezeReviewComments(task, draftToArchive),
    ...freezeFactReviews(task, draftToArchive),
  };

  // 2. Build updated blocks for new working draft
  const targetItemMap = new Map(candidateGroup.items.map((item) => [item.targetBlockId, item]));
  const nextBlocks: ParagraphBlock[] = draftToArchive.blocks.map((b) => {
    const item = targetItemMap.get(b.id);
    if (item) {
      const nextSeq =
        (typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : 0) + 1;
      return {
        ...b,
        content: item.revisedBlockContent,
        revisionSeq: nextSeq,
        updatedAt: new Date().toISOString(),
        adoptedEvidences: b.adoptedEvidences ? JSON.parse(JSON.stringify(b.adoptedEvidences)) : undefined,
      };
    }
    return JSON.parse(JSON.stringify(b));
  });

  const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作稿·已采纳多事实成组定向修订)`;

  // 3. Create brand-new working draft bound to the verified latest approved snapshot
  const factsSummaryStr = candidateGroup.facts.map((f) => `【${f.metric}】`).join('、');
  const newWorkingDraft: DraftVersion = {
    id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    versionNumber: nextVersionNumber,
    createdAt: new Date().toISOString(),
    author: activeRole,
    summary: `基于【${draftToArchive.versionNumber}】归档后采纳两项事实（${factsSummaryStr}，共${candidateGroup.items.length}段）成组定向修订生成的工作稿`,
    blocks: nextBlocks,
    isFinal: false,
    isHistoricalSnapshot: false,
    isWorkingDraft: true,
    sourceDraftId: draftToArchive.id,
    reviewBaselineIds: getReviewBaselineIds(task, draftToArchive),
    snapshotMetadata: {
      ...draftToArchive.snapshotMetadata!,
      factSnapshot: JSON.parse(JSON.stringify(task.factSnapshot)),
      styleSnapshot: JSON.parse(JSON.stringify(task.styleSnapshot)),
      outlineSnapshot: JSON.parse(JSON.stringify(task.outlineSnapshot)),
    },
    auditRecords: [],
    factReviewRecords: [],
    sourceFactReviewRecords: sourceFactReviews(draftToArchive),
  };

  // 4. Build single consolidated atomic modification log
  const factsDetailStr = candidateGroup.facts
    .map(
      (f) =>
        `【${f.metric}】：${f.fromValue}${f.unit} → ${f.toValue}${f.unit}（出处 ${f.fromEvidenceId} → ${f.toEvidenceId}，涉及${f.referencingBlockIds.length}段）`
    )
    .join('；');

  const modLog: ParagraphModificationLog = {
    id: `MOD-LOG-${candidateGroup.id}`,
    taskId: task.id,
    draftId: newWorkingDraft.id,
    blockId: candidateGroup.targetBlockIds.join(','),
    blockOrder: candidateGroup.items[0]?.targetBlockOrder,
    timestamp: new Date().toISOString(),
    source: 'fact_change_revision' as const,
    sourceDescription: `两项事实成组定向修订（共2项事实、${candidateGroup.items.length}个段落：${candidateGroup.items.map((i) => `第${i.targetBlockOrder}段`).join('、')}）：${factsDetailStr}；来源版本 ${draftToArchive.id}`,
    beforeContent: candidateGroup.items.map((i) => `[第${i.targetBlockOrder}段] ${i.originalBlockContent}`).join('\n\n'),
    afterContent: candidateGroup.items.map((i) => `[第${i.targetBlockOrder}段] ${i.revisedBlockContent}`).join('\n\n'),
    affectedBlocks: candidateGroup.items.map((i) => ({
      blockId: i.targetBlockId,
      blockOrder: i.targetBlockOrder,
      sectionTitle: i.targetSectionTitle,
      beforeContent: i.originalBlockContent,
      afterContent: i.revisedBlockContent,
      appliedRevisionSeq: nextBlocks.find((b) => b.id === i.targetBlockId)!.revisionSeq,
    })),
    affectedBlockIds: candidateGroup.targetBlockIds,
    affectedFacts: candidateGroup.facts.map((f) => ({
      factId: f.factId,
      metric: f.metric,
      unit: f.unit,
      period: f.period,
      fromValue: f.fromValue,
      toValue: f.toValue,
      fromEvidenceId: f.fromEvidenceId,
      fromDocName: f.fromDocName,
      fromLocation: f.fromLocation,
      toEvidenceId: f.toEvidenceId,
      toDocName: f.toDocName,
      toLocation: f.toLocation,
      referencingBlockIds: f.referencingBlockIds,
    })),
    targetFactIds: candidateGroup.targetFactIds,
    sourceDraftId: draftToArchive.id,
    status: 'applied' as const,
    undoUnavailableReason: '本次为两项事实成组定向修订且同时更新整稿依据，禁止单独撤销正文；请通过版本历史恢复完整正文与依据。',
  };

  // 5. Update task atomically
  const updatedDrafts = [
    newWorkingDraft,
    ...task.drafts.map((d) => (d.id === draftToArchive.id ? archivedDraft : d)),
  ];

  const updatedTask: Task = {
    ...task,
    drafts: updatedDrafts,
    currentDraftId: newWorkingDraft.id,
    isFinalized: false,
    status: '起草中',
    updatedAt: new Date().toISOString(),
    modificationLogs: [modLog, ...(task.modificationLogs || [])].slice(0, 20),
  };

  return {
    success: true,
    updatedTask,
    newWorkingDraft,
    archivedDraft,
    modificationLog: modLog,
  };
}
