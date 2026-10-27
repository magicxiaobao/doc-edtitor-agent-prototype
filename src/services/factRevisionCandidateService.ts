import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  AdoptedEvidenceRecord,
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
import { computeTextDiff } from './diffService';

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

  if (!draftFactSnap || !Array.isArray(draftFactSnap.items) || !draftStyleSnap || !draftOutlineSnap) {
    return {
      eligible: false,
      reason: '草稿缺少完整冻结依据基准（事实快照、文风快照或大纲快照缺失），无法验证依据一致性。',
    };
  }

  // 5. Task upstream formal confirmations
  if (!task.styleConfirmed || !task.styleSnapshot) {
    return {
      eligible: false,
      reason: '任务文风规范尚未正式核准确认，请先核准文风。',
      unconfirmedUpstream: 'style',
    };
  }

  if (!task.outlineConfirmed || !task.outlineSnapshot) {
    return {
      eligible: false,
      reason: '任务大纲结构尚未正式核准确认，请先核准大纲。',
      unconfirmedUpstream: 'outline',
    };
  }

  if (!task.factSnapshot || !Array.isArray(task.factSnapshot.items)) {
    return {
      eligible: false,
      reason: '任务事实清单尚未正式核准确认，请先前往事实清单完成核准。',
      unconfirmedUpstream: 'fact',
    };
  }

  // 6. Substantive style guidelines verification (compare active rules content)
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
  if (analysis.unreferencedNewFacts && analysis.unreferencedNewFacts.length > 0) {
    return {
      eligible: false,
      reason: `任务事实清单中存在 ${analysis.unreferencedNewFacts.length} 项未在草稿中引用的新核准事实，存在尚未处理的依据差异，无法执行单段微调。`,
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
      reason: '当前稿件依据与任务最新事实完全一致，无受影响的事实变动。',
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
    const unlinked = targetBlock.adoptedEvidences.some(
      (e) => !task.snippets.some((s) => s.id === e.evidenceId)
    );
    if (unlinked) {
      return {
        eligible: false,
        reason: '目标段落包含无法明确关联的材料补写存证，超出本批可靠处理范围。',
      };
    }
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

  // Find all occurrences of snapValue in the target paragraph
  interface NumberMatch {
    idx: number;
    hasUnit: boolean;
    sentence: string;
    hasMetricAffinity: boolean;
  }

  const matches: NumberMatch[] = [];
  let searchIdx = 0;

  while (searchIdx < text.length) {
    const found = text.indexOf(snapValue, searchIdx);
    if (found === -1) break;

    // Check digit boundaries (e.g. 128 shouldn't match inside 2128 or 1280)
    const isPrevDigit = found > 0 && /\d/.test(text[found - 1]);
    const isNextDigit =
      found + snapValue.length < text.length && /\d/.test(text[found + snapValue.length]);

    if (!isPrevDigit && !isNextDigit) {
      // Check if immediately followed by unit (with optional whitespace)
      const after = text.slice(found + snapValue.length);
      const unitRegex = new RegExp(`^\\s*${escapeRegex(unit)}`);
      const hasUnit = unit ? unitRegex.test(after) : true;

      // Extract clause/sentence boundaries
      let sStart = found;
      while (sStart > 0 && !/[。！？；\n]/.test(text[sStart - 1])) {
        sStart--;
      }
      let sEnd = found + snapValue.length;
      while (sEnd < text.length && !/[。！？；\n]/.test(text[sEnd])) {
        sEnd++;
      }
      const sentence = text.slice(sStart, sEnd);

      // Check metric affinity: does the sentence contain the metric name or key tokens?
      const metricTokens = [
        metric,
        ...metric.split(/[\s_\-、,，]+/).filter((t) => t.length >= 2),
      ];
      const hasMetricAffinity = metricTokens.some((tok) => sentence.includes(tok));

      matches.push({
        idx: found,
        hasUnit,
        sentence,
        hasMetricAffinity,
      });
    }

    searchIdx = found + snapValue.length;
  }

  // 1. No occurrence of snapValue found
  if (matches.length === 0) {
    return {
      success: false,
      reason: `正文未找到冻结数值（${snapValue}）或正文已被编辑偏离当时冻结值，无法生成定向修订。`,
    };
  }

  // 2. Filter matches that have the matching unit
  const matchesWithUnit = unit ? matches.filter((m) => m.hasUnit) : matches;
  if (matchesWithUnit.length === 0) {
    return {
      success: false,
      reason: `段落中包含数值“${snapValue}”，但未与指标单位“${unit}”匹配，无法确定指标归属，拒绝生成。`,
    };
  }

  // 3. Disambiguate if multiple matches
  let chosenMatch: NumberMatch | undefined;
  if (matchesWithUnit.length === 1) {
    chosenMatch = matchesWithUnit[0];
  } else {
    // Multiple matches with the same unit: check metric semantic affinity
    const affinityMatches = matchesWithUnit.filter((m) => m.hasMetricAffinity);
    if (affinityMatches.length === 1) {
      chosenMatch = affinityMatches[0];
    } else {
      return {
        success: false,
        reason: `段落中存在多处相同数值与单位表达（${snapValue}${unit}），语义归属不明，无法确定替换对象，请人工编辑。`,
      };
    }
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

  const fromSnip = snapItem.primaryEvidenceId
    ? task.snippets.find((s) => s.id === snapItem.primaryEvidenceId)
    : undefined;
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

    metric,
    unit,
    fromValue: snapValue,
    toValue: latestValue,

    fromEvidenceId: snapItem.primaryEvidenceId,
    fromDocName: snapItem.provenance?.sourceDocName || fromSnip?.docName || '出处材料',
    fromLocation: snapItem.provenance?.location || fromSnip?.location || '段落索引',

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

  if (activeRunId && candidate.runId !== activeRunId) {
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
    ...draftToArchive,
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

      // Update adopted evidence if it points to the changed fact
      let updatedAdoptedEvidences = b.adoptedEvidences ? [...b.adoptedEvidences] : undefined;
      if (candidate.toEvidenceId && updatedAdoptedEvidences) {
        const newSnip = task.snippets.find((s) => s.id === candidate.toEvidenceId);
        const newDoc = newSnip ? task.documents.find((d) => d.id === newSnip.sourceDocId) : undefined;
        const latestFact = task.facts.find((f) => f.id === candidate.targetFactId);

        updatedAdoptedEvidences = updatedAdoptedEvidences.map((ae) => {
          if (ae.associatedFactId === candidate.targetFactId) {
            return {
              ...ae,
              evidenceId: candidate.toEvidenceId!,
              sourceDocId: newSnip?.sourceDocId || ae.sourceDocId,
              sourceDocName: candidate.toDocName || newDoc?.name || ae.sourceDocName,
              snippetLocation: candidate.toLocation || newSnip?.location || ae.snippetLocation,
              snippetText: newSnip?.text || ae.snippetText,
              metricScope: latestFact?.metricScope || ae.metricScope,
            };
          }
          return ae;
        });
      }

      return {
        ...b,
        content: candidate.revisedBlockContent,
        revisionSeq: nextSeq,
        updatedAt: new Date().toISOString(),
        adoptedEvidences: updatedAdoptedEvidences,
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
  };

  return {
    success: true,
    updatedTask,
    newWorkingDraft,
    archivedDraft,
  };
}
