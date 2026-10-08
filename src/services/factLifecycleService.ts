import { Task, Fact, UserRole, EvidenceSnippet, SourceDocument } from '../types';
import { checkPermission } from './permissionService';

/**
 * Parses a Chinese period string into a structured start and end Date.
 * Supports: "2026年1至9月", "2026年1-9月", "2026年前三季度", "2026年上半年",
 * "2026年一季度", "2026年10月", "2025年", "2027年二季度", etc.
 */
export function parsePeriodDateRange(periodStr: string): { start: Date; end: Date } | null {
  if (!periodStr) return null;
  const p = periodStr.trim();

  const yearMatch = p.match(/(\d{4})年/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);

  // Month ranges: "1至9月", "1-9月", "1~9月", "1月至9月", "1月-9月", "1月到9月"
  const monthRangeMatch = p.match(/(\d{1,2})月?\s*(?:至|-|~|到)\s*(\d{1,2})月/);
  if (monthRangeMatch) {
    const startM = parseInt(monthRangeMatch[1], 10);
    const endM = parseInt(monthRangeMatch[2], 10);
    const start = new Date(Date.UTC(year, startM - 1, 1));
    const end = new Date(Date.UTC(year, endM, 0, 23, 59, 59));
    return { start, end };
  }

  // Quarters with cumulative combinations checked first
  if (p.includes('前三季度')) {
    return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 9, 0, 23, 59, 59)) };
  }
  if (p.includes('上半年')) {
    return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 6, 0, 23, 59, 59)) };
  }
  if (p.includes('下半年')) {
    return { start: new Date(Date.UTC(year, 6, 1)), end: new Date(Date.UTC(year, 12, 0, 23, 59, 59)) };
  }
  if (p.includes('一季度') || p.includes('第1季度')) {
    return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 3, 0, 23, 59, 59)) };
  }
  if (p.includes('二季度') || p.includes('第2季度')) {
    return { start: new Date(Date.UTC(year, 3, 1)), end: new Date(Date.UTC(year, 6, 0, 23, 59, 59)) };
  }
  if (p.includes('三季度') || p.includes('第3季度')) {
    return { start: new Date(Date.UTC(year, 6, 1)), end: new Date(Date.UTC(year, 9, 0, 23, 59, 59)) };
  }
  if (p.includes('四季度') || p.includes('第4季度')) {
    return { start: new Date(Date.UTC(year, 9, 1)), end: new Date(Date.UTC(year, 12, 0, 23, 59, 59)) };
  }

  // Single month: e.g. "10月"
  const singleMonthMatch = p.match(/(\d{1,2})月/);
  if (singleMonthMatch) {
    const m = parseInt(singleMonthMatch[1], 10);
    const start = new Date(Date.UTC(year, m - 1, 1));
    const end = new Date(Date.UTC(year, m, 0, 23, 59, 59));
    return { start, end };
  }

  // Full year or annual: e.g. "2025年", "2026年度", "2026全年"
  return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31, 23, 59, 59)) };
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
    if (sourceDoc.usage === 'style_ref' || sourceDoc.period.includes('2025') || factData.isHistoricOnly) {
      return {
        success: false,
        error: `材料【${sourceDoc.name}】为历史文风参考材料（非本期履职数据），严禁转化为本期量化事实依据！`,
      };
    }
    if (sourceDoc.usage === 'rag_clue' || snippet.id === 'EVD-06' || snippet.location === '无原文') {
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
    if (sourceDoc.usage === 'style_ref' || sourceDoc.period.includes('2025')) {
      return { success: false, error: `来源材料【${sourceDoc.name}】为历史文风参考材料，严禁确认为本期量化履职事实！` };
    }
    if (sourceDoc.usage === 'rag_clue' || snippet.id === 'EVD-06' || snippet.location === '无原文') {
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
  const sYear = startDate.slice(0, 4);
  const sMonth = parseInt(startDate.slice(5, 7), 10);
  const eYear = endDate.slice(0, 4);
  const eMonth = parseInt(endDate.slice(5, 7), 10);

  if (sYear === eYear) {
    if (sMonth === 1 && eMonth === 12) return `${sYear}年度`;
    if (sMonth === 1 && eMonth === 3) return `${sYear}年1至3月`;
    if (sMonth === 4 && eMonth === 6) return `${sYear}年4至6月`;
    if (sMonth === 7 && eMonth === 9) return `${sYear}年7至9月`;
    if (sMonth === 10 && eMonth === 12) return `${sYear}年10至12月`;
    if (sMonth === 1 && eMonth === 6) return `${sYear}年1至6月`;
    if (sMonth === 7 && eMonth === 12) return `${sYear}年7至12月`;
    if (sMonth === 1 && eMonth === 9) return `${sYear}年1至9月`;
    if (sMonth === eMonth) return `${sYear}年${sMonth}月`;
    return `${sYear}年${sMonth}至${eMonth}月`;
  }
  return `${sYear}年${sMonth}月至${eYear}年${eMonth}月`;
}
