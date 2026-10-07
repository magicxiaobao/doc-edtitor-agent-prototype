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

/**
 * Sanitizes tasks before writing to localStorage to prevent large files blowing up quota
 * "仍不把大文件装入localStorage"
 */
function sanitizeTasksForStorage(tasks: Task[]): Task[] {
  return tasks.map((task) => {
    const sanitizedDocs = task.documents.map((doc) => {
      // If doc content is large (>15KB), store preview only for local storage
      if (doc.content && doc.content.length > 15000) {
        return {
          ...doc,
          content: doc.content.slice(0, 15000) + '\n\n【系统提示：超长文档正文已截断本地缓存以节约存储，完整材料保留在原文件中】',
        };
      }
      return doc;
    });

    return {
      ...task,
      documents: sanitizedDocs,
    };
  });
}

/**
 * Migrates data from older schema or legacy tasks array to Schema v2
 */
function migrateToSchemaV2(rawTasks: any[]): { tasks: Task[]; message: string } {
  const migratedTasks: Task[] = rawTasks.map((rawT: any) => {
    // Ensure task has drafts array
    const drafts: DraftVersion[] = Array.isArray(rawT.drafts) ? rawT.drafts : [];
    
    // Ensure each draft has snapshotMetadata
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
 * Loads persisted app state from localStorage
 * - Supports schemaVersion migration
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

  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return {
      tasks: defaultPresets,
      currentTaskId: defaultTaskId,
      activeRole: defaultRole,
      isCorrupted: false,
    };
  }

  // Check V2 storage first
  const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
  if (rawV2) {
    try {
      const payload: AppStoragePayload = JSON.parse(rawV2);
      if (payload && Array.isArray(payload.tasks) && payload.tasks.length > 0) {
        // Validate if schema matches
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
      }
    } catch (e: any) {
      console.error('LocalStorage v2 corrupted:', e);
      // Save corrupted raw for recovery
      localStorage.setItem(BACKUP_CORRUPTED_KEY, rawV2);
      return {
        tasks: defaultPresets,
        currentTaskId: defaultTaskId,
        activeRole: defaultRole,
        isCorrupted: true,
        corruptedMessage: `检测到本地存储数据损坏 (JSON解析错误: ${e.message})。已隔离原始数据至备份区，未静默丢弃草稿。`,
      };
    }
  }

  // Check legacy V1 storage
  const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY_V1);
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
      localStorage.setItem(BACKUP_CORRUPTED_KEY, rawV1);
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
 * Saves current app state to localStorage
 */
export function savePersistedState(tasks: Task[], currentTaskId: string, activeRole: UserRole): boolean {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return false;
  }

  try {
    const sanitized = sanitizeTasksForStorage(tasks);
    const payload: AppStoragePayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      currentTaskId,
      activeRole,
      tasks: sanitized,
      lastSavedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn('Failed to save state to localStorage', e);
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
