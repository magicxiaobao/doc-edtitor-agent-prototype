import { Task, UserRole, DraftVersion, ParagraphBlock } from '../types';
import { createPresetTask } from './mockData';

export const CURRENT_SCHEMA_VERSION = 2;
export const STORAGE_KEY_V2 = 'doc_editor_agent_state_v2';
export const LEGACY_STORAGE_KEY_V1 = 'doc_editor_agent_tasks_v1';
export const BACKUP_CORRUPTED_KEY = 'doc_editor_agent_corrupted_backup';

export interface AppStoragePayload {
  schemaVersion: number;
  currentTaskId: string;
  activeRole: UserRole;
  tasks: Task[];
  lastSavedAt: string;
}

export interface LoadStateResult {
  tasks: Task[];
  currentTaskId: string;
  activeRole: UserRole;
  isCorrupted: boolean;
  corruptedMessage?: string;
  migrationMessage?: string;
}

// In-memory fallback for Node.js / non-browser test environments or storage quota emergencies
let memoryStorage: Record<string, string> = {};

export let globalStorageError: string | null = null;

export function getStorageError(): string | null {
  return globalStorageError;
}

export function clearStorageError(): void {
  globalStorageError = null;
}

export function getStorageItem(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(key);
      if (val !== null && val !== undefined) {
        return val;
      }
    }
  } catch (e) {
    // ignore access error
  }
  return memoryStorage[key] ?? null;
}

export function setStorageItem(key: string, value: string): void {
  // Always update in-memory fallback
  memoryStorage[key] = value;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  }
}

/**
 * Unified backup retrieval: reads from localStorage or memoryStorage fallback
 */
export function getCorruptedBackupData(): string | null {
  return getStorageItem(BACKUP_CORRUPTED_KEY) || memoryStorage[BACKUP_CORRUPTED_KEY] || null;
}

/**
 * Requirement 7 & Task 10: Preserves full pasted/uploaded original text without truncation.
 * Even long materials (50,000+ chars) are preserved intact for evidence verification.
 */
function sanitizeTasksForStorage(tasks: Task[]): Task[] {
  // Strictly preserve full original text!
  return tasks;
}

/**
 * Validates task runtime structure integrity.
 * Returns true if valid or safely repaired, false if structural corruption.
 * Validates existence and array types of all internal arrays and draft block structures.
 * Also verifies content, sectionId, order, and referencedFactIds on all blocks,
 * and ensures currentDraftId points to an existing draft in task.drafts.
 */
export function validateTaskStructure(task: any): boolean {
  if (!task || typeof task !== 'object') return false;
  if (typeof task.id !== 'string' || !task.id) return false;
  if (typeof task.title !== 'string') return false;

  // Strict verification: all internal collections must be valid arrays
  if (!Array.isArray(task.drafts)) return false;
  if (!Array.isArray(task.facts)) return false;
  if (!Array.isArray(task.outline)) return false;
  if (!Array.isArray(task.documents)) return false;
  if (!Array.isArray(task.snippets)) return false;
  if (!Array.isArray(task.styleRules)) return false;
  if (!Array.isArray(task.reviewComments)) return false;
  if (!Array.isArray(task.auditIssues)) return false;

  // Validate draft structure and paragraph block references
  for (const draft of task.drafts) {
    if (!draft || typeof draft !== 'object') return false;
    if (typeof draft.id !== 'string' || !draft.id) return false;
    if (!Array.isArray(draft.blocks)) return false;
    for (const b of draft.blocks) {
      if (!b || typeof b !== 'object') return false;
      if (typeof b.id !== 'string' || !b.id) return false;
      if (typeof b.content !== 'string') return false; // Prevent content.length TypeError!
      if (typeof b.sectionId !== 'string') return false;
      if (typeof b.order !== 'number') return false;
      if (!Array.isArray(b.referencedFactIds)) return false;
    }
  }

  // Validate currentDraftId must point to an actual existing draft in task.drafts
  if (task.drafts.length > 0) {
    if (typeof task.currentDraftId !== 'string' || !task.drafts.some((d: any) => d.id === task.currentDraftId)) {
      return false;
    }
  }

  return true;
}

/**
 * Migrates data from older schema or legacy tasks array to Schema v2
 */
function migrateToSchemaV2(rawTasks: any[]): { tasks: Task[]; message: string } {
  const migratedTasks: Task[] = rawTasks.map((rawT: any) => {
    const drafts: DraftVersion[] = Array.isArray(rawT.drafts) ? rawT.drafts : [];
    
    let styleSnapshot = rawT.styleSnapshot;
    if (!styleSnapshot && rawT.styleConfirmed && Array.isArray(rawT.styleRules)) {
      styleSnapshot = {
        confirmedAt: rawT.updatedAt || new Date().toISOString(),
        activeRuleIds: rawT.styleRules.filter((r: any) => r.confirmed).map((r: any) => r.id),
        hash: `STYLE-MIGRATED-${rawT.id || 'task'}`,
      };
    }

    let outlineSnapshot = rawT.outlineSnapshot;
    if (!outlineSnapshot && rawT.outlineConfirmed && Array.isArray(rawT.outline)) {
      outlineSnapshot = {
        confirmedAt: rawT.updatedAt || new Date().toISOString(),
        sections: rawT.outline.map((s: any) => ({
          sectionId: s.id,
          title: s.title,
          suggestedWordCount: s.suggestedWordCount || 500,
          assignedFactIds: Array.isArray(s.assignedFactIds) ? s.assignedFactIds : [],
        })),
        hash: `OUTLINE-MIGRATED-${rawT.id || 'task'}`,
      };
    }

    const migratedDrafts = drafts.map((d: any) => {
      const draftBlocks: ParagraphBlock[] = Array.isArray(d?.blocks) ? d.blocks.map((b: any, bIdx: number) => ({
        id: typeof b?.id === 'string' && b.id ? b.id : `BLK-MIG-${bIdx + 1}`,
        sectionId: typeof b?.sectionId === 'string' && b.sectionId ? b.sectionId : 'SEC-01',
        order: typeof b?.order === 'number' ? b.order : bIdx + 1,
        content: typeof b?.content === 'string' ? b.content : (typeof b?.text === 'string' ? b.text : ''),
        referencedFactIds: Array.isArray(b?.referencedFactIds) ? b.referencedFactIds : [],
        updatedAt: b?.updatedAt || new Date().toISOString(),
      })) : [];

      if (!d.snapshotMetadata) {
        return {
          ...d,
          blocks: draftBlocks,
          snapshotMetadata: {
            taskTitle: rawT.title || '工作总结',
            startDate: rawT.startDate || '2026-01-01',
            endDate: rawT.endDate || '2026-09-30',
            targetWordCount: rawT.targetWordCount || 3000,
            outlineSections: Array.isArray(rawT.outline) ? rawT.outline : [],
            factSnapshot: rawT.factSnapshot,
            styleSnapshot: styleSnapshot || rawT.styleSnapshot,
            outlineSnapshot: outlineSnapshot || rawT.outlineSnapshot,
          },
        };
      }
      return {
        ...d,
        blocks: draftBlocks,
        snapshotMetadata: {
          ...d.snapshotMetadata,
          styleSnapshot: d.snapshotMetadata.styleSnapshot || styleSnapshot || rawT.styleSnapshot,
          outlineSnapshot: d.snapshotMetadata.outlineSnapshot || outlineSnapshot || rawT.outlineSnapshot,
        },
      };
    });

    const targetCurrentDraftId = (migratedDrafts.some((d) => d.id === rawT.currentDraftId))
      ? rawT.currentDraftId
      : (migratedDrafts[0]?.id || '');

    return {
      ...rawT,
      currentDraftId: targetCurrentDraftId,
      drafts: migratedDrafts,
      facts: Array.isArray(rawT.facts) ? rawT.facts : [],
      outline: Array.isArray(rawT.outline) ? rawT.outline : [],
      styleSnapshot: styleSnapshot || rawT.styleSnapshot,
      outlineSnapshot: outlineSnapshot || rawT.outlineSnapshot,
      reviewComments: Array.isArray(rawT.reviewComments) ? rawT.reviewComments : [],
      auditIssues: Array.isArray(rawT.auditIssues) ? rawT.auditIssues : [],
      isFinalized: !!rawT.isFinalized,
      status: rawT.status || '起草中',
      updatedAt: rawT.updatedAt || new Date().toISOString(),
    };
  });

  return {
    tasks: migratedTasks,
    message: `已自动将旧版本本地数据无损迁移至 Schema v2（共迁移 ${migratedTasks.length} 个任务，完整保留草稿与审批快照）。`,
  };
}

/**
 * Loads persisted app state with runtime structure verification
 * - Catches corrupted data with recovery options without silent data loss
 * - Keeps currentTaskId and activeRole on refresh
 */
export function loadPersistedState(): LoadStateResult {
  const defaultPresets = [
    createPresetTask('conflict_pending'),
    createPresetTask('ready_to_draft'),
    createPresetTask('under_review'),
    createPresetTask('blank'),
  ];
  const defaultTaskId = defaultPresets[0].id;
  const defaultRole: UserRole = '主笔甲';

  // Check V2 storage first
  const rawV2 = getStorageItem(STORAGE_KEY_V2);
  if (rawV2) {
    try {
      const payload: AppStoragePayload = JSON.parse(rawV2);

      // Runtime structure verification: must be object, have tasks array
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tasks)) {
        throw new Error('存储结构异常：缺少有效的 tasks 根数组');
      }

      // Check task integrity
      const hasCorruptedTask = payload.tasks.some((t) => !validateTaskStructure(t));
      if (hasCorruptedTask) {
        throw new Error('存储结构异常：检测到任务对象元数据缺失或结构损坏');
      }

      if (payload.tasks.length === 0) {
        return {
          tasks: defaultPresets,
          currentTaskId: defaultTaskId,
          activeRole: defaultRole,
          isCorrupted: false,
        };
      }

      if (payload.schemaVersion === CURRENT_SCHEMA_VERSION) {
        const matchedTaskId = payload.tasks.some((t) => t.id === payload.currentTaskId)
          ? payload.currentTaskId
          : payload.tasks[0].id;

        const matchedRole: UserRole = ['主笔甲', '审阅乙', '供稿丙', '审阅丁'].includes(payload.activeRole)
          ? payload.activeRole
          : '主笔甲';

        return {
          tasks: payload.tasks,
          currentTaskId: matchedTaskId,
          activeRole: matchedRole,
          isCorrupted: false,
        };
      } else {
        // Upgrade older schema
        const migration = migrateToSchemaV2(payload.tasks);
        return {
          tasks: migration.tasks,
          currentTaskId: payload.currentTaskId || migration.tasks[0].id,
          activeRole: payload.activeRole || '主笔甲',
          isCorrupted: false,
          migrationMessage: migration.message,
        };
      }
    } catch (e: any) {
      console.error('LocalStorage v2 corrupted:', e);
      // Save corrupted raw for recovery with independent error protection (quota safe)
      try {
        setStorageItem(BACKUP_CORRUPTED_KEY, rawV2);
      } catch (backupErr) {
        console.warn('Backup write failed (likely quota exceeded), fallback to memory storage:', backupErr);
        memoryStorage[BACKUP_CORRUPTED_KEY] = rawV2;
      }
      return {
        tasks: defaultPresets,
        currentTaskId: defaultTaskId,
        activeRole: defaultRole,
        isCorrupted: true,
        corruptedMessage: `检测到本地存储数据结构损坏 (${e.message})。已隔离原始数据至备份区，未静默丢弃草稿。`,
      };
    }
  }

  // Check legacy V1 storage
  const rawV1 = getStorageItem(LEGACY_STORAGE_KEY_V1);
  if (rawV1) {
    try {
      const parsedV1 = JSON.parse(rawV1);
      if (Array.isArray(parsedV1) && parsedV1.length > 0) {
        const migration = migrateToSchemaV2(parsedV1);
        return {
          tasks: migration.tasks,
          currentTaskId: migration.tasks[0].id,
          activeRole: defaultRole,
          isCorrupted: false,
          migrationMessage: migration.message,
        };
      }
    } catch (e: any) {
      console.error('Legacy localStorage corrupted:', e);
      try {
        setStorageItem(BACKUP_CORRUPTED_KEY, rawV1);
      } catch (backupErr) {
        memoryStorage[BACKUP_CORRUPTED_KEY] = rawV1;
      }
      return {
        tasks: defaultPresets,
        currentTaskId: defaultTaskId,
        activeRole: defaultRole,
        isCorrupted: true,
        corruptedMessage: `旧版缓存数据损坏 (${e.message})，已备份原始字符串并提供恢复选项。`,
      };
    }
  }

  // Defaults
  return {
    tasks: defaultPresets,
    currentTaskId: defaultTaskId,
    activeRole: defaultRole,
    isCorrupted: false,
  };
}

/**
 * Saves current app state to localStorage.
 * If quota exceeded or storage write fails, captures error without losing in-memory state.
 */
export function savePersistedState(tasks: Task[], currentTaskId: string, activeRole: UserRole): boolean {
  try {
    const sanitized = sanitizeTasksForStorage(tasks);
    const payload: AppStoragePayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      currentTaskId,
      activeRole,
      tasks: sanitized,
      lastSavedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload);
    setStorageItem(STORAGE_KEY_V2, serialized);
    clearStorageError();
    return true;
  } catch (e: any) {
    console.warn('Failed to save state to localStorage', e);
    // Write to memoryStorage as emergency backup
    try {
      const payload: AppStoragePayload = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        currentTaskId,
        activeRole,
        tasks: sanitizeTasksForStorage(tasks),
        lastSavedAt: new Date().toISOString(),
      };
      memoryStorage[STORAGE_KEY_V2] = JSON.stringify(payload);
    } catch {
      // ignore
    }

    globalStorageError = `本地存储写入失败或空间受限（${e.message || '存储配额超限'}）。内存中的当前文稿完好无损，建议及时导出TXT/Word文件备份。`;
    return false;
  }
}

/**
 * Resets corrupted state and provides clean presets while keeping corrupted backup
 */
export function resetStorageWithBackup(): Task[] {
  const defaultPresets = [
    createPresetTask('conflict_pending'),
    createPresetTask('ready_to_draft'),
    createPresetTask('under_review'),
    createPresetTask('blank'),
  ];
  savePersistedState(defaultPresets, defaultPresets[0].id, '主笔甲');
  return defaultPresets;
}

/**
 * Attempts best-effort recovery of tasks from corrupted backup data.
 * Fixes missing task titles, metadata, or schema anomalies without data loss.
 */
export function recoverTasksFromCorruptedBackup(): { success: boolean; recoveredTasks: Task[]; message: string } {
  const rawBackup = getCorruptedBackupData();
  if (!rawBackup) {
    return { success: false, recoveredTasks: [], message: '未找到隔离的损坏备份数据。' };
  }

  try {
    const parsed = JSON.parse(rawBackup);
    let candidates: any[] = [];
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
      candidates = parsed.tasks;
    } else if (parsed && typeof parsed === 'object') {
      candidates = [parsed];
    }

    if (candidates.length === 0) {
      return { success: false, recoveredTasks: [], message: '备份数据中无任何可提取的任务对象。' };
    }

    const repairedTasks: Task[] = [];

    for (let idx = 0; idx < candidates.length; idx++) {
      const rawT = candidates[idx];
      if (!rawT || typeof rawT !== 'object') continue;

      const recoveredId = typeof rawT.id === 'string' && rawT.id ? rawT.id : `RECOVERED-TASK-${Date.now()}-${idx}`;
      const recoveredTitle = typeof rawT.title === 'string' && rawT.title ? rawT.title : `已恢复公文任务 (原未命名 #${idx + 1})`;

      // Clean and reconstruct drafts: never inject preset data; ensure referencedFactIds is always array
      let rawDrafts: any[] = Array.isArray(rawT.drafts) ? rawT.drafts : [];
      let cleanedDrafts: DraftVersion[] = [];

      if (rawDrafts.length > 0) {
        cleanedDrafts = rawDrafts.map((d: any, dIdx: number) => {
          const rawBlocks: any[] = Array.isArray(d?.blocks) ? d.blocks : [];
          const cleanedBlocks: ParagraphBlock[] = rawBlocks.map((b: any, bIdx: number) => ({
            id: typeof b?.id === 'string' && b.id ? b.id : `BLK-REC-${dIdx}-${bIdx + 1}`,
            sectionId: typeof b?.sectionId === 'string' && b.sectionId ? b.sectionId : 'SEC-01',
            order: typeof b?.order === 'number' ? b.order : bIdx + 1,
            content: typeof b?.content === 'string' ? b.content : (typeof b?.text === 'string' ? b.text : ''),
            referencedFactIds: Array.isArray(b?.referencedFactIds) ? b.referencedFactIds : [],
            updatedAt: b?.updatedAt || new Date().toISOString(),
          }));

          return {
            id: typeof d?.id === 'string' && d.id ? d.id : `DRAFT-REC-${Date.now()}-${dIdx}`,
            versionNumber: typeof d?.versionNumber === 'string' && d.versionNumber ? d.versionNumber : `v1.${dIdx} (恢复快照)`,
            createdAt: d?.createdAt || new Date().toISOString(),
            author: d?.author || '系统恢复',
            summary: d?.summary || '从异常存储恢复的草稿版本（保留原始正文，未混入示例数据）',
            blocks: cleanedBlocks,
            isWorkingDraft: dIdx === 0,
            isHistoricalSnapshot: dIdx > 0,
            isFinal: !!d?.isFinal,
            sourceDraftId: typeof d?.sourceDraftId === 'string' ? d.sourceDraftId : undefined,
            snapshotMetadata: d?.snapshotMetadata,
            auditRecords: Array.isArray(d?.auditRecords) ? d.auditRecords : [],
            frozenReviewComments: Array.isArray(d?.frozenReviewComments) ? d.frozenReviewComments : undefined,
          };
        });
      } else {
        // If rawT has plain text or raw content, preserve it as a single block in a clean recovered draft
        const fallbackText = typeof rawT.content === 'string' ? rawT.content : (typeof rawT.text === 'string' ? rawT.text : '');
        cleanedDrafts = [
          {
            id: `DRAFT-REC-${Date.now()}`,
            versionNumber: 'v1.0 (待恢复草稿)',
            createdAt: new Date().toISOString(),
            author: '系统恢复',
            summary: '从异常存储中提取的待恢复稿件（保留原始正文，未混入示例数据）',
            blocks: fallbackText ? [
              {
                id: 'BLK-REC-1',
                sectionId: 'SEC-01',
                order: 1,
                content: fallbackText,
                referencedFactIds: [],
                updatedAt: new Date().toISOString(),
              }
            ] : [],
            isWorkingDraft: true,
            isHistoricalSnapshot: false,
          }
        ];
      }

      const hasCurrentDraft = cleanedDrafts.some((d) => d.id === rawT.currentDraftId);
      const resolvedCurrentDraftId = hasCurrentDraft ? rawT.currentDraftId : (cleanedDrafts[0]?.id || '');

      const blankBase = createPresetTask('blank');
      const taskToValidate: Task = {
        ...blankBase,
        id: recoveredId,
        title: recoveredTitle,
        docType: (rawT.docType === '工作总结' || rawT.docType === '汇报材料' || rawT.docType === '专项报告') ? rawT.docType : '工作总结',
        usage: typeof rawT.usage === 'string' ? rawT.usage : blankBase.usage,
        audience: typeof rawT.audience === 'string' ? rawT.audience : blankBase.audience,
        mandatoryCoverage: typeof rawT.mandatoryCoverage === 'string' ? rawT.mandatoryCoverage : blankBase.mandatoryCoverage,
        deadline: typeof rawT.deadline === 'string' ? rawT.deadline : blankBase.deadline,
        primaryAuthor: typeof rawT.primaryAuthor === 'string' ? rawT.primaryAuthor : '主笔甲',
        startDate: typeof rawT.startDate === 'string' ? rawT.startDate : '2026-01-01',
        endDate: typeof rawT.endDate === 'string' ? rawT.endDate : '2026-09-30',
        targetWordCount: typeof rawT.targetWordCount === 'number' ? rawT.targetWordCount : 2000,
        currentStage: typeof rawT.currentStage === 'string' ? rawT.currentStage : 'drafting',
        documents: Array.isArray(rawT.documents) ? rawT.documents : [],
        snippets: Array.isArray(rawT.snippets) ? rawT.snippets : [],
        facts: Array.isArray(rawT.facts) ? rawT.facts : [],
        styleRules: Array.isArray(rawT.styleRules) ? rawT.styleRules : [],
        styleConfirmed: !!rawT.styleConfirmed,
        outline: Array.isArray(rawT.outline) ? rawT.outline : [],
        outlineConfirmed: !!rawT.outlineConfirmed,
        drafts: cleanedDrafts,
        currentDraftId: resolvedCurrentDraftId,
        reviewComments: Array.isArray(rawT.reviewComments) ? rawT.reviewComments : [],
        auditIssues: Array.isArray(rawT.auditIssues) ? rawT.auditIssues : [],
        isFinalized: false,
        status: '待恢复', // 使用空结构和“待恢复”状态，保留原文，避免混入示例业务数据
        schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      };

      // Layer-by-layer validation of recovered result
      if (validateTaskStructure(taskToValidate)) {
        repairedTasks.push(taskToValidate);
      }
    }

    if (repairedTasks.length === 0) {
      return { success: false, recoveredTasks: [], message: '备份数据校验失败，未能恢复有效任务结构。' };
    }

    savePersistedState(repairedTasks, repairedTasks[0].id, '主笔甲');
    return {
      success: true,
      recoveredTasks: repairedTasks,
      message: `成功从备份中恢复 ${repairedTasks.length} 个任务（已补齐空结构与必要段落字段，保留原文并置为“待恢复”状态）。`,
    };
  } catch (err: any) {
    return {
      success: false,
      recoveredTasks: [],
      message: `解析备份数据失败（${err.message}），无法自动修复。`,
    };
  }
}
