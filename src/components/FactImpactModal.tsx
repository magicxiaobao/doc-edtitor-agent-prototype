import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  FactImpactAnalysisResult,
  FactImpactItem,
} from '../services/factImpactService';
import {
  evaluateDraftFactReviews,
  getFactReviewContext,
  isValidFactReviewRecord,
  isValidFrozenFactReviewOverview,
  DraftFactReviewOverview,
  BlockFactReviewEvaluation,
} from '../services/factReviewService';
import { DraftVersion, Task, UserRole, FactRevisionCandidate, MultiParagraphFactRevisionCandidate, MultiFactGroupRevisionCandidate } from '../types';
import {
  checkFactRevisionEligibility,
  generateFactRevisionCandidate,
  validateFactRevisionAcceptance,
  checkMultiParagraphFactRevisionEligibility,
  generateMultiParagraphFactRevisionCandidate,
  validateMultiParagraphFactRevisionAcceptance,
  checkMultiFactGroupRevisionEligibility,
  generateMultiFactGroupRevisionCandidate,
  validateMultiFactGroupRevisionAcceptance,
} from '../services/factRevisionCandidateService';
import { computeTextDiff } from '../services/diffService';
import {
  X,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  MapPin,
  FileText,
  AlertCircle,
  HelpCircle,
  Clock,
  ArrowRight,
  ShieldAlert,
  Info,
  Check,
  RotateCcw,
  PauseCircle,
  History,
  Sparkles,
} from 'lucide-react';

interface FactImpactModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: FactImpactAnalysisResult;
  currentDraft?: DraftVersion;
  task?: Task;
  currentTask?: Task;
  activeRole?: UserRole;
  onLocateBlock?: (blockId: string, factId?: string) => void;
  onViewDraftEvidence?: (item: FactImpactItem) => void;
  onJumpToFactsStage?: () => void;
  onJumpToOutlineStage?: () => void;
  onSaveReviewRecord?: (blockId: string, status: 'reviewed' | 'deferred', notes: string, context: string) => string | void;
  onRevokeReviewRecord?: (blockId: string, reason: string, context: string, recordId: string) => string | void;
  onAcceptFactRevision?: (candidate: FactRevisionCandidate, activeRunId: string) => { success: boolean; reason?: string } | void;
  onAcceptMultiParagraphFactRevision?: (candidateGroup: MultiParagraphFactRevisionCandidate, activeRunId: string) => { success: boolean; reason?: string } | void;
  onAcceptMultiFactGroupRevision?: (candidateGroup: MultiFactGroupRevisionCandidate, activeRunId: string) => { success: boolean; reason?: string } | void;
  initialBlockId?: string;
}

export const FactImpactModal: React.FC<FactImpactModalProps> = ({
  isOpen,
  onClose,
  analysis,
  currentDraft,
  task: taskProp,
  currentTask,
  activeRole = '主笔甲',
  onLocateBlock = () => {},
  onViewDraftEvidence = () => {},
  onJumpToFactsStage,
  onJumpToOutlineStage,
  onSaveReviewRecord,
  onRevokeReviewRecord,
  onAcceptFactRevision,
  onAcceptMultiParagraphFactRevision,
  onAcceptMultiFactGroupRevision,
  initialBlockId,
}) => {
  const task = (taskProp || currentTask)!;
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Form input state keyed by blockId
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [revokingBlockId, setRevokingBlockId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState<string>('');
  const [formContexts,setFormContexts]=useState<Record<string,string>>({});
  const [revokeContext,setRevokeContext]=useState<{fingerprint:string;recordId:string}|null>(null);
  const [formError,setFormError]=useState<string>('');

  // Fact revision candidate state keyed by blockId
  const [activeCandidates, setActiveCandidates] = useState<Record<string, FactRevisionCandidate>>({});
  const [revisionErrors, setRevisionErrors] = useState<Record<string, { reason: string; unconfirmedUpstream?: 'fact' | 'style' | 'outline' }>>({});
  const [acceptErrors, setAcceptErrors] = useState<Record<string, string>>({});
  const activeRevisionRuns = useRef<Record<string, string>>({});

  // Multi-paragraph fact revision candidate state keyed by targetFactId
  const [activeGroupCandidates, setActiveGroupCandidates] = useState<Record<string, MultiParagraphFactRevisionCandidate>>({});
  const [groupRevisionErrors, setGroupRevisionErrors] = useState<Record<string, { reason: string; unconfirmedUpstream?: 'fact' | 'style' | 'outline' }>>({});
  const [groupAcceptErrors, setGroupAcceptErrors] = useState<Record<string, string>>({});
  const activeGroupRevisionRuns = useRef<Record<string, string>>({});

  // Task 25: Two-fact group revision candidate state
  const [activeMultiFactCandidate, setActiveMultiFactCandidate] = useState<MultiFactGroupRevisionCandidate | null>(null);
  const [multiFactGroupError, setMultiFactGroupError] = useState<{ reason: string; unconfirmedUpstream?: 'fact' | 'style' | 'outline' } | null>(null);
  const [multiFactGroupAcceptError, setMultiFactGroupAcceptError] = useState<string | null>(null);
  const activeMultiFactRunId = useRef<string | null>(null);

  // Reset inputs when task or draft changes
  useEffect(() => {
    setReviewNotes({});
    setRevokingBlockId(null);
    setRevokeReason('');
    setFormContexts({});
    setRevokeContext(null);
    setFormError('');
    setActiveCandidates({});
    setRevisionErrors({});
    setAcceptErrors({});
    activeRevisionRuns.current = {};
    setActiveGroupCandidates({});
    setGroupRevisionErrors({});
    setGroupAcceptErrors({});
    activeGroupRevisionRuns.current = {};
    setActiveMultiFactCandidate(null);
    setMultiFactGroupError(null);
    setMultiFactGroupAcceptError(null);
    activeMultiFactRunId.current = null;
  }, [isOpen, task.id, currentDraft?.id, activeRole]);

  useEffect(() => {
    if (!isOpen || !activeMultiFactCandidate) return;
    const card = modalRef.current?.querySelector<HTMLElement>('[data-testid="multi-fact-group-revision-candidate-card"]');
    card?.focus({ preventScroll: true });
    card?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, activeMultiFactCandidate]);

  useEffect(() => {
    if (!isOpen || !Object.keys(activeGroupCandidates).length) return;
    const group = modalRef.current?.querySelector<HTMLElement>('[data-testid^="multi-paragraph-revision-candidate-card-"]');
    group?.focus({ preventScroll: true });
    group?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, activeGroupCandidates]);

  // Capture previous focused element and restore on close
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;
      const card=initialBlockId?modalRef.current?.querySelector<HTMLElement>(`[data-review-block-id="${initialBlockId}"]`):null;
      (card||modalRef.current)?.focus();
      card?.scrollIntoView?.({block:'nearest'});
    }
    return () => {
      if (isOpen && previousActiveElementRef.current?.isConnected) {
        previousActiveElementRef.current.focus({ preventScroll: true });
      }
    };
  }, [isOpen,initialBlockId]);

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const panel = modalRef.current;
        if (!panel) return;
        const controls = [
          ...panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
          ),
        ].filter((el) => !el.closest('[hidden], [inert], [aria-hidden="true"]'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (!first) {
          e.preventDefault();
          panel.focus();
        } else if (
          !panel.contains(active) ||
          active === panel ||
          (e.shiftKey ? active === first : active === last)
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  // Evaluate fact review records
  const reviewOverview: DraftFactReviewOverview = useMemo(() => {
    return evaluateDraftFactReviews(task, currentDraft);
  }, [task, currentDraft]);

  if (!isOpen) return null;

  const isHistoricalOrFinal = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal);
  const hasFrozenReviewConclusion=isHistoricalOrFinal&&isValidFrozenFactReviewOverview(currentDraft?.frozenFactReviewOverview);
  const isAuthor = activeRole === '主笔甲';

  const handleNotesChange = (blockId: string, value: string) => {
    setReviewNotes((prev) => ({ ...prev, [blockId]: value }));
    const block=currentDraft?.blocks.find(b=>b.id===blockId);
    if(currentDraft&&block)setFormContexts(prev=>({...prev,[blockId]:getFactReviewContext(task,currentDraft,block)}));
    setFormError('');
  };

  const handleSubmitReview = (blockId: string, status: 'reviewed' | 'deferred') => {
    const notes = reviewNotes[blockId] || '';
    if (!notes.trim()) return;
    if (onSaveReviewRecord) {
      const error=onSaveReviewRecord(blockId, status, notes.trim(),formContexts[blockId]);
      if(error){setFormError(error);return;}
      // Clear note for this block
      setReviewNotes((prev) => {
        const next = { ...prev };
        delete next[blockId];
        return next;
      });
    }
  };

  const handleConfirmRevoke = (blockId: string) => {
    if (!revokeReason.trim()) return;
    if (onRevokeReviewRecord) {
      if(!revokeContext)return;
      const error=onRevokeReviewRecord(blockId, revokeReason.trim(),revokeContext.fingerprint,revokeContext.recordId);
      if(error){setFormError(error);return;}
      setRevokingBlockId(null);
      setRevokeReason('');
    }
  };

  const handleGenerateRevision = (blockId: string) => {
    setAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    const res = generateFactRevisionCandidate(task, currentDraft, blockId, activeRole);
    if (!res.success || !res.candidate) {
      delete activeRevisionRuns.current[blockId];
      const eligibility = checkFactRevisionEligibility(task, currentDraft, blockId, activeRole);
      setRevisionErrors((prev) => ({
        ...prev,
        [blockId]: {
          reason: res.reason || eligibility.reason || '生成修订候选失败',
          unconfirmedUpstream: eligibility.unconfirmedUpstream,
        },
      }));
      setActiveCandidates((prev) => {
        const next = { ...prev };
        delete next[blockId];
        return next;
      });
    } else {
      activeRevisionRuns.current[blockId] = res.candidate.runId;
      setRevisionErrors((prev) => {
        const next = { ...prev };
        delete next[blockId];
        return next;
      });
      setActiveCandidates((prev) => ({
        ...prev,
        [blockId]: res.candidate!,
      }));
    }
  };

  const handleCancelRevision = (blockId: string) => {
    delete activeRevisionRuns.current[blockId];
    setActiveCandidates((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setRevisionErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  };

  const handleAcceptRevision = (candidate: FactRevisionCandidate) => {
    const blockId = candidate.targetBlockId;
    setAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });

    const runId = activeRevisionRuns.current[blockId];
    const validation = validateFactRevisionAcceptance(task, currentDraft, candidate, activeRole, runId);
    if (!isOpen || !validation.valid) {
      setAcceptErrors(prev => ({ ...prev, [blockId]: validation.reason || '面板已关闭，候选已取消' }));
      return;
    }
    try {
      const res = onAcceptFactRevision?.(candidate, runId);
      if (!res?.success) {
        setAcceptErrors(prev => ({ ...prev, [blockId]: res?.reason || '未完成业务写入，请重试或重新生成候选' }));
        return;
      }
    } catch (error) {
      setAcceptErrors(prev => ({ ...prev, [blockId]: error instanceof Error ? error.message : '采纳异常，请重试' }));
      return;
    }
    delete activeRevisionRuns.current[blockId];

    // Successfully accepted: clear candidate preview
    setActiveCandidates((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  };

  const handleGenerateMultiRevision = (factId: string) => {
    setGroupAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });
    const res = generateMultiParagraphFactRevisionCandidate(task, currentDraft, activeRole, { targetFactId: factId });
    if (!res.success || !res.candidateGroup) {
      delete activeGroupRevisionRuns.current[factId];
      const eligibility = checkMultiParagraphFactRevisionEligibility(task, currentDraft, activeRole, { targetFactId: factId });
      setGroupRevisionErrors((prev) => ({
        ...prev,
        [factId]: {
          reason: res.reason || eligibility.reason || '生成多段落修订候选失败',
          unconfirmedUpstream: eligibility.unconfirmedUpstream,
        },
      }));
      setActiveGroupCandidates((prev) => {
        const next = { ...prev };
        delete next[factId];
        return next;
      });
    } else {
      activeGroupRevisionRuns.current[factId] = res.candidateGroup.runId;
      setGroupRevisionErrors((prev) => {
        const next = { ...prev };
        delete next[factId];
        return next;
      });
      setActiveGroupCandidates((prev) => ({
        ...prev,
        [factId]: res.candidateGroup!,
      }));
    }
  };

  const handleCancelMultiRevision = (factId: string) => {
    delete activeGroupRevisionRuns.current[factId];
    setActiveGroupCandidates((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });
    setGroupRevisionErrors((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });
    setGroupAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });
  };

  const handleAcceptMultiRevision = (candidateGroup: MultiParagraphFactRevisionCandidate) => {
    const factId = candidateGroup.targetFactId;
    setGroupAcceptErrors((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });

    const runId = activeGroupRevisionRuns.current[factId];
    const validation = validateMultiParagraphFactRevisionAcceptance(task, currentDraft, candidateGroup, activeRole, runId);
    if (!isOpen || !validation.valid) {
      setGroupAcceptErrors((prev) => ({ ...prev, [factId]: validation.reason || '面板已关闭，候选已取消' }));
      return;
    }
    try {
      const res = onAcceptMultiParagraphFactRevision?.(candidateGroup, runId);
      if (!res?.success) {
        setGroupAcceptErrors((prev) => ({ ...prev, [factId]: res?.reason || '未完成业务写入，请重试或重新生成候选' }));
        return;
      }
    } catch (error) {
      setGroupAcceptErrors((prev) => ({ ...prev, [factId]: error instanceof Error ? error.message : '采纳异常，请重试' }));
      return;
    }
    delete activeGroupRevisionRuns.current[factId];

    // Successfully accepted: clear candidate preview
    setActiveGroupCandidates((prev) => {
      const next = { ...prev };
      delete next[factId];
      return next;
    });
  };

  const handleGenerateMultiFactGroupRevision = () => {
    setMultiFactGroupAcceptError(null);
    const res = generateMultiFactGroupRevisionCandidate(task, currentDraft, activeRole);
    if (!res.success || !res.candidateGroup) {
      activeMultiFactRunId.current = null;
      const eligibility = checkMultiFactGroupRevisionEligibility(task, currentDraft, activeRole);
      setMultiFactGroupError({
        reason: res.reason || eligibility.reason || '生成两项事实成组修订候选失败',
        unconfirmedUpstream: eligibility.unconfirmedUpstream,
      });
      setActiveMultiFactCandidate(null);
    } else {
      activeMultiFactRunId.current = res.candidateGroup.runId;
      setMultiFactGroupError(null);
      setActiveMultiFactCandidate(res.candidateGroup);
    }
  };

  const handleCancelMultiFactGroupRevision = () => {
    activeMultiFactRunId.current = null;
    setActiveMultiFactCandidate(null);
    setMultiFactGroupError(null);
    setMultiFactGroupAcceptError(null);
  };

  const handleAcceptMultiFactGroupRevision = (candidateGroup: MultiFactGroupRevisionCandidate) => {
    setMultiFactGroupAcceptError(null);
    const runId = activeMultiFactRunId.current || '';
    const validation = validateMultiFactGroupRevisionAcceptance(task, currentDraft, candidateGroup, activeRole, runId);
    if (!isOpen || !validation.valid) {
      setMultiFactGroupAcceptError(validation.reason || '面板已关闭，候选已取消');
      return;
    }
    try {
      const res = onAcceptMultiFactGroupRevision?.(candidateGroup, runId);
      if (!res?.success) {
        setMultiFactGroupAcceptError(res?.reason || '未完成业务写入，请重试或重新生成候选');
        return;
      }
    } catch (error) {
      setMultiFactGroupAcceptError(error instanceof Error ? error.message : '采纳异常，请重试');
      return;
    }
    activeMultiFactRunId.current = null;
    setActiveMultiFactCandidate(null);
  };

  const renderParagraphComparison = (
    blockId: string,
    blockOrder: number,
    originalContent: string,
    revisedContent: string,
    fromValue: string,
    toValue: string,
    unit: string
  ) => {
    return (
      <div className="space-y-2.5">
        {/* Labeled Original Text (Fixes Issue #82: pristine whole paragraph) */}
        <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs space-y-1">
          <div className="flex items-center justify-between text-slate-600 font-semibold">
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-2xs font-mono font-bold">
                【原文】
              </span>
              <span>当前稿完整文本（原数值：{fromValue} {unit}）</span>
            </span>
            <span className="text-2xs text-slate-400">完整未修改段落</span>
          </div>
          <div
            data-testid={`original-block-content-${blockId}`}
            aria-label={`第${blockOrder}段原文完整文本`}
            className="p-2.5 bg-white rounded border border-slate-200 font-serif leading-relaxed text-slate-900 select-text text-xs"
          >
            {originalContent}
          </div>
        </div>

        {/* Labeled Revised Candidate Text (Fixes Issue #82: pristine whole revised paragraph) */}
        <div className="p-2.5 bg-blue-50/50 border border-blue-200 rounded text-xs space-y-1">
          <div className="flex items-center justify-between text-blue-900 font-semibold">
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-blue-200 text-blue-800 text-2xs font-mono font-bold">
                【修订候选】
              </span>
              <span>拟写入完整文本（候选数值：{toValue} {unit}）</span>
            </span>
            <span className="text-2xs text-blue-600 font-medium">仅定向更新指标数值</span>
          </div>
          <div
            data-testid={`revised-block-content-${blockId}`}
            aria-label={`第${blockOrder}段修订候选完整文本`}
            className="p-2.5 bg-white rounded border border-blue-200 font-serif leading-relaxed text-slate-900 select-text text-xs"
          >
            {revisedContent}
          </div>
        </div>

        {/* Labeled Change Location Diff View (Fixes Issue #82: Demarcated tokens, never concatenating into 1280) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-slate-600 font-semibold text-xs">
            <span>变化位置对照（清晰区分原值与候选值，明确标注语义）：</span>
            <span className="text-2xs text-slate-400 font-normal">红色删除标注原值，绿色粗体标注新值</span>
          </div>
          <div
            data-testid={`revision-diff-view-${blockId}`}
            aria-label={`第${blockOrder}段变化位置对照`}
            className="p-3 bg-white rounded border border-slate-300 font-serif leading-relaxed text-slate-900 text-xs select-text"
          >
            {(() => {
              const fromToken = `${fromValue}${unit}`;
              const toToken = `${toValue}${unit}`;
              // Identify the occurrence that actually produces the full candidate.
              // An earlier identical quantity may belong to a different metric.
              let fromIdx = originalContent.indexOf(fromToken);
              while (fromIdx !== -1 &&
                originalContent.slice(0, fromIdx) + toToken + originalContent.slice(fromIdx + fromToken.length) !== revisedContent) {
                fromIdx = originalContent.indexOf(fromToken, fromIdx + fromToken.length);
              }

              if (fromIdx !== -1) {
                const prefix = originalContent.slice(0, fromIdx);
                const suffix = originalContent.slice(fromIdx + fromToken.length);
                return (
                  <>
                    <span>{prefix}</span>
                    <span
                      className="bg-rose-100 text-rose-800 line-through decoration-rose-500 px-1 py-0.5 rounded font-mono mx-0.5 inline-flex items-center"
                      aria-label={`删除原数值文本: ${fromToken}`}
                    >
                      [删: {fromToken}]
                    </span>
                    <span
                      className="bg-emerald-100 text-emerald-800 font-bold px-1 py-0.5 rounded font-mono mx-0.5 inline-flex items-center"
                      aria-label={`新增候选数值文本: ${toToken}`}
                    >
                      [改: {toToken}]
                    </span>
                    <span>{suffix}</span>
                  </>
                );
              }

              return computeTextDiff(originalContent, revisedContent).map((seg, sIdx) => {
                if (seg.type === 'removed') {
                  return (
                    <span
                      key={sIdx}
                      className="bg-rose-100 text-rose-800 line-through decoration-rose-500 px-1 py-0.5 rounded font-mono mx-0.5 inline-flex items-center"
                      aria-label={`删除原数值文本: ${seg.text}`}
                    >
                      [删: {seg.text}]
                    </span>
                  );
                }
                if (seg.type === 'added') {
                  return (
                    <span
                      key={sIdx}
                      className="bg-emerald-100 text-emerald-800 font-bold px-1 py-0.5 rounded font-mono mx-0.5 inline-flex items-center"
                      aria-label={`新增候选数值文本: ${seg.text}`}
                    >
                      [改: {seg.text}]
                    </span>
                  );
                }
                return <span key={sIdx}>{seg.text}</span>;
              });
            })()}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fact-impact-modal-title"
      data-testid="fact-impact-modal"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[92vh] flex flex-col border border-slate-200 outline-hidden"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50 rounded-t-xl shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-100 text-blue-700 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2
                  id="fact-impact-modal-title"
                  className="font-bold text-slate-800 text-base sm:text-lg"
                >
                  事实变更影响总览与逐段复核
                </h2>
                {isHistoricalOrFinal ? (
                  <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                    {currentDraft?.isFinal ? '正式定稿（只读）' : '历史快照（只读）'}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                    当前工作稿
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                对照稿件版本：
                <span className="font-semibold text-slate-700">
                  {currentDraft?.versionNumber || '无'}
                </span>
                {isHistoricalOrFinal &&
                  ' · 展示此稿历史冻结依据与当前任务事实的差异，不回写旧快照'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭事实影响检查面板"
            data-testid="btn-close-fact-impact-modal"
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 text-sm">
          {/* Top Banner Status */}
          {!analysis.hasDraft ? (
            <div className="p-4 bg-slate-100 border border-slate-200 rounded-lg text-slate-700 flex items-center gap-2">
              <Info className="w-5 h-5 text-slate-500 shrink-0" />
              <span>当前任务尚无正文草稿，无法进行事实变更比对。</span>
            </div>
          ) : !analysis.hasSnapshotBaseline ? (
            <div className="p-4 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 space-y-1">
              <div className="flex items-center gap-2 font-semibold text-amber-800">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                <span>缺少比较基准，需人工核实</span>
              </div>
              <p className="text-xs text-amber-700 leading-relaxed">
                当前稿件未保存冻结事实快照（可能为老旧稿件或前序审批未生成快照），系统无法确定起草时的基准依据。请核准事实清单后重新起草，或人工核查正文内容。
              </p>
            </div>
          ) : analysis.changedFactsCount > 0 ? (
            <div className="p-4 bg-amber-50/90 border border-amber-300 rounded-lg text-amber-950 space-y-2.5">
              {/* Requirement 4: Original discrepancy count preserved + review progress shown separately */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 font-semibold text-amber-900 text-sm">
                  <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                  <span>
                    依据变更影响：共发现{' '}
                    <strong className="font-mono text-base text-amber-950 underline decoration-amber-500 underline-offset-2">
                      {analysis.changedFactsCount}
                    </strong>{' '}
                    项事实存在差异 · 涉及{' '}
                    <strong className="font-mono text-base text-amber-950 underline decoration-amber-500 underline-offset-2">
                      {analysis.affectedBlocksCount}
                    </strong>{' '}
                    段正文需复核
                  </span>
                </div>
                {!isHistoricalOrFinal && isAuthor && analysis.changedFactsCount === 1 && analysis.impactItems[0]?.referencingBlocks.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleGenerateMultiRevision(analysis.impactItems[0].factId)}
                    data-testid={`btn-generate-multi-paragraph-fact-revision-${analysis.impactItems[0].factId}`}
                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs transition-colors"
                    title={`按任务最新核准事实生成全部关联段落（共${analysis.impactItems[0].referencingBlocks.length}段）的一致修订候选`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>按最新事实生成关联段落修订候选</span>
                  </button>
                )}
                {!isHistoricalOrFinal && isAuthor && analysis.changedFactsCount === 2 && (
                  <button
                    type="button"
                    onClick={handleGenerateMultiFactGroupRevision}
                    data-testid="btn-generate-multi-fact-group-revision"
                    className="px-3.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs transition-colors"
                    title="按任务最新核准事实生成两项事实全部关联段落成组定向修订候选"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>生成两项事实成组修订候选</span>
                  </button>
                )}
              </div>

              {/* Requirement 4: Separate Review Progress Counters */}
              <div className="flex items-center gap-2 flex-wrap text-xs bg-white/80 p-2.5 rounded border border-amber-200">
                <span className="font-bold text-slate-800">人工复核进度：</span>
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold border border-emerald-200">
                  已记录 {reviewOverview.reviewedCount} 段
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold border border-amber-200">
                  待处理 {reviewOverview.pendingCount} 段
                </span>
                {reviewOverview.deferredCount > 0 && (
                  <span className="text-slate-500 text-xs">
                    （含暂缓 {reviewOverview.deferredCount} 段）
                  </span>
                )}
                {reviewOverview.invalidatedCount > 0 && (
                  <span className="text-rose-700 font-semibold text-xs">
                    （含失效需重核 {reviewOverview.invalidatedCount} 段）
                  </span>
                )}
              </div>

              {/* Prominent disclaimer: Requirement 3 */}
              <div className="p-2.5 bg-amber-100/70 rounded border border-amber-300 text-xs text-amber-950 flex items-start gap-2">
                <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  <strong className="font-semibold text-amber-900">重要核查提示：</strong>
                  人工复核记录仅表达主笔人工核对情况，
                  <strong className="text-rose-800">不等于正文或依据已更新</strong>
                  。复核记录不改写正文、不自动采纳建议、不更新快照基准，亦不能绕过阻断性核校或定稿门禁。如需调整正文，请使用正文编辑或段落建议流程。
                </div>
              </div>

              {/* Multi-Fact Group Ineligibility / Generation Error Alert */}
              {multiFactGroupError && (
                <div
                  data-testid="alert-multi-fact-group-ineligible"
                  className="p-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-950 space-y-2"
                >
                  <div className="flex items-center gap-1.5 font-bold text-amber-900">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>未满足两项事实成组定向修订准入条件</span>
                  </div>
                  <p className="leading-relaxed font-medium">
                    {multiFactGroupError.reason}
                  </p>
                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    {multiFactGroupError.unconfirmedUpstream === 'fact' && onJumpToFactsStage && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onJumpToFactsStage();
                        }}
                        data-testid="btn-goto-facts-stage-multi-group"
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                      >
                        <span>前往事实清单核准</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                    {['outline', 'style'].includes(multiFactGroupError.unconfirmedUpstream || '') && onJumpToOutlineStage && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onJumpToOutlineStage();
                        }}
                        data-testid="btn-goto-outline-stage-multi-group"
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                      >
                        <span>{multiFactGroupError.unconfirmedUpstream === 'style' ? '前往文风核准' : '前往大纲核准'}</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleCancelMultiFactGroupRevision}
                      className="px-2 py-1 text-xs text-slate-600 hover:bg-amber-100 rounded cursor-pointer font-medium"
                    >
                      关闭提示
                    </button>
                  </div>
                </div>
              )}

              {/* Task 25: Multi-Fact Group Revision Candidate Card */}
              {activeMultiFactCandidate && (
                <div
                  data-testid="multi-fact-group-revision-candidate-card"
                  tabIndex={-1}
                  className="p-4 bg-sky-50/70 border-2 border-sky-400 rounded-lg text-xs space-y-3.5 shadow-sm"
                >
                  <div className="flex items-center justify-between border-b border-sky-200 pb-2 flex-wrap gap-2">
                    <div className="flex items-center gap-1.5 font-bold text-sky-950 text-sm">
                      <Sparkles className="w-4 h-4 text-sky-600 shrink-0" />
                      <span>两项事实成组定向修订候选（共2项事实、去重后受影响 {activeMultiFactCandidate.items.length} 个段落）</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                      <span>任务: {activeMultiFactCandidate.taskId}</span>
                      <span>·</span>
                      <span>基准版本: {activeMultiFactCandidate.sourceDraftVersionNumber || activeMultiFactCandidate.sourceDraftId}</span>
                      <span>·</span>
                      <span>事实: [{activeMultiFactCandidate.targetFactIds.join(', ')}]</span>
                    </div>
                  </div>

                  {/* Fact items summary (2 facts) */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {activeMultiFactCandidate.facts.map((fact) => {
                      const factImpactItem = analysis.impactItems.find((i) => i.factId === fact.factId);
                      return (
                        <div
                          key={fact.factId}
                          data-testid={`candidate-fact-item-${fact.factId}`}
                          className="p-3 bg-white rounded-lg border border-sky-200 space-y-2 shadow-2xs"
                        >
                          <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                            <span className="font-bold text-slate-900 text-xs">
                              事实指标：{fact.metric}
                            </span>
                            <span className="text-2xs font-mono text-slate-400">
                              [{fact.factId}]
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-2xs">数值变化与统计期间</span>
                            <div className="font-semibold text-slate-800 text-xs mt-0.5">
                              <span className="text-slate-500 line-through mr-1 font-mono">
                                {fact.fromValue} {fact.unit}
                              </span>
                              <span className="text-sky-700 font-mono font-bold">
                                → {fact.toValue} {fact.unit}
                              </span>
                              {fact.period && (
                                <span className="text-2xs text-slate-500 ml-1.5 font-normal">
                                  （期间：{fact.period}）
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="space-y-1 text-2xs text-slate-600">
                            <div className="flex items-center justify-between">
                              <span>
                                旧冻结出处：{fact.fromDocName}（{fact.fromLocation}）
                              </span>
                              {factImpactItem && (
                                <button
                                  type="button"
                                  onClick={() => onViewDraftEvidence(factImpactItem)}
                                  data-testid={`btn-view-evidence-${fact.factId}`}
                                  className="text-2xs text-blue-600 hover:underline flex items-center gap-0.5 cursor-pointer"
                                >
                                  <ExternalLink className="w-2.5 h-2.5" />
                                  <span>核验旧依据</span>
                                </button>
                              )}
                            </div>
                            <div>
                              拟采用新出处：
                              <strong className="text-sky-800 font-medium">
                                {fact.toDocName}（{fact.toLocation}）
                              </strong>
                            </div>
                            <div className="text-slate-400">
                              关联段落（共{fact.referencingBlockIds.length}段）：
                              {fact.referencingBlockIds
                                .map((bid) => {
                                  const blk = currentDraft?.blocks.find((b) => b.id === bid);
                                  return blk ? `第${blk.order}段` : bid;
                                })
                                .join('、')}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Affected Paragraphs List */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sky-950 font-bold text-xs">
                      <span>共影响 {activeMultiFactCandidate.items.length} 个段落，逐段修订预览：</span>
                      <span className="text-2xs text-slate-500 font-normal">两事实关联段落互不重叠，支持分别定位正文与核验完整段落</span>
                    </div>

                    {activeMultiFactCandidate.items.map((item) => {
                      const factForItem = activeMultiFactCandidate.facts.find((f) =>
                        f.referencingBlockIds.includes(item.targetBlockId)
                      )!;
                      return (
                        <div
                          key={item.targetBlockId}
                          data-testid={`candidate-item-${item.targetBlockId}`}
                          className="p-3 bg-white rounded-lg border border-sky-200 space-y-2 shadow-2xs"
                        >
                          <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-800 text-xs">
                                第 {item.targetBlockOrder} 段
                              </span>
                              <span className="text-slate-500 text-xs">·</span>
                              <span className="text-slate-600 text-xs font-medium">
                                【{item.targetSectionTitle}】
                              </span>
                              <span className="text-2xs font-mono text-slate-400">
                                [Block ID: {item.targetBlockId}]
                              </span>
                              <span className="text-2xs px-1.5 py-0.2 rounded bg-sky-100 text-sky-800 font-medium">
                                关联事实：{factForItem.metric}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => onLocateBlock(item.targetBlockId, factForItem.factId)}
                              data-testid={`btn-locate-candidate-block-${item.targetBlockId}`}
                              className="px-2 py-0.5 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded text-2xs font-medium flex items-center gap-1 cursor-pointer"
                            >
                              <MapPin className="w-2.5 h-2.5" />
                              <span>定位正文</span>
                            </button>
                          </div>

                          {renderParagraphComparison(
                            item.targetBlockId,
                            item.targetBlockOrder,
                            item.originalBlockContent,
                            item.revisedBlockContent,
                            factForItem.fromValue,
                            factForItem.toValue,
                            factForItem.unit
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Scope & Lifecycle Notice */}
                  <div className="p-2.5 bg-sky-100/60 rounded border border-sky-200 text-2xs text-sky-950 space-y-1 leading-relaxed">
                    <div className="font-semibold flex items-center gap-1">
                      <Info className="w-3.5 h-3.5 text-sky-700 shrink-0" />
                      <span>本次两项事实成组操作范围与原子性依据说明：</span>
                    </div>
                    <p>
                      1. <strong>成组一致修订全部 {activeMultiFactCandidate.items.length} 个关联段落</strong>（Block IDs: {activeMultiFactCandidate.targetBlockIds.join(', ')}），两项事实关联段落互不重叠，其余所有段落正文、未变事实引用与依据严格保持原样。
                    </p>
                    <p>
                      2. 确认采纳将<strong>一次性归档当前工作稿为只读历史快照</strong>（完整冻结旧正文、旧依据与当时人工复核留痕），并<strong>只创建一个新工作稿</strong>。
                    </p>
                    <p>
                      3. 新工作稿绑定完整核准的最新事实快照；新稿复核记录初始化为空，旧记录仅作来源参考，后续仍需按规定通过审阅与核校定稿门禁。
                    </p>
                    <p>
                      4. 本批不提供单事实或单段部分采纳，禁止单独撤销正文；恢复须通过版本历史完整恢复正文与依据。
                    </p>
                  </div>

                  {/* Acceptance Validation / Error Alert */}
                  {(() => {
                    const runId = activeMultiFactRunId.current || '';
                    const validation = validateMultiFactGroupRevisionAcceptance(task, currentDraft, activeMultiFactCandidate, activeRole, runId);
                    return (
                      <>
                        {!validation.valid && (
                          <p role="alert" data-testid="alert-multi-fact-group-stale" className="text-rose-800 text-xs font-medium">
                            {validation.reason} 请使用上方入口重新生成候选。
                          </p>
                        )}
                        {multiFactGroupAcceptError && (
                          <div
                            data-testid="alert-multi-fact-group-accept-error"
                            className="p-2.5 bg-rose-50 border border-rose-300 rounded text-xs text-rose-950 space-y-1"
                          >
                            <div className="flex items-center gap-1 font-bold text-rose-900">
                              <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                              <span>采纳失败</span>
                            </div>
                            <p>{multiFactGroupAcceptError}</p>
                          </div>
                        )}
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleCancelMultiFactGroupRevision}
                            data-testid="btn-cancel-multi-fact-group-revision"
                            className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded cursor-pointer font-medium"
                          >
                            取消
                          </button>

                          {multiFactGroupAcceptError ? (
                            <button
                              type="button"
                              onClick={() => handleAcceptMultiFactGroupRevision(activeMultiFactCandidate)}
                              data-testid="btn-retry-accept-multi-fact-group-revision"
                              disabled={!validation.valid || !onAcceptMultiFactGroupRevision}
                              className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>重试采纳</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleAcceptMultiFactGroupRevision(activeMultiFactCandidate)}
                              data-testid="btn-accept-multi-fact-group-revision"
                              disabled={!validation.valid || !onAcceptMultiFactGroupRevision}
                              className="px-4 py-1.5 bg-sky-600 hover:bg-sky-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>全部采纳并创建新工作稿</span>
                            </button>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-950 space-y-1">
              <div className="flex items-center gap-2 font-semibold text-emerald-900">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span>未发现已关联事实的差异</span>
              </div>
              <p className="text-xs text-emerald-800 leading-relaxed">
                已有快照基准的关联事实未检出差异；未收入快照的引用及定性表述仍需人工核对。
              </p>
              <p className="text-xs text-emerald-700/90">
                提示：本检查仅覆盖已建立引用关联的事实，未引用或定性表述内容请结合材料原文人工核对。
              </p>
            </div>
          )}

          {hasFrozenReviewConclusion&&reviewOverview.blockEvaluations.length>0&&(
            <div className="p-3 bg-slate-50 border border-slate-200 rounded text-sm" data-testid="frozen-review-summary">
              保存当时的人工复核：已记录 {reviewOverview.reviewedCount} 段 · 待处理 {reviewOverview.pendingCount} 段。
              以下历史留痕保持当时状态；上方依据差异另与任务当前事实比较。
            </div>
          )}
          {isHistoricalOrFinal&&!hasFrozenReviewConclusion&&(
            <p role="status" className="p-3 bg-amber-50 text-sm text-amber-900" data-testid="missing-frozen-review-summary">
              此版本缺少保存当时的复核结论，无法还原当时进度。原记录仅供查看；以下回退依据反映任务当前状态，不能视为历史冻结数据。
            </p>
          )}
          {!isHistoricalOrFinal&&analysis.changedFactsCount===0&&reviewOverview.blockEvaluations.length>0&&(
            <p className="text-sm">人工复核：已记录 {reviewOverview.reviewedCount} 段 · 待处理 {reviewOverview.pendingCount} 段；原有记录继续保留供核对。</p>
          )}
          {currentDraft?.factReviewRecovery&&<p role="status" className="p-3 bg-amber-50 text-sm text-amber-900">
            部分复核数据格式不完整，已隔离并保留，未计入有效人工复核；正文已保留，请重新核对。
          </p>}
          {formError&&<p role="alert" className="p-3 bg-rose-50 text-sm text-rose-900">{formError}</p>}
          {/* Scope limitation alert for unlinked material evidence */}
          {analysis.hasDraft && !task.factSnapshot && (
            <p className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
              任务事实清单尚未重新确认，起草前置审批未就绪；本项为任务整体审批状态，不计为每条事实发生变化。
            </p>
          )}
          {analysis.missingBaselineFactIds.length > 0 && (
            <div
              data-testid="fact-impact-baseline-limit"
              className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1"
            >
              <p className="font-semibold">部分引用缺少快照基准，需人工核实</p>
              {analysis.allReferencedItems
                .filter((item) => analysis.missingBaselineFactIds.includes(item.factId))
                .map((item) => (
                  <p key={item.factId}>
                    {item.metric}：本稿核准快照未收录；关联
                    {item.referencingBlocks.map((b) => `第${b.blockOrder}段`).join('、')}
                    。无法确认当时采用依据，不据此推断事实发生变化。
                  </p>
                ))}
            </div>
          )}
          {analysis.materialEvidenceScope && (
            <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-lg text-xs text-blue-900 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-blue-800">
                <Info className="w-4 h-4 text-blue-600 shrink-0" />
                <span>检查范围说明（材料补写存证）：</span>
              </div>
              <p className="leading-relaxed">
                {analysis.materialEvidenceScope.notice}
              </p>
            </div>
          )}

          {Array.isArray(currentDraft?.sourceFactReviewRecords)&&currentDraft.sourceFactReviewRecords.filter(isValidFactReviewRecord).length>0&&(
            <details className="p-3 border rounded text-sm" data-testid="source-fact-reviews">
              <summary className="cursor-pointer">来源版本的复核留痕（仅供参考，新工作稿需重新核对）</summary>
              {currentDraft.sourceFactReviewRecords.filter(isValidFactReviewRecord).map((r,i)=>(
                <p key={`${r.id}-${i}`} className="mt-2 whitespace-pre-wrap">第{r.blockOrder}段 · {r.reviewedBy} · {r.reviewedAt}：{r.notes}{r.revocation&&`（已撤回：${r.revocation.reason}）`}</p>))}
            </details>)}
          {/* Section Navigation Quick Jump */}
          {reviewOverview.blockEvaluations.length > 0 && (
            <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
              <span className="text-xs font-semibold text-slate-500">视图导航：</span>
              <a
                href="#fact-review-section"
                className="px-2.5 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold transition-colors cursor-pointer border border-blue-200"
              >
                按段落逐段复核 ({reviewOverview.blockEvaluations.length}段)
              </a>
              <a
                href="#fact-impact-cards-section"
                className="px-2.5 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 text-xs font-semibold transition-colors cursor-pointer border border-slate-200"
              >
                变动事实出处总览 ({analysis.impactItems.length}项)
              </a>
            </div>
          )}

          {/* PART 1: Block-by-Block Fact Review Section (Requirement 1, 2, 3, 4) */}
          {reviewOverview.blockEvaluations.length > 0 && (
            <div id="fact-review-section" className="space-y-4" data-testid="fact-review-section">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
                  <span>{hasFrozenReviewConclusion ? '保存当时的段落复核留痕'
                    : isHistoricalOrFinal ? '历史复核参考（当时结论未保存）' : '受影响段落逐段人工复核'}</span>
                  <span className="text-xs text-slate-500 font-normal">
                    （按正文段落独立核对与留痕）
                  </span>
                </h3>
              </div>

              <div className="space-y-4">
                {reviewOverview.blockEvaluations.map((ev: BlockFactReviewEvaluation) => {
                  const block = currentDraft?.blocks.find((b) => b.id === ev.blockId);
                  const cleanContent = block?.content.trim() || '';
                  const excerpt =
                    cleanContent.length > 80 ? cleanContent.slice(0, 80) + '…' : cleanContent;

                  const isRevokingThis = revokingBlockId === ev.blockId;
                  const currentNoteInput = reviewNotes[ev.blockId] || '';
                  const liveContext=currentDraft&&block?getFactReviewContext(task,currentDraft,block):'';
                  const isStale=Boolean(currentNoteInput&&formContexts[ev.blockId]!==liveContext);
                  const isSubmitDisabled = !currentNoteInput.trim()||isStale;
                  const candidate = activeCandidates[ev.blockId];
                  const candidateValidation = candidate ? validateFactRevisionAcceptance(task, currentDraft,
                    candidate, activeRole, activeRevisionRuns.current[ev.blockId]) : undefined;

                  const multiFactItem = analysis.impactItems.find((item) =>
                    item.referencingBlocks.some((b) => b.blockId === ev.blockId) && item.referencingBlocks.length > 1
                  );
                  const multiFactId = multiFactItem?.factId;
                  const isGroupHost = multiFactItem?.referencingBlocks[0]?.blockId === ev.blockId;
                  const groupCandidate = multiFactId ? activeGroupCandidates[multiFactId] : undefined;
                  const groupValidation = (groupCandidate && multiFactId) ? validateMultiParagraphFactRevisionAcceptance(task, currentDraft, groupCandidate, activeRole, activeGroupRevisionRuns.current[multiFactId]) : undefined;

                  return (
                    <div
                      key={ev.blockId}
                      data-testid={`fact-review-block-card-${ev.blockId}`}
                      data-review-block-id={ev.blockId}
                      tabIndex={-1}
                      className={`border rounded-lg p-4 space-y-3.5 transition-colors ${
                        ev.displayStatus === 'reviewed'
                          ? 'border-emerald-200 bg-white shadow-2xs'
                          : ev.displayStatus === 'invalidated'
                          ? 'border-rose-300 bg-rose-50/30 shadow-2xs'
                          : ev.displayStatus === 'deferred'
                          ? 'border-amber-200 bg-white shadow-2xs'
                          : 'border-slate-200 bg-white shadow-2xs'
                      }`}
                    >
                      {/* Block Title and Review Status Badge */}
                      <div className="flex items-start justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-900 text-sm">
                            第{ev.blockOrder}段 · {ev.sectionTitle}
                          </span>
                          <span className="text-xs font-mono text-slate-400">
                            [{ev.blockId}]
                          </span>

                          {/* Status Badge */}
                          <span
                            data-testid={`badge-review-status-${ev.blockId}`}
                            className={`text-xs px-2.5 py-0.5 rounded font-semibold border ${
                              ev.displayStatus === 'reviewed'
                                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                : ev.displayStatus === 'deferred'
                                ? 'bg-amber-100 text-amber-800 border-amber-300'
                                : ev.displayStatus === 'invalidated'
                                ? 'bg-rose-100 text-rose-800 border-rose-300'
                                : 'bg-slate-100 text-slate-700 border-slate-300'
                            }`}
                          >
                            {ev.displayStatusLabel}
                          </span>
                        </div>

                        {/* Top Block Actions: Locate & Fact Revision */}
                        <div className="flex items-center gap-2">
                          {!isHistoricalOrFinal && isAuthor && analysis.changedFactsCount === 2 && (
                            <button
                              type="button"
                              onClick={handleGenerateMultiFactGroupRevision}
                              data-testid={`btn-generate-multi-fact-group-revision-${ev.blockId}`}
                              className="px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                              title="按任务最新核准事实生成两项事实成组修订候选"
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>生成两项事实成组修订候选</span>
                            </button>
                          )}
                          {!isHistoricalOrFinal && isAuthor && analysis.changedFactsCount !== 2 && multiFactItem && (
                            <button
                              type="button"
                              onClick={() => handleGenerateMultiRevision(multiFactItem.factId)}
                              data-testid={`btn-generate-multi-paragraph-fact-revision-${ev.blockId}`}
                              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                              title={`按任务最新核准事实生成全部关联段落（共${multiFactItem.referencingBlocks.length}段）的一致修订候选`}
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>按最新事实生成关联段落修订候选</span>
                            </button>
                          )}
                          {!isHistoricalOrFinal && isAuthor && analysis.changedFactsCount !== 2 && !multiFactItem && (
                            <button
                              type="button"
                              onClick={() => handleGenerateRevision(ev.blockId)}
                              data-testid={`btn-generate-fact-revision-${ev.blockId}`}
                              className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                              title="按任务最新核准事实生成该段落的定向修订候选"
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>按最新事实生成修订候选</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onLocateBlock(ev.blockId, ev.changedFacts[0]?.factId)}
                            data-testid={`btn-review-locate-${ev.blockId}`}
                            className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                            title={`定位到正文第${ev.blockOrder}段`}
                          >
                            <MapPin className="w-3.5 h-3.5" />
                            <span>定位正文</span>
                          </button>
                        </div>
                      </div>

                      {/* Current Paragraph Excerpt */}
                      <div className="p-2.5 bg-slate-50 rounded border border-slate-200 text-xs space-y-1">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>当前正文内容摘要：</span>
                          <span className="font-mono">
                            修订版本号：{typeof block?.revisionSeq === 'number' && Number.isFinite(block.revisionSeq) ? block.revisionSeq : 0}
                          </span>
                        </div>
                        <p className="text-slate-800 font-serif">“{excerpt}”</p>
                      </div>

                      {/* Ineligibility / Generation Error Alert */}
                      {revisionErrors[ev.blockId] && (
                        <div
                          data-testid={`alert-revision-ineligible-${ev.blockId}`}
                          className="p-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-950 space-y-2"
                        >
                          <div className="flex items-center gap-1.5 font-bold text-amber-900">
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                            <span>未满足定向修订准入条件</span>
                          </div>
                          <p className="leading-relaxed font-medium">
                            {revisionErrors[ev.blockId].reason}
                          </p>
                          <div className="flex items-center gap-2 pt-1 flex-wrap">
                            {revisionErrors[ev.blockId].unconfirmedUpstream === 'fact' && onJumpToFactsStage && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onJumpToFactsStage();
                                }}
                                data-testid={`btn-goto-facts-stage-${ev.blockId}`}
                                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                              >
                                <span>前往事实清单核准</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                            {['outline', 'style'].includes(revisionErrors[ev.blockId].unconfirmedUpstream || '') && onJumpToOutlineStage && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onJumpToOutlineStage();
                                }}
                                data-testid={`btn-goto-outline-stage-${ev.blockId}`}
                                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                              >
                                <span>{revisionErrors[ev.blockId].unconfirmedUpstream === 'style' ? '前往文风核准' : '前往大纲核准'}</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleCancelRevision(ev.blockId)}
                              className="px-2 py-1 text-xs text-slate-600 hover:bg-amber-100 rounded cursor-pointer font-medium"
                            >
                              关闭提示
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Multi-Paragraph Ineligibility / Generation Error Alert */}
                      {isGroupHost && multiFactId && groupRevisionErrors[multiFactId] && (
                        <div
                          data-testid={`alert-multi-revision-ineligible-${multiFactId}`}
                          className="p-3 bg-indigo-50 border border-indigo-300 rounded text-xs text-indigo-950 space-y-2"
                        >
                          <div className="flex items-center gap-1.5 font-bold text-indigo-900">
                            <AlertTriangle className="w-4 h-4 text-indigo-600 shrink-0" />
                            <span>未满足多段落定向修订准入条件</span>
                          </div>
                          <p className="leading-relaxed font-medium">
                            {groupRevisionErrors[multiFactId].reason}
                          </p>
                          <div className="flex items-center gap-2 pt-1 flex-wrap">
                            {groupRevisionErrors[multiFactId].unconfirmedUpstream === 'fact' && onJumpToFactsStage && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onJumpToFactsStage();
                                }}
                                data-testid={`btn-goto-facts-stage-multi-${multiFactId}`}
                                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                              >
                                <span>前往事实清单核准</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                            {['outline', 'style'].includes(groupRevisionErrors[multiFactId].unconfirmedUpstream || '') && onJumpToOutlineStage && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onJumpToOutlineStage();
                                }}
                                data-testid={`btn-goto-outline-stage-multi-${multiFactId}`}
                                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                              >
                                <span>{groupRevisionErrors[multiFactId].unconfirmedUpstream === 'style' ? '前往文风核准' : '前往大纲核准'}</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleCancelMultiRevision(multiFactId)}
                              className="px-2 py-1 text-xs text-slate-600 hover:bg-indigo-100 rounded cursor-pointer font-medium"
                            >
                              关闭提示
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Multi-Paragraph Candidate Comparison Panel */}
                      {isGroupHost && multiFactId && groupCandidate && (
                        <div
                          data-testid={`multi-paragraph-revision-candidate-card-${multiFactId}`}
                          tabIndex={-1}
                          className="p-3.5 bg-indigo-50/70 border-2 border-indigo-400 rounded-lg text-xs space-y-3 shadow-sm"
                        >
                          <div className="flex items-center justify-between border-b border-indigo-200 pb-2 flex-wrap gap-2">
                            <div className="flex items-center gap-1.5 font-bold text-indigo-900 text-sm">
                              <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
                              <span>事实变更定向修订候选（关联全部 {groupCandidate.items.length} 个段落一致修订）</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                              <span>任务: {groupCandidate.taskId}</span>
                              <span>·</span>
                              <span>基准版本: {groupCandidate.sourceDraftVersionNumber || groupCandidate.sourceDraftId}</span>
                              <span>·</span>
                              <span>事实: [{groupCandidate.targetFactId}]</span>
                            </div>
                          </div>

                          {/* Metric & Value Change */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-2.5 bg-white rounded border border-indigo-200">
                            <div>
                              <span className="text-slate-400 block text-2xs">事实指标、数值与统计期间</span>
                              <div className="font-semibold text-slate-800 text-xs mt-0.5">
                                {groupCandidate.metric}：
                                <span className="text-slate-500 line-through mr-1 font-mono">
                                  {groupCandidate.fromValue} {groupCandidate.unit}
                                </span>
                                <span className="text-indigo-600 font-mono font-bold">
                                  → {groupCandidate.toValue} {groupCandidate.unit}
                                </span>
                              </div>
                              <div className="text-2xs text-slate-500 mt-0.5">
                                统计期间：{groupCandidate.period}
                              </div>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-2xs">依据出处材料变更</span>
                              <div className="text-xs text-slate-700 mt-0.5 space-y-0.5">
                                <div className="flex items-center justify-between">
                                  <div>
                                    旧冻结出处：
                                    <span className="text-slate-600">
                                      {groupCandidate.fromDocName}（{groupCandidate.fromLocation}）
                                    </span>
                                  </div>
                                  {multiFactItem && (
                                    <button
                                      type="button"
                                      onClick={() => onViewDraftEvidence(multiFactItem)}
                                      className="text-2xs text-blue-600 hover:underline flex items-center gap-0.5 cursor-pointer"
                                    >
                                      <ExternalLink className="w-2.5 h-2.5" />
                                      <span>核验旧依据</span>
                                    </button>
                                  )}
                                </div>
                                <div>
                                  拟采用新出处：
                                  <strong className="text-indigo-700">
                                    {groupCandidate.toDocName}（{groupCandidate.toLocation}）
                                  </strong>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Affected Paragraphs List */}
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-indigo-950 font-bold text-xs">
                              <span>共影响 {groupCandidate.items.length} 个段落，逐段修订预览：</span>
                              <span className="text-2xs text-slate-500 font-normal">支持分别定位正文与核验完整段落</span>
                            </div>

                            {groupCandidate.items.map((item) => (
                              <div
                                key={item.targetBlockId}
                                data-testid={`candidate-item-${item.targetBlockId}`}
                                className="p-3 bg-white rounded-lg border border-indigo-200 space-y-2 shadow-2xs"
                              >
                                <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 flex-wrap gap-2">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-slate-800 text-xs">
                                      第 {item.targetBlockOrder} 段
                                    </span>
                                    <span className="text-slate-500 text-xs">·</span>
                                    <span className="text-slate-600 text-xs font-medium">
                                      【{item.targetSectionTitle}】
                                    </span>
                                    <span className="text-2xs font-mono text-slate-400">
                                      [Block ID: {item.targetBlockId}]
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => onLocateBlock(item.targetBlockId, groupCandidate.targetFactId)}
                                    data-testid={`btn-locate-candidate-block-${item.targetBlockId}`}
                                    className="px-2 py-0.5 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded text-2xs font-medium flex items-center gap-1 cursor-pointer"
                                  >
                                    <MapPin className="w-2.5 h-2.5" />
                                    <span>定位正文</span>
                                  </button>
                                </div>

                                {renderParagraphComparison(
                                  item.targetBlockId,
                                  item.targetBlockOrder,
                                  item.originalBlockContent,
                                  item.revisedBlockContent,
                                  groupCandidate.fromValue,
                                  groupCandidate.toValue,
                                  groupCandidate.unit
                                )}
                              </div>
                            ))}
                          </div>

                          {/* Scope & Lifecycle Notice */}
                          <div className="p-2.5 bg-indigo-100/60 rounded border border-indigo-200 text-2xs text-indigo-900 space-y-1 leading-relaxed">
                            <div className="font-semibold flex items-center gap-1">
                              <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                              <span>本次操作范围与原子性依据说明：</span>
                            </div>
                            <p>
                              1. <strong>整体一致修订全部 {groupCandidate.items.length} 个关联段落</strong>（Block IDs: {groupCandidate.targetBlockIds.join(', ')}），其余所有段落正文、事实引用与材料存证严格保持原样。
                            </p>
                            <p>
                              2. 确认采纳将<strong>一次性归档当前草稿为只读历史快照</strong>（保留旧正文、旧依据与当时人工复核结论），并<strong>只创建一个新工作稿</strong>。
                            </p>
                            <p>
                              3. 新工作稿绑定完整核准的最新事实快照（{groupCandidate.toValue} {groupCandidate.unit}）；新稿复核记录初始化为空，不自动继承“已复核”签名，后续仍需按规定通过审阅与核校定稿门禁。
                            </p>
                            <p>
                              4. 禁止部分选择、逐段采纳或单独撤销其中一段；恢复须通过版本历史完整恢复正文与依据。
                            </p>
                          </div>

                          {/* Acceptance Error Alert */}
                          {groupValidation && !groupValidation.valid && (
                            <p role="alert" data-testid={`alert-multi-revision-stale-${multiFactId}`} className="text-rose-800 text-xs font-medium">
                              {groupValidation.reason} 请使用上方入口重新生成候选。
                            </p>
                          )}
                          {groupAcceptErrors[multiFactId] && (
                            <div
                              data-testid={`alert-multi-revision-accept-error-${multiFactId}`}
                              className="p-2.5 bg-rose-50 border border-rose-300 rounded text-xs text-rose-950 space-y-1"
                            >
                              <div className="flex items-center gap-1 font-bold text-rose-900">
                                <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                                <span>采纳失败</span>
                              </div>
                              <p>{groupAcceptErrors[multiFactId]}</p>
                            </div>
                          )}

                          {/* Candidate Actions */}
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => handleCancelMultiRevision(multiFactId)}
                              data-testid={`btn-cancel-multi-fact-revision-${multiFactId}`}
                              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded cursor-pointer font-medium"
                            >
                              取消
                            </button>

                            {groupAcceptErrors[multiFactId] ? (
                              <button
                                type="button"
                                onClick={() => handleAcceptMultiRevision(groupCandidate)}
                                data-testid={`btn-retry-accept-multi-fact-revision-${multiFactId}`}
                                disabled={!groupValidation?.valid || !onAcceptMultiParagraphFactRevision}
                                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>重试采纳</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleAcceptMultiRevision(groupCandidate)}
                                data-testid={`btn-accept-multi-fact-revision-${multiFactId}`}
                                disabled={!groupValidation?.valid || !onAcceptMultiParagraphFactRevision}
                                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs transition-colors"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>全部采纳并创建新工作稿</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Candidate Comparison Panel (Requirement 3, 4, 5) */}
                      {activeCandidates[ev.blockId] && (
                        <div
                          data-testid={`fact-revision-candidate-card-${ev.blockId}`}
                          className="p-3.5 bg-blue-50/70 border-2 border-blue-400 rounded-lg text-xs space-y-3 shadow-sm"
                        >
                          <div className="flex items-center justify-between border-b border-blue-200 pb-2 flex-wrap gap-2">
                            <div className="flex items-center gap-1.5 font-bold text-blue-900 text-sm">
                              <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
                              <span>事实变更定向修订候选（仅影响第{ev.blockOrder}段）</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                              <span>任务: {activeCandidates[ev.blockId].taskId}</span>
                              <span>·</span>
                              <span>基准版本: {activeCandidates[ev.blockId].sourceDraftVersionNumber || activeCandidates[ev.blockId].sourceDraftId}</span>
                              <span>·</span>
                              <span>段落: [{activeCandidates[ev.blockId].targetBlockId}]</span>
                            </div>
                          </div>

                          {/* Metric & Value Change */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-2.5 bg-white rounded border border-blue-200">
                            <div>
                              <span className="text-slate-400 block text-2xs">事实指标与数值变化</span>
                              <div className="font-semibold text-slate-800 text-xs mt-0.5">
                                {activeCandidates[ev.blockId].metric}：
                                <span className="text-slate-500 line-through mr-1 font-mono">
                                  {activeCandidates[ev.blockId].fromValue} {activeCandidates[ev.blockId].unit}
                                </span>
                                <span className="text-blue-600 font-mono font-bold">
                                  → {activeCandidates[ev.blockId].toValue} {activeCandidates[ev.blockId].unit}
                                </span>
                              </div>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-2xs">依据出处材料变更</span>
                              <div className="text-xs text-slate-700 mt-0.5 space-y-0.5">
                                <div>
                                  旧冻结出处：
                                  <span className="text-slate-600">
                                    {activeCandidates[ev.blockId].fromDocName}（{activeCandidates[ev.blockId].fromLocation}）
                                  </span>
                                </div>
                                <div>
                                  拟采用新出处：
                                  <strong className="text-blue-700">
                                    {activeCandidates[ev.blockId].toDocName}（{activeCandidates[ev.blockId].toLocation}）
                                  </strong>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Text Comparison (Fixes Issue #82: unambiguous demarcation, pristine complete texts) */}
                          {renderParagraphComparison(
                            ev.blockId,
                            ev.blockOrder,
                            activeCandidates[ev.blockId].originalBlockContent,
                            activeCandidates[ev.blockId].revisedBlockContent,
                            activeCandidates[ev.blockId].fromValue,
                            activeCandidates[ev.blockId].toValue,
                            activeCandidates[ev.blockId].unit
                          )}

                          {/* Scope & Lifecycle Notice */}
                          <div className="p-2.5 bg-blue-100/60 rounded border border-blue-200 text-2xs text-blue-900 space-y-1 leading-relaxed">
                            <div className="font-semibold flex items-center gap-1">
                              <Info className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                              <span>本次操作范围与依据说明：</span>
                            </div>
                            <p>
                              1. <strong>仅修改第{ev.blockOrder}段</strong>（Block ID: {activeCandidates[ev.blockId].targetBlockId}），其余所有段落正文、事实引用与材料存证保持原样。
                            </p>
                            <p>
                              2. 确认采纳将<strong>归档当前草稿为只读历史快照</strong>（保留旧正文、旧依据与当时人工复核结论），并<strong>创建新工作稿</strong>。
                            </p>
                            <p>
                              3. 新工作稿绑定完整核准的最新事实快照（{activeCandidates[ev.blockId].toValue} {activeCandidates[ev.blockId].unit}）；新稿复核记录初始化为空，不自动继承“已复核”签名，后续仍需按规定通过审阅与核校定稿门禁。
                            </p>
                          </div>

                          {/* Acceptance Error Alert */}
                          {candidateValidation && !candidateValidation.valid && (
                            <p role="alert" data-testid={`alert-revision-stale-${ev.blockId}`} className="text-rose-800">
                              {candidateValidation.reason} 请使用上方入口重新生成候选。
                            </p>
                          )}
                          {acceptErrors[ev.blockId] && (
                            <div
                              data-testid={`alert-revision-accept-error-${ev.blockId}`}
                              className="p-2.5 bg-rose-50 border border-rose-300 rounded text-xs text-rose-950 space-y-1"
                            >
                              <div className="flex items-center gap-1 font-bold text-rose-900">
                                <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                                <span>采纳失败</span>
                              </div>
                              <p>{acceptErrors[ev.blockId]}</p>
                            </div>
                          )}

                          {/* Candidate Actions */}
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => handleCancelRevision(ev.blockId)}
                              data-testid={`btn-cancel-fact-revision-${ev.blockId}`}
                              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded cursor-pointer font-medium"
                            >
                              取消
                            </button>

                            {acceptErrors[ev.blockId] ? (
                              <button
                                type="button"
                                onClick={() => handleAcceptRevision(activeCandidates[ev.blockId])}
                                data-testid={`btn-retry-accept-fact-revision-${ev.blockId}`}
                                disabled={!candidateValidation?.valid || !onAcceptFactRevision}
                                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>重试采纳</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleAcceptRevision(activeCandidates[ev.blockId])}
                                data-testid={`btn-accept-fact-revision-${ev.blockId}`}
                                disabled={!candidateValidation?.valid || !onAcceptFactRevision}
                                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs transition-colors"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>采纳修订并创建新工作稿</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Merged Facts Differences Affecting This Block */}
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-slate-700">
                          本段关联的变更事实（共 {ev.changedFacts.length} 项，已合并展示）：
                        </div>

                        <div className="space-y-2">
                          {ev.changedFacts.map((factItem: FactImpactItem) => (
                            <div
                              key={factItem.factId}
                              className="p-3 bg-slate-50 rounded border border-slate-200 text-xs space-y-2"
                            >
                              <div className="flex items-center justify-between flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                  <strong className="text-slate-900 font-semibold">
                                    {factItem.metric}
                                  </strong>
                                  <span className="font-mono text-slate-400">
                                    [{factItem.factId}]
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {factItem.differenceTags.map((tag: any, tIdx: number) => (
                                    <span
                                      key={tIdx}
                                      className="text-xs px-1.5 py-0.2 rounded font-semibold bg-rose-100 text-rose-800 border border-rose-200"
                                    >
                                      {tag.label}
                                    </span>
                                  ))}

                                  <button
                                    type="button"
                                    onClick={() => onViewDraftEvidence(factItem)}
                                    className="text-xs text-blue-700 hover:text-blue-900 font-medium ml-1 underline cursor-pointer"
                                  >
                                    查看本稿依据
                                  </button>
                                </div>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                <div className="bg-white p-2 rounded border border-slate-200 space-y-0.5">
                                  <span className="text-slate-400 block font-medium">
                                    本稿采用（快照冻结）：
                                  </span>
                                  <div>
                                    数值：<strong className="font-mono">{factItem.draftSnapshotValue}</strong>
                                  </div>
                                  <div>期间：{factItem.draftPeriod}</div>
                                  <div>口径：{factItem.draftMetricScope}</div>
                                  <div>出处：{factItem.draftDocName} ({factItem.draftLocation})</div>
                                </div>

                                <div className="bg-white p-2 rounded border border-slate-200 space-y-0.5">
                                  <span className="text-slate-400 block font-medium">
                                    {hasFrozenReviewConclusion ? '保存当时的任务状态（冻结）：'
                                      : isHistoricalOrFinal ? '任务当前状态（非历史冻结）：' : '任务最新状态：'}
                                  </span>
                                  <div>
                                    数值：<strong className="font-mono text-blue-800">{factItem.latestConfirmedValue}</strong>
                                  </div>
                                  <div>期间：{factItem.latestPeriod}</div>
                                  <div>口径：{factItem.latestMetricScope}</div>
                                  <div>出处：{factItem.latestDocName} ({factItem.latestLocation})</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {currentDraft&&Array.isArray(currentDraft.factReviewRecords)&&
                        currentDraft.factReviewRecords.filter(isValidFactReviewRecord).filter(r=>r.blockId===ev.blockId&&r.id!==ev.record?.id).length>0&&(
                        <details className="text-sm border rounded p-2" data-testid={`review-history-${ev.blockId}`}>
                          <summary className="cursor-pointer">查看此前复核留痕</summary>
                          {currentDraft.factReviewRecords.filter(isValidFactReviewRecord).filter(r=>r.blockId===ev.blockId&&r.id!==ev.record?.id).map(r=>(
                            <div key={r.id} className="border-t mt-2 pt-2 whitespace-pre-wrap">
                              {r.reviewedBy} · {new Date(r.reviewedAt).toLocaleString('zh-CN')}：{r.notes}
                              {r.revocation&&<p>撤回：{r.revocation.revokedBy} · {r.revocation.revokedAt} · {r.revocation.reason}</p>}
                            </div>))}
                        </details>)}
                      {/* Check Limitations (Requirement 7) */}
                      {ev.limitations.length > 0 && (
                        <div className="p-2.5 bg-amber-50 rounded border border-amber-200 text-xs text-amber-900 space-y-0.5">
                          <span className="font-semibold block">【检查限制提示】</span>
                          {ev.limitations.map((lim: string, lIdx: number) => (
                            <p key={lIdx}>• {lim}</p>
                          ))}
                          <p className="text-amber-800 text-xs">
                            人工复核记录仅表达主笔核对情况，不能把上述限制推断为“系统已自动核验”。
                          </p>
                        </div>
                      )}

                      {/* Invalidation Alert if Applicable (Requirement 3, 4) */}
                      {ev.displayStatus === 'invalidated' && (
                        <div
                          data-testid={`alert-invalidated-${ev.blockId}`}
                          className="p-3 bg-rose-50 border border-rose-300 rounded text-xs text-rose-950 space-y-1"
                        >
                          <div className="flex items-center gap-1.5 font-bold text-rose-900">
                            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                            <span>{isHistoricalOrFinal&&!hasFrozenReviewConclusion ? '当时复核状态无法还原' : '原复核已失效，需重新核对'}</span>
                          </div>
                          <p className="leading-relaxed font-medium">
                            失效原因：{ev.invalidatedReason}
                          </p>
                          <p className="text-xs text-rose-800 leading-relaxed">
                            {isHistoricalOrFinal&&!hasFrozenReviewConclusion
                              ? '此版本未保存可还原的当时结论，不能从任务当前状态推断当时是否有效。原记录保持只读，供人工查阅。'
                              : '在此记录保存后，段落正文或相关依据发生了变动，旧的人工核对结论已不再适用，该段已重新计入待处理范围，请核对最新差异后重新记录。'}
                          </p>
                        </div>
                      )}

                      {isStale&&<p role="alert" className="text-sm text-rose-800">正文或依据已变化，请重新核对当前差异并更新说明后提交；原说明已保留。</p>}
                      {/* Display Existing Record if Present */}
                      {ev.record && (
                        <div
                          data-testid={`record-detail-${ev.blockId}`}
                          className="p-3 bg-slate-50 rounded border border-slate-200 text-xs space-y-2"
                        >
                          <div className="flex items-center justify-between flex-wrap gap-1 font-semibold text-slate-800 border-b border-slate-200 pb-1.5">
                            <span>
                              {ev.record.status === 'reviewed'
                                ? '已保存的人工复核记录'
                                : ev.record.status === 'deferred'
                                ? '已记录的暂缓处理信息'
                                : '已撤销的复核记录'}
                            </span>
                            <span className="text-slate-400 font-normal">
                              记录人：<strong>{ev.record.reviewedBy}</strong> · 时间：
                              {new Date(ev.record.reviewedAt).toLocaleString('zh-CN')}
                            </span>
                          </div>

                          <div className="space-y-1">
                            <div>
                              <span className="text-slate-400">核对说明/原因：</span>
                              <span className="font-medium text-slate-800 whitespace-pre-wrap">
                                {ev.record.notes}
                              </span>
                            </div>
                            <div className="text-slate-500">
                              <span>核对时正文快照：</span>
                              <span className="font-serif text-slate-700">
                                “{ev.record.paragraphContentAtReview}”
                              </span>
                              <span className="text-slate-400 ml-1">
                                (版本序号: {ev.record.paragraphRevisionSeqAtReview})
                              </span>
                            </div>
                          </div>

                          {/* Revocation info if revoked */}
                          {ev.record.status === 'revoked' && ev.record.revocation && (
                            <div className="p-2 bg-slate-100 rounded text-slate-600 space-y-0.5 border border-slate-200">
                              <div>
                                撤回人：{ev.record.revocation.revokedBy} · 撤回时间：
                                {new Date(ev.record.revocation.revokedAt).toLocaleString('zh-CN')}
                              </div>
                              <div>撤回原因：{ev.record.revocation.reason}</div>
                            </div>
                          )}

                          {/* Revoke Action Button for valid records in editable draft by author */}
                          {!isHistoricalOrFinal &&
                            isAuthor &&
                            ev.record.status !== 'revoked' &&
                            !isRevokingThis && (
                              <div className="pt-1 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => {setRevokingBlockId(ev.blockId);setRevokeReason('');setFormError('');
                                    setRevokeContext({fingerprint:liveContext,recordId:ev.record!.id});}}
                                  data-testid={`btn-revoke-review-${ev.blockId}`}
                                  className="text-xs text-rose-700 hover:text-rose-900 font-medium flex items-center gap-1 cursor-pointer hover:underline"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  <span>撤回复核记录</span>
                                </button>
                              </div>
                            )}

                          {/* Inline Revocation Form */}
                          {isRevokingThis && (
                            <div className="p-2.5 bg-rose-50 rounded border border-rose-200 space-y-2 mt-2">
                              <label htmlFor={`revoke-reason-${ev.blockId}`} className="block text-xs font-semibold text-rose-900">
                                撤回原因说明（必填）：
                              </label>
                              <input
                                type="text"
                                id={`revoke-reason-${ev.blockId}`}
                                value={revokeReason}
                                onChange={(e) => setRevokeReason(e.target.value)}
                                data-testid={`input-revoke-reason-${ev.blockId}`}
                                placeholder="请填写撤回复核的原因（例如：原核对口径有误，需重新核实）..."
                                className="w-full text-xs p-2 border border-rose-300 rounded bg-white text-slate-800 focus:ring-1 focus:ring-rose-500"
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRevokingBlockId(null);
                                    setRevokeReason('');
                                  }}
                                  className="px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded cursor-pointer"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleConfirmRevoke(ev.blockId)}
                                  data-testid={`btn-confirm-revoke-${ev.blockId}`}
                                  disabled={!revokeReason.trim()}
                                  className="px-3 py-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded text-xs font-semibold cursor-pointer"
                                >
                                  确认撤回
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Editable Form for Author on Working Draft (Requirement 2) */}
                      {!isHistoricalOrFinal && isAuthor ? (
                        <div className="space-y-2.5 pt-2 border-t border-slate-200">
                          <label
                            htmlFor={`review-notes-${ev.blockId}`}
                            className="block text-xs font-semibold text-slate-800"
                          >
                            {ev.record && ev.record.status === 'reviewed' && ev.displayStatus === 'reviewed'
                              ? '追加/更新核对说明：'
                              : '填写人工核对说明或暂缓原因（必填）：'}
                          </label>

                          <textarea
                            id={`review-notes-${ev.blockId}`}
                            rows={2}
                            value={currentNoteInput}
                            onChange={(e) => handleNotesChange(ev.blockId, e.target.value)}
                            data-testid={`input-review-notes-${ev.blockId}`}
                            placeholder="请填写具体核对说明（如：已核对科室甲口径120项，正文表述将在下轮统稿中微调）..."
                            className="w-full text-xs p-2.5 border border-slate-300 rounded-lg bg-white text-slate-800 focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                          />

                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <span className="text-xs text-slate-400">
                              {isSubmitDisabled ? '请填写说明后提交' : '核对说明已填写'}
                            </span>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleSubmitReview(ev.blockId, 'deferred')}
                                data-testid={`btn-defer-review-${ev.blockId}`}
                                disabled={isSubmitDisabled}
                                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                                title="填写原因后暂缓处理，该段继续计入待处理范围"
                              >
                                <PauseCircle className="w-3.5 h-3.5" />
                                <span>暂缓处理</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleSubmitReview(ev.blockId, 'reviewed')}
                                data-testid={`btn-submit-review-${ev.blockId}`}
                                disabled={isSubmitDisabled}
                                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                                title="保存主笔人工核对记录，必须填写核对说明"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>记录人工复核</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : isHistoricalOrFinal ? (
                        <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                          当前为只读快照/定稿，仅供查看历史留痕，不能修改复核记录。
                        </div>
                      ) : (
                        <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                          当前身份为【{activeRole}】（只读演示），仅主笔甲可记录或撤回复核。
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PART 2: Changed Facts Impact List (Preserved Task 21 Implementation) */}
          {analysis.impactItems.length > 0 && (
            <div id="fact-impact-cards-section" className="space-y-4">
              <div className="flex items-center justify-between pb-1 border-b border-slate-200">
                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
                  <span>变动事实与受影响段落清单</span>
                    <span className="text-xs px-2 py-0.2 rounded-full bg-amber-100 text-amber-800 font-mono">
                      {analysis.impactItems.length} 项
                    </span>
                  </h3>
                  <span className="text-xs text-slate-400">
                    可点击“定位正文”高亮段落，或“查看本稿依据”核查冻结原文
                  </span>
                </div>

                <div className="space-y-4">
                  {analysis.impactItems.map((item) => (
                    <div
                      key={item.factId}
                      data-testid={`fact-impact-card-${item.factId}`}
                      className="border border-slate-200 rounded-lg p-4 bg-white shadow-2xs space-y-3.5 hover:border-slate-300 transition-colors"
                    >
                      {/* Fact Title & Discrepancy Badges */}
                      <div className="flex items-start justify-between flex-wrap gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-slate-900 text-sm">
                              {item.metric}
                            </span>
                            <span className="text-xs font-mono text-slate-400">
                              [{item.factId}]
                            </span>
                          </div>
                        </div>

                        {/* Difference Tags */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {item.differenceTags.map((tag, tagIdx) => (
                            <span
                              key={tagIdx}
                              className={`text-xs px-2 py-0.5 rounded font-semibold ${
                                tag.type === 'value'
                                  ? 'bg-rose-100 text-rose-800 border border-rose-200'
                                  : tag.type === 'unit'
                                  ? 'bg-orange-100 text-orange-800 border border-orange-200'
                                  : tag.type === 'period'
                                  ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                  : tag.type === 'metric_scope'
                                  ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                  : tag.type === 'primary_evidence'
                                  ? 'bg-blue-100 text-blue-800 border border-blue-200'
                                  : 'bg-rose-50 text-rose-900 border border-rose-300'
                              }`}
                              title={tag.description}
                            >
                              {tag.label}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Comparison Grid: Draft Snapshot vs Latest Task Fact */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs">
                        {/* Left: Draft Snapshot */}
                        <div className="space-y-1.5 bg-white p-2.5 rounded border border-slate-200">
                          <div className="flex items-center justify-between text-slate-500 font-semibold border-b border-slate-100 pb-1">
                            <span>本稿采用依据（快照冻结）</span>
                            <span className="font-mono text-slate-400">
                              {item.hasFrozenSnapshot ? '已冻结' : '未收录'}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div>
                              <span className="text-slate-400">采用数值：</span>
                              <span className="font-bold font-mono text-slate-800">
                                {item.draftSnapshotValue}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">统计期间：</span>
                              <span className="text-slate-700 font-medium">
                                {item.draftPeriod}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">核算口径：</span>
                              <span className="text-slate-700">
                                {item.draftMetricScope}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">主出处：</span>
                              <span className="text-slate-700">
                                {item.draftDocName} ({item.draftLocation})
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Right: Latest Task Fact */}
                        <div className="space-y-1.5 bg-white p-2.5 rounded border border-slate-200">
                          <div className="flex items-center justify-between text-slate-500 font-semibold border-b border-slate-100 pb-1">
                            <span>任务最新状态</span>
                            <span
                              className={`font-semibold px-1.5 py-0.2 rounded text-xs ${
                                item.latestStatus === 'confirmed' && !item.unresolvedConflict
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {item.latestStatusLabel}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div>
                              <span className="text-slate-400">最新数值：</span>
                              <span className="font-bold font-mono text-blue-800">
                                {item.latestConfirmedValue}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">统计期间：</span>
                              <span className="text-slate-700 font-medium">
                                {item.latestPeriod}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">核算口径：</span>
                              <span className="text-slate-700">
                                {item.latestMetricScope}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">主出处：</span>
                              <span className="text-slate-700">
                                {item.latestDocName} ({item.latestLocation})
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Referencing Blocks in Current Draft */}
                      <div className="space-y-2 pt-1">
                        <div className="text-xs font-semibold text-slate-700 flex items-center justify-between">
                          <span>
                            引用此事实的正文段落（共{' '}
                            <strong className="text-slate-900 font-mono">
                              {item.referencingBlocks.length}
                            </strong>{' '}
                            段）：
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onViewDraftEvidence(item)}
                              data-testid={`btn-view-evidence-${item.factId}`}
                              className="text-xs text-blue-700 hover:text-blue-900 font-medium flex items-center gap-1 cursor-pointer hover:underline"
                              title="查看当前稿件当时冻结的材料出处与原文片段"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              <span>查看本稿依据</span>
                            </button>

                            {onJumpToFactsStage && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onJumpToFactsStage();
                                }}
                                data-testid={`btn-jump-facts-${item.factId}`}
                                className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 cursor-pointer hover:underline"
                                title="前往任务事实清单核对（注：该页面查看任务当前最新事实，与本稿历史冻结依据不同）"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>前往任务事实核验（当前最新事实）</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {item.referencingBlocks.length > 0 ? (
                          <div className="space-y-2">
                            {item.referencingBlocks.map((blk) => (
                              <div
                                key={blk.blockId}
                                className="flex items-center justify-between gap-3 p-2.5 bg-slate-50 rounded border border-slate-200/80 hover:bg-slate-100/60 transition-colors"
                              >
                                <div className="min-w-0 flex-1 space-y-0.5">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="font-bold text-slate-800">
                                      第{blk.blockOrder}段 · {blk.sectionTitle}
                                    </span>
                                    <span className="font-mono text-slate-400">
                                      [{blk.blockId}]
                                    </span>
                                    {blk.viaMaterialSupplement && (
                                      <span className="px-1.5 py-0.2 rounded text-xs bg-indigo-50 text-indigo-700 border border-indigo-200">
                                        材料补写关联
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-600 truncate">
                                    “{blk.contentExcerpt}”
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => onLocateBlock(blk.blockId, item.factId)}
                                  data-testid={`btn-locate-block-${blk.blockId}`}
                                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shrink-0 transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600"
                                  title={`定位到正文第${blk.blockOrder}段并展开依据`}
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                  <span>定位正文</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="p-2 bg-slate-50 rounded border border-slate-200 text-xs text-slate-500">
                            此事实在当前稿件正文段落中未被直接引用（仅存在于快照记录中）。
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* PART 3: Facts in Task Not Yet Referenced by Draft (Fix for Issue #76) */}
          {analysis.unreferencedNewFacts.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-slate-700 text-xs flex items-center gap-1.5">
                  {/* Issue #76 wording fix: do not infer creation time */}
                  <span>任务中尚未被所选稿件引用的事实</span>
                  <span className="text-xs px-1.5 py-0.2 rounded bg-slate-200 text-slate-700 font-mono">
                    {analysis.unreferencedNewFacts.length} 项
                  </span>
                </h4>
                <span className="text-xs text-slate-400">
                  不计入受影响正文段落数
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {analysis.unreferencedNewFacts.map((f) => (
                  <div
                    key={f.factId}
                    className="p-2.5 bg-slate-50 border border-slate-200 rounded space-y-0.5"
                  >
                    <div className="flex items-center justify-between font-medium text-slate-800">
                      <span>{f.metric}</span>
                      <span className="text-xs font-mono text-slate-400">[{f.factId}]</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-500">
                      <span>
                        数值：<strong className="text-slate-700 font-mono">{f.value} {f.unit}</strong>
                      </span>
                      <span className="px-1.5 py-0.2 rounded text-xs bg-slate-100 text-slate-600">
                        {f.statusLabel}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 rounded-b-xl flex items-center justify-between flex-wrap gap-2 shrink-0">
          <p className="text-xs text-slate-500">
            {isHistoricalOrFinal
              ? '当前为只读快照/定稿，仅提供比对核查；如需更新，请创建新工作稿后起草。'
              : '提示：本检查仅提供差异发现与段落定位，不会自动替换文字或改写快照。'}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg text-xs font-semibold cursor-pointer transition-colors"
          >
            关闭面板
          </button>
        </div>
      </div>
    </div>
  );
};
