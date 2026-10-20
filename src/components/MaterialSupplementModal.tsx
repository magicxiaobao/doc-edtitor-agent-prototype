import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  FileText, 
  CheckSquare, 
  Square, 
  Sparkles, 
  AlertTriangle, 
  ExternalLink, 
  ArrowRight,
  RefreshCw,
  Info,
  CheckCircle2,
  Trash2
} from 'lucide-react';
import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  UserRole, 
  EvidenceSnippet, 
  Fact, 
  RevisionSuggestion,
  TaskStage
} from '../types';
import { 
  validateMaterialForSupplementation, 
  computeMaterialFingerprint,
  isSupportedSupplementPrompt,
  requestMaterialSupplementationAsync,
  validateSelectedMaterialsQuantitativeClaims
} from '../services/materialSupplementService';
import { checkPermission } from '../services/permissionService';

export interface MaterialSupplementModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  currentDraft: DraftVersion | undefined;
  activeBlock: ParagraphBlock | undefined;
  activeRole: UserRole;
  onViewSnippet: (snippet: EvidenceSnippet, fact?: Fact) => void;
  onSelectStage?: (stage: TaskStage) => void;
  onSupplementSuccess: (suggestion: RevisionSuggestion) => void;
}

const SUPPORTED_PROMPT_EXAMPLES = [
  '结合所选案例补充本段工作做法',
  '补充典型案例举措及成效',
  '根据所选材料补充具体工作做法',
  '补充有关案例做法与实践经验'
];

export const MaterialSupplementModal: React.FC<MaterialSupplementModalProps> = ({
  isOpen,
  onClose,
  task,
  currentDraft,
  activeBlock,
  activeRole,
  onViewSnippet,
  onSelectStage,
  onSupplementSuccess,
}) => {
  const [selectedSnippetIds, setSelectedSnippetIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState<string>('结合所选案例补充本段工作做法');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  const currentTaskIdRef = useRef(task.id);
  const currentDraftIdRef = useRef(currentDraft?.id);
  const currentBlockIdRef = useRef(activeBlock?.id);
  const previousTaskIdRef = useRef(task.id);
  const previousDraftIdRef = useRef(currentDraft?.id);
  const previousBlockIdRef = useRef(activeBlock?.id);

  useEffect(() => {
    if (
      previousTaskIdRef.current !== task.id ||
      previousDraftIdRef.current !== currentDraft?.id ||
      previousBlockIdRef.current !== activeBlock?.id
    ) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setIsGenerating(false);
      setSelectedSnippetIds([]);
      setGenerationError(null);
      if (previousTaskIdRef.current !== task.id && isOpen) {
        onClose();
      }
      previousTaskIdRef.current = task.id;
      previousDraftIdRef.current = currentDraft?.id;
      previousBlockIdRef.current = activeBlock?.id;
    }
    currentTaskIdRef.current = task.id;
    currentDraftIdRef.current = currentDraft?.id;
    currentBlockIdRef.current = activeBlock?.id;
  }, [task.id, currentDraft?.id, activeBlock?.id, isOpen, onClose]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Store trigger element for focus restoration & auto-focus first element
  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement;
      setGenerationError(null);
      const timer = setTimeout(() => {
        if (modalRef.current) {
          const focusables = Array.from(
            modalRef.current.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
          if (focusables.length > 0) {
            focusables[0].focus();
          }
        }
      }, 50);
      return () => clearTimeout(timer);
    } else {
      if (triggerElementRef.current && typeof triggerElementRef.current.focus === 'function') {
        triggerElementRef.current.focus();
      }
    }
  }, [isOpen]);

  // Tab cycle and Escape key handling with strict focus trap
  useEffect(() => {
    if (!isOpen) return;

    const getFocusables = (): HTMLElement[] => {
      if (!modalRef.current) return [];
      const all = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      const visible = all.filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
      return visible.length > 0 ? visible : all;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (isGenerating && abortControllerRef.current) {
          abortControllerRef.current.abort();
          setIsGenerating(false);
        }
        onClose();
        return;
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusables = getFocusables();

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        // If focus has leaked outside modal, trap it back
        if (!modalRef.current.contains(document.activeElement)) {
          e.preventDefault();
          if (e.shiftKey) {
            lastElement.focus();
          } else {
            firstElement.focus();
          }
          return;
        }

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (!modalRef.current) return;
      if (!modalRef.current.contains(e.target as Node)) {
        e.preventDefault();
        const focusables = getFocusables();
        if (focusables.length > 0) {
          focusables[0].focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [isOpen, isGenerating, onClose]);

  if (!isOpen || !activeBlock) return null;

  const perm = checkPermission(activeRole, 'adopt_revision');
  const isImmutable = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal || task.isFinalized);

  // Filter and validate all snippets in task with early quantitative verification
  const allSnippetsWithValidation = (task.snippets || []).map((snip) => {
    const admission = validateMaterialForSupplementation(task, snip);
    const doc = (task.documents || []).find((d) => d.id === snip.sourceDocId);
    const relatedFact = (task.facts || []).find(
      (f) => f.status === 'confirmed' && !f.isHistoricOnly && (f.primaryEvidenceId === snip.id || f.evidenceIds?.includes(snip.id))
    );

    // Early quantitative claim verification against fact base
    const quantCheck = validateSelectedMaterialsQuantitativeClaims(task, [snip]);

    let isEligible = admission.eligible;
    let reason = admission.reason;
    if (isEligible && !quantCheck.valid) {
      isEligible = false;
      const unverifiedItems = quantCheck.unverifiedClaims?.map((c) => {
        const m = c.match(/“([^”]+)”/);
        return m ? m[1] : c;
      }) || [];
      reason = `包含未核准量化指标（${unverifiedItems.join('、') || '量化数据未核准'}），须先在材料与事实页面核准登记`;
    }

    return {
      snippet: snip,
      doc,
      relatedFact,
      admission: {
        eligible: isEligible,
        reason,
        baseAdmissionEligible: admission.eligible,
        quantValid: quantCheck.valid,
      },
    };
  });

  const validSnippets = allSnippetsWithValidation.filter((item) => item.admission.eligible);
  const hasValidMaterials = validSnippets.length > 0;

  const handleToggleSnippet = (snippetId: string, isValid: boolean) => {
    if (!isValid) return;
    setGenerationError(null);
    setSelectedSnippetIds((prev) =>
      prev.includes(snippetId) ? prev.filter((id) => id !== snippetId) : [...prev, snippetId]
    );
  };

  const handleClearSelection = () => {
    setSelectedSnippetIds([]);
    setGenerationError(null);
  };

  const handleCancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsGenerating(false);
    setGenerationError('主笔已取消本次补写建议生成。原有正文与草稿内容保持不变。');
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!perm.allowed) {
      setGenerationError(perm.reason || '权限受限，仅主笔可生成补写建议');
      return;
    }
    if (isImmutable) {
      setGenerationError('当前文稿处于只读冻结状态，禁止生成补写');
      return;
    }
    if (selectedSnippetIds.length === 0) {
      setGenerationError('请至少勾选一项本期有效的核准材料依据！未选择有效材料时，不能生成补写。');
      return;
    }

    setGenerationError(null);
    setIsGenerating(true);

    const boundTaskId = task.id;
    const boundDraftId = currentDraft?.id;
    const boundBlockId = activeBlock.id;
    const runId = `RUN-MAT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const selectedSnippets = (task.snippets || []).filter((s) => selectedSnippetIds.includes(s.id));
      const suggestion = await requestMaterialSupplementationAsync({
        block: activeBlock,
        selectedSnippets,
        prompt: instruction,
        task,
        currentDraft,
        runId,
        signal: controller.signal,
      });

      // Strict boundary check: If task, draft, or block changed in workspace, discard!
      if (
        controller.signal.aborted ||
        currentTaskIdRef.current !== boundTaskId ||
        currentDraftIdRef.current !== boundDraftId ||
        currentBlockIdRef.current !== boundBlockId ||
        task.id !== boundTaskId ||
        suggestion.taskId !== boundTaskId ||
        suggestion.targetBlockId !== boundBlockId
      ) {
        return;
      }

      setIsGenerating(false);
      if (suggestion.isUnsupportedPrompt) {
        setGenerationError(suggestion.unsupportedPromptNotice || suggestion.diffExplanation);
        return;
      }
      onSupplementSuccess(suggestion);
      onClose();
    } catch (err: any) {
      if (
        controller.signal.aborted ||
        currentTaskIdRef.current !== boundTaskId ||
        currentDraftIdRef.current !== boundDraftId ||
        currentBlockIdRef.current !== boundBlockId ||
        task.id !== boundTaskId
      ) {
        return;
      }
      if (err.name === 'AbortError' || controller.signal.aborted) {
        setGenerationError('主笔已取消本次补写建议生成。原有正文与草稿内容保持不变。');
      } else {
        setGenerationError(err?.message || '补写生成发生异常，请稍后重试');
      }
      setIsGenerating(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="material-supplement-title"
    >
      <div 
        ref={modalRef}
        data-testid="material-supplement-modal"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-3xl flex flex-col max-h-[92vh] overflow-hidden my-auto"
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 id="material-supplement-title" className="text-base font-bold text-slate-900">
                依据材料补写段落
              </h2>
              <p className="text-xs text-slate-500">
                指定经核准的业务材料原文，为正文特定段落补充真实可靠的举措做法（本地确定性模拟）
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="btn-close-material-supplement-modal"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-md cursor-pointer transition-colors"
            title="关闭窗口 (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 flex-1">
          {/* Paragraph Scope & Baseline Card (Compact streamlined bar for tablet landscape & desktop) */}
          <div className="p-2 sm:p-2.5 bg-blue-50/80 rounded-lg border border-blue-200 text-xs flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span 
                data-testid="label-scope-notice"
                className="font-bold text-blue-900 text-xs shrink-0 flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-700 shrink-0" />
                本次仅修改第 {activeBlock.order} 段
              </span>
              <span className="text-slate-300 text-xs shrink-0">|</span>
              <span className="text-xs text-slate-500 shrink-0 hidden sm:inline font-medium">当前段落原文：</span>
              <p 
                data-testid="current-block-content-preview"
                className="text-xs text-slate-800 font-serif truncate max-w-sm sm:max-w-md md:max-w-lg cursor-pointer hover:text-slate-950"
                title={`点击查看完整：${activeBlock.content}`}
              >
                {activeBlock.content}
              </p>
            </div>
            <span className="text-xs text-blue-700 font-mono shrink-0">
              共 {activeBlock.content.length} 字
            </span>
          </div>

          {/* Material Selection Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-800">
                  选择本次补写依据的材料片段：
                </span>
                <span 
                  data-testid="selected-snippets-count-badge"
                  className="text-xs px-2 py-0.5 rounded-full font-bold bg-teal-100 text-teal-800 border border-teal-200"
                >
                  已选 {selectedSnippetIds.length} 项
                </span>
              </div>
              {selectedSnippetIds.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-clear-selected-snippets"
                  onClick={handleClearSelection}
                  className="text-xs text-rose-700 hover:text-rose-900 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>清空已选</span>
                </button>
              )}
            </div>

            {/* List of Material Snippets */}
            {allSnippetsWithValidation.length > 0 ? (
              <div className="space-y-2.5 max-h-[260px] overflow-y-auto pr-1">
                {allSnippetsWithValidation.map(({ snippet, doc, relatedFact, admission }) => {
                  const isSelected = selectedSnippetIds.includes(snippet.id);
                  const isValid = admission.eligible;

                  return (
                    <div
                      key={snippet.id}
                      data-testid={`material-item-${snippet.id}`}
                      className={`p-3.5 rounded-lg border text-xs transition-all ${
                        !isValid
                          ? 'bg-slate-50/80 border-slate-200 opacity-70'
                          : isSelected
                          ? 'bg-teal-50/70 border-teal-400 ring-2 ring-teal-100 shadow-2xs'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Selection Checkbox */}
                        <button
                          type="button"
                          data-testid={`checkbox-select-snippet-${snippet.id}`}
                          disabled={!isValid || isGenerating}
                          onClick={() => handleToggleSnippet(snippet.id, isValid)}
                          className={`mt-0.5 shrink-0 cursor-pointer ${
                            !isValid
                              ? 'text-slate-300 cursor-not-allowed'
                              : isSelected
                              ? 'text-teal-700'
                              : 'text-slate-400 hover:text-slate-600'
                          }`}
                          aria-label={`选择材料 ${snippet.docName}`}
                        >
                          {isSelected ? (
                            <CheckSquare className="w-5 h-5 fill-teal-100" />
                          ) : (
                            <Square className="w-5 h-5" />
                          )}
                        </button>

                        <div className="flex-1 space-y-1.5">
                          {/* Title and Status Tags */}
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-bold text-slate-900 text-sm">
                              {snippet.docName}
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {isValid ? (
                                <span className="bg-emerald-100 text-emerald-800 text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                  <span>准入有效</span>
                                </span>
                              ) : (
                                <span 
                                  data-testid={`admission-error-badge-${snippet.id}`}
                                  className="bg-amber-100 text-amber-900 border border-amber-300 text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1"
                                >
                                  <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                                  <span>{admission.reason}</span>
                                </span>
                              )}
                              <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded font-mono">
                                {snippet.period || '期间未注明'}
                              </span>
                            </div>
                          </div>

                          {/* Snippet text */}
                          <div className="p-2 bg-slate-50 rounded border border-slate-100 text-slate-800 text-sm font-serif leading-relaxed">
                            “{snippet.text}”
                          </div>

                          {/* Business metadata */}
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs text-slate-500 pt-0.5">
                            <div>
                              来源文档：<strong className="text-slate-700">{doc?.name || snippet.docName}</strong>
                            </div>
                            <div>
                              统计口径：<strong className="text-slate-700">{snippet.location || '专项做法'}</strong>
                            </div>
                            <div>
                              用途属性：<strong className="text-slate-700">{doc?.usage || '业务材料'}</strong>
                            </div>
                          </div>

                          {/* Related confirmed fact if any */}
                          {relatedFact && (
                            <div className="text-xs text-blue-800 bg-blue-50/70 p-1.5 rounded flex items-center justify-between">
                              <span>
                                关联已核准事实：{relatedFact.metric} ({relatedFact.selectedConflictValue || relatedFact.value}{relatedFact.unit})
                              </span>
                              <span className="font-mono text-xs">{relatedFact.metricScope}</span>
                            </div>
                          )}

                          {/* Diagnosis info collapsed */}
                          <details className="text-xs text-slate-400 cursor-pointer pt-0.5">
                            <summary className="hover:text-slate-600">系统诊断信息（内部标识）</summary>
                            <div className="p-1.5 bg-slate-100 rounded font-mono text-xs text-slate-600 mt-1 space-y-0.5">
                              <div>片段ID: {snippet.id}</div>
                              <div>文档ID: {snippet.sourceDocId}</div>
                              <div>位置: {snippet.location || '正文'}</div>
                              <div>指纹: {computeMaterialFingerprint([snippet])}</div>
                            </div>
                          </details>

                          {/* View original in drawer */}
                          <div className="pt-1 flex justify-end">
                            <button
                              type="button"
                              onClick={() => onViewSnippet(snippet, relatedFact)}
                              className="text-xs text-blue-700 hover:text-blue-900 font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <span>在抽屉中查看材料原文</span>
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-5 bg-amber-50 rounded-lg border border-amber-200 text-amber-900 text-xs space-y-2">
                <div className="font-bold flex items-center gap-1.5 text-sm">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>材料库中暂无可用的有效补写材料</span>
                </div>
                <p className="leading-relaxed">
                  当前任务中尚未导入符合本期时间与公文用途要求的业务案例材料，或材料未完成事实核准。
                </p>
                {onSelectStage && (
                  <div className="pt-2">
                    <button
                      type="button"
                      data-testid="btn-go-to-materials"
                      onClick={() => {
                        onClose();
                        onSelectStage('material_fact');
                      }}
                      className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1 shadow-2xs"
                    >
                      <span>前往材料与事实页面导入与核准</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* When all materials are invalid, show clear guidance */}
            {allSnippetsWithValidation.length > 0 && !hasValidMaterials && (
              <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-amber-900 text-xs space-y-2">
                <div className="font-bold flex items-center gap-1.5 text-sm">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>当前所有材料均未通过补写准入校验</span>
                </div>
                <p className="leading-relaxed">
                  材料已被排除、属于历史文风参考、缺少原文线索或存在跨期问题。为防止虚构事实，系统已阻断生成。原有正文完好保留。
                </p>
                {onSelectStage && (
                  <div className="pt-1">
                    <button
                      type="button"
                      data-testid="btn-go-to-materials"
                      onClick={() => {
                        onClose();
                        onSelectStage('material_fact');
                      }}
                      className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1 shadow-2xs"
                    >
                      <span>前往材料与事实页面调整材料</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Supplement Instruction Input */}
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <label htmlFor="supplement-instruction-input" className="text-sm font-bold text-slate-800 block">
              主笔本次补写要求：
            </label>
            <textarea
              id="supplement-instruction-input"
              data-testid="input-supplement-instruction"
              rows={2}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setGenerationError(null);
              }}
              disabled={isGenerating}
              placeholder="例如：结合所选案例补充本段工作做法..."
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:outline-hidden"
            />

            {/* Supported Examples Chips */}
            <div className="space-y-1">
              <span className="text-xs text-slate-400">明确支持的指令示例（点击填入）：</span>
              <div className="flex flex-wrap gap-1.5">
                {SUPPORTED_PROMPT_EXAMPLES.map((ex, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setInstruction(ex);
                      setGenerationError(null);
                    }}
                    disabled={isGenerating}
                    className="text-xs bg-slate-100 hover:bg-teal-50 text-slate-700 hover:text-teal-800 px-2.5 py-1 rounded-md border border-slate-200 cursor-pointer transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Error Message Box */}
          {generationError && (
            <div 
              data-testid="material-supplement-error-box"
              className="p-3 bg-rose-50 border border-rose-300 rounded-lg text-xs text-rose-900 space-y-1"
            >
              <div className="font-bold flex items-center gap-1 text-sm">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>补写无法生成</span>
              </div>
              <p className="leading-relaxed text-xs">{generationError}</p>
            </div>
          )}

          {/* Loading state with cancellation */}
          {isGenerating && (
            <div 
              data-testid="supplement-generating-indicator"
              className="p-3.5 bg-teal-50 border border-teal-300 rounded-lg text-xs space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-teal-900 text-sm flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-teal-700 animate-spin" />
                  正在根据所选材料为第 {activeBlock.order} 段生成补写建议...
                </span>
                <button
                  type="button"
                  data-testid="btn-cancel-supplement-generation"
                  onClick={handleCancelGeneration}
                  className="px-3 py-1 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-md text-xs font-bold cursor-pointer"
                >
                  取消生成
                </button>
              </div>
              <p className="text-teal-700 text-xs">
                正在校验材料指纹与关联事实，提取真实做法。原有正文完全保持不变。
              </p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
          <span className="text-slate-500">
            范围提示：确认采纳后将仅替换第 {activeBlock.order} 段，其余段落不发生变动。
          </span>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              data-testid="btn-cancel-modal"
              onClick={onClose}
              disabled={isGenerating}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-sm font-medium cursor-pointer transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              data-testid="btn-submit-material-supplement"
              onClick={() => handleSubmit()}
              disabled={isGenerating || selectedSnippetIds.length === 0 || !hasValidMaterials || isImmutable}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-lg text-sm font-bold shadow-xs cursor-pointer disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              <span>生成补写建议</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
