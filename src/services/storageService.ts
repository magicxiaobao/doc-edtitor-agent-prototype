import { Task, UserRole, DraftVersion } from '../types';
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
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memoryStorage[key] ?? null;
}

export function setStorageItem(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memoryStorage[key] = value;
  }
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
 */
function validateTaskStructure(task: any): boolean {
  if (!task || typeof task !== 'object') return false;
  if (typeof task.id !== 'string' || !task.id) return false;
  if (typeof task.title !== 'string') return false;
  return true;
}

/**
 * Migrates data from older schema or legacy tasks array to Schema v2
 */
function migrateToSchemaV2(rawTasks: any[]): { tasks: Task[]; message: string } {
  const migratedTasks: Task[] = rawTasks.map((rawT: any) => {
    const drafts: DraftVersion[] = Array.isArray(rawT.drafts) ? rawT.drafts : [];
    
    const migratedDrafts = drafts.map((d: any) => {
      if (!d.snapshotMetadata) {
        return {
          ...d,
          snapshotMetadata: {
            taskTitle: rawT.title || '工作总结',
            startDate: rawT.startDate || '2026-01-01',
            endDate: rawT.endDate || '2026-09-30',
            targetWordCount: rawT.targetWordCount || 3000,
            outlineSections: Array.isArray(rawT.outline) ? rawT.outline : [],
            factSnapshot: rawT.factSnapshot,
            styleSnapshot: rawT.styleSnapshot,
          },
        };
      }
      return d;
    });

    return {
      ...rawT,
      currentDraftId: rawT.currentDraftId || migratedDrafts[0]?.id || '',
      drafts: migratedDrafts,
      facts: Array.isArray(rawT.facts) ? rawT.facts : [],
      outline: Array.isArray(rawT.outline) ? rawT.outline : [],
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
      // Save corrupted raw for recovery
      setStorageItem(BACKUP_CORRUPTED_KEY, rawV2);
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
      setStorageItem(BACKUP_CORRUPTED_KEY, rawV1);
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
  const rawBackup = getStorageItem(BACKUP_CORRUPTED_KEY);
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

    const defaultPresets = [
      createPresetTask('conflict_pending'),
      createPresetTask('ready_to_draft'),
      createPresetTask('under_review'),
      createPresetTask('blank'),
    ];

    const repairedTasks: Task[] = candidates.map((rawT: any, idx: number) => {
      const fallbackPreset = defaultPresets[idx % defaultPresets.length];
      const drafts: DraftVersion[] = Array.isArray(rawT.drafts) ? rawT.drafts : [];
      return {
        ...fallbackPreset,
        ...rawT,
        id: typeof rawT.id === 'string' && rawT.id ? rawT.id : `RECOVERED-TASK-${Date.now()}-${idx}`,
        title: typeof rawT.title === 'string' && rawT.title ? rawT.title : `已恢复公文任务 (原未命名 #${idx + 1})`,
        docType: rawT.docType || fallbackPreset.docType,
        startDate: rawT.startDate || fallbackPreset.startDate,
        endDate: rawT.endDate || fallbackPreset.endDate,
        targetWordCount: typeof rawT.targetWordCount === 'number' ? rawT.targetWordCount : fallbackPreset.targetWordCount,
        currentStage: rawT.currentStage || 'drafting',
        documents: Array.isArray(rawT.documents) ? rawT.documents : fallbackPreset.documents,
        snippets: Array.isArray(rawT.snippets) ? rawT.snippets : fallbackPreset.snippets,
        facts: Array.isArray(rawT.facts) ? rawT.facts : fallbackPreset.facts,
        styleRules: Array.isArray(rawT.styleRules) ? rawT.styleRules : fallbackPreset.styleRules,
        outline: Array.isArray(rawT.outline) ? rawT.outline : fallbackPreset.outline,
        drafts: drafts.length > 0 ? drafts : fallbackPreset.drafts,
        currentDraftId: rawT.currentDraftId || (drafts[0]?.id ?? fallbackPreset.currentDraftId),
        reviewComments: Array.isArray(rawT.reviewComments) ? rawT.reviewComments : fallbackPreset.reviewComments,
        auditIssues: Array.isArray(rawT.auditIssues) ? rawT.auditIssues : fallbackPreset.auditIssues,
        isFinalized: !!rawT.isFinalized,
        status: rawT.status || '起草中',
        updatedAt: new Date().toISOString(),
      };
    });

    savePersistedState(repairedTasks, repairedTasks[0].id, '主笔甲');
    return {
      success: true,
      recoveredTasks: repairedTasks,
      message: `成功从备份中恢复 ${repairedTasks.length} 个任务（已补齐缺失元数据并无损保留草稿内容）。`,
    };
  } catch (err: any) {
    return {
      success: false,
      recoveredTasks: [],
      message: `解析备份数据失败（${err.message}），无法自动修复。`,
    };
  }
}
