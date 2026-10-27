import {
  Task,
  DraftVersion,
  ParagraphBlock,
  FactItemSnapshot,
  FactSnapshot,
  StyleSnapshot,
  OutlineSnapshot,
  FactRevisionCandidate,
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

// Capturing a new approval may refresh provenance time without changing its meaning.
function semanticFact(item: FactItemSnapshot) {
  const { capturedAt: _time, ...provenance } = item.provenance || {};
  return { ...item, provenance: item.provenance ? provenance : undefined };
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

function completeBasisError(task: Task, draft: DraftVersion, targetFactId: string): string | undefined {
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
    if (fact.id !== targetFactId && canonical(semanticFact(old)) !== canonical(semanticFact(latest))) {
      return `非目标事实【${fact.metric}】的指标、裁决或出处仍有变化，超出本批范围。`;
    }
    if (fact.id === targetFactId && old.metric !== latest.metric) {
      return '目标指标名称已变化，无法证明是同一数值指标。';
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
