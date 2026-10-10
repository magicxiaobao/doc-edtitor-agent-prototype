import React, { useState, useEffect } from 'react';
import { 
  Task, 
  DraftVersion, 
  DraftCandidate, 
  UserRole, 
  ParagraphBlock, 
  EvidenceSnippet, 
  CandidateComparisonViewMode, 
  AlignedParagraphRow 
} from '../types';
import { computeTextDiff } from '../services/diffService';
import { validateCandidateAcceptance } from '../services/draftLifecycleService';
import { computeDraftBlocksHash } from '../services/draftLifecycleService';
import { 
  X, 
  Sparkles, 
  Check, 
  AlertTriangle, 
  Split, 
  FileDiff, 
  Eye, 
  BookOpen, 
  RefreshCw, 
  ArrowLeft, 
  Tag, 
  Info, 
  ChevronRight, 
  ExternalLink,
  ChevronDown
} from 'lucide-react';

interface CandidateComparisonModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  currentDraft: DraftVersion | undefined;
  candidate: DraftCandidate | null;
  onAccept: () => void;
  onDiscard: () => void;
  onRegenerate: () => void;
  activeRole: UserRole;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  currentInstructionInput?: string;
  onInspectFact?: (factId: string) => void;
}

export const CandidateComparisonModal: React.FC<CandidateComparisonModalProps> = ({
  isOpen,
  onClose,
  task,
  currentDraft,
  candidate,
  onAccept,
  onDiscard,
  onRegenerate,
  activeRole,
  onViewSnippet,
  currentInstructionInput = '',
  onInspectFact,
}) => {
  // View mode
  const [viewMode, setViewMode] = useState<CandidateComparisonViewMode>('split');
  // Selected chapter/section filter (empty means all)
  const [selectedSectionId, setSelectedSectionId] = useState<string>('all');
  // Diagnostics toggle
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Reconcile all section IDs across currentDraft blocks, candidate blocks, and task.outline
  // MUST be declared before any conditional return null to satisfy React Rules of Hooks!
  interface ComparisonSectionItem {
    id: string;
    title: string;
    suggestedWordCount?: number;
    assignedFactIds?: string[];
    isDeletedFromOutline?: boolean;
    isAddedInOutline?: boolean;
  }

  const sections: ComparisonSectionItem[] = React.useMemo(() => {
    if (!candidate) return [];
    const sectionMap = new Map<string, ComparisonSectionItem>();
    
    // 1. First add outline sections from task
    (task.outline || []).forEach((sec) => {
      sectionMap.set(sec.id, {
        id: sec.id,
        title: sec.title,
        suggestedWordCount: sec.suggestedWordCount,
        assignedFactIds: sec.assignedFactIds,
        isDeletedFromOutline: false,
      });
    });

    // 2. Check snapshot outline sections if current draft has frozen outline metadata
    const frozenOutlineSections = currentDraft?.snapshotMetadata?.outlineSections || [];
    frozenOutlineSections.forEach((fSec) => {
      if (!sectionMap.has(fSec.id)) {
        sectionMap.set(fSec.id, {
          id: fSec.id,
          title: fSec.title,
          suggestedWordCount: fSec.suggestedWordCount,
          assignedFactIds: fSec.assignedFactIds,
          isDeletedFromOutline: true,
        });
      }
    });

    // 3. Scan currentDraft blocks for any section IDs
    (currentDraft?.blocks || []).forEach((b) => {
      if (b.sectionId && !sectionMap.has(b.sectionId)) {
        sectionMap.set(b.sectionId, {
          id: b.sectionId,
          title: `已删除章节【${b.sectionId}】`,
          suggestedWordCount: 0,
          assignedFactIds: [],
          isDeletedFromOutline: true,
        });
      }
    });

    // 4. Scan candidate blocks for any section IDs
    (candidate?.blocks || []).forEach((b) => {
      if (b.sectionId && !sectionMap.has(b.sectionId)) {
        sectionMap.set(b.sectionId, {
          id: b.sectionId,
          title: `新候选章节【${b.sectionId}】`,
          suggestedWordCount: 0,
          assignedFactIds: [],
          isAddedInOutline: true,
        });
      }
    });

    // Mark sections that exist in currentDraft but have NO blocks in candidate and are not in task.outline
    return Array.from(sectionMap.values()).map((sec) => {
      const existsInTaskOutline = (task.outline || []).some((o) => o.id === sec.id);
      return {
        ...sec,
        isDeletedFromOutline: !existsInTaskOutline,
      };
    });
  }, [task.outline, currentDraft, candidate]);

  if (!isOpen || !candidate) {
    return null;
  }

  // Word count calculations
  const currentWordCount = currentDraft?.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;
  const candidateWordCount = candidate.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;
  const wordCountDiff = candidateWordCount - currentWordCount;

  // Real-time acceptance validation
  const validationResult = validateCandidateAcceptance(
    task,
    currentDraft,
    candidate,
    candidate.runId,
    activeRole
  );

  // Live content change check
  const isContentModifiedAfterGen = Boolean(
    currentDraft &&
      candidate.baseDraftContentHash &&
      computeDraftBlocksHash(currentDraft.blocks) !== candidate.baseDraftContentHash
  );

  const isInvalidated = !validationResult.valid || isContentModifiedAfterGen;
  const invalidationReason =
    validationResult.reason ||
    (isContentModifiedAfterGen
      ? '基准正文已变更：在此候选生成后，正文已被人工编辑修改，采纳旧候选将覆盖人工修改！候选已失效，请重新生成或先保存快照。'
      : undefined);

  // Instruction prompt mismatch check
  const currentTrimmedInstruction = currentInstructionInput.trim();
  const candidatePrompt = (candidate.instructionPrompt || '').trim();
  const hasInstructionMismatch = Boolean(
    currentTrimmedInstruction &&
      candidatePrompt &&
      currentTrimmedInstruction !== candidatePrompt
  );

  // Format generated time
  const generatedTimeStr = candidate.generatedAt
    ? new Date(candidate.generatedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '刚刚';

  const filteredSections =
    selectedSectionId === 'all'
      ? sections
      : sections.filter((s) => s.id === selectedSectionId);

  // Compute aligned rows for a given section
  const getSectionAlignedRows = (sectionId: string): AlignedParagraphRow[] => {
    const curBlocks = currentDraft?.blocks.filter((b) => b.sectionId === sectionId) || [];
    const candBlocks = candidate.blocks.filter((b) => b.sectionId === sectionId) || [];

    const rows: AlignedParagraphRow[] = [];
    const processedCandidateBlockIds = new Set<string>();

    // 1. Check each current block
    curBlocks.forEach((cBlock) => {
      // Find candidate block with same ID
      const matchingCandBlock = candBlocks.find((b) => b.id === cBlock.id);
      if (matchingCandBlock) {
        processedCandidateBlockIds.add(matchingCandBlock.id);
        if (cBlock.content === matchingCandBlock.content) {
          rows.push({
            type: 'identical',
            blockId: cBlock.id,
            currentBlock: cBlock,
            candidateBlock: matchingCandBlock,
          });
        } else {
          rows.push({
            type: 'modified',
            blockId: cBlock.id,
            currentBlock: cBlock,
            candidateBlock: matchingCandBlock,
            diffSegments: computeTextDiff(cBlock.content, matchingCandBlock.content),
          });
        }
      } else {
        // Exists in current draft, but not in candidate draft -> removed
        rows.push({
          type: 'removed',
          blockId: cBlock.id,
          currentBlock: cBlock,
        });
      }
    });

    // 2. Check candidate blocks that have no matching current block -> added
    candBlocks.forEach((candBlock) => {
      if (!processedCandidateBlockIds.has(candBlock.id)) {
        rows.push({
          type: 'added',
          blockId: candBlock.id,
          candidateBlock: candBlock,
        });
      }
    });

    return rows;
  };

  // Total change counts across all sections
  let totalModified = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  sections.forEach((sec) => {
    const rows = getSectionAlignedRows(sec.id);
    rows.forEach((r) => {
      if (r.type === 'modified') totalModified++;
      if (r.type === 'added') totalAdded++;
      if (r.type === 'removed') totalRemoved++;
    });
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="candidate-modal-title"
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 md:p-6 overflow-hidden animate-in fade-in duration-200"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-7xl h-[92vh] max-h-[960px] flex flex-col overflow-hidden">
        {/* 1. Modal Top Bar */}
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/90 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-blue-100 text-blue-700 flex items-center justify-center border border-blue-200 shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 id="candidate-modal-title" className="text-sm font-bold text-slate-900 tracking-tight flex items-center gap-2">
                <span>整稿候选审阅与差异对比</span>
                <span className="text-xs font-normal text-slate-500">
                  ({totalModified}处修改 · {totalAdded}处新增 · {totalRemoved}处删除)
                </span>
              </h2>
              <div className="text-[11px] text-slate-500 flex items-center gap-2">
                <span>生成时刻：{generatedTimeStr}</span>
                <span aria-hidden="true">·</span>
                <span>写作要求：<strong className="text-slate-700 font-medium">{candidate.instructionPrompt || '标准公文规范起草'}</strong></span>
              </div>
            </div>
          </div>

          {/* View mode switcher */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center p-0.5 bg-slate-200/80 rounded-lg text-xs" role="tablist">
              <button
                role="tab"
                aria-selected={viewMode === 'split'}
                onClick={() => setViewMode('split')}
                className={`px-3 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  viewMode === 'split'
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="左右两栏同时对比当前稿与候选稿"
              >
                <Split className="w-3.5 h-3.5" />
                <span>双栏对比</span>
              </button>
              <button
                role="tab"
                aria-selected={viewMode === 'diff'}
                onClick={() => setViewMode('diff')}
                className={`px-3 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  viewMode === 'diff'
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="高亮标记逐句删改差异"
              >
                <FileDiff className="w-3.5 h-3.5" />
                <span>差异标记</span>
              </button>
              <button
                role="tab"
                aria-selected={viewMode === 'candidate'}
                onClick={() => setViewMode('candidate')}
                className={`px-3 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  viewMode === 'candidate'
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="仅查看候选稿全文"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>候选全文</span>
              </button>
              <button
                role="tab"
                aria-selected={viewMode === 'current'}
                onClick={() => setViewMode('current')}
                className={`px-3 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  viewMode === 'current'
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="仅查看当前稿正文"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>当前正文</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
              title="返回正文（保留候选稿）"
              aria-label="关闭对比窗口"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 2. Metadata Status Banner: Current vs Candidate Version Specs */}
        <div className="px-5 py-2.5 bg-slate-100 border-b border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs shrink-0">
          {/* Current draft specs */}
          <div className="flex items-center justify-between bg-white px-3 py-2 rounded border border-slate-200">
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500">基准对照稿（当前文稿）</div>
              <div className="font-bold text-slate-800 flex items-center gap-1.5">
                <span>{currentDraft?.versionNumber || '初始空白草稿'}</span>
                <span className="text-[10px] font-normal text-slate-500">
                  ({currentDraft?.isFinal ? '已定稿' : currentDraft?.isHistoricalSnapshot ? '历史快照' : '可编辑工作稿'})
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-slate-700 font-mono font-medium">{currentWordCount} 字</div>
              <div className="text-[10px] text-slate-400">
                {currentDraft?.snapshotMetadata?.factSnapshot ? '含冻结依据快照' : '暂无冻结快照'}
              </div>
            </div>
          </div>

          {/* Candidate draft specs */}
          <div className="flex items-center justify-between bg-white px-3 py-2 rounded border border-blue-200 shadow-2xs">
            <div className="space-y-0.5">
              <div className="text-[11px] text-blue-700 font-medium">起草候选稿（待主笔整体采纳）</div>
              <div className="font-bold text-blue-900 flex items-center gap-1.5">
                <span>新起草候选</span>
                <span className="text-[10px] font-normal text-blue-600 font-mono">
                  {wordCountDiff >= 0 ? `+${wordCountDiff}字` : `${wordCountDiff}字`}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-blue-900 font-mono font-bold">{candidateWordCount} 字</div>
              <div className="text-[10px] text-emerald-700 font-medium">基于最新已核准事实与大纲</div>
            </div>
          </div>
        </div>

        {/* 3. Invalidation Warning Alert if present */}
        {isInvalidated && (
          <div className="px-5 py-2.5 bg-rose-50 border-b border-rose-300 text-xs text-rose-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shrink-0">
            <div className="flex items-start sm:items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5 sm:mt-0" />
              <div>
                <strong className="font-bold text-rose-900">候选已失效：</strong>
                <span>{invalidationReason}</span>
              </div>
            </div>
            <button
              onClick={onRegenerate}
              className="px-3 py-1 bg-rose-700 hover:bg-rose-800 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shrink-0 self-start sm:self-auto"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>以最新正文重新起草</span>
            </button>
          </div>
        )}

        {/* 4. Instruction Mismatch Notice if user edited draftInstructionInput */}
        {hasInstructionMismatch && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                当前候选基于上一轮写作要求【<strong className="text-amber-950">{candidatePrompt}</strong>】生成；输入框已修改为新要求【
                <strong className="text-amber-950">{currentTrimmedInstruction}</strong>】。
              </span>
            </div>
            <button
              onClick={onRegenerate}
              className="px-2.5 py-0.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer shrink-0 self-start sm:self-auto"
            >
              <RefreshCw className="w-3 h-3" />
              <span>按新要求重新生成</span>
            </button>
          </div>
        )}

        {/* 5. Chapter/Section Jump Selector */}
        <div className="px-5 py-2 border-b border-slate-200 bg-white flex items-center gap-2 overflow-x-auto text-xs shrink-0">
          <span className="text-[11px] text-slate-400 font-medium shrink-0">章节导航：</span>
          <button
            onClick={() => setSelectedSectionId('all')}
            className={`px-2.5 py-1 rounded text-xs transition-colors shrink-0 cursor-pointer ${
              selectedSectionId === 'all'
                ? 'bg-blue-50 text-blue-800 font-bold border border-blue-300'
                : 'text-slate-600 hover:bg-slate-100 border border-transparent'
            }`}
          >
            全部章节 ({sections.length})
          </button>
          {sections.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => setSelectedSectionId(sec.id)}
              className={`px-2.5 py-1 rounded text-xs transition-colors shrink-0 cursor-pointer flex items-center gap-1 ${
                selectedSectionId === sec.id
                  ? 'bg-blue-50 text-blue-800 font-bold border border-blue-300'
                  : 'text-slate-600 hover:bg-slate-100 border border-slate-200/60'
              }`}
            >
              <span>{idx + 1}. {sec.title}</span>
              {sec.isDeletedFromOutline && (
                <span className="text-[10px] bg-rose-100 text-rose-800 border border-rose-300 px-1 py-0.2 rounded font-bold">
                  已删章节
                </span>
              )}
              {sec.isAddedInOutline && (
                <span className="text-[10px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-1 py-0.2 rounded font-bold">
                  候选新增
                </span>
              )}
            </button>
          ))}
        </div>

        {/* 6. Comparison Body Workspace */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-slate-50">
          {filteredSections.map((sec, sIdx) => {
            const rows = getSectionAlignedRows(sec.id);

            return (
              <div
                key={sec.id}
                className={`bg-white rounded-lg border shadow-2xs overflow-hidden ${
                  sec.isDeletedFromOutline
                    ? 'border-rose-300 ring-1 ring-rose-200'
                    : 'border-slate-200'
                }`}
              >
                {/* Section Header */}
                <div className={`px-4 py-2.5 border-b flex items-center justify-between ${
                  sec.isDeletedFromOutline
                    ? 'bg-rose-50 border-rose-200'
                    : 'bg-slate-100 border-slate-200'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                      <span>第 {sIdx + 1} 章节：{sec.title}</span>
                      {sec.isDeletedFromOutline && (
                        <span className="text-[10px] bg-rose-200 text-rose-900 border border-rose-400 px-1.5 py-0.2 rounded font-bold">
                          [大纲已删除章节 · 旧稿正文保留对照]
                        </span>
                      )}
                      {sec.isAddedInOutline && (
                        <span className="text-[10px] bg-emerald-200 text-emerald-900 border border-emerald-400 px-1.5 py-0.2 rounded font-bold">
                          [候选新增章节]
                        </span>
                      )}
                    </span>
                    {sec.suggestedWordCount ? (
                      <span className="text-[11px] text-slate-500">
                        (建议字数：{sec.suggestedWordCount}字)
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {sec.assignedFactIds ? `分配事实：${sec.assignedFactIds.length} 项` : ''}
                  </div>
                </div>

                {/* Section Paragraphs Comparison Rows */}
                <div className="divide-y divide-slate-100">
                  {rows.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400 italic">
                      本章节尚无段落内容
                    </div>
                  ) : (
                    rows.map((row, rIdx) => {
                      const isIdentical = row.type === 'identical';
                      const isModified = row.type === 'modified';
                      const isAdded = row.type === 'added';
                      const isRemoved = row.type === 'removed';

                      return (
                        <div key={row.blockId || rIdx} className="p-4 space-y-2">
                          {/* Paragraph Header with ID, Status badge, Facts */}
                          <div className="flex items-center justify-between text-xs pb-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-700">
                                第 {row.candidateBlock?.order || row.currentBlock?.order || rIdx + 1} 段
                              </span>
                              {isIdentical && (
                                <span className="text-[10px] text-slate-400">内容无变动</span>
                              )}
                              {isModified && (
                                <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-medium">
                                  文本已修改
                                </span>
                              )}
                              {isAdded && (
                                <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-medium">
                                  新增段落
                                </span>
                              )}
                              {isRemoved && (
                                <span className="text-[10px] bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-medium">
                                  已删除段落
                                </span>
                              )}
                            </div>

                            {/* Fact Tags on Paragraph */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {((row.candidateBlock || row.currentBlock)?.referencedFactIds || []).map(
                                (factId) => {
                                  const fact = task.facts.find((f) => f.id === factId);
                                  return (
                                    <button
                                      key={factId}
                                      onClick={() => onInspectFact && onInspectFact(factId)}
                                      className="text-[10px] bg-blue-50 text-blue-700 hover:bg-blue-100 px-1.5 py-0.5 rounded border border-blue-200 flex items-center gap-1 cursor-pointer transition-colors"
                                      title={`核对事实依据：${fact?.metric || factId}`}
                                    >
                                      <Tag className="w-2.5 h-2.5" />
                                      <span>{fact?.metric || factId}</span>
                                      {fact && (
                                        <span className="font-mono font-medium">
                                          ({fact.value}{fact.unit})
                                        </span>
                                      )}
                                    </button>
                                  );
                                }
                              )}
                            </div>
                          </div>

                          {/* Content according to viewMode */}
                          {/* 1. SPLIT MODE (2 Columns) */}
                          {viewMode === 'split' && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                              {/* Left: Current Block */}
                              <div
                                className={`p-3 rounded border leading-relaxed ${
                                  isRemoved
                                    ? 'bg-rose-50/60 border-rose-300 text-rose-950 line-through'
                                    : isModified
                                    ? 'bg-amber-50/40 border-amber-200 text-slate-800'
                                    : isAdded
                                    ? 'bg-slate-50 border-dashed border-slate-200 text-slate-400 italic'
                                    : 'bg-white border-slate-200 text-slate-800'
                                }`}
                              >
                                <div className="text-[10px] text-slate-400 mb-1 font-mono uppercase">
                                  当前稿内容
                                </div>
                                {row.currentBlock ? (
                                  <p>{row.currentBlock.content}</p>
                                ) : (
                                  <p className="text-slate-400 italic">当前版本中无此段落</p>
                                )}
                              </div>

                              {/* Right: Candidate Block */}
                              <div
                                className={`p-3 rounded border leading-relaxed ${
                                  isAdded
                                    ? 'bg-emerald-50/80 border-emerald-300 text-emerald-950 font-medium'
                                    : isModified
                                    ? 'bg-blue-50/70 border-blue-300 text-blue-950 font-medium'
                                    : isRemoved
                                    ? 'bg-slate-50 border-dashed border-slate-200 text-slate-400 italic'
                                    : 'bg-white border-slate-200 text-slate-800'
                                }`}
                              >
                                <div className="text-[10px] text-blue-700 mb-1 font-mono uppercase">
                                  候选稿建议
                                </div>
                                {row.candidateBlock ? (
                                  <p>{row.candidateBlock.content}</p>
                                ) : (
                                  <p className="text-slate-400 italic">候选版本中已移除此段落</p>
                                )}
                              </div>
                            </div>
                          )}

                          {/* 2. DIFF MODE (Inline Differences) */}
                          {viewMode === 'diff' && (
                            <div className="p-3 bg-white rounded border border-slate-200 text-sm leading-relaxed">
                              {isIdentical && row.currentBlock && (
                                <p className="text-slate-800">{row.currentBlock.content}</p>
                              )}
                              {isModified && row.diffSegments && (
                                <p className="space-x-0.5">
                                  {row.diffSegments.map((seg, sIdx) => {
                                    if (seg.type === 'equal') {
                                      return (
                                        <span key={sIdx} className="text-slate-800">
                                          {seg.text}
                                        </span>
                                      );
                                    }
                                    if (seg.type === 'removed') {
                                      return (
                                        <span
                                          key={sIdx}
                                          className="bg-rose-100 text-rose-800 line-through px-0.5 rounded"
                                          title="已删减原文"
                                        >
                                          {seg.text}
                                        </span>
                                      );
                                    }
                                    if (seg.type === 'added') {
                                      return (
                                        <span
                                          key={sIdx}
                                          className="bg-emerald-100 text-emerald-900 font-semibold px-0.5 rounded underline decoration-emerald-500"
                                          title="候选新增内容"
                                        >
                                          {seg.text}
                                        </span>
                                      );
                                    }
                                    return null;
                                  })}
                                </p>
                              )}
                              {isAdded && row.candidateBlock && (
                                <p className="bg-emerald-50 text-emerald-900 font-medium p-2 rounded border border-emerald-200">
                                  <strong className="text-emerald-800 mr-1">[新增段落]</strong>
                                  {row.candidateBlock.content}
                                </p>
                              )}
                              {isRemoved && row.currentBlock && (
                                <p className="bg-rose-50 text-rose-800 line-through p-2 rounded border border-rose-200">
                                  <strong className="text-rose-900 mr-1">[删除段落]</strong>
                                  {row.currentBlock.content}
                                </p>
                              )}
                            </div>
                          )}

                          {/* 3. CANDIDATE ONLY MODE */}
                          {viewMode === 'candidate' && (
                            <div className="p-3 bg-white rounded border border-slate-200 text-sm leading-relaxed text-slate-800">
                              {row.candidateBlock ? (
                                <p>{row.candidateBlock.content}</p>
                              ) : (
                                <p className="text-slate-400 italic">候选稿中无此段落（已删除）</p>
                              )}
                            </div>
                          )}

                          {/* 4. CURRENT ONLY MODE */}
                          {viewMode === 'current' && (
                            <div className="p-3 bg-white rounded border border-slate-200 text-sm leading-relaxed text-slate-800">
                              {row.currentBlock ? (
                                <p>{row.currentBlock.content}</p>
                              ) : (
                                <p className="text-slate-400 italic">当前稿中无此段落（候选新增）</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}

          {/* Diagnostics Section Toggle */}
          <div className="pt-2">
            <button
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 cursor-pointer"
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  showDiagnostics ? 'rotate-180' : ''
                }`}
              />
              <span>演示诊断信息（内部 ID、基准指纹与运行记录）</span>
            </button>

            {showDiagnostics && (
              <div className="mt-2 p-3 bg-slate-100 rounded-lg border border-slate-200 text-[11px] font-mono text-slate-600 space-y-1">
                <div>RunId: {candidate.runId}</div>
                <div>TaskId: {candidate.taskId}</div>
                <div>BaseDraftId: {candidate.baseDraftId || 'none'}</div>
                <div>BaseDraftContentHash: {candidate.baseDraftContentHash}</div>
                <div>UpstreamFactHash: {candidate.upstreamApprovalVersion?.factSnapshotHash || 'none'}</div>
                <div>UpstreamStyleHash: {candidate.upstreamApprovalVersion?.styleHash || 'none'}</div>
                <div>UpstreamOutlineHash: {candidate.upstreamApprovalVersion?.outlineHash || 'none'}</div>
              </div>
            )}
          </div>
        </div>

        {/* 7. Modal Bottom Action Bar */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium cursor-pointer"
            >
              返回正文编辑
            </button>
            <button
              onClick={onDiscard}
              className="px-3 py-2 bg-white hover:bg-rose-50 border border-rose-300 text-rose-700 rounded-lg text-xs font-medium cursor-pointer"
              title="放弃此候选稿，保持当前稿件不变"
            >
              放弃候选稿
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onRegenerate}
              className="px-3.5 py-2 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
              title="根据当前正文及输入指令重新生成整稿候选"
            >
              <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
              <span>重新起草</span>
            </button>

            <button
              onClick={onAccept}
              disabled={isInvalidated || activeRole !== '主笔甲'}
              className={`px-5 py-2 rounded-lg text-xs font-bold shadow-xs flex items-center gap-1.5 transition-colors ${
                isInvalidated || activeRole !== '主笔甲'
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white cursor-pointer'
              }`}
              title={
                activeRole !== '主笔甲'
                  ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可采纳候选稿`
                  : isInvalidated
                  ? invalidationReason || '候选已失效，无法采纳'
                  : '整体采纳并自动归档旧稿，生成新工作稿'
              }
            >
              <Check className="w-4 h-4" />
              <span>整体采纳并创建新工作稿</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
