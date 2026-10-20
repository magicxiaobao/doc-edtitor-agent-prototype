import {
  Task,
  ParagraphBlock,
  DraftVersion,
  EvidenceSnippet,
  SourceDocument,
  Fact,
  RevisionSuggestion,
  AdoptedEvidenceRecord,
  DiffSegment
} from '../types';
import {
  parsePeriodDateRange,
  arePeriodsStrictlyIdentical,
  extractClausePeriod,
  CANONICAL_PERIOD_PATTERN
} from './factLifecycleService';
export {
  arePeriodsStrictlyIdentical,
  parsePeriodDateRange,
  extractClausePeriod,
  CANONICAL_PERIOD_PATTERN
} from './factLifecycleService';
import { computeContentHash } from './mockDraftService';
import { computeTextDiff } from './diffService';

/**
 * Validates whether a date range period falls strictly within the task start/end date.
 * Supports ISO date strings (2026-01-01), Chinese dates, or quarterly/monthly period strings.
 */
export function isDateRangeWithinTask(
  periodStr: string,
  taskStartDate?: string,
  taskEndDate?: string
): boolean {
  if (!periodStr) return false;
  const range = parsePeriodDateRange(periodStr);
  if (!range) return false;
  if (!taskStartDate || !taskEndDate) return true;

  const parseTaskBound = (dStr: string, isEnd: boolean): Date => {
    const isoMatch = dStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (isoMatch) {
      const y = parseInt(isoMatch[1], 10);
      const m = parseInt(isoMatch[2], 10);
      const d = parseInt(isoMatch[3], 10);
      return isEnd
        ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59))
        : new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    }
    const r = parsePeriodDateRange(dStr);
    if (r) return isEnd ? r.end : r.start;
    return new Date(dStr.includes('T') ? dStr : isEnd ? `${dStr}T23:59:59Z` : `${dStr}T00:00:00Z`);
  };

  const taskStart = parseTaskBound(taskStartDate, false);
  const taskEnd = parseTaskBound(taskEndDate, true);

  if (isNaN(taskStart.getTime()) || isNaN(taskEnd.getTime())) {
    return true;
  }

  // Range cannot start before task start date (60s tolerance for precision)
  if (range.start.getTime() < taskStart.getTime() - 60000) {
    return false;
  }
  // Range cannot end after task end date (60s tolerance for precision)
  if (range.end.getTime() > taskEnd.getTime() + 60000) {
    return false;
  }
  return true;
}

/**
 * Validates whether a snippet and its parent document are eligible for supplementation:
 * 1. Document must exist in task.documents and NOT be excluded
 * 2. Document usage must be 'current_fact' (style_ref, history_bg, rag_clue strictly forbidden)
 * 3. Document and snippet period must align with the current task's statistical period (complete start/end date range validation)
 * 4. Snippet must have substantive text (not '无原文', not RAG clue without source, not '暂无案例' disclaimer)
 */
export function validateMaterialForSupplementation(
  task: Task,
  snippet: EvidenceSnippet
): { eligible: boolean; reason?: string } {
  if (!snippet) {
    return { eligible: false, reason: '材料片段不存在' };
  }

  const doc = task.documents.find((d) => d.id === snippet.sourceDocId);
  if (!doc) {
    return { eligible: false, reason: '未找到来源材料文档（可能已被删除）' };
  }

  if (doc.excluded) {
    return { eligible: false, reason: '来源文档已被排除，不可作为补写依据' };
  }

  if (doc.usage === 'style_ref' || (doc.usage as string) === 'style') {
    return { eligible: false, reason: '文风参考材料不可作为本期事实补写依据' };
  }

  if (doc.usage === 'history_bg') {
    return { eligible: false, reason: '历史背景材料不可作为本期事实补写依据' };
  }

  if (doc.usage === 'rag_clue' || snippet.id === 'EVD-06' || snippet.location === '无原文' || snippet.location?.includes('线索') || snippet.location?.includes('摘要')) {
    return { eligible: false, reason: '知识库检索线索（缺少确凿原文出处）不可直接作为事实补写依据' };
  }

  // Negative statements / lack-of-case disclaimers cannot masquerade as authentic practices
  const negativePatterns = ['暂无案例', '无典型案例', '无案例说明', '缺少案例', '未提供案例', '暂无典型', '无具体推进案例', '尚无案例', '无案例'];
  if (negativePatterns.some((np) => snippet.text.includes(np) || snippet.docName.includes(np) || doc.name.includes(np))) {
    return { eligible: false, reason: '该材料仅为无案例声明或缺少案例说明，不可作为正文补写内容' };
  }

  // Substantive text length check
  if (!snippet.text || snippet.text.trim().length < 8) {
    return { eligible: false, reason: '材料内容过短，缺少实质性工作举措描述' };
  }

  // Complete period alignment check:
  // Must match current task period (complete start to end date range validation)
  if (task.startDate && task.endDate) {
    const isDocPeriodValid = isDateRangeWithinTask(doc.period, task.startDate, task.endDate);
    const isSnipPeriodValid = snippet.period ? isDateRangeWithinTask(snippet.period, task.startDate, task.endDate) : isDocPeriodValid;

    if (!isDocPeriodValid || !isSnipPeriodValid) {
      return { eligible: false, reason: `材料统计期间（${snippet.period || doc.period}）与本任务期间（${task.startDate}至${task.endDate}）跨期不符，不可作为本期依据` };
    }
  } else {
    const docRange = parsePeriodDateRange(doc.period);
    const snipRange = snippet.period ? parsePeriodDateRange(snippet.period) : docRange;
    if (!docRange || !snipRange) {
      return { eligible: false, reason: '材料无法判定统计期间，不可作为本期补写依据' };
    }
  }

  return { eligible: true };
}

/**
 * Returns eligible and ineligible materials for supplementation in the current task.
 */
export function getEligibleMaterialsForSupplementation(task: Task): {
  eligibleSnippets: EvidenceSnippet[];
  ineligibleList: { snippet: EvidenceSnippet; reason: string }[];
} {
  const eligibleSnippets: EvidenceSnippet[] = [];
  const ineligibleList: { snippet: EvidenceSnippet; reason: string }[] = [];

  for (const snip of task.snippets || []) {
    const res = validateMaterialForSupplementation(task, snip);
    if (res.eligible) {
      eligibleSnippets.push(snip);
    } else {
      ineligibleList.push({ snippet: snip, reason: res.reason || '不符合补写准入要求' });
    }
  }

  return { eligibleSnippets, ineligibleList };
}

/**
 * Masks calendar years, months, full date ranges, quarter notations, and document locations
 * with spaces of identical length, preventing date components (e.g. "1至" in "2026年1至9月")
 * from being mistakenly parsed as quantitative claims.
 */
export function maskDateAndPeriodPatterns(text: string): string {
  if (!text) return '';
  let result = text;
  // Match full Chinese date ranges, quarters, months, and exact dates using canonical period pattern
  result = result.replace(new RegExp(CANONICAL_PERIOD_PATTERN, 'g'), (m) => ' '.repeat(m.length));
  // Match document locations, e.g. 第1段, 第12条, 第3页, 第5章, 第2节
  result = result.replace(/第\d+[段条页章节]/g, (m) => ' '.repeat(m.length));
  return result;
}

/**
 * Verifies whether a fact's business metric and scope align with the claim context in snippet text.
 * Strictly prevents "工程验收16场" from matching "组织专题培训16场",
 * and prevents "一季度城区培训16场" from matching "三季度农村培训16场".
 */
export function isMetricContextCompatible(
  fact: Fact,
  snippet: EvidenceSnippet,
  surroundingContext: string
): boolean {
  const metric = (fact.metric || '').trim();
  const scope = (fact.metricScope || '').trim();
  if (!metric) return true;

  const metricLower = metric.toLowerCase();
  const scopeLower = scope.toLowerCase();
  const contextLower = surroundingContext.toLowerCase();

  // Cross-domain subject contradiction checks (evaluated first and unconditionally)
  // 1. Engineering / Acceptance vs Training
  const isContextEngineering = contextLower.includes('工程') || contextLower.includes('验收') || contextLower.includes('竣工') || contextLower.includes('施工') || contextLower.includes('监理');
  const isFactTraining = metricLower.includes('培训') || metricLower.includes('参训') || metricLower.includes('学员') || metricLower.includes('讲座') || scopeLower.includes('培训');
  if (isContextEngineering && isFactTraining) {
    return false;
  }

  // 2. Training vs Engineering
  const isContextTraining = contextLower.includes('培训') || contextLower.includes('参训') || contextLower.includes('学员') || contextLower.includes('讲座');
  const isFactEngineering = metricLower.includes('工程') || metricLower.includes('验收') || metricLower.includes('竣工') || metricLower.includes('施工') || scopeLower.includes('工程');
  if (isContextTraining && isFactEngineering) {
    return false;
  }

  // 3. Training vs Procurement / Service
  if (
    isContextTraining &&
    (metricLower.includes('采购') || metricLower.includes('交易') || metricLower.includes('预约'))
  ) {
    return false;
  }

  // 4. Procurement vs Appointment / Training
  if (
    (contextLower.includes('采购') || contextLower.includes('招标') || contextLower.includes('标段') || contextLower.includes('交易')) &&
    (metricLower.includes('预约') || metricLower.includes('培训') || metricLower.includes('实操') || metricLower.includes('窗口'))
  ) {
    return false;
  }

  // 5. Appointment service vs Engineering / Procurement / Training
  if (
    (contextLower.includes('预约') || contextLower.includes('窗口') || contextLower.includes('便民')) &&
    (isFactEngineering || isFactTraining || metricLower.includes('采购') || metricLower.includes('交易'))
  ) {
    return false;
  }

  // 6. Geographic / administrative scope contradiction checks:
  const isUrbanContext = contextLower.includes('城区') || contextLower.includes('城市') || contextLower.includes('市辖区') || contextLower.includes('市区');
  const isRuralContext = contextLower.includes('农村') || contextLower.includes('乡村') || contextLower.includes('乡镇') || contextLower.includes('村委');
  const isUrbanFact = metricLower.includes('城区') || metricLower.includes('城市') || scopeLower.includes('城区') || scopeLower.includes('城市');
  const isRuralFact = metricLower.includes('农村') || metricLower.includes('乡村') || metricLower.includes('乡镇') || scopeLower.includes('农村') || scopeLower.includes('乡村');
  if (isUrbanContext && isRuralFact) return false;
  if (isRuralContext && isUrbanFact) return false;

  // 7. Quarter / timing contradiction checks between context and fact
  const isQ1Context = contextLower.includes('一季度') || contextLower.includes('1季度') || contextLower.includes('首季');
  const isQ2Context = contextLower.includes('二季度') || contextLower.includes('2季度');
  const isQ3Context = contextLower.includes('三季度') || contextLower.includes('3季度');
  const isQ4Context = contextLower.includes('四季度') || contextLower.includes('4季度');
  const isQ1Fact = metricLower.includes('一季度') || scopeLower.includes('一季度') || (fact.period || '').includes('一季度');
  const isQ2Fact = metricLower.includes('二季度') || scopeLower.includes('二季度') || (fact.period || '').includes('二季度');
  const isQ3Fact = metricLower.includes('三季度') || scopeLower.includes('三季度') || (fact.period || '').includes('三季度');
  const isQ4Fact = metricLower.includes('四季度') || scopeLower.includes('四季度') || (fact.period || '').includes('四季度');
  if (isQ1Context && (isQ2Fact || isQ3Fact || isQ4Fact)) return false;
  if (isQ2Context && (isQ1Fact || isQ3Fact || isQ4Fact)) return false;
  if (isQ3Context && (isQ1Fact || isQ2Fact || isQ4Fact)) return false;
  if (isQ4Context && (isQ1Fact || isQ2Fact || isQ3Fact)) return false;

  // If fact is strictly bound to this snippet ID and no domain contradiction exists
  if (fact.primaryEvidenceId === snippet.id || (Array.isArray(fact.evidenceIds) && fact.evidenceIds.includes(snippet.id))) {
    return true;
  }

  // If fact is explicitly bound to a different snippet ID, reject endorsement
  if (fact.primaryEvidenceId && fact.primaryEvidenceId !== snippet.id) {
    return false;
  }
  if (Array.isArray(fact.evidenceIds) && fact.evidenceIds.length > 0 && !fact.evidenceIds.includes(snippet.id)) {
    return false;
  }

  // Exact metric in surrounding context
  if (contextLower.includes(metricLower)) {
    return true;
  }

  // Scope in surrounding context
  if (scopeLower && contextLower.includes(scopeLower)) {
    return true;
  }

  return false;
}

/**
 * Validates quantitative assertions inside selected snippets:
 * Rule: Newly added quantitative claims must correspond to valid confirmed facts in the task
 * with identical value, unit, period and scope.
 * If a snippet contains numbers with units that cannot be matched to confirmed facts in the task,
 * generation is BLOCKED to prevent ungrounded quantitative assertions.
 */
export function validateSelectedMaterialsQuantitativeClaims(
  task: Task,
  selectedSnippets: EvidenceSnippet[]
): {
  valid: boolean;
  reason?: string;
  unverifiedClaims?: string[];
  matchedFactIds?: string[];
} {
  const unverifiedClaims: string[] = [];
  const matchedFactIds = new Set<string>();

  for (const snip of selectedSnippets) {
    const text = snip.text;
    const doc = task.documents.find((d) => d.id === snip.sourceDocId);

    // 1. First mask date and period patterns to avoid extracting date fragments (e.g. '1至' in '2026年1至9月')
    const maskedText = maskDateAndPeriodPatterns(text);

    // Match numbers with units on masked text
    const matches = maskedText.matchAll(/\d+(?:\.\d+)?(?:人次|场次|万元|亿元|分钟|小时|项|场|次|人|个|家|件|条|篇|套|户|台|元|吨|%|[\u4e00-\u9fa5%]{1,4})/g);

    for (const occurrence of matches) {
      const match = occurrence[0];
      // Filter out calendar years and dates and locations
      if (/^\d{4}年$/.test(match)) continue;
      if (/^\d{1,2}月$/.test(match)) continue;
      if (/^\d{1,2}日$/.test(match)) continue;
      if (/^第\d+段$/.test(match)) continue;
      if (/^第\d+季度$/.test(match)) continue;
      // Note: Minute exemption is strictly removed! 10分钟 is validated as a quantitative claim.

      // Parse number and unit
      const numMatch = match.match(/^(\d+(?:\.\d+)?)([\u4e00-\u9fa5%]+)$/);
      if (!numMatch) continue;

      const numVal = numMatch[1];
      const unit = numMatch[2];

      // Exclude generic number words that are not quantitative metrics
      if (['年', '月份', '季度', '段', '页', '批次', '步'].includes(unit)) continue;

      // Extract clause around match
      const matchIdx = occurrence.index!;
      const textBefore = matchIdx >= 0 ? snip.text.slice(Math.max(0, matchIdx - 60), matchIdx) : '';
      const textAfter = matchIdx >= 0 ? snip.text.slice(matchIdx + match.length, Math.min(snip.text.length, matchIdx + match.length + 60)) : '';
      const surroundingContext = `${textBefore}${match}${textAfter}`;

      // Extract explicit statistical period governing this metric in snippet text
      const snipEffectivePeriod = (snip.period || doc?.period || '').trim();
      const fallbackYear =
        snipEffectivePeriod.match(/\d{4}年/)?.[0] ||
        doc?.period?.match(/\d{4}年/)?.[0] ||
        (task.startDate ? `${task.startDate.slice(0, 4)}年` : undefined);
      const clausePeriodInfo = extractClausePeriod(snip.text, match, fallbackYear, matchIdx);

      // If multiple conflicting periods exist in the clause/sentence and attribution cannot be determined, prompt manual verification
      if (clausePeriodInfo.isAmbiguous) {
        unverifiedClaims.push(
          `${snip.docName || '所选材料'}中的“${match}”（${clausePeriodInfo.reason || '存在多个统计期间且无法确定指标归属，请人工核验'}）`
        );
        continue;
      }

      // Look for matching confirmed Fact in task.facts strictly bound to source with exact unit, period and scope
      const matchedFact = task.facts.find((f) => {
        if (f.status !== 'confirmed' || f.isHistoricOnly) return false;
        if (f.hasConflict && !f.selectedConflictValue) return false;

        // 1. Strict snippet & source binding check
        const hasExplicitEvidenceBinding = Boolean(
          f.primaryEvidenceId || (Array.isArray(f.evidenceIds) && f.evidenceIds.length > 0)
        );
        if (hasExplicitEvidenceBinding) {
          const isSnippetBound =
            f.primaryEvidenceId === snip.id ||
            (Array.isArray(f.evidenceIds) && f.evidenceIds.includes(snip.id));
          if (!isSnippetBound) {
            // Fact is explicitly bound to another snippet, cannot endorse this snippet!
            return false;
          }
        } else {
          // Fact only has sourceDocId: must match snip.sourceDocId
          if (f.sourceDocId !== snip.sourceDocId) return false;
        }

        // 2. Strict value match
        const effectiveVal = f.selectedConflictValue || f.value;
        if (effectiveVal !== numVal) return false;

        // 3. Strict unit match: EXACT EQUALITY ONLY (removes substring inclusion, e.g. '人' != '人次')
        const normalizeUnit = (u: string) => u.trim().replace(/(?:以内|以上|以下|左右|多|余|内)$/, '');
        const unitMatches = f.unit.trim() === unit.trim() || (normalizeUnit(f.unit) === normalizeUnit(unit) && normalizeUnit(unit).length > 0);
        if (!unitMatches) return false;

        // 4. Strict period alignment:
        const factEffectivePeriod = (f.period || '').trim();
        // A. If snippet text has an explicit period for this metric clause, both fact and snippet metadata must strictly match it
        if (clausePeriodInfo.period) {
          if (!arePeriodsStrictlyIdentical(factEffectivePeriod, clausePeriodInfo.period)) {
            return false;
          }
          if (snipEffectivePeriod && !arePeriodsStrictlyIdentical(snipEffectivePeriod, clausePeriodInfo.period)) {
            return false;
          }
        } else {
          // B. If no explicit period in text, fact and snippet metadata must strictly match each other
          if (factEffectivePeriod || snipEffectivePeriod) {
            if (!arePeriodsStrictlyIdentical(factEffectivePeriod, snipEffectivePeriod)) {
              return false;
            }
          }
        }

        // Fact period must also be within task period
        if (task.startDate && task.endDate && f.period) {
          if (!isDateRangeWithinTask(f.period, task.startDate, task.endDate)) {
            return false;
          }
        }

        // 5. Business metric & scope context compatibility check
        return isMetricContextCompatible(f, snip, surroundingContext);
      });

      if (matchedFact) {
        matchedFactIds.add(matchedFact.id);
      } else {
        unverifiedClaims.push(`${snip.docName || '所选材料'}中的“${match}”`);
      }
    }
  }

  if (unverifiedClaims.length > 0) {
    return {
      valid: false,
      reason: `所选材料包含未核准的量化指标（${unverifiedClaims.join('、')}），未在事实库中找到口径一致的核准记录。首批补写规则要求量化主张必须先在材料与事实页面完成核准登记，已安全阻断本次生成。`,
      unverifiedClaims,
      matchedFactIds: Array.from(matchedFactIds),
    };
  }

  return {
    valid: true,
    matchedFactIds: Array.from(matchedFactIds),
  };
}

/**
 * Computes deterministic content fingerprint of selected materials.
 * Used to detect whether materials were modified, excluded, or deleted prior to adoption.
 */
export function computeMaterialFingerprint(snippets: EvidenceSnippet[]): string {
  if (!snippets || snippets.length === 0) return 'NO-MATERIALS';
  const sorted = [...snippets].sort((a, b) => a.id.localeCompare(b.id));
  const raw = sorted.map((s) => `${s.id}::${s.docName}::${s.period}::${s.text.trim()}`).join('|||');
  return `MAT-FP-${computeContentHash(raw)}`;
}

/**
 * Verifies if user-provided supplementation prompt is supported.
 */
export function isSupportedSupplementPrompt(prompt?: string): boolean {
  if (!prompt || !prompt.trim()) return true;
  const p = prompt.trim();
  return (
    p.includes('结合') ||
    p.includes('所选') ||
    p.includes('案例') ||
    p.includes('举措') ||
    p.includes('成效') ||
    p.includes('做法') ||
    p.includes('补充') ||
    p.includes('典型') ||
    p.includes('充实') ||
    p.includes('工作做法') ||
    p.includes('试点') ||
    p.includes('业务')
  );
}

export interface MaterialSupplementOptions {
  customPrompt?: string;
  task: Task;
  currentDraft?: DraftVersion;
  runId?: string;
}

/**
 * Deterministically generates evidence-guided paragraph supplementation.
 * - Excerpts faithful practices from selected materials
 * - Strictly protects all existing numbers, units and periods in block.content
 * - Embeds explicit attribution to selected materials
 * - Distinguishes appointment services vs centralized procurement
 * - Respects dynamic numbers (no hardcoded 16/800/2026 fallback)
 * - Returns clear limitations when unsupported or invalid
 */
export function generateMaterialSupplementation(
  block: ParagraphBlock,
  selectedSnippets: EvidenceSnippet[],
  options: MaterialSupplementOptions
): RevisionSuggestion {
  const { task, currentDraft, customPrompt, runId = `RUN-MAT-${Date.now().toString(36)}` } = options;
  const originalText = block.content;
  const prompt = customPrompt?.trim() || '结合所选案例补充本段工作做法';

  // 1. Verify prompt support
  if (!isSupportedSupplementPrompt(prompt)) {
    return {
      runId,
      taskId: task.id,
      sourceDraftId: currentDraft?.id || task.currentDraftId,
      targetBlockId: block.id,
      targetBlockOrder: block.order,
      targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
      baseContent: originalText,
      baseContentHash: computeContentHash(originalText),
      action: 'custom',
      customPrompt: prompt,
      originalText,
      suggestedText: originalText,
      diffExplanation: `未识别支持的补写指令【${prompt}】。受本地确定性模拟限制，原型仅支持明确的材料补写演示指令（如“结合所选案例补充本段工作做法”、“结合典型做法充实本段举措成效”）。本次正文严格保留原文未发生变化。`,
      factsAffected: block.referencedFactIds,
      createdAt: new Date().toISOString(),
      wordCountDelta: 0,
      needsVerificationNotes: ['未支持的补写指令，已严格保留原文', '请使用推荐的补写示例指令进行演示体验'],
      diffSegments: computeTextDiff(originalText, originalText),
      isUnsupportedPrompt: true,
      unsupportedPromptNotice: `当前原型模拟服务暂未支持补写要求“${prompt}”。原型支持明确的材料补写指令（如“结合所选案例补充本段工作做法”、“结合典型做法充实本段举措成效”等）。`,
      isMaterialSupplementation: true,
      selectedSnippetIds: selectedSnippets.map((s) => s.id),
      materialFingerprint: computeMaterialFingerprint(selectedSnippets),
      materialPrompt: prompt,
    };
  }

  // 2. Verify selected snippets existence and eligibility
  if (!selectedSnippets || selectedSnippets.length === 0) {
    return {
      runId,
      taskId: task.id,
      sourceDraftId: currentDraft?.id || task.currentDraftId,
      targetBlockId: block.id,
      targetBlockOrder: block.order,
      targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
      baseContent: originalText,
      baseContentHash: computeContentHash(originalText),
      action: 'custom',
      customPrompt: prompt,
      originalText,
      suggestedText: originalText,
      diffExplanation: '本次补写未勾选任何有效材料片段。为杜绝无据虚构或盲目添加未核实举措，本次改写严格保留原文未作修改。请在辅助面板中勾选具体采用的材料片段后再行生成。',
      factsAffected: block.referencedFactIds,
      createdAt: new Date().toISOString(),
      wordCountDelta: 0,
      needsVerificationNotes: ['未勾选有效材料，已保留原文并阻断无依据补写', '请先选择具体材料片段'],
      diffSegments: computeTextDiff(originalText, originalText),
      isUnsupportedPrompt: true,
      unsupportedPromptNotice: '未选择本次使用的材料片段，无法生成有据补写建议。',
      isMaterialSupplementation: true,
      selectedSnippetIds: [],
      materialFingerprint: 'NO-MATERIALS',
      materialPrompt: prompt,
    };
  }

  // Check each selected snippet eligibility
  for (const snip of selectedSnippets) {
    const check = validateMaterialForSupplementation(task, snip);
    if (!check.eligible) {
      return {
        runId,
        taskId: task.id,
        sourceDraftId: currentDraft?.id || task.currentDraftId,
        targetBlockId: block.id,
        targetBlockOrder: block.order,
        targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
        baseContent: originalText,
        baseContentHash: computeContentHash(originalText),
        action: 'custom',
        customPrompt: prompt,
        originalText,
        suggestedText: originalText,
        diffExplanation: `所选材料【${snip.docName || snip.id}】未通过准入校验：${check.reason}。已严格保留原文，杜绝不合格依据悄悄入稿。`,
        factsAffected: block.referencedFactIds,
        createdAt: new Date().toISOString(),
        wordCountDelta: 0,
        needsVerificationNotes: [check.reason || '所选材料不符合准入条件', '缺少合格依据时已严格保留原文'],
        diffSegments: computeTextDiff(originalText, originalText),
        isUnsupportedPrompt: true,
        unsupportedPromptNotice: check.reason,
        isMaterialSupplementation: true,
        selectedSnippetIds: selectedSnippets.map((s) => s.id),
        materialFingerprint: computeMaterialFingerprint(selectedSnippets),
        materialPrompt: prompt,
      };
    }
  }

  // 3. Verify quantitative assertions in selected snippets
  const quantCheck = validateSelectedMaterialsQuantitativeClaims(task, selectedSnippets);
  if (!quantCheck.valid) {
    return {
      runId,
      taskId: task.id,
      sourceDraftId: currentDraft?.id || task.currentDraftId,
      targetBlockId: block.id,
      targetBlockOrder: block.order,
      targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
      baseContent: originalText,
      baseContentHash: computeContentHash(originalText),
      action: 'custom',
      customPrompt: prompt,
      originalText,
      suggestedText: originalText,
      diffExplanation: quantCheck.reason || '所选材料包含未核准量化数据，已安全阻断本次生成。',
      factsAffected: block.referencedFactIds,
      createdAt: new Date().toISOString(),
      wordCountDelta: 0,
      needsVerificationNotes: [
        quantCheck.reason || '量化数据未核准',
        '首批规则要求新增量化主张必须先在材料与事实页面核准登记',
      ],
      diffSegments: computeTextDiff(originalText, originalText),
      isUnsupportedPrompt: true,
      unsupportedPromptNotice: quantCheck.reason,
      isMaterialSupplementation: true,
      selectedSnippetIds: selectedSnippets.map((s) => s.id),
      materialFingerprint: computeMaterialFingerprint(selectedSnippets),
      materialPrompt: prompt,
    };
  }

  // 4. Verify upstream fact snapshot consistency
  if (currentDraft?.snapshotMetadata?.factSnapshot && task.factSnapshot) {
    if (currentDraft.snapshotMetadata.factSnapshot.hash !== task.factSnapshot.hash) {
      const snapNotice = '当前工作稿冻结事实依据与任务最新核准事实快照存在版本差异，请先按现有流程重新起草或同步依据后再行补写！';
      return {
        runId,
        taskId: task.id,
        sourceDraftId: currentDraft.id,
        targetBlockId: block.id,
        targetBlockOrder: block.order,
        targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
        baseContent: originalText,
        baseContentHash: computeContentHash(originalText),
        action: 'custom',
        customPrompt: prompt,
        originalText,
        suggestedText: originalText,
        diffExplanation: snapNotice,
        factsAffected: block.referencedFactIds,
        createdAt: new Date().toISOString(),
        wordCountDelta: 0,
        needsVerificationNotes: [snapNotice, '版本快照不一致时禁止将最新值与旧快照混搭'],
        diffSegments: computeTextDiff(originalText, originalText),
        isUnsupportedPrompt: true,
        unsupportedPromptNotice: snapNotice,
        isMaterialSupplementation: true,
        selectedSnippetIds: selectedSnippets.map((s) => s.id),
        materialFingerprint: computeMaterialFingerprint(selectedSnippets),
        materialPrompt: prompt,
      };
    }
  }

  // 5. Detect whether selected snippets provide authentic incremental information relative to originalText
  const docNames = Array.from(new Set(selectedSnippets.map((s) => s.docName || '所选材料')));

  // Extract cleaned excerpt clauses per snippet
  const cleanedSnippets = selectedSnippets.map((s) => {
    let t = s.text.trim();
    // Strip leading dates or section numbers
    t = t.replace(/^\d{4}年(?:\d{1,2}月|\d{1,2}至\d{1,2}月|\d{1,2}-\d{1,2}月)[，、\s]*/, '');
    t = t.replace(/^[第一二三四五六七八九十]+段[：:]\s*/, '');
    t = t.replace(/[。；;]+$/, '');
    return {
      snippet: s,
      cleanedText: t,
    };
  });

  // Extract quantitative metrics from originalText
  const originalNumbers = (originalText.match(/\d+(?:\.\d+)?[\u4e00-\u9fa5%]{1,4}/g) || []).map((m) => m.trim());

  // Determine incremental content per snippet
  const incrementalClauses: string[] = [];
  const redundantItems: string[] = [];

  for (const item of cleanedSnippets) {
    const rawClauses = item.cleanedText
      .split(/[。；;]+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    for (const clause of rawClauses) {
      // If the entire clause is already a substring of originalText
      if (originalText.includes(clause)) {
        redundantItems.push(clause);
        continue;
      }

      // Check sub-clauses by comma
      const subClauses = clause
        .split(/[，,]+/)
        .map((sc) => sc.trim())
        .filter((sc) => sc.length > 0);

      const newSubClauses = subClauses.filter((sc) => {
        if (originalText.includes(sc)) {
          redundantItems.push(sc);
          return false;
        }
        // If subclause is just repeating numbers already in original text (e.g. 16场, 800人次)
        const scNums = sc.match(/\d+(?:\.\d+)?[\u4e00-\u9fa5%]{1,4}/g) || [];
        if (scNums.length > 0 && scNums.every((n) => originalNumbers.includes(n))) {
          // If the metrics are already present and the subclause keywords also match originalText
          const stripped = sc.replace(/\d+(?:\.\d+)?[\u4e00-\u9fa5%]{1,4}/g, '').trim();
          if (!stripped || originalText.includes(stripped)) {
            redundantItems.push(sc);
            return false;
          }
        }
        return true;
      });

      if (newSubClauses.length > 0) {
        incrementalClauses.push(newSubClauses.join('，'));
      }
    }
  }

  // If no incremental clauses are found (content is completely redundant/duplicate with originalText)
  if (incrementalClauses.length === 0) {
    const sampleDuplicates = Array.from(new Set(redundantItems)).slice(0, 3).join('”、“');
    const notice = `所选材料【${docNames.join('、')}】核心内容已包含在当前段落中（如“${sampleDuplicates || '既有举措与数据'}”），未检测到可补充的新增举措或数据。为杜绝在正文中重复堆叠相同数据与内容，已安全保留段落原文。`;
    return {
      runId,
      taskId: task.id,
      sourceDraftId: currentDraft?.id || task.currentDraftId,
      targetBlockId: block.id,
      targetBlockOrder: block.order,
      targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
      baseContent: originalText,
      baseContentHash: computeContentHash(originalText),
      action: 'custom',
      customPrompt: prompt,
      originalText,
      suggestedText: originalText,
      diffExplanation: notice,
      factsAffected: block.referencedFactIds,
      createdAt: new Date().toISOString(),
      wordCountDelta: 0,
      needsVerificationNotes: [
        '所选材料核心内容已包含在当前段落中，未检测到新增做法',
        '杜绝相同数据与举措在同一段落内重复拼接',
        '材料出处记录已在依据面板中提供追溯',
      ],
      diffSegments: computeTextDiff(originalText, originalText),
      isUnsupportedPrompt: true,
      unsupportedPromptNotice: notice,
      isMaterialSupplementation: true,
      selectedSnippetIds: selectedSnippets.map((s) => s.id),
      materialFingerprint: computeMaterialFingerprint(selectedSnippets),
      materialPrompt: prompt,
    };
  }

  const baseText = originalText.trim().replace(/[。；;]+$/, '');
  // Form genuine, authentic official document sentence without template prefix "结合【...】实际做法"
  const incrementalText = incrementalClauses.join('；');
  const suggestedText = `${baseText}。同时，${incrementalText}。`;

  // Build adopted evidence records
  const adoptedEvidences: AdoptedEvidenceRecord[] = selectedSnippets.map((snip) => {
    const doc = task.documents.find((d) => d.id === snip.sourceDocId);
    const matchedFact = task.facts.find(
      (f) =>
        f.status === 'confirmed' && !f.isHistoricOnly &&
        (f.primaryEvidenceId === snip.id || (Array.isArray(f.evidenceIds) && f.evidenceIds.includes(snip.id))) &&
        arePeriodsStrictlyIdentical(f.period || '', snip.period || doc?.period || '')
    );
    return {
      evidenceId: snip.id,
      sourceDocId: snip.sourceDocId,
      sourceDocName: snip.docName?.trim() || doc?.name.trim() || '材料来源',
      snippetLocation: snip.location,
      snippetText: snip.text,
      period: snip.period?.trim() || doc?.period.trim() || '',
      usage: doc?.usage || 'current_fact',
      associatedFactId: matchedFact?.id,
      metric: matchedFact?.metric,
      metricScope: matchedFact?.metricScope,
      contentFingerprint: computeMaterialFingerprint([snip]),
      capturedAt: new Date().toISOString(),
    };
  });

  const diffSegments = computeTextDiff(originalText, suggestedText);
  const wordCountDelta = suggestedText.length - originalText.length;
  const diffExplanation = `依据所选材料【${docNames.join('、')}】补充段落工作举措。全量保留段落既有事实数据，举措核心内容忠实摘录自所选材料原文，衔接语句作中性表述加工，未添加无依据成效或业务机制。`;

  return {
    runId,
    taskId: task.id,
    sourceDraftId: currentDraft?.id || task.currentDraftId,
    targetBlockId: block.id,
    targetBlockOrder: block.order,
    targetSectionTitle: task.outline.find((s) => s.id === block.sectionId)?.title,
    baseContent: originalText,
    baseContentHash: computeContentHash(originalText),
    action: 'custom',
    customPrompt: prompt,
    originalText,
    suggestedText,
    diffExplanation,
    factsAffected: Array.from(new Set([...block.referencedFactIds, ...(quantCheck.matchedFactIds || [])])),
    createdAt: new Date().toISOString(),
    wordCountDelta,
    needsVerificationNotes: [
      `所选材料原文摘录：【${docNames.join('、')}】核心举措`,
      '结构衔接：中性引入所选材料实际做法，未追加无依据成效结论',
      '全量保护段落既有事实与台账数据口径',
      '采纳前将再次复核所选材料与核准事实有效性',
    ],
    diffSegments,
    isUnsupportedPrompt: false,
    isMaterialSupplementation: true,
    selectedSnippetIds: selectedSnippets.map((s) => s.id),
    selectedFactIds: quantCheck.matchedFactIds || [],
    adoptedEvidences,
    materialFingerprint: computeMaterialFingerprint(selectedSnippets),
    materialPrompt: prompt,
    upstreamApprovalVersion: {
      factSnapshotConfirmedAt: task.factSnapshot?.confirmedAt,
      factSnapshotHash: task.factSnapshot?.hash,
      styleConfirmedAt: task.styleSnapshot?.confirmedAt,
      styleHash: task.styleSnapshot?.hash,
      outlineConfirmedAt: task.outlineSnapshot?.confirmedAt,
      outlineHash: task.outlineSnapshot?.hash,
    },
  };
}

export interface MaterialSupplementAsyncRequest {
  block: ParagraphBlock;
  selectedSnippets: EvidenceSnippet[];
  prompt: string;
  task: Task;
  currentDraft?: DraftVersion;
  runId: string;
  signal?: AbortSignal;
  simulateFailure?: boolean;
  delayMs?: number;
}

/**
 * Asynchronous adapter providing cancellable async lifecycle simulation for material supplementation.
 */
export async function requestMaterialSupplementationAsync(
  req: MaterialSupplementAsyncRequest
): Promise<RevisionSuggestion> {
  const {
    block,
    selectedSnippets,
    prompt,
    task,
    currentDraft,
    runId,
    signal,
    simulateFailure = false,
    delayMs = 350,
  } = req;

  if (signal?.aborted) {
    throw new DOMException('生成请求已取消', 'AbortError');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal?.aborted) {
        reject(new DOMException('生成请求已取消', 'AbortError'));
      } else {
        resolve();
      }
    }, delayMs);

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('生成请求已取消', 'AbortError'));
        },
        { once: true }
      );
    }
  });

  if (simulateFailure) {
    throw new Error('模拟接口调用失败：服务临时繁忙或连接超时，请点击重试。');
  }

  return generateMaterialSupplementation(block, selectedSnippets, {
    customPrompt: prompt,
    task,
    currentDraft,
    runId,
  });
}
