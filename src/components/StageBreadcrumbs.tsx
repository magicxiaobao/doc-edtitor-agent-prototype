import React from 'react';
import { Task, TaskStage } from '../types';
import { getApplicableReviewComments } from '../services/draftLifecycleService';
import { 
  FileEdit, 
  Database, 
  BookOpen, 
  PenTool, 
  MessageSquare, 
  CheckCircle,
  AlertTriangle,
  Lock
} from 'lucide-react';

interface StageBreadcrumbsProps {
  currentStage: TaskStage;
  task: Task;
  onSelectStage: (stage: TaskStage) => void;
}

export const StageBreadcrumbs: React.FC<StageBreadcrumbsProps> = ({
  currentStage,
  task,
  onSelectStage,
}) => {
  const hasConflictPending = task.facts.some((f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded');
  const factsConfirmed = !!task.factSnapshot;
  const outlineConfirmed = task.outlineConfirmed;
  const hasDraft = task.drafts.length > 0;
  const currentDraft = task.drafts.find(d => d.id === task.currentDraftId) || task.drafts[0];
  // This badge opens the live review workspace, including new baseline opinions.
  const reviewComments = currentDraft ? getApplicableReviewComments(task, currentDraft) : [];
  const pendingCommentsCount = reviewComments.filter(c => ['pending', 'accepted_pending_implementation', 'need_discussion'].includes(c.status)).length;
  const hasPendingComments = pendingCommentsCount > 0;

  const stages: {
    id: TaskStage;
    number: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    isAccessible: boolean;
    badgeText?: string;
    badgeType?: 'success' | 'warning' | 'info' | 'locked';
  }[] = [
    {
      id: 'task_setup',
      number: '01',
      label: '任务要求',
      icon: FileEdit,
      isAccessible: true,
      badgeText: task.docType,
      badgeType: 'info',
    },
    {
      id: 'material_fact',
      number: '02',
      label: '材料与事实',
      icon: Database,
      isAccessible: true,
      badgeText: hasConflictPending ? '有待裁决冲突' : factsConfirmed ? '事实已确认' : '待确认',
      badgeType: hasConflictPending ? 'warning' : factsConfirmed ? 'success' : 'info',
    },
    {
      id: 'style_outline',
      number: '03',
      label: '文风与大纲',
      icon: BookOpen,
      isAccessible: true,
      badgeText: outlineConfirmed ? '大纲已确认' : '待确认',
      badgeType: outlineConfirmed ? 'success' : 'info',
    },
    {
      id: 'drafting',
      number: '04',
      label: '正文起草',
      icon: PenTool,
      isAccessible: true,
      badgeText: hasDraft ? `${task.drafts.length}个版本` : '可生成初稿',
      badgeType: hasDraft ? 'success' : 'info',
    },
    {
      id: 'review',
      number: '05',
      label: '审阅协作',
      icon: MessageSquare,
      isAccessible: true,
      badgeText: hasPendingComments ? `${pendingCommentsCount}条待处理` : '已阅',
      badgeType: hasPendingComments ? 'warning' : 'success',
    },
    {
      id: 'final_export',
      number: '06',
      label: '核校与导出',
      icon: CheckCircle,
      isAccessible: true,
      badgeText: task.isFinalized ? '已定稿' : '待定稿',
      badgeType: task.isFinalized ? 'success' : 'info',
    },
  ];

  return (
    <div className="bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 py-2.5 shadow-2xs">
      <div className="max-w-7xl mx-auto flex items-center justify-between overflow-x-auto no-scrollbar gap-2">
        <nav className="flex items-center space-x-1 sm:space-x-2 min-w-max" aria-label="工作阶段进度">
          {stages.map((st, idx) => {
            const isActive = currentStage === st.id;
            const Icon = st.icon;

            return (
              <React.Fragment key={st.id}>
                {idx > 0 && <span className="text-slate-300 font-light text-xs">/</span>}
                <button
                  onClick={() => onSelectStage(st.id)}
                  className={`flex items-center space-x-2 px-3 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    isActive
                      ? 'bg-blue-50 text-blue-800 border border-blue-200 font-semibold shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold ${
                      isActive ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-blue-700' : 'text-slate-400'}`} />
                  <span>{st.label}</span>

                  {st.badgeText && (
                    <span
                      className={`text-xs px-1.5 py-0.2 rounded font-normal ${
                        st.badgeType === 'warning'
                          ? 'bg-amber-100 text-amber-800 border border-amber-200'
                          : st.badgeType === 'success'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {st.badgeText}
                    </span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        {/* Stage Status Summary & Warning Pills */}
        <div className="hidden xl:flex items-center gap-2 text-xs">
          {hasConflictPending && (
            <div className="flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded text-xs">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              <span>发现 {task.facts.filter(f => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded').length} 项口径冲突需裁决</span>
            </div>
          )}
          <span className="text-slate-400 text-xs">
            更新时间：{new Date(task.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    </div>
  );
};
