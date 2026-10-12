import React, { useState, useEffect, useMemo } from 'react';
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
  Info
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
}) => {
  // Pending editable text (initialized to pristine AI suggestion, can be fine-tuned)
  const [pendingText, setPendingText] = useState<string>(suggestion.suggestedText);

  // View modes: 'diff' (差异对比), 'editor' (微调编辑), 'baseline' (生成基准原文), 'ai_original' (AI原始建议)
  const [viewMode, setViewMode] = useState<'diff' | 'editor' | 'baseline' | 'ai_original'>('diff');

  // Copy feedback tooltip
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Reset pendingText whenever suggestion changes (new runId or target block)
  useEffect(() => {
    setPendingText(suggestion.suggestedText);
    setViewMode('diff');
  }, [suggestion.runId, suggestion.targetBlockId]);

  // Target block in current draft
  const targetBlock = useMemo(() => {
    return currentDraft?.blocks.find((b) => b.id === suggestion.targetBlockId);
  }, [currentDraft?.blocks, suggestion.targetBlockId]);

  // Detect whether human fine-tuning has occurred (exact comparison, preserving whitespace/newlines)
  const isFineTuned = useMemo(() => {
    return pendingText !== suggestion.suggestedText;
  }, [pendingText, suggestion.suggestedText]);

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
      {/* 1. Header with Metadata & Fine-tune Status */}
      <div className="p-3 bg-white border-b border-blue-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center text-blue-700">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="font-bold text-xs text-blue-950 flex items-center gap-1.5">
              <span>第 {targetOrderDisplay} 段建议</span>
              {isFineTuned && (
                <span
                  data-testid="badge-fine-tuned"
                  className="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                >
                  <Sliders className="w-2.5 h-2.5 text-amber-700" />
                  已人工微调
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="bg-blue-100/80 text-blue-800 px-2 py-0.5 rounded font-medium">
            {suggestion.action === 'custom'
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
              <span className="text-[10px] font-mono text-blue-600 bg-blue-50 px-1 py-0.5 rounded">
                {suggestion.sourceCommentId}
              </span>
            </div>
            {suggestion.sourceCommentSummary && (
              <p className="text-[11px] text-slate-600 leading-relaxed bg-slate-50/80 p-1.5 rounded">
                “{suggestion.sourceCommentSummary}”
              </p>
            )}
          </div>
        )}

        {/* Warning if cursor is on different block */}
        {isDifferentBlockSelected && targetBlock && (
          <div className="p-2 bg-amber-50 border border-amber-300 rounded text-amber-900 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold flex items-center gap-1 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                当前光标在第 {activeBlock?.order} 段，建议绑定第 {targetBlock.order} 段
              </span>
              {onJumpToTargetBlock && (
                <button
                  type="button"
                  onClick={() => onJumpToTargetBlock(targetBlock.id)}
                  className="text-blue-700 hover:underline font-bold text-[11px] flex items-center gap-0.5 cursor-pointer"
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
            <p className="text-[11px] text-rose-800 leading-relaxed">
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
            className={`flex-1 py-1 px-2 rounded text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'diff'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Eye className="w-3 h-3" />
            <span>修改差异</span>
          </button>
          <button
            type="button"
            data-testid="tab-editor-view"
            onClick={() => setViewMode('editor')}
            className={`flex-1 py-1 px-2 rounded text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'editor'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Sliders className="w-3 h-3" />
            <span>待采纳文本{isFineTuned ? ' (已微调)' : ' (可微调)'}</span>
          </button>
          <button
            type="button"
            data-testid="tab-baseline-view"
            onClick={() => setViewMode('baseline')}
            className={`flex-1 py-1 px-1.5 rounded text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'baseline'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <FileText className="w-3 h-3" />
            <span>生成时原文</span>
          </button>
          <button
            type="button"
            data-testid="tab-ai-original-view"
            onClick={() => setViewMode('ai_original')}
            className={`flex-1 py-1 px-1.5 rounded text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              viewMode === 'ai_original'
                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>AI原始建议</span>
          </button>
        </div>

        {/* View Mode 1: Diff View (差异对比) */}
        {viewMode === 'diff' && (
          <div data-testid="view-diff-content" className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
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
                      <span className="text-[10px] font-bold bg-emerald-300 text-emerald-900 px-1 rounded font-sans">
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
                      <span className="text-[10px] font-bold bg-rose-300 text-rose-900 px-1 rounded no-underline font-sans">
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
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-700">
                可直接在下方微调修改待采纳正文：
              </span>
              {isFineTuned && (
                <button
                  type="button"
                  data-testid="btn-reset-ai-original"
                  onClick={handleResetToAiOriginal}
                  className="text-blue-700 hover:text-blue-900 hover:underline flex items-center gap-0.5 font-bold cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  还原为AI原始建议
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
            <div className="flex items-center justify-between text-[11px] text-slate-500">
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
            <div className="flex items-center justify-between text-[11px] text-slate-500 font-bold">
              <span>建议生成时的基准正文（原始存证）：</span>
              <span className="font-mono">{suggestion.baseContent.length} 字</span>
            </div>
            <div className="p-3 bg-white rounded border border-slate-200 text-slate-600 text-sm font-serif leading-relaxed select-text">
              {suggestion.baseContent}
            </div>
          </div>
        )}

        {/* View Mode 4: AI Original Suggestion (未覆盖的AI原始生成建议) */}
        {viewMode === 'ai_original' && (
          <div data-testid="view-ai-original-content" className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-blue-900 font-bold">
              <span>AI原始建议文本（微调不覆盖此原始记录）：</span>
              <span className="font-mono text-slate-500">{suggestion.suggestedText.length} 字</span>
            </div>
            <div className="p-3 bg-white rounded border border-blue-200 text-slate-900 text-sm font-serif leading-relaxed select-text">
              {suggestion.suggestedText}
            </div>
          </div>
        )}

        {/* 3. Explanations & Verification Notes */}
        <div className="p-2.5 bg-white/90 rounded border border-blue-100 text-xs space-y-1.5">
          <div>
            <strong className="text-slate-900">AI原始建议说明：</strong>
            <span className="text-slate-700 ml-1 leading-relaxed">{suggestion.diffExplanation}</span>
          </div>

          {/* Explicit disclaimer when human fine-tuning exists */}
          {isFineTuned && (
            <div
              data-testid="notice-fine-tuned-disclaimer"
              className="p-1.5 bg-amber-50 rounded border border-amber-200 text-amber-900 text-[11px] flex items-start gap-1"
            >
              <Info className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>人工微调标识：</strong>待采纳文本已由主笔人工微调，实际采纳将严格写入微调后内容；上述AI说明针对原始建议，不冒充对人工修改的重新核验。
              </span>
            </div>
          )}

          {suggestion.needsVerificationNotes && suggestion.needsVerificationNotes.length > 0 && (
            <div className="pt-1 border-t border-slate-100">
              <strong className="text-amber-800">需核对项：</strong>
              <ul className="list-disc list-inside mt-0.5 space-y-0.5 text-amber-900 text-[11px]">
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
            className="px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
            title="复制当前文本至剪贴板"
          >
            <Copy className="w-3.5 h-3.5 text-slate-500" />
            <span>{copyFeedback || '复制文本'}</span>
          </button>
          <button
            type="button"
            data-testid="btn-regenerate-suggestion"
            onClick={onRegenerate}
            disabled={isGenerating}
            className="px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-50 transition-colors"
            title="以当前段落正文重新生成建议"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            <span>重新生成</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="btn-discard-suggestion"
            onClick={onDiscard}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-600 rounded text-xs font-medium cursor-pointer transition-colors"
            title="放弃此建议（正文不改变）"
          >
            放弃
          </button>

          <button
            type="button"
            data-testid="btn-adopt-suggestion"
            onClick={() => onAdopt(pendingText)}
            disabled={isAdoptDisabled}
            className={`px-4 py-1.5 rounded text-xs font-bold shadow-xs flex items-center gap-1.5 transition-all ${
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
  );
};
