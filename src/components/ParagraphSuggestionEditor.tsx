import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  UserRole,
  RevisionSuggestion,
  DiffSegment
} from '../types';
import {
  validateParagraphSuggestionAcceptance,
  ParagraphSuggestionValidationResult
} from '../services/draftLifecycleService';
import { computeTextDiff } from '../services/diffService';
import {
  Sparkles,
  Check,
  RotateCcw,
  AlertCircle,
  AlertTriangle,
  Copy,
  RefreshCw,
  CornerDownRight,
  MessageSquare,
  FileText,
  Sliders,
  Eye,
  CheckCircle2,
  Info,
  Maximize2,
  X,
  Tag
} from 'lucide-react';

interface ParagraphSuggestionEditorProps {
  task: Task;
  currentDraft: DraftVersion | undefined;
  suggestion: RevisionSuggestion;
  activeRole: UserRole;
  activeBlock?: ParagraphBlock;
  activeCompletedRunId: string | null;
  isGenerating: boolean;
  onAdopt: (pendingText: string) => void;
  onDiscard: () => void;
  onRegenerate: () => void;
  onJumpToTargetBlock?: (blockId: string) => void;
  pendingText?: string;
  controlledPendingText?: string;
  onPendingTextChange?: (text: string) => void;
}

export const ParagraphSuggestionEditor: React.FC<ParagraphSuggestionEditorProps> = ({
  task,
  currentDraft,
  suggestion,
  activeRole,
  activeBlock,
  activeCompletedRunId,
  isGenerating,
  onAdopt,
  onDiscard,
  onRegenerate,
  onJumpToTargetBlock,
  pendingText: incomingPendingText,
  controlledPendingText,
  onPendingTextChange,
}) => {
  // Pending editable text (supports controlled from parent via pendingText or controlledPendingText, or internal state fallback)
  const actualControlledText = controlledPendingText !== undefined ? controlledPendingText : incomingPendingText;
  const isControlled = actualControlledText !== undefined;
  const [internalPendingText, setInternalPendingText] = useState<string>(suggestion.suggestedText);
  const pendingText = isControlled ? actualControlledText : internalPendingText;

  const setPendingText = (newVal: string) => {
    if (isControlled) {
      onPendingTextChange?.(newVal);
    } else {
      setInternalPendingText(newVal);
    }
  };

  // View modes: 'diff' (差异对比), 'editor' (微调编辑), 'baseline' (生成基准原文), 'ai_original' (AI原始建议)
  const [viewMode, setViewMode] = useState<'diff' | 'editor' | 'baseline' | 'ai_original'>('diff');

  // Copy feedback tooltip
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Wide modal review mode
  const [isWideModalOpen, setIsWideModalOpen] = useState(false);
  const openWideBtnRef = useRef<HTMLButtonElement>(null);
  const modalContainerRef = useRef<HTMLDivElement>(null);
  const modalCloseBtnRef = useRef<HTMLButtonElement>(null);

  // Focus management, Tab trapping, and Escape handling for wide review modal
  useEffect(() => {
    if (!isWideModalOpen) return;

    // 1. Initial focus: transfer focus inside modal immediately so background buttons lose focus
    const transferInitialFocus = () => {
      if (modalCloseBtnRef.current) {
        modalCloseBtnRef.current.focus();
      } else if (modalContainerRef.current) {
        modalContainerRef.current.focus();
      }
    };
    transferInitialFocus();
    const focusTimer = setTimeout(transferInitialFocus, 25);

    // Prevent background scrolling while modal is open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 2. Keyboard handler (Capture phase): Esc closes & restores focus; Tab loops inside modal
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setIsWideModalOpen(false);
        setTimeout(() => {
          openWideBtnRef.current?.focus();
        }, 30);
        return;
      }

      if (e.key === 'Tab') {
        if (!modalContainerRef.current) return;
        const focusableElements = Array.from(
          modalContainerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          // Backward tab: Shift + Tab
          if (document.activeElement === firstElement || !modalContainerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          // Forward tab: Tab
          if (document.activeElement === lastElement || !modalContainerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isWideModalOpen]);

  // Reset internalPendingText whenever suggestion changes (if not controlled)
  useEffect(() => {
    if (!isControlled) {
      setInternalPendingText(suggestion.suggestedText);
    }
    setViewMode('diff');
  }, [suggestion.runId, suggestion.targetBlockId, isControlled, suggestion.suggestedText]);

  // Target block in current draft
  const targetBlock = useMemo(() => {
    return currentDraft?.blocks.find((b) => b.id === suggestion.targetBlockId);
  }, [currentDraft?.blocks, suggestion.targetBlockId]);

  // Detect whether human fine-tuning has occurred (exact comparison, preserving whitespace/newlines)
  const isFineTuned = useMemo(() => {
    return pendingText !== suggestion.suggestedText;
  }, [pendingText, suggestion.suggestedText]);

  // Detect whether suggestion originated from reviewer-provided replacement draft
  const isReviewerReplacement = useMemo(() => {
    return Boolean(
      suggestion.isReviewerReplacement ||
      suggestion.sourceCommentType === 'replacement' ||
      (suggestion.sourceCommentId &&
        (suggestion.diffExplanation.includes('审阅人提供的替换稿') || suggestion.diffExplanation.includes('替换稿')))
    );
  }, [suggestion.isReviewerReplacement, suggestion.sourceCommentType, suggestion.sourceCommentId, suggestion.diffExplanation]);

  // Check whether reviewer replacement modified numbers/metrics relative to original baseline
  const replacementDataDiff = useMemo(() => {
    if (!isReviewerReplacement) return null;
    const origNums = suggestion.baseContent.match(/\d+(?:[.\d]+)?[\u4e00-\u9fa5]{1,3}/g) || [];
    const replNums = suggestion.suggestedText.match(/\d+(?:[.\d]+)?[\u4e00-\u9fa5]{1,3}/g) || [];
    if (origNums.join(',') !== replNums.join(',')) {
      return {
        origNums,
        replNums,
      };
    }
    return null;
  }, [isReviewerReplacement, suggestion.baseContent, suggestion.suggestedText]);

  // Character count delta: baseline -> current pending text
  const baseLength = suggestion.baseContent.length;
  const currentLength = pendingText.length;
  const lengthDelta = currentLength - baseLength;

  // Real-time diff calculation from baseline to current pending text
  const dynamicDiffSegments: DiffSegment[] = useMemo(() => {
    return computeTextDiff(suggestion.baseContent, pendingText);
  }, [suggestion.baseContent, pendingText]);

  // Shared validation using unified lifecycle validator
  const validation: ParagraphSuggestionValidationResult = useMemo(() => {
    return validateParagraphSuggestionAcceptance({
      task,
      currentDraft,
      suggestion,
      pendingTextToAdopt: pendingText,
      activeCompletedRunId,
      activeRole,
      isGenerating,
    });
  }, [
    task,
    currentDraft,
    suggestion,
    pendingText,
    activeCompletedRunId,
    activeRole,
    isGenerating,
  ]);

  const isAdoptDisabled = !validation.valid;
  const adoptDisabledReason = validation.reason || '';

  const isDifferentBlockSelected = Boolean(activeBlock && activeBlock.id !== suggestion.targetBlockId);

  // Handle Copy
  const handleCopyText = () => {
    try {
      const textToCopy = viewMode === 'ai_original' ? suggestion.suggestedText : pendingText;
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopyFeedback('已复制文本到剪贴板！');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback('复制失败，请手动选中文本');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  };

  // Reset fine-tuning back to original AI suggestion
  const handleResetToAiOriginal = () => {
    setPendingText(suggestion.suggestedText);
  };

  const targetOrderDisplay = targetBlock?.order || suggestion.targetBlockOrder || '?';

  return (
    <div
      data-testid="paragraph-suggestion-editor"
      className="bg-blue-50/75 border-2 border-blue-200 rounded-lg flex flex-col shadow-xs overflow-hidden"
    >
      {/* 1. Header with Metadata, Scope Label & Wide Review Trigger */}
      <div className="p-3 bg-white border-b border-blue-200 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-700 shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="font-bold text-sm text-blue-950 flex items-center gap-1.5 flex-wrap">
              <span>{`仅修改第${targetOrderDisplay}段`}</span>
              {isFineTuned && (
                <span
                  data-testid="badge-fine-tuned"
                  className="bg-amber-100 text-amber-900 border border-amber-300 text-xs px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5"
                >
                  <Sliders className="w-3 h-3 text-amber-700" />
                  已人工微调
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 font-normal mt-0.5 flex items-center gap-1">
              <Tag className="w-3 h-3 text-blue-600" />
              <span>操作范围：仅限第{targetOrderDisplay}段（局部改写，不影响其他段落）</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="bg-blue-100/80 text-blue-800 px-2 py-0.5 rounded text-xs font-medium">
            {isReviewerReplacement
              ? `审阅替换稿（${suggestion.sourceCommentReviewer || '审阅人'}）`
              : suggestion.action === 'custom'
              ? `指令：${suggestion.customPrompt?.slice(0, 10) || '改写'}...`
              : suggestion.action === 'compress'
              ? '压缩精炼'
              : suggestion.action === 'expand'
              ? '补充表达'
              : suggestion.action === 'formal'
              ? '正式文风'
              : suggestion.action === 'highlight'
              ? '突出重点'
              : suggestion.action}
          </span>
          <button
            ref={openWideBtnRef}
            type="button"
            data-testid="btn-open-wide-modal"
            onClick={() => setIsWideModalOpen(true)}
            className="px-3 py-1.5 bg-white hover:bg-blue-50 text-blue-700 border border-blue-300 rounded-md text-sm font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
            title="展开宽屏评审面板（差异对比与微调）"
            aria-label="展开宽屏评审面板"
            aria-expanded={isWideModalOpen}
          >
            <Maximize2 className="w-4 h-4" />
            <span>宽屏评审</span>
          </button>
        </div>
      </div>

      {/* 2. Scrollable Middle Body */}
      <div className="p-3 space-y-3 overflow-y-auto max-h-[460px] text-xs">
        {/* Source review comment context (if any) */}
        {suggestion.sourceCommentId && (
          <div
            data-testid="suggestion-source-comment-banner"
            className="p-2.5 bg-white rounded border border-blue-200 text-xs text-blue-950 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold flex items-center gap-1 text-blue-900">
                <MessageSquare className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                关联审阅意见【{suggestion.sourceCommentReviewer || '审阅人'}】
              </span>
              <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1 py-0.5 rounded">
                {suggestion.sourceCommentId}
              </span>
            </div>
            {suggestion.sourceCommentSummary && (
              <p className="text-xs text-slate-600 leading-relaxed bg-slate-50/80 p-1.5 rounded">
                “{suggestion.sourceCommentSummary}”
              </p>
            )}
          </div>
        )}

        {/* Warning if cursor is on different block */}
        {isDifferentBlockSelected && targetBlock && (
          <div className="p-2 bg-amber-50 border border-amber-300 rounded text-amber-900 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold flex items-center gap-1 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                当前光标在第 {activeBlock?.order} 段，建议绑定第 {targetBlock.order} 段
              </span>
              {onJumpToTargetBlock && (
                <button
                  type="button"
                  onClick={() => onJumpToTargetBlock(targetBlock.id)}
                  className="text-blue-700 hover:underline font-bold text-xs flex items-center gap-0.5 cursor-pointer"
                >
                  <CornerDownRight className="w-3 h-3" />
                  定位目标段
                </button>
              )}
            </div>
          </div>
        )}

        {/* Conflict Warning: Baseline modified after suggestion was generated */}
        {validation.isModifiedAfter && (
          <div
            data-testid="warning-baseline-modified"
            className="p-2.5 bg-rose-50 border border-rose-300 rounded text-rose-900 text-xs space-y-1"
          >
            <div className="font-bold flex items-center gap-1 text-rose-800">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>建议已失效（正文基准已被人工编辑修改）</span>
            </div>
            <p className="text-xs text-rose-800 leading-relaxed">
              目标段落自建议生成后已被修改，基准变动导致建议失效。为防止直接覆盖人工文本，请重新基于当前文本生成建议。
            </p>
          </div>
        )}

        {/* View Mode Switcher Tabs */}
        <div className="flex items-center gap-1 bg-white p-1 rounded-md border border-slate-200">
          <button
            type="button"
            data-testid="tab-diff-view"
            onClick={() => setViewMode('diff')}
            className={`flex-1 py-1.5 px-2.5 rounded text-sm font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'diff'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>修改差异</span>
          </button>
          <button
            type="button"
            data-testid="tab-editor-view"
            onClick={() => setViewMode('editor')}
            className={`flex-1 py-1.5 px-2.5 rounded text-sm font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'editor'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>待采纳文本{isFineTuned ? ' (已微调)' : ' (可微调)'}</span>
          </button>
          <button
            type="button"
            data-testid="tab-baseline-view"
            onClick={() => setViewMode('baseline')}
            className={`flex-1 py-1.5 px-2 rounded text-sm font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'baseline'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>生成时原文</span>
          </button>
          <button
            type="button"
            data-testid="tab-ai-original-view"
            onClick={() => setViewMode('ai_original')}
            className={`flex-1 py-1.5 px-2 rounded text-sm font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'ai_original'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isReviewerReplacement ? '审阅替换稿' : 'AI原始建议'}</span>
          </button>
        </div>

        {/* View Mode 1: Diff View (差异对比) */}
        {viewMode === 'diff' && (
          <div data-testid="view-diff-content" className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
              <span>基准原文 → 当前待采纳文本差异</span>
              <span data-testid="word-count-delta" className="font-mono text-blue-900 font-semibold">
                字数：原 {baseLength} 字 → 现 {currentLength} 字 ({lengthDelta >= 0 ? `+${lengthDelta}` : `${lengthDelta}`}字)
              </span>
            </div>
            <div className="p-3 bg-white rounded border border-slate-300 text-slate-900 text-sm leading-relaxed font-serif select-text max-h-[220px] overflow-y-auto">
              {dynamicDiffSegments.map((seg, sIdx) => {
                if (seg.type === 'equal') {
                  return <span key={sIdx}>{seg.text}</span>;
                }
                if (seg.type === 'added') {
                  return (
                    <span
                      key={sIdx}
                      data-testid="diff-segment-added"
                      className="bg-emerald-100 text-emerald-900 px-1 py-0.5 mx-0.5 rounded font-medium border-b-2 border-emerald-500 inline-flex items-center gap-0.5"
                      title="新增内容"
                    >
                      <span className="text-xs font-bold bg-emerald-300 text-emerald-900 px-1 rounded font-sans">
                        +新增
                      </span>
                      <span>{seg.text}</span>
                    </span>
                  );
                }
                if (seg.type === 'removed') {
                  return (
                    <span
                      key={sIdx}
                      data-testid="diff-segment-removed"
                      className="bg-rose-100 text-rose-900 line-through px-1 py-0.5 mx-0.5 rounded opacity-75 border-b-2 border-rose-400 inline-flex items-center gap-0.5"
                      title="删减内容"
                    >
                      <span className="text-xs font-bold bg-rose-300 text-rose-900 px-1 rounded no-underline font-sans">
                        -删减
                      </span>
                      <span>{seg.text}</span>
                    </span>
                  );
                }
                return null;
              })}
            </div>
          </div>
        )}

        {/* View Mode 2: Fine-tune Editor (待采纳文本，可直接编辑微调) */}
        {viewMode === 'editor' && (
          <div data-testid="view-editor-content" className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700">
                可直接在下方微调修改待采纳正文：
              </span>
              {isFineTuned && (
                <button
                  type="button"
                  data-testid="btn-reset-ai-original"
                  onClick={handleResetToAiOriginal}
                  className="text-blue-700 hover:text-blue-900 hover:underline flex items-center gap-0.5 text-sm font-bold cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {isReviewerReplacement ? '还原为审阅替换稿' : '还原为AI原始建议'}
                </button>
              )}
            </div>
            <textarea
              data-testid="textarea-pending-text"
              value={pendingText}
              onChange={(e) => setPendingText(e.target.value)}
              rows={6}
              className="w-full p-2.5 bg-white border-2 border-blue-300 rounded text-slate-900 text-sm font-serif leading-relaxed focus:outline-none focus:border-blue-600 resize-y"
              placeholder="可在此微调正文，实际采纳将直接写入此处修改后的文本..."
            />
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>修改后将动态重新计算正文差异及字数增减</span>
              <span className="font-mono">
                当前字数：<strong className="text-blue-900">{pendingText.length}</strong> 字
              </span>
            </div>
          </div>
        )}

        {/* View Mode 3: Baseline Text (生成时原文) */}
        {viewMode === 'baseline' && (
          <div data-testid="view-baseline-content" className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-500 font-bold">
              <span>建议生成时的基准正文（原始存证）：</span>
              <span className="font-mono">{suggestion.baseContent.length} 字</span>
            </div>
            <div className="p-3 bg-white rounded border border-slate-200 text-slate-600 text-sm font-serif leading-relaxed select-text">
              {suggestion.baseContent}
            </div>
          </div>
        )}

        {/* View Mode 4: AI Original Suggestion or Reviewer Replacement */}
        {viewMode === 'ai_original' && (
          <div data-testid="view-ai-original-content" className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-blue-900 font-bold">
              <span>
                {isReviewerReplacement
                  ? `【${suggestion.sourceCommentReviewer || '审阅人'}】审阅人提供的替换稿：`
                  : 'AI原始建议文本（微调不覆盖此原始记录）：'}
              </span>
              <span className="font-mono text-slate-500">{suggestion.suggestedText.length} 字</span>
            </div>
            <div className="p-3 bg-white rounded border border-blue-200 text-slate-900 text-sm font-serif leading-relaxed select-text">
              {suggestion.suggestedText}
            </div>
          </div>
        )}

        {/* Reviewer replacement data alteration warning */}
        {replacementDataDiff && (
          <div
            data-testid="reviewer-replacement-data-notice"
            className="p-2.5 bg-amber-50 rounded border border-amber-300 text-amber-900 text-xs flex items-start gap-1.5"
          >
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong>审阅替换稿包含数据指标调整：</strong>
              <span>
                原文【{replacementDataDiff.origNums.join('、') || '无量化数据'}】与替换稿【{replacementDataDiff.replNums.join('、') || '无量化数据'}】存在差异。
                该分支已跳过自动化指标保留强制锁定，请主笔务必核验台账依据后再行采纳。
              </span>
            </div>
          </div>
        )}

        {/* 3. Explanations & Verification Notes */}
        <div className="p-2.5 bg-white/90 rounded border border-blue-100 text-xs space-y-1.5">
          <div>
            <strong className="text-slate-900">
              {isReviewerReplacement ? '审阅替换稿说明：' : 'AI原始建议说明：'}
            </strong>
            <span className="text-slate-700 ml-1 leading-relaxed">{suggestion.diffExplanation}</span>
          </div>

          {/* Explicit disclaimer when human fine-tuning exists */}
          {isFineTuned && (
            <div
              data-testid="notice-fine-tuned-disclaimer"
              className="p-1.5 bg-amber-50 rounded border border-amber-200 text-amber-900 text-xs flex items-start gap-1"
            >
              <Info className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>人工微调标识：</strong>待采纳文本已由主笔人工微调，实际采纳将严格写入微调后内容；上述说明针对{isReviewerReplacement ? '审阅人原始替换稿' : '原始AI建议'}，不冒充对人工修改的重新核验。
              </span>
            </div>
          )}

          {suggestion.needsVerificationNotes && suggestion.needsVerificationNotes.length > 0 && (
            <div className="pt-1 border-t border-slate-100">
              <strong className="text-amber-800">需核对项：</strong>
              <ul className="list-disc list-inside mt-0.5 space-y-0.5 text-amber-900 text-xs">
                {suggestion.needsVerificationNotes.map((note, nIdx) => (
                  <li key={nIdx}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* 4. Sticky Bottom Action Bar (Fixed at bottom so always accessible regardless of scroll) */}
      <div
        data-testid="suggestion-sticky-actions"
        className="sticky bottom-0 bg-white/95 backdrop-blur-xs border-t border-blue-200 p-2.5 z-10 flex flex-wrap items-center justify-between gap-2 shadow-sm"
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="btn-copy-suggestion"
            onClick={handleCopyText}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-md text-sm font-medium flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
            title="复制当前文本至剪贴板"
          >
            <Copy className="w-4 h-4 text-slate-500" />
            <span>{copyFeedback || '复制文本'}</span>
          </button>
          <button
            type="button"
            data-testid="btn-regenerate-suggestion"
            onClick={onRegenerate}
            disabled={isGenerating}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-md text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
            title="以当前段落正文重新生成建议"
          >
            <RefreshCw className="w-4 h-4 text-slate-500" />
            <span>重新生成</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="btn-discard-suggestion"
            onClick={onDiscard}
            className="px-3.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-md text-sm font-medium cursor-pointer transition-colors shadow-2xs"
            title="放弃此建议（正文不改变）"
          >
            放弃
          </button>

          <button
            type="button"
            data-testid="btn-adopt-suggestion"
            onClick={() => onAdopt(pendingText)}
            disabled={isAdoptDisabled}
            className={`px-4 py-1.5 rounded-md text-sm font-bold shadow-xs flex items-center gap-1.5 transition-all ${
              isAdoptDisabled
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-blue-700 hover:bg-blue-800 text-white cursor-pointer active:scale-98'
            }`}
            title={adoptDisabledReason || '采纳写入目标段落'}
          >
            <Check className="w-4 h-4" />
            <span>
              {isFineTuned
                ? `采纳微调至第${targetOrderDisplay}段`
                : `采纳到第${targetOrderDisplay}段`}
            </span>
          </button>
        </div>
      </div>

      {/* 5. Wide Review Modal Dialog (承接人工微调、差异展示及固定操作区，支持键盘Esc关闭与焦点恢复) */}
      {isWideModalOpen && (
        <div
          ref={modalContainerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="wide-review-title"
          data-testid="modal-wide-suggestion-review"
          data-nested-modal="true"
          tabIndex={-1}
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setIsWideModalOpen(false);
              setTimeout(() => openWideBtnRef.current?.focus(), 30);
            }
          }}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[92vh] flex flex-col border border-slate-300 overflow-hidden animate-in fade-in zoom-in duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700 shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 id="wide-review-title" className="font-bold text-base text-slate-900">
                      局部AI建议宽屏评审 · 仅修改第 {targetOrderDisplay} 段
                    </h3>
                    {isFineTuned && (
                      <span className="bg-amber-100 text-amber-900 border border-amber-300 text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1">
                        <Sliders className="w-3 h-3 text-amber-700" />
                        已人工微调
                      </span>
                    )}
                    <span className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded font-medium">
                      {suggestion.action === 'custom'
                        ? `指令：${suggestion.customPrompt || '改写'}`
                        : suggestion.action === 'compress'
                        ? '压缩精炼'
                        : suggestion.action === 'expand'
                        ? '补充表达'
                        : suggestion.action === 'formal'
                        ? '正式文风'
                        : suggestion.action === 'highlight'
                        ? '突出重点'
                        : suggestion.action}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    操作范围：仅限第{targetOrderDisplay}段（局部改写，不影响整篇其他段落）· 支持键盘 Escape 关闭与焦点锁入
                  </p>
                </div>
              </div>

              <button
                ref={modalCloseBtnRef}
                type="button"
                data-testid="btn-close-wide-modal"
                onClick={() => {
                  setIsWideModalOpen(false);
                  setTimeout(() => openWideBtnRef.current?.focus(), 30);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                aria-label="关闭宽屏评审"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Associated Comment Banner */}
              {suggestion.sourceCommentId && (
                <div className="p-3 bg-blue-50/80 rounded-lg border border-blue-200 text-xs text-blue-950 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold flex items-center gap-1 text-blue-900 text-sm">
                      <MessageSquare className="w-4 h-4 text-blue-600 shrink-0" />
                      关联审阅意见【{suggestion.sourceCommentReviewer || '审阅人'}】
                    </span>
                    <span className="text-xs font-mono text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded">
                      {suggestion.sourceCommentId}
                    </span>
                  </div>
                  {suggestion.sourceCommentSummary && (
                    <p className="text-xs text-slate-700 leading-relaxed bg-white/80 p-2 rounded border border-blue-100">
                      “{suggestion.sourceCommentSummary}”
                    </p>
                  )}
                </div>
              )}

              {/* Conflict Warning */}
              {validation.isModifiedAfter && (
                <div className="p-3 bg-rose-50 border border-rose-300 rounded-lg text-rose-900 text-xs space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-rose-800 text-sm">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>建议已失效（正文基准已被人工编辑修改）</span>
                  </div>
                  <p className="text-xs text-rose-800 leading-relaxed">
                    目标段落自建议生成后已被人工编辑修改，基准变动导致建议失效。为防止直接覆盖人工文本，请重新基于当前文本生成建议。
                  </p>
                </div>
              )}

              {/* View Mode Tabs in Modal */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-sm">
                <button
                  type="button"
                  onClick={() => setViewMode('diff')}
                  className={`flex-1 py-1.5 px-3 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                    viewMode === 'diff'
                      ? 'bg-blue-600 text-white shadow-2xs font-bold'
                      : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>修改差异对比</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('editor')}
                  className={`flex-1 py-1.5 px-3 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                    viewMode === 'editor'
                      ? 'bg-blue-600 text-white shadow-2xs font-bold'
                      : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>待采纳正文编辑 {isFineTuned ? '(已微调)' : '(可微调)'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('baseline')}
                  className={`flex-1 py-1.5 px-3 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                    viewMode === 'baseline'
                      ? 'bg-blue-600 text-white shadow-2xs font-bold'
                      : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>生成时基准原文</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('ai_original')}
                  className={`flex-1 py-1.5 px-3 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                    viewMode === 'ai_original'
                      ? 'bg-blue-600 text-white shadow-2xs font-bold'
                      : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isReviewerReplacement ? '审阅替换稿' : 'AI原始建议'}</span>
                </button>
              </div>

              {/* Wide View Panels */}
              {viewMode === 'diff' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
                    <span>正文修改差异对比：</span>
                    <span className="font-mono">
                      原 {baseLength} 字 → 现 {currentLength} 字 ({lengthDelta >= 0 ? `+${lengthDelta}` : lengthDelta} 字)
                    </span>
                  </div>
                  <div className="p-4 bg-slate-50/80 rounded-lg border border-slate-200 text-slate-900 text-base font-serif leading-relaxed select-text min-h-[160px]">
                    {dynamicDiffSegments.map((seg, sIdx) => {
                      if (seg.type === 'equal') {
                        return <span key={sIdx} className="text-slate-800">{seg.text}</span>;
                      }
                      if (seg.type === 'removed') {
                        return (
                          <span
                            key={sIdx}
                            className="bg-rose-100 text-rose-800 line-through decoration-rose-500 px-0.5 rounded-xs"
                            title="被删减文本"
                          >
                            {seg.text}
                          </span>
                        );
                      }
                      return (
                        <span
                          key={sIdx}
                          className="bg-emerald-100 text-emerald-900 font-medium underline decoration-emerald-500 px-0.5 rounded-xs"
                          title="新增/替换文本"
                        >
                          {seg.text}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {viewMode === 'editor' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-700 font-semibold">
                    <span>主笔人工微调编辑器（改写将直接写入当前草稿）：</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-500">{currentLength} 字</span>
                      {isFineTuned && (
                        <button
                          type="button"
                          onClick={handleResetToAiOriginal}
                          className="text-xs text-blue-700 hover:text-blue-900 underline cursor-pointer"
                        >
                          {isReviewerReplacement ? '重置为审阅替换稿' : '重置为AI建议'}
                        </button>
                      )}
                    </div>
                  </div>
                  <textarea
                    rows={8}
                    value={pendingText}
                    onChange={(e) => setPendingText(e.target.value)}
                    className="w-full p-4 border border-blue-300 rounded-lg text-base font-serif leading-relaxed text-slate-900 bg-white focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                    placeholder="在此直接微调正文..."
                  />
                </div>
              )}

              {viewMode === 'baseline' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500 font-semibold">
                    <span>建议生成时的基准正文（原始存证）：</span>
                    <span className="font-mono">{suggestion.baseContent.length} 字</span>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-slate-700 text-base font-serif leading-relaxed select-text min-h-[140px]">
                    {suggestion.baseContent}
                  </div>
                </div>
              )}

              {viewMode === 'ai_original' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-blue-900 font-semibold">
                    <span>
                      {isReviewerReplacement
                        ? `【${suggestion.sourceCommentReviewer || '审阅人'}】审阅人提供的替换稿：`
                        : 'AI原始建议文本（微调不覆盖此原始记录）：'}
                    </span>
                    <span className="font-mono text-slate-500">{suggestion.suggestedText.length} 字</span>
                  </div>
                  <div className="p-4 bg-blue-50/50 rounded-lg border border-blue-200 text-slate-900 text-base font-serif leading-relaxed select-text min-h-[140px]">
                    {suggestion.suggestedText}
                  </div>
                </div>
              )}

              {/* Reviewer replacement data alteration warning in Wide Modal */}
              {replacementDataDiff && (
                <div
                  data-testid="reviewer-replacement-data-notice-modal"
                  className="p-3 bg-amber-50 rounded-lg border border-amber-300 text-amber-900 text-xs flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <strong>审阅替换稿包含数据指标调整：</strong>
                    <span>
                      原文【{replacementDataDiff.origNums.join('、') || '无量化数据'}】与替换稿【{replacementDataDiff.replNums.join('、') || '无量化数据'}】存在差异。
                      该分支已跳过自动化指标保留强制锁定，请主笔务必核验台账依据后再行采纳。
                    </span>
                  </div>
                </div>
              )}

              {/* Explanations in Wide Modal */}
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-2">
                <div>
                  <strong className="text-slate-900">
                    {isReviewerReplacement ? '审阅替换稿说明：' : 'AI原始建议说明：'}
                  </strong>
                  <span className="text-slate-700 ml-1.5 leading-relaxed">{suggestion.diffExplanation}</span>
                </div>
                {isFineTuned && (
                  <div className="p-2 bg-amber-50 rounded border border-amber-200 text-amber-900 text-xs flex items-start gap-1.5">
                    <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <span>
                      <strong>人工微调标识：</strong>待采纳文本已由主笔人工微调，实际采纳将严格写入微调后内容；上述说明针对{isReviewerReplacement ? '审阅人原始替换稿' : '原始AI建议'}，不冒充对人工修改的重新核验。
                    </span>
                  </div>
                )}
                {suggestion.needsVerificationNotes && suggestion.needsVerificationNotes.length > 0 && (
                  <div className="pt-2 border-t border-slate-200">
                    <strong className="text-amber-800">需核对项：</strong>
                    <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-900 text-xs">
                      {suggestion.needsVerificationNotes.map((note, nIdx) => (
                        <li key={nIdx}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Fixed Footer Actions */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyText}
                  className="px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Copy className="w-4 h-4 text-slate-500" />
                  <span>{copyFeedback || '复制文本'}</span>
                </button>
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={isGenerating}
                  className="px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className="w-4 h-4 text-slate-500" />
                  <span>重新生成</span>
                </button>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    onDiscard();
                    setIsWideModalOpen(false);
                  }}
                  className="px-4 py-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium cursor-pointer transition-colors"
                >
                  放弃建议
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onAdopt(pendingText);
                    setIsWideModalOpen(false);
                  }}
                  disabled={isAdoptDisabled}
                  className={`px-5 py-2 rounded-lg text-sm font-bold shadow-xs flex items-center gap-1.5 transition-all ${
                    isAdoptDisabled
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-blue-700 hover:bg-blue-800 text-white cursor-pointer active:scale-98'
                  }`}
                  title={adoptDisabledReason || '采纳写入目标段落'}
                >
                  <Check className="w-4 h-4" />
                  <span>
                    {isFineTuned
                      ? `采纳微调至第${targetOrderDisplay}段`
                      : `采纳到第${targetOrderDisplay}段`}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
