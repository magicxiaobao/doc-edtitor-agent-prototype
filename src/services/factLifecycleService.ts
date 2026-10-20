import { Task, Fact, UserRole, EvidenceSnippet, SourceDocument, DraftVersion, FactItemSnapshot } from '../types';
import { checkPermission } from './permissionService';

/**
 * Canonical regular expression for extracting periods from Chinese text and 公文 metadata.
 * Ordered strictly from most specific (date ranges with days) to explicit full years.
 */
/**
 * Canonical regular expression pattern for extracting periods from Chinese text and 公文 metadata.
 * Ordered strictly from most specific (date ranges with days) to explicit full years.
 */
export const CANONICAL_PERIOD_PATTERN = [
  // 1. Full date ranges with days: e.g. "2026年4月15日至6月15日", "2026-04-15至2026-06-15", "2026年4月15日-6月15日"
  '\\d{4}年\\d{1,2}月\\d{1,2}日?\\s*(?:至|-|~|到)\\s*(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日?',
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\s*(?:至|-|~|到)\\s*(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2})',
  '\\d{1,2}月\\d{1,2}日?\\s*(?:至|-|~|到)\\s*\\d{1,2}月\\d{1,2}日?',
  // 2. Month ranges: e.g. "2026年1至9月", "2026年1-9月", "2025年11月至2026年3月", "1至9月", "2026年1月至9月"
  '\\d{4}年\\d{1,2}月?\\s*(?:至|-|~|到)\\s*(?:\\d{4}年)?\\d{1,2}月',
  '\\d{1,2}月?\\s*(?:至|-|~|到)\\s*\\d{1,2}月',
  // 3. Quarters: e.g. "2026年前三季度", "2026年1季度", "2026年一季度", "2026年第1季度", "2026年上半年", "2026年下半年"
  '(?:\\d{4}年)?前[3三]季度',
  '(?:\\d{4}年)?(?:上|下)半年',
  '(?:\\d{4}年)?(?:第)?[1234一二三四]季度',
  '(?:\\d{4})[-年]?[Qq][1-4]',
  // 4. Single exact dates: e.g. "2026年4月15日", "2026-04-15"
  '\\d{4}年\\d{1,2}月\\d{1,2}日',
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}',
  '\\d{1,2}月\\d{1,2}日',
  // 5. Single months: e.g. "2026年1月", "2026年10月份", "1月"
  '\\d{4}年\\d{1,2}月(?:份)?',
  '\\d{1,2}月(?:份)?',
  // 6. Explicit full years / annual: ONLY explicit full year formats
  '\\d{4}年(?:度|全年|年全年)',
  '\\d{4}年度',
  '\\d{4}全年',
  '\\d{4}年(?=[，,。；;、\\s]|$|中|期间)',
].join('|');

export const CANONICAL_PERIOD_REGEX = new RegExp(CANONICAL_PERIOD_PATTERN, 'g');

/**
 * Extracts and attributes the specific statistical period governing a quantitative claim inside text.
 * Returns the normalized period string, or marks isAmbiguous if multiple conflicting periods exist without clear attribution.
 */
export function extractClausePeriod(
  fullText: string,
  matchClause: string,
  fallbackYear?: string,
  matchIndex?: number
): { period: string | null; isAmbiguous: boolean; reason?: string } {
  if (!fullText) return { period: null, isAmbiguous: false };

  // Locate this occurrence, not the first equal number in another sentence.
  const offset = matchIndex ?? Math.max(0, fullText.indexOf(matchClause));
  const sentenceStart = Math.max(...['。', '；', ';', '\n'].map(c => fullText.lastIndexOf(c, offset - 1))) + 1;
  const tail = fullText.slice(offset).search(/[。；;\n]/);
  const sentenceEnd = tail < 0 ? fullText.length : offset + tail;
  const targetSentence = fullText.slice(sentenceStart, sentenceEnd);
  const relative = offset - sentenceStart;
  const clauseStart = Math.max(targetSentence.lastIndexOf('，', relative - 1), targetSentence.lastIndexOf(',', relative - 1)) + 1;
  const clauseTail = targetSentence.slice(relative).search(/[，,]/);
  const targetSubClause = targetSentence.slice(clauseStart, clauseTail < 0 ? undefined : relative + clauseTail);

  const matchPeriods = (text: string): string[] => {
    const re = new RegExp(CANONICAL_PERIOD_PATTERN, 'g');
    const matches = text.match(re) || [];
    return Array.from(new Set(matches.map((m) => m.trim())));
  };

  // 1. Check subclause matches first
  const subMatches = matchPeriods(targetSubClause);
  if (subMatches.length === 1) {
    return normalizeExtractedPeriod(subMatches[0], fallbackYear);
  }
  if (subMatches.length > 1) {
    return {
      period: null,
      isAmbiguous: true,
      reason: `指标【${matchClause}】所在分句包含多个统计期间（${subMatches.join('、')}），无法确定指标归属，请人工核验`,
    };
  }

  // 2. If subclause didn't have a period, check sentence
  const sentenceMatches = matchPeriods(targetSentence);
  if (sentenceMatches.length === 1) {
    return normalizeExtractedPeriod(sentenceMatches[0], fallbackYear);
  }
  if (sentenceMatches.length > 1) {
    return {
      period: null,
      isAmbiguous: true,
      reason: `指标【${matchClause}】所在语句包含多个统计期间（${sentenceMatches.join('、')}），无法确定指标归属，请人工核验`,
    };
  }

  // 3. Check full text (e.g. overarching period at beginning of snippet)
  const fullMatches = matchPeriods(fullText);
  if (fullMatches.length === 1) {
    return normalizeExtractedPeriod(fullMatches[0], fallbackYear);
  }
  if (fullMatches.length > 1) {
    return {
      period: null,
      isAmbiguous: true,
      reason: `材料正文包含多个统计期间（${fullMatches.join('、')}），无法确定指标【${matchClause}】归属，请人工核验`,
    };
  }

  return { period: null, isAmbiguous: false };
}

function normalizeExtractedPeriod(raw: string, fallbackYear?: string): { period: string; isAmbiguous: boolean } {
  if (/^\d{4}/.test(raw)) {
    return { period: raw, isAmbiguous: false };
  }
  if (fallbackYear) {
    const y = fallbackYear.match(/\d{4}/)?.[0];
    if (y) {
      return { period: `${y}年${raw}`, isAmbiguous: false };
    }
  }
  return { period: raw, isAmbiguous: false };
}

/**
 * Helper to construct and validate strict UTC date range without rollover.
 * Validates month 1-12, days in month, and ensures start <= end.
 */
function createValidDateRange(
  sYear: number,
  sMonth: number, // 1-12
  sDay: number,
  eYear: number,
  eMonth: number, // 1-12
  eDay: number
): { start: Date; end: Date } | null {
  if (sMonth < 1 || sMonth > 12 || eMonth < 1 || eMonth > 12) return null;
  if (sDay < 1 || sDay > 31 || eDay < 1 || eDay > 31) return null;

  const start = new Date(Date.UTC(sYear, sMonth - 1, sDay, 0, 0, 0));
  const end = new Date(Date.UTC(eYear, eMonth - 1, eDay, 23, 59, 59));

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  if (start.getTime() > end.getTime()) return null;

  // Strict calendar validity: ensure no rollover occurred (e.g., Feb 30 -> Mar 2)
  if (
    start.getUTCFullYear() !== sYear ||
    start.getUTCMonth() !== sMonth - 1 ||
    start.getUTCDate() !== sDay ||
    end.getUTCFullYear() !== eYear ||
    end.getUTCMonth() !== eMonth - 1 ||
    end.getUTCDate() !== eDay
  ) {
    return null;
  }

  return { start, end };
}

function getLastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses a Chinese period string into a structured start and end Date.
 * Supports: "2026年1至9月", "2026年1-9月", "2026年前三季度", "2026年上半年",
 * "2026年一季度", "2026年1季度", "2026年10月", "2026年1月", "2025年", "2026年4月15日至6月15日", etc.
 * ONLY explicit annual formats ("2026年", "2026年度", "2026全年", "2026年全年") parse as full year.
 * Unknown or unparseable formats return null (never fall back to full year!).
 */
export function parsePeriodDateRange(periodStr: string): { start: Date; end: Date } | null {
  if (!periodStr) return null;
  const p = periodStr.trim();
  if (!p) return null;

  // 1. ISO/Dash date format with exact days: e.g. "2026-04-15至2026-06-15"
  const isoRangeMatch = p.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:至|-|~|到)\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoRangeMatch) {
    const sYear = parseInt(isoRangeMatch[1], 10);
    const sM = parseInt(isoRangeMatch[2], 10);
    const sD = parseInt(isoRangeMatch[3], 10);
    const eYear = parseInt(isoRangeMatch[4], 10);
    const eM = parseInt(isoRangeMatch[5], 10);
    const eD = parseInt(isoRangeMatch[6], 10);
    return createValidDateRange(sYear, sM, sD, eYear, eM, eD);
  }

  // 1b. Single ISO/Dash date: e.g. "2026-04-15"
  const isoSingleMatch = p.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoSingleMatch) {
    const sYear = parseInt(isoSingleMatch[1], 10);
    const sM = parseInt(isoSingleMatch[2], 10);
    const sD = parseInt(isoSingleMatch[3], 10);
    return createValidDateRange(sYear, sM, sD, sYear, sM, sD);
  }

  // 2. Exact Chinese date ranges with days: e.g. "2026年4月15日至6月15日", "2026年4月15日至2026年6月15日"
  const exactDateRangeMatch = p.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(?:至|-|~|到)\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?$/);
  if (exactDateRangeMatch) {
    const sYear = parseInt(exactDateRangeMatch[1], 10);
    const sM = parseInt(exactDateRangeMatch[2], 10);
    const sD = parseInt(exactDateRangeMatch[3], 10);
    const eYear = exactDateRangeMatch[4] ? parseInt(exactDateRangeMatch[4], 10) : sYear;
    const eM = parseInt(exactDateRangeMatch[5], 10);
    const eD = parseInt(exactDateRangeMatch[6], 10);
    return createValidDateRange(sYear, sM, sD, eYear, eM, eD);
  }

  // 3. Cross-year month ranges: e.g. "2025年11月至2026年3月"
  const crossYearMonthMatch = p.match(/^(\d{4})年(\d{1,2})月?\s*(?:至|-|~|到)\s*(\d{4})年(\d{1,2})月?$/);
  if (crossYearMonthMatch) {
    const sYear = parseInt(crossYearMonthMatch[1], 10);
    const sM = parseInt(crossYearMonthMatch[2], 10);
    const eYear = parseInt(crossYearMonthMatch[3], 10);
    const eM = parseInt(crossYearMonthMatch[4], 10);
    return createValidDateRange(sYear, sM, 1, eYear, eM, getLastDayOfMonth(eYear, eM));
  }

  // 4. Same-year month ranges: e.g. "2026年1至9月", "2026年1-9月", "2026年1月至9月"
  const sameYearMonthMatch = p.match(/^(\d{4})年\s*(\d{1,2})月?\s*(?:至|-|~|到)\s*(\d{1,2})月?$/);
  if (sameYearMonthMatch) {
    const year = parseInt(sameYearMonthMatch[1], 10);
    const sM = parseInt(sameYearMonthMatch[2], 10);
    const eM = parseInt(sameYearMonthMatch[3], 10);
    return createValidDateRange(year, sM, 1, year, eM, getLastDayOfMonth(year, eM));
  }

  const yearMatch = p.match(/^(\d{4})/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);

  // Quarters and Halves (supports both Chinese numeral and Arabic numeral, with or without '第')
  if (/^(\d{4})年?前[3三]季度$/.test(p)) {
    return createValidDateRange(year, 1, 1, year, 9, 30);
  }
  if (/^(\d{4})年?上半年$/.test(p)) {
    return createValidDateRange(year, 1, 1, year, 6, 30);
  }
  if (/^(\d{4})年?下半年$/.test(p)) {
    return createValidDateRange(year, 7, 1, year, 12, 31);
  }
  if (/^(\d{4})年?(?:第)?[1一]季度$|^(\d{4})[-年]?[Qq]1$/.test(p)) {
    return createValidDateRange(year, 1, 1, year, 3, 31);
  }
  if (/^(\d{4})年?(?:第)?[2二]季度$|^(\d{4})[-年]?[Qq]2$/.test(p)) {
    return createValidDateRange(year, 4, 1, year, 6, 30);
  }
  if (/^(\d{4})年?(?:第)?[3三]季度$|^(\d{4})[-年]?[Qq]3$/.test(p)) {
    return createValidDateRange(year, 7, 1, year, 9, 30);
  }
  if (/^(\d{4})年?(?:第)?[4四]季度$|^(\d{4})[-年]?[Qq]4$/.test(p)) {
    return createValidDateRange(year, 10, 1, year, 12, 31);
  }

  // Single exact date: e.g. "2026年4月15日"
  const singleDateMatch = p.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (singleDateMatch) {
    const m = parseInt(singleDateMatch[2], 10);
    const d = parseInt(singleDateMatch[3], 10);
    return createValidDateRange(year, m, d, year, m, d);
  }

  // Single month: e.g. "2026年1月", "2026年10月"
  const singleMonthMatch = p.match(/^(\d{4})年(\d{1,2})月(?:份)?$/);
  if (singleMonthMatch) {
    const m = parseInt(singleMonthMatch[2], 10);
    return createValidDateRange(year, m, 1, year, m, getLastDayOfMonth(year, m));
  }

  // Full year or annual: ONLY explicit full year formats
  if (/^(\d{4})(?:年|年度|全年|年全年)$/.test(p)) {
    return createValidDateRange(year, 1, 1, year, 12, 31);
  }

  // Unknown or unparseable format returns null (never fall back to full year!)
  return null;
}

/**
 * Evaluates whether two period strings resolve to strictly identical date boundaries.
 * Enforces exact equivalence (e.g. "2026年一季度" === "2026年1至3月", "2026年前三季度" === "2026年1至9月"),
 * while strictly rejecting containment / inclusion (e.g. "2026年1至3月" vs "2026年1至9月"),
 * partial overlaps (e.g. "2026年1至4月" vs "2026年3至6月"), and disjoint ranges.
 * Both periods MUST be successfully parseable and produce legal calendar dates;
 * unparseable formats (e.g. "2026年待确认") or illegal dates return false.
 * Same unparseable strings are NEVER passed directly without successful date resolution.
 */
export function arePeriodsStrictlyIdentical(periodA?: string, periodB?: string): boolean {
  if (!periodA || !periodB) return false;
  const pA = periodA.trim();
  const pB = periodB.trim();
  if (!pA || !pB) return false;

  const rangeA = parsePeriodDateRange(pA);
  const rangeB = parsePeriodDateRange(pB);
  if (!rangeA || !rangeB) {
    return false;
  }
  if (
    isNaN(rangeA.start.getTime()) ||
    isNaN(rangeA.end.getTime()) ||
    isNaN(rangeB.start.getTime()) ||
    isNaN(rangeB.end.getTime()) ||
    rangeA.start.getTime() > rangeA.end.getTime() ||
    rangeB.start.getTime() > rangeB.end.getTime()
  ) {
    return false;
  }
  return rangeA.start.getTime() === rangeB.start.getTime() && rangeA.end.getTime() === rangeB.end.getTime();
}

/**
 * Validates whether a fact period falls within task statistical period.
 * Uses structured date ranges and explicit compatibility rules.
 */
export function isPeriodWithinTaskPeriod(
  factPeriod: string,
  taskStartDate: string,
  taskEndDate: string
): boolean {
  if (!factPeriod) return false;

  const factRange = parsePeriodDateRange(factPeriod);
  if (!factRange) return false;

  if (!taskStartDate || !taskEndDate) return true;

  const taskStart = new Date(taskStartDate + 'T00:00:00Z');
  const taskEnd = new Date(taskEndDate + 'T23:59:59Z');

  const tStartMs = taskStart.getTime() - 86400000; // 1-day tolerance
  const tEndMs = taskEnd.getTime() + 86400000;

  // 1. Fact interval cannot begin after task end date (e.g. 2026年10月 in Q1-Q3 task)
  if (factRange.start.getTime() > tEndMs) {
    return false;
  }

  // 2. Fact interval cannot end after task end date (e.g. 2026年10月 in Q1-Q3 task)
  if (factRange.end.getTime() > tEndMs) {
    return false;
  }

  // 3. Fact interval cannot begin before task start date (e.g. 2026年1至6月 in Q2-Q3 task, 2025年 in 2026 task)
  if (factRange.start.getTime() < tStartMs) {
    return false;
  }

  return true;
}

/**
 * Requirement 3: Creates a fact candidate.
 * - Retains creator role and source snippet.
 * - Contributor ('供稿丙') candidates MUST stay 'pending'.
 * - Non-existent evidence, historic style materials, or textless clues
 *   CANNOT be accepted as current quantitative facts just by passing an ID.
 */
function sourcePeriodError(factPeriod: string, snippet: EvidenceSnippet, doc: SourceDocument): string | undefined {
  const fact = parsePeriodDateRange(factPeriod);
  const evidence = parsePeriodDateRange(snippet.period);
  const source = parsePeriodDateRange(doc.period);
  if (!fact || !evidence || !source) return '事实、片段与来源材料须填写可识别的统计期间，请先核验出处';
  if (fact.start.getTime() !== evidence.start.getTime() || fact.end.getTime() !== evidence.end.getTime() || fact.start < source.start || fact.end > source.end) {
    return `事实期间【${factPeriod}】与原文片段【${snippet.period}】或来源材料【${doc.period}】不符，不能将跨期材料改标为本期事实`;
  }
  return undefined;
}

export function createFactCandidate(
  task: Task,
  factData: Omit<Fact, 'id' | 'status'>,
  authorRole: UserRole
): { success: boolean; error?: string; fact?: Fact } {
  // Permission check
  const perm = checkPermission(authorRole, 'supplement_fact');
  if (!perm.allowed) {
    return { success: false, error: perm.reason || '无权提交事实材料' };
  }

  // 1. Evidence Existence & Source Document Validation
  const snippet = task.snippets.find((s) => s.id === factData.primaryEvidenceId);
  if (!snippet && !factData.isAuthorSupplemented) {
    return {
      success: false,
      error: `依据片段【${factData.primaryEvidenceId}】在当前材料库中不存在，严禁仅凭虚构ID建立事实！`,
    };
  }

  // 2. Historic Style Material Isolation & RAG clue isolation
  if (snippet) {
    const sourceDoc = task.documents.find((d) => d.id === snippet.sourceDocId);
    if (!sourceDoc) {
      return {
        success: false,
        error: `片段【${snippet.id}】所属的来源文档不存在，严禁凭失效出处登记事实！`,
      };
    }
    const periodError = sourcePeriodError(factData.period, snippet, sourceDoc);
    if (periodError) return { success: false, error: periodError };
    if (sourceDoc.excluded || sourceDoc.usage === 'style_ref' || sourceDoc.usage === 'history_bg' || factData.isHistoricOnly) {
      return {
        success: false,
        error: `材料【${sourceDoc.name}】为历史文风参考材料（非本期履职数据），严禁转化为本期量化事实依据！`,
      };
    }
    if (sourceDoc.usage === 'rag_clue' || snippet.id === 'EVD-06' || /无原文|线索|摘要/.test(snippet.location)) {
      // Textless RAG clue cannot be confirmed as quantitative fact
      return {
        success: false,
        error: `【${sourceDoc.name}】仅为定性问答线索，无原文位置与量化指标，不可作为量化事实入库！`,
      };
    }
  }

  // 3. Period interval check
  if (!isPeriodWithinTaskPeriod(factData.period, task.startDate, task.endDate)) {
    return {
      success: false,
      error: `事实统计期间【${factData.period}】与本公文任务统计期间【${task.startDate} 至 ${task.endDate}】不符，属于跨期数据！`,
    };
  }

  const newFactId = `FACT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 100)}`;
  const newFact: Fact = {
    ...factData,
    id: newFactId,
    status: 'pending', // Requirement 3: 候选保持pending，待主笔核准
    createdByRole: authorRole,
  };

  return { success: true, fact: newFact };
}

/**
 * Requirement 3: Confirms a fact.
 * - Only '主笔甲' can confirm.
 * - Re-validates evidence source document, usage, period, and conflicts.
 * - Upstream confirmation invalidates downstream outline approvals!
 */
export function confirmFact(
  task: Task,
  factId: string,
  authorRole: UserRole
): { success: boolean; error?: string; updatedTask?: Task } {
  const perm = checkPermission(authorRole, 'confirm_facts');
  if (!perm.allowed) {
    return { success: false, error: perm.reason || '权限受限：仅主笔甲可审核确认事实依据' };
  }

  const fact = task.facts.find((f) => f.id === factId);
  if (!fact) {
    return { success: false, error: '未找到指定事实' };
  }

  if (fact.isHistoricOnly) {
    return { success: false, error: '历史参考数据不可确认为本期量化履职事实' };
  }

  if (fact.status === 'gap') {
    return { success: false, error: '资料缺口或仅答案线索在补齐正式量化出处前不可确认' };
  }

  if (fact.hasConflict && !fact.selectedConflictValue) {
    return { success: false, error: '存在未裁决的指标口径冲突，必须先裁决采信口径或明确排除' };
  }

  // Re-validate evidence snippet and source document
  if (fact.primaryEvidenceId && !fact.isAuthorSupplemented) {
    const snippet = task.snippets.find((s) => s.id === fact.primaryEvidenceId);
    if (!snippet) {
      return { success: false, error: `依据片段【${fact.primaryEvidenceId}】在材料库中不存在，无法确认！` };
    }
    const sourceDoc = task.documents.find((d) => d.id === snippet.sourceDocId);
    if (!sourceDoc) {
      return { success: false, error: `依据片段【${snippet.id}】所属来源文件不存在，严禁凭失效出处确认为事实！` };
    }
    const periodError = sourcePeriodError(fact.period, snippet, sourceDoc);
    if (periodError) return { success: false, error: periodError };
    if (sourceDoc.excluded || sourceDoc.usage === 'style_ref' || sourceDoc.usage === 'history_bg') {
      return { success: false, error: `来源材料【${sourceDoc.name}】为历史文风参考材料，严禁确认为本期量化履职事实！` };
    }
    if (sourceDoc.usage === 'rag_clue' || snippet.id === 'EVD-06' || /无原文|线索|摘要/.test(snippet.location)) {
      return { success: false, error: `【${sourceDoc.name}】仅为定性问答线索，无原文位置与量化指标，不可作为量化事实入库！` };
    }
  }

  // Re-validate period
  if (!isPeriodWithinTaskPeriod(fact.period, task.startDate, task.endDate)) {
    return {
      success: false,
      error: `事实统计期间【${fact.period}】与本公文任务统计期间【${task.startDate} 至 ${task.endDate}】不符，属于跨期数据！`,
    };
  }

  const updatedFacts = task.facts.map((f) => (f.id === factId ? { ...f, status: 'confirmed' as const } : f));

  // Requirement 3: 上游事实变更一致地使下游大纲审批失效
  const updatedTask: Task = {
    ...task,
    facts: updatedFacts,
    outlineConfirmed: false, // 事实变动使下游大纲失效
    factSnapshot: undefined, // 需重新生成并确认快照
    outlineSnapshot: undefined,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, updatedTask };
}

/**
 * Requirement 3: Modifies or excludes a fact and invalidates downstream approvals
 */
export function modifyOrExcludeFact(
  task: Task,
  factId: string,
  updates: Partial<Fact>,
  authorRole: UserRole
): { success: boolean; error?: string; updatedTask?: Task } {
  const perm = checkPermission(authorRole, 'confirm_facts');
  if (!perm.allowed) {
    return { success: false, error: perm.reason || '权限受限：仅主笔甲可维护事实状态' };
  }

  const updatedFacts = task.facts.map((f) => (f.id === factId ? { ...f, ...updates } : f));

  // Invalidate downstream approvals
  const updatedTask: Task = {
    ...task,
    facts: updatedFacts,
    outlineConfirmed: false, // 下游失效
    factSnapshot: undefined,
    outlineSnapshot: undefined,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, updatedTask };
}

/**
 * Returns a default human-readable period string aligned with task start and end dates.
 * Ensures the period stays strictly within task bounds (e.g. Q2 task defaults to "2026年4至6月").
 */
export function formatDefaultPeriodForTask(startDate?: string, endDate?: string): string {
  if (!startDate || !endDate) return '2026年1至9月';
  const sYear = parseInt(startDate.slice(0, 4), 10);
  const sMonth = parseInt(startDate.slice(5, 7), 10);
  const sDay = parseInt(startDate.slice(8, 10), 10) || 1;
  const eYear = parseInt(endDate.slice(0, 4), 10);
  const eMonth = parseInt(endDate.slice(5, 7), 10);
  const eDay = parseInt(endDate.slice(8, 10), 10) || 1;

  // Determine if it covers full calendar months (from 1st of start month to last day of end month)
  const lastDayOfEndMonth = new Date(Date.UTC(eYear, eMonth, 0)).getUTCDate();
  const isFullMonth = sDay === 1 && eDay === lastDayOfEndMonth;

  if (!isFullMonth) {
    // Preserve accurate start and end dates (e.g. 4月15日至6月15日, 跨年月中起止等)
    if (sYear === eYear) {
      return `${sYear}年${sMonth}月${sDay}日至${eMonth}月${eDay}日`;
    }
    return `${sYear}年${sMonth}月${sDay}日至${eYear}年${eMonth}月${eDay}日`;
  }

  if (sYear === eYear) {
    if (sMonth === 1 && eMonth === 12) return `${sYear}年度`;
    if (sMonth === 1 && eMonth === 3) return `${sYear}年一季度`;
    if (sMonth === 4 && eMonth === 6) return `${sYear}年二季度`;
    if (sMonth === 7 && eMonth === 9) return `${sYear}年三季度`;
    if (sMonth === 10 && eMonth === 12) return `${sYear}年四季度`;
    if (sMonth === 1 && eMonth === 6) return `${sYear}年上半年`;
    if (sMonth === 7 && eMonth === 12) return `${sYear}年下半年`;
    if (sMonth === 1 && eMonth === 9) return `${sYear}年1至9月`;
    if (sMonth === eMonth) return `${sYear}年${sMonth}月`;
    return `${sYear}年${sMonth}至${eMonth}月`;
  }
  return `${sYear}年${sMonth}月至${eYear}年${eMonth}月`;
}

export interface ResolvedDraftFactEvidence {
  fact: Fact;
  snapItem: FactItemSnapshot | null;
  isHistoricalOrFinal: boolean;
  hasFrozenItem: boolean;

  // Adopted / effective values for the draft being viewed
  adoptedValue: string;
  effectivePeriod: string;
  effectiveMetricScope: string;
  effectiveEvidenceId?: string;
  effectiveSnippet: EvidenceSnippet | null;
  effectiveDocName?: string;
  effectiveLocation?: string;

  // Task current latest confirmed values
  currentConfirmedValue: string;
  currentPeriod: string;
  currentMetricScope: string;
  currentEvidenceId?: string;
  currentSnippet: EvidenceSnippet | null;
  currentDocName?: string;
  currentLocation?: string;

  // Discrepancy checks
  hasSnapshotDiff: boolean;
  hasPeriodDiff: boolean;
  hasScopeDiff: boolean;
  hasEvidenceDiff: boolean;

  isEvidenceMissingInSnapshot: boolean;
  isEvidencePrunedOrUnavailable: boolean;
  isSnapshotMissingFact: boolean;
}

/**
 * P2: Shared evidence reading logic between DraftingStage sidebar and SnippetDrawer.
 * Unifies the resolution of statistical period, metric scope, and primary evidence ID
 * so historical drafts strictly display frozen values while latest values are explicitly labeled.
 */
export function findDraftFact(task: Task, draft: DraftVersion | undefined, id: string): Fact | undefined {
  const latest = task.facts.find(f => f.id === id);
  if (latest) return latest;
  const frozen = draft?.snapshotMetadata?.factSnapshot?.items?.find(f => f.factId === id);
  if (!frozen) return undefined;
  return { ...frozen, id, status: 'excluded', hasConflict: frozen.hasConflict || false,
    conflictCandidates: frozen.conflictCandidates?.map(c => ({...c, evidenceId:c.evidenceId || '', sourceDocId:''})),
    evidenceIds: frozen.primaryEvidenceId ? [frozen.primaryEvidenceId] : [], value: frozen.selectedConflictValue || frozen.value };
}

export function resolveDraftFactEvidence(
  fact: Fact,
  draft: DraftVersion | undefined,
  task: Task
): ResolvedDraftFactEvidence {
  const isHistoricalOrFinal = Boolean(draft?.isHistoricalSnapshot || draft?.isFinal);
  const snapItem = draft?.snapshotMetadata?.factSnapshot?.items?.find(
    (item) => item.factId === fact.id
  ) || null;
  const hasFrozenItem = Boolean(snapItem);

  const adoptedValue = snapItem
    ? `${snapItem.selectedConflictValue || snapItem.value} ${snapItem.unit}`
    : isHistoricalOrFinal
    ? '历史快照未收录此事实'
    : `${fact.selectedConflictValue || fact.value} ${fact.unit}`;

  const latestFact = task.facts.find(f => f.id === fact.id);
  const currentConfirmedValue = latestFact?.status === 'confirmed' ? `${latestFact.selectedConflictValue || latestFact.value} ${latestFact.unit}` : latestFact ? '当前未核准' : '任务中已删除此事实';

  const currentSnippet = latestFact ? task.snippets.find((s) => s.id === latestFact.primaryEvidenceId) || null : null;
  const currentDoc = currentSnippet ? task.documents.find((d) => d.id === currentSnippet.sourceDocId) : undefined;
  const currentDocName = currentSnippet?.docName || currentDoc?.name || '未知材料文档';
  const currentLocation = currentSnippet?.location || '段落索引';

  let effectivePeriod: string;
  let effectiveMetricScope: string;
  let effectiveEvidenceId: string | undefined;
  let effectiveSnippet: EvidenceSnippet | null = null;
  let isEvidenceMissingInSnapshot = false;
  let isEvidencePrunedOrUnavailable = false;

  if (isHistoricalOrFinal) {
    if (snapItem) {
      effectivePeriod = snapItem.period || '未记录期间';
      effectiveMetricScope = snapItem.metricScope || '无单独口径';
      effectiveEvidenceId = snapItem.primaryEvidenceId;
      if (effectiveEvidenceId) {
        effectiveSnippet = task.snippets.find((s) => s.id === effectiveEvidenceId) || null;
        if (!effectiveSnippet) {
          isEvidencePrunedOrUnavailable = true;
        }
      } else {
        isEvidenceMissingInSnapshot = true;
      }
    } else {
      effectivePeriod = '快照未记录';
      effectiveMetricScope = '快照未记录';
      effectiveEvidenceId = undefined;
      effectiveSnippet = null;
    }
  } else if (!latestFact && snapItem) {
    effectivePeriod = snapItem.period || '未记录期间';
    effectiveMetricScope = snapItem.metricScope || '无单独口径';
    effectiveEvidenceId = snapItem.primaryEvidenceId;
    effectiveSnippet = effectiveEvidenceId ? task.snippets.find(s => s.id === effectiveEvidenceId) || null : null;
    isEvidenceMissingInSnapshot = !effectiveEvidenceId;
    isEvidencePrunedOrUnavailable = Boolean(effectiveEvidenceId && !effectiveSnippet);
  } else {
    effectivePeriod = fact.period;
    effectiveMetricScope = fact.metricScope || '标准口径';
    effectiveEvidenceId = fact.primaryEvidenceId;
    effectiveSnippet = currentSnippet;
  }

  const effectiveDoc = effectiveSnippet ? task.documents.find((d) => d.id === effectiveSnippet.sourceDocId) : undefined;
  const effectiveDocName = effectiveSnippet?.docName || effectiveDoc?.name;
  const effectiveLocation = effectiveSnippet?.location || '段落索引';

  const hasSnapshotDiff = Boolean(
    snapItem && latestFact && (
      (snapItem.selectedConflictValue || snapItem.value) !== (latestFact.selectedConflictValue || latestFact.value) ||
      snapItem.unit !== latestFact.unit
    )
  );
  const hasPeriodDiff = Boolean(
    snapItem && snapItem.period && snapItem.period !== fact.period
  );
  const hasScopeDiff = Boolean(
    snapItem && (snapItem.metricScope || '') !== (fact.metricScope || '')
  );
  const hasEvidenceDiff = Boolean(
    snapItem && snapItem.primaryEvidenceId && snapItem.primaryEvidenceId !== fact.primaryEvidenceId
  );

  return {
    fact,
    snapItem,
    isHistoricalOrFinal,
    hasFrozenItem,
    adoptedValue,
    effectivePeriod,
    effectiveMetricScope,
    effectiveEvidenceId,
    effectiveSnippet,
    effectiveDocName,
    effectiveLocation,
    currentConfirmedValue,
    currentPeriod: fact.period,
    currentMetricScope: fact.metricScope || '标准口径',
    currentEvidenceId: fact.primaryEvidenceId,
    currentSnippet,
    currentDocName,
    currentLocation,
    hasSnapshotDiff,
    hasPeriodDiff,
    hasScopeDiff,
    hasEvidenceDiff,
    isEvidenceMissingInSnapshot,
    isEvidencePrunedOrUnavailable,
    isSnapshotMissingFact: isHistoricalOrFinal && !snapItem,
  };
}
