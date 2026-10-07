import React, { useState } from 'react';
import { UserRole, Task } from '../types';
import { 
  FileCheck2, 
  UserCheck, 
  RotateCcw, 
  Layers, 
  Sparkles, 
  CheckCircle2, 
  FileText,
  HelpCircle,
  Sliders,
  ChevronDown,
  ShieldAlert
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
  const [showSandboxBar, setShowSandboxBar] = useState(true);

  return (
    <header className="sticky top-0 z-40 shadow-sm border-b border-slate-800">
      {/* 1. Main Official Application Navigation Bar */}
      <div className="bg-slate-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Left: Brand and Task Title */}
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded bg-blue-600 flex items-center justify-center font-bold text-white shadow-xs">
                <FileCheck2 className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                  <span>公文辅助协作原型系统</span>
                  <span className="text-xs bg-blue-900/90 text-blue-300 px-2 py-0.5 rounded font-mono border border-blue-700/60">
                    本地演示版
                  </span>
                </div>
                <p className="text-xs text-slate-400 hidden sm:block">
                  面向机关文稿主笔与审阅者 · 严谨事实追溯与文风适配
                </p>
              </div>
            </div>

            <div className="h-6 w-px bg-slate-700 hidden md:block" />

            {/* Current Task Selector */}
            <div className="hidden md:flex items-center space-x-2">
              <FileText className="w-4 h-4 text-slate-400" />
              <label htmlFor="navbar-task-select" className="sr-only">当前处理公文任务</label>
              <select
                id="navbar-task-select"
                value={currentTask.id}
                onChange={(e) => onSelectTask(e.target.value)}
                className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer max-w-sm truncate"
              >
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} ({t.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Right: Demo Sandbox Toggle & Status */}
          <div className="flex items-center space-x-3 text-sm">
            <button
              onClick={() => setShowSandboxBar(!showSandboxBar)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition-colors cursor-pointer ${
                showSandboxBar
                  ? 'bg-purple-900/60 text-purple-200 border-purple-700 hover:bg-purple-900/80'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
              }`}
              title="切换演示辅助工具条"
            >
              <Sliders className="w-3.5 h-3.5 text-purple-400" />
              <span>{showSandboxBar ? '收起演示专区' : '展开演示专区'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. Clearly Marked Demo Sandbox Area */}
      {showSandboxBar && (
        <div className="bg-purple-950 text-purple-100 border-t border-purple-900/80 px-4 sm:px-6 lg:px-8 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="bg-purple-700 text-white text-xs px-2 py-0.5 rounded font-bold uppercase tracking-wider shrink-0">
                演练辅助专区
              </span>
              <span className="text-xs text-purple-200 font-medium hidden sm:inline">
                供评审与技术验证使用（模拟多人角色交互与典型数据场景，非正式服务端鉴权）
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Active Role Selector */}
              <div className="flex items-center bg-purple-900/80 border border-purple-800 rounded p-0.5 text-xs">
                <span className="text-purple-300 px-2 flex items-center gap-1 font-medium">
                  <UserCheck className="w-3.5 h-3.5 text-purple-300" />
                  模拟身份:
                </span>
                {(['主笔甲', '审阅乙', '审阅丁', '供稿丙'] as UserRole[]).map((role) => (
                  <button
                    key={role}
                    onClick={() => onSelectRole(role)}
                    className={`px-2.5 py-1 rounded transition-colors text-xs font-medium cursor-pointer ${
                      activeRole === role
                        ? 'bg-purple-600 text-white shadow-xs font-bold'
                        : 'text-purple-300 hover:text-white hover:bg-purple-800/80'
                    }`}
                    title={`切换演示身份为：${role}`}
                  >
                    {role}
                  </button>
                ))}
              </div>

              {/* Preset Scenario Selector */}
              <div className="relative group">
                <button className="flex items-center gap-1.5 px-3 py-1 bg-purple-900/90 hover:bg-purple-800 border border-purple-700 rounded text-purple-100 text-xs font-medium transition-colors cursor-pointer">
                  <Layers className="w-3.5 h-3.5 text-amber-300" />
                  <span>载入预置场景</span>
                  <ChevronDown className="w-3 h-3 text-purple-300" />
                </button>
                <div className="absolute right-0 mt-1 w-64 bg-slate-900 border border-slate-700 rounded-md shadow-xl py-1 hidden group-hover:block z-50 animate-in fade-in duration-150">
                  <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
                    选择预置验收场景
                  </div>
                  <button
                    onClick={() => onLoadScenario('blank')}
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 hover:text-white flex flex-col cursor-pointer"
                  >
                    <span className="font-semibold text-slate-100">1. 空白新建任务</span>
                    <span className="text-xs text-slate-400">完整新建流程与参数校验</span>
                  </button>
                  <button
                    onClick={() => onLoadScenario('conflict_pending')}
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 hover:text-white flex flex-col cursor-pointer"
                  >
                    <span className="font-semibold text-amber-300">2. 存在口径冲突 (120 vs 128)</span>
                    <span className="text-xs text-slate-400">材料比对、冲突裁决与定稿阻断</span>
                  </button>
                  <button
                    onClick={() => onLoadScenario('ready_to_draft')}
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 hover:text-white flex flex-col cursor-pointer"
                  >
                    <span className="font-semibold text-blue-300">3. 事实大纲已确认待起草</span>
                    <span className="text-xs text-slate-400">文风规则抽取、大纲调整与起草</span>
                  </button>
                  <button
                    onClick={() => onLoadScenario('under_review')}
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 hover:text-white flex flex-col cursor-pointer"
                  >
                    <span className="font-semibold text-emerald-300">4. 审阅意见与篇幅冲突</span>
                    <span className="text-xs text-slate-400">审阅批注、篇幅协调与定稿导出</span>
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
                className="flex items-center gap-1 px-2.5 py-1 text-purple-200 hover:text-rose-200 hover:bg-rose-950/60 border border-purple-800 hover:border-rose-800 rounded transition-colors text-xs font-medium cursor-pointer"
                title="重置本地演示状态为默认"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>重置数据</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
