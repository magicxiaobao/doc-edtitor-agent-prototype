import React, { useState, useEffect } from 'react';
import { 
  Task, 
  TaskStage, 
  UserRole, 
  EvidenceSnippet 
} from './types';
import { createPresetTask } from './services/mockData';
import { 
  loadPersistedState, 
  savePersistedState, 
  resetStorageWithBackup,
  recoverTasksFromCorruptedBackup,
  getStorageError,
  getCorruptedBackupData,
  BACKUP_CORRUPTED_KEY 
} from './services/storageService';
import { Navbar } from './components/Navbar';
import { StageBreadcrumbs } from './components/StageBreadcrumbs';
import { SnippetDrawer } from './components/SnippetDrawer';
import { TaskSetupStage } from './components/stages/TaskSetupStage';
import { MaterialsAndFactsStage } from './components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './components/stages/StyleAndOutlineStage';
import { DraftingStage } from './components/stages/DraftingStage';
import { ReviewStage } from './components/stages/ReviewStage';
import { AuditAndExportStage } from './components/stages/AuditAndExportStage';
import { AlertTriangle, RefreshCw, Download, CheckCircle2, X } from 'lucide-react';

export function App() {
  // Requirement 5: Load with schema migration & corruption recovery
  const [initialLoaded] = useState(() => loadPersistedState());
  const [tasks, setTasks] = useState<Task[]>(initialLoaded.tasks);
  const [currentTaskId, setCurrentTaskId] = useState<string>(initialLoaded.currentTaskId);
  const [activeRole, setActiveRole] = useState<UserRole>(initialLoaded.activeRole);
  
  const [isCorrupted, setIsCorrupted] = useState(initialLoaded.isCorrupted);
  const [corruptedMessage, setCorruptedMessage] = useState(initialLoaded.corruptedMessage);
  const [migrationMessage, setMigrationMessage] = useState(initialLoaded.migrationMessage);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [viewingSnippet, setViewingSnippet] = useState<EvidenceSnippet | null>(null);

  // Sync state to localStorage whenever tasks, currentTaskId, or activeRole changes
  useEffect(() => {
    // 损坏待恢复状态时暂停自动保存，保留原始存储与备份，避免被默认预置数据覆盖
    if (isCorrupted) {
      return;
    }
    const success = savePersistedState(tasks, currentTaskId, activeRole);
    if (!success) {
      setStorageError(getStorageError() || '本地存储配额不足或写入失败。内存中文稿完好无损，建议及时导出文件备份。');
    } else {
      setStorageError(null);
    }
  }, [tasks, currentTaskId, activeRole, isCorrupted]);

  const currentTask = tasks.find((t) => t.id === currentTaskId) || tasks[0];

  const handleUpdateCurrentTask = (updatedFields: Partial<Task>) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === currentTask.id
          ? {
              ...t,
              ...updatedFields,
              updatedAt: new Date().toISOString(),
            }
          : t
      )
    );
  };

  const handleCreateTask = (
    newTaskData: Omit<
      Task,
      | 'id'
      | 'documents'
      | 'snippets'
      | 'facts'
      | 'styleRules'
      | 'outline'
      | 'drafts'
      | 'reviewComments'
      | 'auditIssues'
    >
  ) => {
    const newTask: Task = {
      ...newTaskData,
      id: `TASK-${Date.now().toString(36).toUpperCase()}`,
      documents: [],
      snippets: [],
      facts: [],
      styleRules: [],
      outline: [],
      drafts: [],
      reviewComments: [],
      auditIssues: [],
    };

    setTasks((prev) => [newTask, ...prev]);
    setCurrentTaskId(newTask.id);
  };

  const handleLoadScenario = (scenario: 'blank' | 'conflict_pending' | 'ready_to_draft' | 'under_review') => {
    const preset = createPresetTask(scenario);
    setTasks((prev) => [preset, ...prev.filter((t) => t.id !== preset.id)]);
    setCurrentTaskId(preset.id);
  };

  const handleResetData = () => {
    const defaults = resetStorageWithBackup();
    setTasks(defaults);
    setCurrentTaskId(defaults[0].id);
    setActiveRole('主笔甲');
    setIsCorrupted(false);
  };

  const handleAttemptRecovery = () => {
    const res = recoverTasksFromCorruptedBackup();
    if (res.success && res.recoveredTasks.length > 0) {
      setTasks(res.recoveredTasks);
      setCurrentTaskId(res.recoveredTasks[0].id);
      setIsCorrupted(false);
      setMigrationMessage(res.message);
    } else {
      alert(res.message || '自动恢复失败，建议下载备份文件或重置预置数据。');
    }
  };

  const handleDownloadCorruptedBackup = () => {
    const raw = getCorruptedBackupData() || '';
    if (!raw) {
      alert('未找到可下载的备份数据');
      return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `corrupted_data_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSelectStage = (stage: TaskStage) => {
    handleUpdateCurrentTask({ currentStage: stage });
  };

  const handleProceedStage = (nextStage: TaskStage) => {
    handleUpdateCurrentTask({ currentStage: nextStage });
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800 text-sm">
      {/* Top Navbar */}
      <Navbar
        currentTask={currentTask}
        tasks={tasks}
        onSelectTask={setCurrentTaskId}
        activeRole={activeRole}
        onSelectRole={setActiveRole}
        onLoadScenario={handleLoadScenario}
        onResetData={handleResetData}
      />

      {/* Migration Notice Banner */}
      {migrationMessage && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2.5 text-xs text-blue-900 flex items-center justify-between">
          <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
            <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
            <span>{migrationMessage}</span>
            <button 
              onClick={() => setMigrationMessage(undefined)}
              className="ml-auto text-blue-500 hover:text-blue-800 cursor-pointer"
              aria-label="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Storage Error / Quota Failure Banner */}
      {storageError && (
        <div className="bg-rose-50 border-b border-rose-300 px-4 py-3 text-sm text-rose-950">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <strong className="font-bold">数据存储告警：</strong>
                <span>{storageError}</span>
              </div>
            </div>
            <button
              onClick={() => setStorageError(null)}
              className="px-3 py-1 bg-white border border-rose-300 hover:bg-rose-100 rounded text-xs font-semibold text-rose-900 cursor-pointer self-start sm:self-auto"
            >
              关闭提示
            </button>
          </div>
        </div>
      )}

      {/* Corrupted Data Alert Banner with Recovery Options */}
      {isCorrupted && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-3 text-sm text-amber-950">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <strong className="font-bold">数据存储安全提示：</strong>
                <span>{corruptedMessage || '检测到本地缓存数据异常，已隔离原始数据至备份区，未静默丢弃草稿。'}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleAttemptRecovery}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>尝试自动修复恢复</span>
              </button>
              <button
                onClick={handleDownloadCorruptedBackup}
                className="px-3 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 rounded text-xs font-semibold text-amber-900 flex items-center gap-1 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出损坏数据JSON</span>
              </button>
              <button
                onClick={handleResetData}
                className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>重置为标准预置场景</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage Breadcrumb Progress */}
      <StageBreadcrumbs
        currentStage={currentTask.currentStage}
        task={currentTask}
        onSelectStage={handleSelectStage}
      />

      {/* Main Stage Workspace - Checked for 1440, 1280, 1024 widths */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {currentTask.currentStage === 'task_setup' && (
          <TaskSetupStage
            currentTask={currentTask}
            tasks={tasks}
            onUpdateTask={handleUpdateCurrentTask}
            onSelectTask={setCurrentTaskId}
            onCreateTask={handleCreateTask}
            onProceedToNextStage={() => handleProceedStage('material_fact')}
            activeRole={activeRole}
          />
        )}

        {currentTask.currentStage === 'material_fact' && (
          <MaterialsAndFactsStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            onViewSnippet={setViewingSnippet}
            onProceedToNextStage={() => handleProceedStage('style_outline')}
            activeRole={activeRole}
          />
        )}

        {currentTask.currentStage === 'style_outline' && (
          <StyleAndOutlineStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            onViewSnippet={setViewingSnippet}
            onProceedToNextStage={() => handleProceedStage('drafting')}
            activeRole={activeRole}
          />
        )}

        {currentTask.currentStage === 'drafting' && (
          <DraftingStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            onViewSnippet={setViewingSnippet}
            onProceedToNextStage={() => handleProceedStage('review')}
            activeRole={activeRole}
            onSelectStage={handleSelectStage}
          />
        )}

        {currentTask.currentStage === 'review' && (
          <ReviewStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            onProceedToNextStage={() => handleProceedStage('final_export')}
            activeRole={activeRole}
            onSelectStage={handleSelectStage}
          />
        )}

        {currentTask.currentStage === 'final_export' && (
          <AuditAndExportStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            activeRole={activeRole}
            onSelectStage={handleSelectStage}
          />
        )}
      </main>

      {/* Global Snippet Drawer for Evidence Source Tracing */}
      <SnippetDrawer
        snippet={viewingSnippet}
        documents={currentTask.documents}
        onClose={() => setViewingSnippet(null)}
        task={currentTask}
        currentDraft={currentTask.drafts.find((d) => d.id === currentTask.currentDraftId)}
      />
    </div>
  );
}
