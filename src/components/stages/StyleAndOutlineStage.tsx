import React, { useState } from 'react';
import { 
  Task, 
  StyleRule, 
  OutlineSection, 
  UserRole, 
  EvidenceSnippet 
} from '../../types';
import { 
  BookOpen, 
  ListTree, 
  CheckCircle2, 
  AlertTriangle, 
  Plus, 
  Trash2, 
  ArrowUp, 
  ArrowDown, 
  ExternalLink, 
  FileText, 
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  HelpCircle
} from 'lucide-react';

interface StyleAndOutlineStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
}

export const StyleAndOutlineStage: React.FC<StyleAndOutlineStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
}) => {
  const [activeTab, setActiveTab] = useState<'outline' | 'style'>('outline');
  const [selectedStructureTemplate, setSelectedStructureTemplate] = useState<'standard' | 'problem_driven'>('standard');

  // New section modal
  const [showAddSectionModal, setShowAddSectionModal] = useState(false);
  const [newSecTitle, setNewSecTitle] = useState('');
  const [newSecPurpose, setNewSecPurpose] = useState('');
  const [newSecWordCount, setNewSecWordCount] = useState(800);

  // Check if prerequisites are met
  const factsConfirmed = !!task.factSnapshot;
  const hasConflictPending = task.facts.some((f) => f.hasConflict && !f.selectedConflictValue);

  // Word count stats
  const totalSuggestedWords = task.outline.reduce((acc, s) => acc + s.suggestedWordCount, 0);
  const targetWords = task.targetWordCount;
  const wordDiff = totalSuggestedWords - targetWords;

  // Move section
  const handleMoveSection = (index: number, direction: 'up' | 'down') => {
    const newOutline = [...task.outline];
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= newOutline.length) return;

    const temp = newOutline[index];
    newOutline[index] = newOutline[targetIdx];
    newOutline[targetIdx] = temp;

    // update orders
    newOutline.forEach((s, idx) => {
      s.order = idx + 1;
    });

    onUpdateTask({
      outline: newOutline,
      outlineConfirmed: false, // Invalidate outline confirmed state on change
    });
  };

  const handleDeleteSection = (secId: string) => {
    if (task.outline.length <= 1) {
      alert('文稿至少需要保留一个主体章节');
      return;
    }
    const newOutline = task.outline.filter((s) => s.id !== secId).map((s, idx) => ({ ...s, order: idx + 1 }));
    onUpdateTask({
      outline: newOutline,
      outlineConfirmed: false,
    });
  };

  const handleAddSection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSecTitle.trim()) return;

    const newSection: OutlineSection = {
      id: `SEC-${Date.now().toString(36)}`,
      order: task.outline.length + 1,
      title: newSecTitle.trim(),
      purpose: newSecPurpose.trim() || '概述相关专项业务举措与阶段成效',
      suggestedWordCount: newSecWordCount,
      assignedFactIds: [],
      uncoveredRequirements: [],
      hasMaterialGap: false,
      confirmed: false,
    };

    onUpdateTask({
      outline: [...task.outline, newSection],
      outlineConfirmed: false,
    });

    setShowAddSectionModal(false);
    setNewSecTitle('');
    setNewSecPurpose('');
    setNewSecWordCount(800);
  };

  const handleConfirmStyle = () => {
    onUpdateTask({
      styleConfirmed: true,
    });
  };

  const handleConfirmOutline = () => {
    if (!factsConfirmed) {
      alert('前序事实清单尚未确认。请先返回“材料与事实”阶段确认事实清单。');
      return;
    }

    onUpdateTask({
      outlineConfirmed: true,
      status: '起草中',
    });
  };

  const handleApplyTemplate = (type: 'standard' | 'problem_driven') => {
    setSelectedStructureTemplate(type);
    if (type === 'standard') {
      const standardSections: OutlineSection[] = [
        {
          id: 'SEC-01',
          order: 1,
          title: '一、前三季度总体运行态势与工作成效',
          purpose: '全面总结2026年前三季度总体履职进展，展示重点任务、业务培训和专题调研的核心成效。',
          suggestedWordCount: 1200,
          assignedFactIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
          uncoveredRequirements: [],
          hasMaterialGap: false,
          confirmed: true,
        },
        {
          id: 'SEC-02',
          order: 2,
          title: '二、存在的主要短板与突出问题',
          purpose: '客观分析当前工作中在协调机制、数字化支撑及基层满意度深化方面存在的困难与短板。',
          suggestedWordCount: 800,
          assignedFactIds: ['FACT-06'],
          uncoveredRequirements: ['服务满意度量化数据待补充'],
          hasMaterialGap: true,
          gapDescription: '服务满意度尚缺量化评估支撑材料',
          confirmed: true,
        },
        {
          id: 'SEC-03',
          order: 3,
          title: '三、四季度重点攻坚方向与工作安排',
          purpose: '围绕全年目标冲刺，提出冲刺攻坚重点任务、深化常态化培训调研的针对性举措。',
          suggestedWordCount: 1000,
          assignedFactIds: [],
          uncoveredRequirements: [],
          hasMaterialGap: false,
          confirmed: true,
        },
      ];
      onUpdateTask({ outline: standardSections, outlineConfirmed: false });
    } else {
      const problemDrivenSections: OutlineSection[] = [
        {
          id: 'SEC-P1',
          order: 1,
          title: '一、对照年度既定攻坚目标的推进成效与数据对照',
          purpose: '以年度目标完成进度为线索，重点汇报各项核心业务完成情况与指标支撑。',
          suggestedWordCount: 1400,
          assignedFactIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
          uncoveredRequirements: [],
          hasMaterialGap: false,
          confirmed: true,
        },
        {
          id: 'SEC-P2',
          order: 2,
          title: '二、基层反映突出的重难点问题与根因分析',
          purpose: '梳理调查研究与日常监督中基层反映的突出难点，剖析制约机制。',
          suggestedWordCount: 800,
          assignedFactIds: ['FACT-06'],
          uncoveredRequirements: ['服务满意度量化数据待补充'],
          hasMaterialGap: true,
          gapDescription: '满意度指标暂无量化数据支撑',
          confirmed: true,
        },
        {
          id: 'SEC-P3',
          order: 3,
          title: '三、破除瓶颈、抓好落实的针对性举措',
          purpose: '针对前述问题逐条列出破解之策，明确牵头科室与完成时限。',
          suggestedWordCount: 800,
          assignedFactIds: [],
          uncoveredRequirements: [],
          hasMaterialGap: false,
          confirmed: true,
        },
      ];
      onUpdateTask({ outline: problemDrivenSections, outlineConfirmed: false });
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-blue-700" />
              阶段03：单位文风提取与大纲规划确认
            </h2>
            {task.outlineConfirmed ? (
              <span className="text-xs bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> 大纲已确认锁定
              </span>
            ) : (
              <span className="text-xs bg-blue-100 text-blue-800 border border-blue-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <RefreshCw className="w-3.5 h-3.5" /> 待主笔调整确认
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            从本单位历史样稿中提炼文风规范（旧年份96项严密隔离为样式参考）；根据已确认事实搭建三段式大纲并分配数据依据。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleConfirmOutline}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>确认大纲并进入起草</span>
          </button>

          <button
            onClick={onProceedToNextStage}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <span>下一步：正文起草</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Prerequisite Warnings */}
      {!factsConfirmed && (
        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              <strong>提示：</strong>阶段02的事实清单尚未生成快照。建议先返回确认事实清单，避免后续正文引用未核验数据。
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg px-4 pt-2">
        <button
          onClick={() => setActiveTab('outline')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'outline'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <ListTree className="w-4 h-4" />
          <span>公文大纲规划与事实分配 ({task.outline.length}个章节)</span>
        </button>

        <button
          onClick={() => setActiveTab('style')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'style'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>单位文风规范提炼 ({task.styleRules.length}条规则)</span>
          {task.styleConfirmed && (
            <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded font-medium">
              已确认
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: 大纲规划 */}
      {activeTab === 'outline' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-5">
          {/* Controls: Template Switcher & Word Count Bar */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-700">预设大纲结构：</span>
              <button
                onClick={() => handleApplyTemplate('standard')}
                className={`px-2.5 py-1 rounded transition-colors text-xs font-medium cursor-pointer ${
                  selectedStructureTemplate === 'standard'
                    ? 'bg-blue-700 text-white'
                    : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                标准三段式 (成效/问题/安排)
              </button>
              <button
                onClick={() => handleApplyTemplate('problem_driven')}
                className={`px-2.5 py-1 rounded transition-colors text-xs font-medium cursor-pointer ${
                  selectedStructureTemplate === 'problem_driven'
                    ? 'bg-blue-700 text-white'
                    : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                目标导向型 (目标对照/瓶颈剖析/攻坚之策)
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-slate-600">
                <span>总字数规划：</span>
                <strong className="text-slate-900 font-mono text-sm">{totalSuggestedWords}</strong>
                <span>/ 目标 {targetWords} 字</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    Math.abs(wordDiff) <= 200
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {wordDiff >= 0 ? `+${wordDiff}` : wordDiff} 字
                </span>
              </div>

              <button
                onClick={() => setShowAddSectionModal(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded text-xs font-medium cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>增加章节</span>
              </button>
            </div>
          </div>

          {/* Outline Sections List */}
          <div className="space-y-3">
            {task.outline.map((sec, idx) => {
              const assignedFacts = task.facts.filter((f) => sec.assignedFactIds.includes(f.id));

              return (
                <div
                  key={sec.id}
                  className="p-4 border border-slate-200 rounded-lg hover:border-slate-300 bg-white transition-all space-y-3"
                >
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center text-xs font-bold font-mono">
                        {sec.order}
                      </span>
                      <input
                        type="text"
                        value={sec.title}
                        onChange={(e) => {
                          const updated = task.outline.map((s) => (s.id === sec.id ? { ...s, title: e.target.value } : s));
                          onUpdateTask({ outline: updated, outlineConfirmed: false });
                        }}
                        className="text-xs font-bold text-slate-900 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-hidden py-0.5 px-1 w-72 sm:w-96"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 text-xs">
                      <div className="flex items-center gap-1 bg-slate-100 px-2 py-1 rounded text-slate-600">
                        <span>建议字数:</span>
                        <input
                          type="number"
                          value={sec.suggestedWordCount}
                          onChange={(e) => {
                            const updated = task.outline.map((s) =>
                              s.id === sec.id ? { ...s, suggestedWordCount: parseInt(e.target.value) || 0 } : s
                            );
                            onUpdateTask({ outline: updated, outlineConfirmed: false });
                          }}
                          className="w-16 bg-white border border-slate-300 rounded px-1 text-center font-mono text-xs"
                        />
                        <span>字</span>
                      </div>

                      <button
                        onClick={() => handleMoveSection(idx, 'up')}
                        disabled={idx === 0}
                        className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        title="上移章节"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleMoveSection(idx, 'down')}
                        disabled={idx === task.outline.length - 1}
                        className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        title="下移章节"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleDeleteSection(sec.id)}
                        className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                        title="删除章节"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Section Purpose */}
                  <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded border border-slate-200/70">
                    <span className="font-semibold text-slate-700">章节目标：</span>
                    <input
                      type="text"
                      value={sec.purpose}
                      onChange={(e) => {
                        const updated = task.outline.map((s) => (s.id === sec.id ? { ...s, purpose: e.target.value } : s));
                        onUpdateTask({ outline: updated, outlineConfirmed: false });
                      }}
                      className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-hidden w-full text-xs mt-1"
                    />
                  </div>

                  {/* Assigned Facts */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-[11px] font-semibold text-slate-500">拟用事实依据：</span>
                    {assignedFacts.length > 0 ? (
                      assignedFacts.map((fact) => {
                        const snippet = task.snippets.find((s) => s.id === fact.primaryEvidenceId);
                        return (
                          <div
                            key={fact.id}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-900 border border-blue-200 rounded text-[11px]"
                          >
                            <span className="font-medium">{fact.metric}:</span>
                            <span className="font-bold">
                              {fact.value} {fact.unit}
                            </span>
                            {snippet && (
                              <button
                                onClick={() => onViewSnippet(snippet)}
                                className="text-blue-600 hover:text-blue-900 ml-1 cursor-pointer"
                                title="查看原文片段"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <span className="text-[11px] text-slate-400 italic">（本章节暂未分配量化事实依据）</span>
                    )}

                    {sec.hasMaterialGap && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded text-[11px] font-medium">
                        <AlertTriangle className="w-3 h-3 text-amber-600" />
                        <span>待补材料：{sec.gapDescription}</span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: 单位文风 */}
      {activeTab === 'style' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-4">
          <div className="bg-purple-50/70 p-4 rounded-lg border border-purple-200 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-purple-900 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-purple-700" />
                单位历史定稿参考与文风规则提炼
              </h3>
              <button
                onClick={handleConfirmStyle}
                className="px-3 py-1 bg-purple-700 hover:bg-purple-800 text-white rounded text-xs font-medium cursor-pointer"
              >
                确认并采纳文风规则
              </button>
            </div>
            <p className="text-xs text-purple-800">
              参考材料：<strong>2025年度工作总结（SRC-04）</strong>。系统提炼标题结构、段落表达等规范。
              <span className="text-rose-700 font-bold ml-1">
                【严密隔离机制】2025年历史完成的96项仅作为行文例句参考，严禁带入2026年本期正文数据！
              </span>
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {task.styleRules.map((rule) => {
              const sampleDoc = task.documents.find((d) => d.id === rule.sampleDocId);

              return (
                <div
                  key={rule.id}
                  className="p-4 border border-slate-200 rounded-lg bg-slate-50/50 flex flex-col justify-between space-y-3"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">{rule.title}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-medium">
                        {rule.category}
                      </span>
                    </div>

                    <p className="text-xs text-slate-600 mt-2 leading-relaxed">{rule.description}</p>

                    <div className="mt-3 p-2.5 bg-white border border-slate-200 rounded text-xs text-slate-700 space-y-1">
                      <div className="text-[11px] font-semibold text-slate-400">样稿出处例句：</div>
                      <div className="font-mono text-slate-800 text-[11px] italic">“{rule.sampleSnippet}”</div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
                    <span>来源：{sampleDoc?.name || rule.sampleDocId}</span>
                    <button
                      onClick={() => {
                        const snip = task.snippets.find((s) => s.sourceDocId === rule.sampleDocId);
                        if (snip) onViewSnippet(snip);
                      }}
                      className="text-purple-700 hover:text-purple-900 font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <span>查看样稿原文</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Section Modal */}
      {showAddSectionModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">新增大纲章节</h3>
              <button
                onClick={() => setShowAddSectionModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleAddSection} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">章节标题</label>
                <input
                  type="text"
                  placeholder="例如：四、党建引领与干部队伍建设"
                  value={newSecTitle}
                  onChange={(e) => setNewSecTitle(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">章节目的与核心内容</label>
                <textarea
                  rows={2}
                  placeholder="阐明本章节主要总结的业务举措与预期目标..."
                  value={newSecPurpose}
                  onChange={(e) => setNewSecPurpose(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">建议字数 (字)</label>
                <input
                  type="number"
                  value={newSecWordCount}
                  onChange={(e) => setNewSecWordCount(parseInt(e.target.value) || 0)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddSectionModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认增加章节
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
