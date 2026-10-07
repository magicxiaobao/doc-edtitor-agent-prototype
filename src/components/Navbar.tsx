import React from 'react';
import { UserRole, Task } from '../types';
import { 
  FileCheck2, 
  UserCheck, 
  RotateCcw, 
  Layers, 
  Sparkles, 
  CheckCircle2, 
  FileText,
  HelpCircle
} from 'lucide-react';

interface NavbarProps {
  currentTask: Task;
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
  activeRole: UserRole;
  onSelectRole: (role: UserRole) => void;
  onLoadScenario: (scenario: 'blank' | 'conflict_pending' | 'ready_to_draft' | 'under_review') => void;
  onResetData: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTask,
  tasks,
  onSelectTask,
  activeRole,
  onSelectRole,
  onLoadScenario,
  onResetData,
}) => {
  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-40 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
        {/* Left: Brand and Task Title */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center font-bold text-white shadow-xs">
              <FileCheck2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
                <span>公文辅助协作原型</span>
                <span className="text-[10px] bg-blue-900/80 text-blue-300 px-1.5 py-0.5 rounded font-mono border border-blue-700/50">
                  DEMO v0.1
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                面向主笔与审阅者 · 严谨事实追溯与文风适配
              </p>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-700 hidden md:block" />

          {/* Current Task Selector */}
          <div className="hidden lg:flex items-center space-x-2">
            <FileText className="w-4 h-4 text-slate-400" />
            <select
              value={currentTask.id}
              onChange={(e) => onSelectTask(e.target.value)}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2.5 py-1 focus:ring-1 focus:ring-blue-500 focus:outline-hidden cursor-pointer max-w-xs truncate"
            >
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.status})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Right: Role Switcher, Scenarios, and Actions */}
        <div className="flex items-center space-x-3 text-xs">
          {/* Active Role Selector */}
          <div className="flex items-center bg-slate-800 border border-slate-700 rounded p-0.5">
            <span className="text-slate-400 px-2 flex items-center gap-1 text-[11px]">
              <UserCheck className="w-3.5 h-3.5 text-blue-400" />
              当前角色:
            </span>
            {(['主笔甲', '审阅乙', '审阅丁', '供稿丙'] as UserRole[]).map((role) => (
              <button
                key={role}
                onClick={() => onSelectRole(role)}
                className={`px-2 py-1 rounded transition-colors text-xs font-medium cursor-pointer ${
                  activeRole === role
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-700/60'
                }`}
                title={`切换当前操作身份为${role}`}
              >
                {role}
              </button>
            ))}
          </div>

          {/* Preset Scenario Selector */}
          <div className="relative group hidden sm:block">
            <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-200 transition-colors cursor-pointer">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              <span>快速载入演示场景</span>
            </button>
            <div className="absolute right-0 mt-1 w-64 bg-slate-800 border border-slate-700 rounded-md shadow-xl py-1 hidden group-hover:block z-50 animate-in fade-in duration-150">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-700">
                预置验收场景
              </div>
              <button
                onClick={() => onLoadScenario('blank')}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 hover:text-white flex flex-col cursor-pointer"
              >
                <span className="font-medium text-slate-100">1. 空白新建任务</span>
                <span className="text-[11px] text-slate-400">验证任务创建、校验与必填规则</span>
              </button>
              <button
                onClick={() => onLoadScenario('conflict_pending')}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 hover:text-white flex flex-col cursor-pointer"
              >
                <span className="font-medium text-amber-300">2. 存在口径冲突 (120 vs 128)</span>
                <span className="text-[11px] text-slate-400">验证材料查看、冲突裁决与缺口</span>
              </button>
              <button
                onClick={() => onLoadScenario('ready_to_draft')}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 hover:text-white flex flex-col cursor-pointer"
              >
                <span className="font-medium text-blue-300">3. 事实大纲已确认待起草</span>
                <span className="text-[11px] text-slate-400">验证文风抽取、大纲调整与模拟起草</span>
              </button>
              <button
                onClick={() => onLoadScenario('under_review')}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 hover:text-white flex flex-col cursor-pointer"
              >
                <span className="font-medium text-emerald-300">4. 审阅意见与篇幅冲突</span>
                <span className="text-[11px] text-slate-400">验证审阅批注、篇幅冲突与定稿导出</span>
              </button>
            </div>
          </div>

          {/* Reset button */}
          <button
            onClick={() => {
              if (window.confirm('确认重置演示数据为系统初始状态吗？未保存的临时改动将被清除。')) {
                onResetData();
              }
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 text-slate-300 hover:text-rose-300 hover:bg-rose-950/40 border border-slate-700 hover:border-rose-800 rounded transition-colors cursor-pointer"
            title="重置本地演示状态"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden md:inline">重置演示</span>
          </button>
        </div>
      </div>
    </header>
  );
};
