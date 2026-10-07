import React, { useState } from 'react';
import { Task, UserRole, TaskStage } from '../../types';
import { 
  FileText, 
  Calendar, 
  Users, 
  Target, 
  Clock, 
  CheckSquare, 
  Plus, 
  Search, 
  Filter, 
  ArrowRight,
  AlertCircle,
  FolderOpen
} from 'lucide-react';

interface TaskSetupStageProps {
  currentTask: Task;
  tasks: Task[];
  onUpdateTask: (updated: Partial<Task>) => void;
  onSelectTask: (taskId: string) => void;
  onCreateTask: (newTask: Omit<Task, 'id' | 'documents' | 'snippets' | 'facts' | 'styleRules' | 'outline' | 'drafts' | 'reviewComments' | 'auditIssues'>) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
}

export const TaskSetupStage: React.FC<TaskSetupStageProps> = ({
  currentTask,
  tasks,
  onUpdateTask,
  onSelectTask,
  onCreateTask,
  onProceedToNextStage,
  activeRole,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');

  // Form states for modal
  const [formTitle, setFormTitle] = useState('');
  const [formDocType, setFormDocType] = useState<'工作总结' | '汇报材料' | '专项报告'>('工作总结');
  const [formUsage, setFormUsage] = useState('');
  const [formAudience] = useState('单位领导班子、各业务科室负责人');
  const [formStartDate, setFormStartDate] = useState('2026-01-01');
  const [formEndDate, setFormEndDate] = useState('2026-09-30');
  const [formTargetWords, setFormTargetWords] = useState(3000);
  const [formCoverage, setFormCoverage] = useState('重点攻坚完成数、干部教育培训人次、专题调研开展成效、短板弱项及四季度安排');
  const [formDeadline, setFormDeadline] = useState('2026-10-15');
  const [formError, setFormError] = useState<string | null>(null);

  // Filter tasks
  const filteredTasks = tasks.filter((t) => {
    const matchSearch = t.title.toLowerCase().includes(searchTerm.toLowerCase()) || t.usage.toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'all' || t.docType === filterType;
    return matchSearch && matchType;
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formTitle.trim()) {
      setFormError('任务主题与名称不能为空');
      return;
    }

    if (!formStartDate || !formEndDate) {
      setFormError('统计开始日期和结束日期均为必填项');
      return;
    }

    if (new Date(formStartDate) > new Date(formEndDate)) {
      setFormError('统计起止日期颠倒：统计开始日期不能晚于结束日期');
      return;
    }

    if (formTargetWords <= 0) {
      setFormError('目标字数必须大于0');
      return;
    }

    onCreateTask({
      title: formTitle.trim(),
      docType: formDocType,
      usage: formUsage.trim() || '单位重点工作专项汇总汇报',
      audience: formAudience,
      startDate: formStartDate,
      endDate: formEndDate,
      targetWordCount: formTargetWords,
      mandatoryCoverage: formCoverage.trim(),
      deadline: formDeadline,
      primaryAuthor: activeRole === '主笔甲' ? '主笔甲' : '主笔甲',
      currentStage: 'task_setup',
      status: '草稿',
      updatedAt: new Date().toISOString(),
      isFinalized: false,
      schemaVersion: 1,
      styleConfirmed: false,
      outlineConfirmed: false,
      currentDraftId: '',
    });

    setShowCreateModal(false);
    // Reset form
    setFormTitle('');
    setFormUsage('');
  };

  return (
    <div className="space-y-6">
      {/* Workbench Header & Quick Actions */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-blue-700" />
            公文起草任务工作台
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            管理当前单位所有工作总结与汇报撰写任务，统一设定写作目标、统计范围及刚性要求。
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs transition-colors cursor-pointer self-start md:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>新建公文任务</span>
        </button>
      </div>

      {/* Main Grid: Left Tasks Table / Right Current Task Requirements */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Task List / Switcher */}
        <div className="lg:col-span-5 bg-white rounded-lg border border-slate-200 shadow-2xs flex flex-col">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row gap-2 justify-between items-start sm:items-center">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-slate-800">全部任务列表</span>
              <span className="text-[11px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-mono">
                {filteredTasks.length}
              </span>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-40">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2" />
                <input
                  type="text"
                  placeholder="搜索任务..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full text-xs pl-7 pr-2 py-1 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="text-xs border border-slate-300 rounded py-1 px-1.5 bg-white text-slate-700"
              >
                <option value="all">全类别</option>
                <option value="工作总结">工作总结</option>
                <option value="汇报材料">汇报材料</option>
                <option value="专项报告">专项报告</option>
              </select>
            </div>
          </div>

          <div className="divide-y divide-slate-100 overflow-y-auto max-h-[500px]">
            {filteredTasks.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs">
                未检索到符合条件的公文任务
              </div>
            ) : (
              filteredTasks.map((t) => {
                const isSelected = t.id === currentTask.id;
                return (
                  <div
                    key={t.id}
                    onClick={() => onSelectTask(t.id)}
                    className={`p-3.5 transition-colors cursor-pointer flex flex-col gap-1.5 ${
                      isSelected
                        ? 'bg-blue-50/70 border-l-4 border-blue-700'
                        : 'hover:bg-slate-50 border-l-4 border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-xs text-slate-800 line-clamp-1">
                        {t.title}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                          t.status === '已定稿'
                            ? 'bg-emerald-100 text-emerald-800'
                            : t.status === '审阅中'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-slate-500">
                      <span>文种：{t.docType}</span>
                      <span>主笔：{t.primaryAuthor}</span>
                      <span>目标：{t.targetWordCount}字</span>
                    </div>

                    <div className="text-[11px] text-slate-400">
                      统计期间：{t.startDate} 至 {t.endDate}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Current Task Requirements Detail Form */}
        <div className="lg:col-span-7 bg-white rounded-lg border border-slate-200 shadow-2xs flex flex-col">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-xs text-slate-800">当前任务写作要求与配置</h3>
              <p className="text-[11px] text-slate-500">
                主笔可在此调整任务统计期间、受众目标与刚性要求。
              </p>
            </div>
            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-medium">
              当前编辑：{currentTask.title}
            </span>
          </div>

          <div className="p-5 space-y-4 text-xs">
            {/* Title & DocType */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <label className="font-semibold text-slate-700 flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5 text-blue-700" />
                  任务名称
                </label>
                <input
                  type="text"
                  value={currentTask.title}
                  onChange={(e) => onUpdateTask({ title: e.target.value })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">文种类别</label>
                <select
                  value={currentTask.docType}
                  onChange={(e) =>
                    onUpdateTask({
                      docType: e.target.value as '工作总结' | '汇报材料' | '专项报告',
                    })
                  }
                  className="w-full text-xs p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                >
                  <option value="工作总结">工作总结</option>
                  <option value="汇报材料">汇报材料</option>
                  <option value="专项报告">专项报告</option>
                </select>
              </div>
            </div>

            {/* Target & Audience */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 flex items-center gap-1">
                  <Target className="w-3.5 h-3.5 text-blue-700" />
                  汇报用途
                </label>
                <input
                  type="text"
                  value={currentTask.usage}
                  onChange={(e) => onUpdateTask({ usage: e.target.value })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-blue-700" />
                  目标受众
                </label>
                <input
                  type="text"
                  value={currentTask.audience}
                  onChange={(e) => onUpdateTask({ audience: e.target.value })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>
            </div>

            {/* Period and Word Count */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-blue-700" />
                  统计起始日期
                </label>
                <input
                  type="date"
                  value={currentTask.startDate}
                  onChange={(e) => onUpdateTask({ startDate: e.target.value })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-blue-700" />
                  统计截止日期
                </label>
                <input
                  type="date"
                  value={currentTask.endDate}
                  onChange={(e) => onUpdateTask({ endDate: e.target.value })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">目标篇幅 (字)</label>
                <input
                  type="number"
                  value={currentTask.targetWordCount}
                  onChange={(e) => onUpdateTask({ targetWordCount: parseInt(e.target.value) || 0 })}
                  className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>
            </div>

            {/* Mandatory Coverage */}
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 flex items-center gap-1">
                <CheckSquare className="w-3.5 h-3.5 text-blue-700" />
                必须覆盖的核心内容与指标要求
              </label>
              <textarea
                rows={3}
                value={currentTask.mandatoryCoverage}
                onChange={(e) => onUpdateTask({ mandatoryCoverage: e.target.value })}
                className="w-full text-xs p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                placeholder="例如：重点任务完成情况、干部教育培训人次、专项调研开展成效..."
              />
            </div>

            {/* Next stage CTA */}
            <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
              <div className="text-slate-500 text-[11px]">
                提示：完成任务要求设置后，请进入下一阶段整理单位材料与事实清单。
              </div>

              <button
                onClick={onProceedToNextStage}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                <span>下一步：整理材料与事实</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-xl w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-700" />
                新建公文写作任务
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="p-5 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">
                  任务主题 / 文稿名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="例如：某单位2026年前三季度工作总结"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">文种类别</label>
                  <select
                    value={formDocType}
                    onChange={(e) => setFormDocType(e.target.value as any)}
                    className="w-full p-2 border border-slate-300 rounded text-xs bg-white focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="工作总结">工作总结</option>
                    <option value="汇报材料">汇报材料</option>
                    <option value="专项报告">专项报告</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">目标篇幅 (字)</label>
                  <input
                    type="number"
                    value={formTargetWords}
                    onChange={(e) => setFormTargetWords(parseInt(e.target.value) || 0)}
                    className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">
                    统计起始日期 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formStartDate}
                    onChange={(e) => setFormStartDate(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">
                    统计截止日期 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formEndDate}
                    onChange={(e) => setFormEndDate(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">必须覆盖的核心内容</label>
                <textarea
                  rows={2}
                  value={formCoverage}
                  onChange={(e) => setFormCoverage(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认建立任务
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
