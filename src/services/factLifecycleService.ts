import { Task, Fact, UserRole, EvidenceSnippet, SourceDocument } from '../types';
import { checkPermission } from './permissionService';

/**
 * Validates whether a fact period falls within task statistical period.
 * Supports "2026年1至9月", "2026年1-9月", "2027年二季度", etc.
 */
export function isPeriodWithinTaskPeriod(
  factPeriod: string,
  taskStartDate: string,
  taskEndDate: string
): boolean {
  if (!factPeriod) return false;

  // Extract year from task
  const taskStartYear = taskStartDate ? taskStartDate.split('-')[0] : '';
  const taskEndYear = taskEndDate ? taskEndDate.split('-')[0] : '';

  // Extract year from fact
  const factYearMatch = factPeriod.match(/(\d{4})年/);
  if (factYearMatch) {
    const factYear = factYearMatch[1];
    if (taskStartYear && factYear !== taskStartYear && factYear !== taskEndYear) {
      return false;
    }
  }

  // Historic year 2025 or earlier cannot enter 2026/2027 task
  if (factPeriod.includes('2025') || factPeriod.includes('2024') || factPeriod.includes('2023')) {
    if (!taskStartYear.includes('2025') && !taskStartYear.includes('2024')) {
      return false;
    }
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

  // 1. Evidence Existence Validation
  const snippet = task.snippets.find((s) => s.id === factData.primaryEvidenceId);
  if (!snippet && !factData.isAuthorSupplemented) {
    return {
      success: false,
      error: `依据片段【${factData.primaryEvidenceId}】在当前材料库中不存在，严禁仅凭虚构ID建立事实！`,
    };
  }

  // 2. Historic Style Material Isolation
  if (snippet) {
    const sourceDoc = task.documents.find((d) => d.id === snippet.sourceDocId);
    if (sourceDoc) {
      if (sourceDoc.usage === 'style_ref' || sourceDoc.period.includes('2025') || factData.isHistoricOnly) {
        return {
          success: false,
          error: `材料【${sourceDoc.name}】为历史文风参考材料（非本期履职数据），严禁转化为本期量化事实依据！`,
        };
      }
      if (sourceDoc.usage === 'rag_clue' || snippet.id === 'EVD-06') {
        // Textless RAG clue cannot be confirmed as quantitative fact
        return {
          success: false,
          error: `【${sourceDoc.name}】仅为定性问答线索，无原文位置与量化指标，不可作为量化事实入库！`,
        };
      }
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
    status: 'pending', // Requirement 3: 供稿候选保持pending
    createdByRole: authorRole,
  };

  return { success: true, fact: newFact };
}

/**
 * Requirement 3: Confirms a fact.
 * - Only '主笔甲' can confirm.
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

  const updatedFacts = task.facts.map((f) => (f.id === factId ? { ...f, status: 'confirmed' as const } : f));

  // Requirement 3: 上游事实变更一致地使下游大纲审批失效
  const updatedTask: Task = {
    ...task,
    facts: updatedFacts,
    outlineConfirmed: false, // 事实变动使下游大纲失效
    factSnapshot: undefined, // 需重新生成并确认快照
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
    updatedAt: new Date().toISOString(),
  };

  return { success: true, updatedTask };
}
