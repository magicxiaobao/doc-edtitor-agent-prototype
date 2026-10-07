import React, { useState } from 'react';
import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  UserRole, 
  EvidenceSnippet 
} from '../../types';
import { 
  generateDraftFromFactsAndOutline, 
  generateParagraphRevision, 
  RevisionAction, 
  RevisionSuggestion 
} from '../../services/mockDraftService';
import { 
  PenTool, 
  Sparkles, 
  Save, 
  History, 
  FileText, 
  ChevronLeft, 
  ChevronRight, 
  Check, 
  X, 
  RotateCcw, 
  ExternalLink, 
  AlertCircle, 
  ArrowRight,
  ShieldAlert,
  Edit3
} from 'lucide-react';

interface DraftingStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
}

export const DraftingStage: React.FC<DraftingStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
}) => {
  // Active draft version
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];

  // Collapsible panels
  const [showLeftNav, setShowLeftNav] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);

  // Selected block for editing / inspection
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCandidateBlocks, setPendingCandidateBlocks] = useState<ParagraphBlock[] | null>(null);

  // Local revision state
  const [revisionSuggestion, setRevisionSuggestion] = useState<RevisionSuggestion | null>(null);

  // Manual Version Save Modal
  const [showSaveVersionModal, setShowSaveVersionModal] = useState(false);
  const [versionSummary, setVersionSummary] = useState('');

  // Version History Drawer
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  // Check role permission
  const isReviewerOnly = activeRole === '审阅乙' || activeRole === '审阅丁';

  // Selected block object
  const activeBlock = currentDraft?.blocks.find((b) => b.id === selectedBlockId) || currentDraft?.blocks[0];

  // Total word count of current draft
  const currentWordCount = currentDraft?.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;

  // Handle Generate / Regenerate
  const handleStartGenerate = () => {
    if (!task.outlineConfirmed) {
      alert('请先完成大纲确认，再执行初稿生成。');
      return;
    }

    setIsGenerating(true);
    setTimeout(() => {
      const generatedBlocks = generateDraftFromFactsAndOutline(task);
      if (task.drafts.length === 0) {
        // Direct initial draft
        const initialDraft: DraftVersion = {
          id: `DRAFT-${Date.now()}`,
          versionNumber: 'v1.0 (初稿)',
          createdAt: new Date().toISOString(),
          author: activeRole,
          summary: '系统根据已确认事实及大纲生成的首个完整初稿版本',
          blocks: generatedBlocks,
        };
        onUpdateTask({
          drafts: [initialDraft],
          currentDraftId: initialDraft.id,
          status: '起草中',
        });
      } else {
        // Offer candidate blocks for comparison
        setPendingCandidateBlocks(generatedBlocks);
      }
      setIsGenerating(false);
    }, 600);
  };

  const handleAcceptCandidate = () => {
    if (!pendingCandidateBlocks) return;
    const newVersion: DraftVersion = {
      id: `DRAFT-${Date.now()}`,
      versionNumber: `v1.${task.drafts.length}`,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: '基于最新已确认事实重新生成的初稿版本',
      blocks: pendingCandidateBlocks,
    };
    onUpdateTask({
      drafts: [newVersion, ...task.drafts],
      currentDraftId: newVersion.id,
    });
    setPendingCandidateBlocks(null);
  };

  const handleUpdateBlockContent = (blockId: string, newContent: string) => {
    if (isReviewerOnly) {
      alert('当前角色为审阅者，仅具有提出意见权限，不可直接修改正文。如需修改请切换角色为“主笔甲”。');
      return;
    }

    if (!currentDraft) return;

    const updatedBlocks = currentDraft.blocks.map((b) => {
      if (b.id === blockId) {
        return {
          ...b,
          content: newContent,
          updatedAt: new Date().toISOString(),
        };
      }
      return b;
    });

    const updatedDrafts = task.drafts.map((d) => (d.id === currentDraft.id ? { ...d, blocks: updatedBlocks } : d));
    onUpdateTask({ drafts: updatedDrafts });
  };

  // Local revision action
  const handleRequestRevision = (action: RevisionAction) => {
    if (!activeBlock) return;
    const suggestion = generateParagraphRevision(activeBlock, action);
    setRevisionSuggestion(suggestion);
  };

  const handleAdoptRevision = () => {
    if (!revisionSuggestion || !activeBlock) return;

    // Check if base block was modified after suggestion was generated
    if (activeBlock.updatedAt !== revisionSuggestion.baseBlockUpdatedAt) {
      if (!window.confirm('检测到该段落在生成建议后已被主笔人工编辑。是否仍确认采纳并覆盖？')) {
        return;
      }
    }

    handleUpdateBlockContent(activeBlock.id, revisionSuggestion.suggestedText);
    setRevisionSuggestion(null);
  };

  // Save version snapshot
  const handleSaveVersion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentDraft) return;

    const snapshotVersion: DraftVersion = {
      id: `DRAFT-${Date.now()}`,
      versionNumber: `v1.${task.drafts.length} (${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })})`,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: versionSummary.trim() || '主笔手动保存的稿件快照',
      blocks: JSON.parse(JSON.stringify(currentDraft.blocks)),
    };

    onUpdateTask({
      drafts: [snapshotVersion, ...task.drafts],
      currentDraftId: snapshotVersion.id,
    });

    setShowSaveVersionModal(false);
    setVersionSummary('');
  };

  // Restore history draft
  const handleRestoreDraft = (version: DraftVersion) => {
    const restoredVersion: DraftVersion = {
      id: `DRAFT-RESTORED-${Date.now()}`,
      versionNumber: `v${task.drafts.length + 1}.0 (恢复自${version.versionNumber})`,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: `恢复自历史版本 ${version.versionNumber}：${version.summary}`,
      blocks: JSON.parse(JSON.stringify(version.blocks)),
    };

    onUpdateTask({
      drafts: [restoredVersion, ...task.drafts],
      currentDraftId: restoredVersion.id,
    });
    setShowVersionHistory(false);
  };

  return (
    <div className="space-y-4">
      {/* Top Banner */}
      <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-blue-50 text-blue-700 flex items-center justify-center">
            <PenTool className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-800">
                阶段04：正文起草与依据追溯工作台
              </h2>
              {currentDraft && (
                <span className="text-[11px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-mono">
                  {currentDraft.versionNumber}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              白色文稿为视觉核心 · 结构化段落与事实紧密绑定 · 支持局部扩写/压缩及出处反查
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isReviewerOnly && (
            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded flex items-center gap-1 font-medium">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
              当前为审阅身份（仅读/批注模式）
            </span>
          )}

          {task.drafts.length === 0 ? (
            <button
              onClick={handleStartGenerate}
              disabled={isGenerating}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isGenerating ? '起草生成中...' : '生成首轮初稿'}</span>
            </button>
          ) : (
            <>
              <button
                onClick={() => setShowSaveVersionModal(true)}
                disabled={isReviewerOnly}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <Save className="w-3.5 h-3.5 text-slate-500" />
                <span>保存新版本</span>
              </button>

              <button
                onClick={() => setShowVersionHistory(true)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer"
              >
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span>版本历史 ({task.drafts.length})</span>
              </button>

              <button
                onClick={handleStartGenerate}
                disabled={isGenerating || isReviewerOnly}
                className="px-3 py-1.5 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span>重新生成候选稿</span>
              </button>

              <button
                onClick={onProceedToNextStage}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1 cursor-pointer"
              >
                <span>下一步：审阅修改</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Candidate comparison banner if present */}
      {pendingCandidateBlocks && (
        <div className="bg-amber-50 border-2 border-amber-300 p-4 rounded-lg flex items-center justify-between shadow-xs">
          <div>
            <h4 className="font-bold text-xs text-amber-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-600" />
              已生成新一轮候选文稿（基于最新已确认事实）
            </h4>
            <p className="text-[11px] text-amber-800 mt-0.5">
              请主笔审阅是否采纳替换现有文稿。替换后现有版本将自动归档入历史记录。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPendingCandidateBlocks(null)}
              className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded text-xs hover:bg-slate-50 cursor-pointer"
            >
              放弃候选稿
            </button>
            <button
              onClick={handleAcceptCandidate}
              className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs cursor-pointer"
            >
              采纳并替换为新版本
            </button>
          </div>
        </div>
      )}

      {/* 3-Column Document Workspace */}
      <div className="grid grid-cols-12 gap-4 items-start min-h-[640px]">
        {/* Left: Collapsible Outline Navigation */}
        {showLeftNav ? (
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-3 sticky top-18 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-blue-700" />
                文稿章节大纲
              </span>
              <button
                onClick={() => setShowLeftNav(false)}
                className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="折叠导航栏"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              {task.outline.map((sec) => (
                <div
                  key={sec.id}
                  className="p-2.5 rounded bg-slate-50 hover:bg-blue-50/60 border border-slate-200/60 transition-colors cursor-pointer text-xs"
                >
                  <div className="font-semibold text-slate-800 line-clamp-1">{sec.title}</div>
                  <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
                    <span>建议：{sec.suggestedWordCount}字</span>
                    <span>{sec.assignedFactIds.length}项依据</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
              <div>当前正文字数：<strong className="text-slate-800 font-mono">{currentWordCount}</strong> 字</div>
              <div>目标字数：<strong className="text-slate-800 font-mono">{task.targetWordCount}</strong> 字</div>
            </div>
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowLeftNav(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开章节导航"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Center: White Document Editor Canvas */}
        <div
          className={`${
            showLeftNav && showRightInspector
              ? 'col-span-12 lg:col-span-6'
              : !showLeftNav && showRightInspector
              ? 'col-span-12 lg:col-span-8'
              : showLeftNav && !showRightInspector
              ? 'col-span-12 lg:col-span-9'
              : 'col-span-12'
          } bg-white rounded-lg border border-slate-200 shadow-sm p-6 sm:p-10 min-h-[640px] flex flex-col justify-between`}
        >
          {currentDraft ? (
            <div className="space-y-6">
              {/* Document Header */}
              <div className="text-center pb-6 border-b border-slate-200 space-y-2">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight font-serif">
                  {task.title}
                </h1>
                <div className="text-xs text-slate-500 space-y-0.5">
                  <p>统计期间：{task.startDate} 至 {task.endDate} · 汇报对象：{task.audience}</p>
                  <p className="text-[11px] text-slate-400">
                    拟稿人：{currentDraft.author} · 统计字数：{currentWordCount}字 · 版本：{currentDraft.versionNumber}
                  </p>
                </div>
              </div>

              {/* Document Paragraph Blocks */}
              <div className="space-y-6">
                {currentDraft.blocks.map((block, idx) => {
                  const isSelected = selectedBlockId === block.id || (!selectedBlockId && idx === 0);
                  const section = task.outline.find((s) => s.id === block.sectionId);
                  const isSectionFirstBlock = idx === 0 || currentDraft.blocks[idx - 1]?.sectionId !== block.sectionId;

                  return (
                    <div key={block.id} className="space-y-2">
                      {/* Section Title if First Block */}
                      {isSectionFirstBlock && section && (
                        <h2 className="text-base font-bold text-slate-800 pt-3 pb-1 border-b border-slate-100 flex items-center justify-between">
                          <span>{section.title}</span>
                          <span className="text-[11px] text-slate-400 font-normal">
                            建议 {section.suggestedWordCount} 字
                          </span>
                        </h2>
                      )}

                      {/* Block Container */}
                      <div
                        onClick={() => setSelectedBlockId(block.id)}
                        className={`group relative p-3 rounded-md transition-all cursor-text ${
                          isSelected
                            ? 'bg-blue-50/40 border-2 border-blue-600 shadow-xs ring-2 ring-blue-100'
                            : 'hover:bg-slate-50/80 border border-transparent'
                        }`}
                      >
                        {/* Paragraph content (editable) */}
                        <textarea
                          rows={Math.max(2, Math.ceil(block.content.length / 38))}
                          value={block.content}
                          disabled={isReviewerOnly}
                          onChange={(e) => handleUpdateBlockContent(block.id, e.target.value)}
                          className="w-full bg-transparent resize-none focus:outline-hidden text-slate-800 text-[15px] leading-relaxed text-justify indent-8 font-normal font-sans"
                        />

                        {/* Block metadata & facts pill */}
                        <div className="mt-2 flex flex-wrap items-center justify-between text-[11px] text-slate-400 pt-1.5 border-t border-slate-100/70">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[10px] text-slate-400">第{block.order || idx + 1}段</span>
                            {block.referencedFactIds.map((factId) => {
                              const fact = task.facts.find((f) => f.id === factId);
                              if (!fact) return null;
                              return (
                                <button
                                  key={fact.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const snippet = task.snippets.find((s) => s.id === fact.primaryEvidenceId);
                                    if (snippet) onViewSnippet(snippet);
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-blue-100/80 text-blue-800 hover:bg-blue-200 font-medium cursor-pointer"
                                  title={`点击追溯出处：${fact.metric}`}
                                >
                                  <span>{fact.metric}: {fact.value}{fact.unit}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              );
                            })}
                          </div>

                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-[10px] text-slate-400">点击选中段落查看AI修改建议</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="py-24 text-center space-y-4">
              <FileText className="w-12 h-12 text-slate-300 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-700">当前任务尚未生成正文草稿</h3>
                <p className="text-xs text-slate-400">
                  前序阶段已确认事实与大纲。点击上方“生成首轮初稿”按钮，系统将根据已确认指标进行确定性起草。
                </p>
              </div>
              <button
                onClick={handleStartGenerate}
                disabled={isGenerating}
                className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>立即生成初稿</span>
              </button>
            </div>
          )}
        </div>

        {/* Right: Collapsible Inspector / AI Revision Assistant */}
        {showRightInspector ? (
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-4 sticky top-18 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                段落修改与依据追溯
              </span>
              <button
                onClick={() => setShowRightInspector(false)}
                className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="折叠辅助面板"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Currently Focused Block Info */}
            {activeBlock ? (
              <div className="space-y-3">
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200/80 text-xs">
                  <div className="font-semibold text-slate-700">当前定位段落：第{activeBlock.order}段</div>
                  <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                    “{activeBlock.content}”
                  </p>
                </div>

                {/* Local AI Revision Tools */}
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-slate-600 block">段落精修操作：</span>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <button
                      onClick={() => handleRequestRevision('compress')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="精简压缩篇幅，保留16场、800人次等核心事实"
                    >
                      压缩精炼
                    </button>
                    <button
                      onClick={() => handleRequestRevision('expand')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="扩充细节举措与制度闭环"
                    >
                      举措扩写
                    </button>
                    <button
                      onClick={() => handleRequestRevision('formal')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="转换为标准庄重公文句式"
                    >
                      正式文风
                    </button>
                    <button
                      onClick={() => handleRequestRevision('highlight')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="突出核心成效与突破亮点"
                    >
                      突出重点
                    </button>
                  </div>
                </div>

                {/* Revision Diff Comparison Box */}
                {revisionSuggestion && (
                  <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg space-y-2 text-xs">
                    <div className="font-bold text-blue-900 flex items-center justify-between">
                      <span>修改建议预览</span>
                      <span className="text-[10px] bg-blue-200 text-blue-800 px-1.5 py-0.2 rounded font-mono">
                        {revisionSuggestion.action}
                      </span>
                    </div>

                    <div className="p-2 bg-white rounded border border-blue-100 text-slate-800 text-[11px] leading-relaxed">
                      {revisionSuggestion.suggestedText}
                    </div>

                    <div className="text-[10px] text-blue-800 leading-normal">
                      <strong>事实考量：</strong>{revisionSuggestion.diffExplanation}
                    </div>

                    <div className="pt-1 flex justify-end gap-1.5">
                      <button
                        onClick={() => setRevisionSuggestion(null)}
                        className="px-2.5 py-1 bg-white border border-slate-300 text-slate-600 rounded text-[11px] hover:bg-slate-50 cursor-pointer"
                      >
                        拒绝
                      </button>
                      <button
                        onClick={handleAdoptRevision}
                        className="px-3 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded text-[11px] font-semibold shadow-xs cursor-pointer"
                      >
                        采纳替换正文
                      </button>
                    </div>
                  </div>
                )}

                {/* Traced Facts in this Block */}
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <span className="text-[11px] font-bold text-slate-600 block">本段关联事实依据：</span>
                  {activeBlock.referencedFactIds.length > 0 ? (
                    activeBlock.referencedFactIds.map((factId) => {
                      const fact = task.facts.find((f) => f.id === factId);
                      const snippet = task.snippets.find((s) => s.id === fact?.primaryEvidenceId);
                      if (!fact) return null;

                      return (
                        <div key={fact.id} className="p-2 bg-slate-50 rounded border border-slate-200 text-xs space-y-1">
                          <div className="font-bold text-slate-800">{fact.metric}</div>
                          <div className="text-[11px] text-blue-700 font-semibold">
                            确认值：{fact.value} {fact.unit}
                          </div>
                          {snippet && (
                            <button
                              onClick={() => onViewSnippet(snippet)}
                              className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
                            >
                              <span>来源：{snippet.docName} ({snippet.location})</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-[11px] text-slate-400 italic">本段暂未绑定量化事实依据</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400">点击文稿中的段落以查看依据与修改建议</p>
            )}
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowRightInspector(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开辅助面板"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Save Version Snapshot Modal */}
      {showSaveVersionModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">保存正文历史版本快照</h3>
              <button
                onClick={() => setShowSaveVersionModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleSaveVersion} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">版本变更说明 / 摘要</label>
                <textarea
                  rows={3}
                  placeholder="例如：主笔手动调整第一部分重点指标表述，精炼培训成效段落"
                  value={versionSummary}
                  onChange={(e) => setVersionSummary(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSaveVersionModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认保存快照
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Version History Drawer */}
      {showVersionHistory && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <History className="w-4 h-4 text-blue-700" />
                文稿历史版本归档
              </h3>
              <button
                onClick={() => setShowVersionHistory(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {task.drafts.map((ver) => {
                const isCurrent = ver.id === currentDraft?.id;
                return (
                  <div
                    key={ver.id}
                    className={`p-3.5 rounded-lg border text-xs space-y-2 ${
                      isCurrent
                        ? 'border-blue-600 bg-blue-50/50'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">{ver.versionNumber}</span>
                      <span className="text-[11px] text-slate-400">
                        {new Date(ver.createdAt).toLocaleTimeString('zh-CN')}
                      </span>
                    </div>

                    <p className="text-slate-600 text-[11px]">{ver.summary}</p>
                    <div className="text-[10px] text-slate-400">保存人：{ver.author}</div>

                    <div className="pt-1 flex justify-end gap-2">
                      {!isCurrent && (
                        <button
                          onClick={() => handleRestoreDraft(ver)}
                          className="px-2.5 py-1 text-blue-700 hover:bg-blue-50 border border-blue-200 rounded text-[11px] font-medium cursor-pointer"
                        >
                          恢复至此版本 (生成新版本)
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
