import React, { useState, useEffect } from 'react';
import { 
  Task, 
  TaskStage, 
  UserRole, 
  EvidenceSnippet 
} from './types';
import { createPresetTask } from './services/mockData';
import { Navbar } from './components/Navbar';
import { StageBreadcrumbs } from './components/StageBreadcrumbs';
import { SnippetDrawer } from './components/SnippetDrawer';
import { TaskSetupStage } from './components/stages/TaskSetupStage';
import { MaterialsAndFactsStage } from './components/stages/MaterialsAndFactsStage';
import { StyleAndOutlineStage } from './components/stages/StyleAndOutlineStage';
import { DraftingStage } from './components/stages/DraftingStage';
import { ReviewStage } from './components/stages/ReviewStage';
import { AuditAndExportStage } from './components/stages/AuditAndExportStage';

const LOCAL_STORAGE_KEY = 'doc_editor_agent_tasks_v1';

export function App() {
  // Load tasks from localStorage or generate defaults
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Failed to parse saved tasks from localStorage', e);
    }

    // Default presets
    return [
      createPresetTask('conflict_pending'),
      createPresetTask('ready_to_draft'),
      createPresetTask('under_review'),
      createPresetTask('blank'),
    ];
  });

  const [currentTaskId, setCurrentTaskId] = useState<string>(() => {
    return tasks[0]?.id || 'TASK-CONFLICT';
  });

  const [activeRole, setActiveRole] = useState<UserRole>('主笔甲');
  const [viewingSnippet, setViewingSnippet] = useState<EvidenceSnippet | null>(null);

  // Sync tasks to localStorage whenever tasks change
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn('Failed to save tasks to localStorage', e);
    }
  }, [tasks]);

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
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    const initialTasks = [
      createPresetTask('conflict_pending'),
      createPresetTask('ready_to_draft'),
      createPresetTask('under_review'),
      createPresetTask('blank'),
    ];
    setTasks(initialTasks);
    setCurrentTaskId(initialTasks[0].id);
  };

  const handleSelectStage = (stage: TaskStage) => {
    handleUpdateCurrentTask({ currentStage: stage });
  };

  const handleProceedStage = (nextStage: TaskStage) => {
    handleUpdateCurrentTask({ currentStage: nextStage });
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800">
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

      {/* Stage Breadcrumb Progress */}
      <StageBreadcrumbs
        currentStage={currentTask.currentStage}
        task={currentTask}
        onSelectStage={handleSelectStage}
      />

      {/* Main Stage Workspace */}
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
          />
        )}

        {currentTask.currentStage === 'review' && (
          <ReviewStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            onProceedToNextStage={() => handleProceedStage('final_export')}
            activeRole={activeRole}
          />
        )}

        {currentTask.currentStage === 'final_export' && (
          <AuditAndExportStage
            task={currentTask}
            onUpdateTask={handleUpdateCurrentTask}
            activeRole={activeRole}
          />
        )}
      </main>

      {/* Global Snippet Drawer for Evidence Source Tracing */}
      <SnippetDrawer
        snippet={viewingSnippet}
        documents={currentTask.documents}
        onClose={() => setViewingSnippet(null)}
      />
    </div>
  );
}
