import React, { useEffect, useRef, useState } from 'react';
import {
  Task,
  DraftVersion,
  UserRole,
  EvidenceSnippet,
  Fact,
  AdoptedEvidenceRecord,
} from '../types';
import {
  evaluatePostRevisionVerification,
  recordPostRevisionVerification,
  deferPostRevisionVerification,
  revokePostRevisionVerification,
} from '../services/postRevisionVerificationService';
import { computeTextDiff } from '../services/diffService';
import {
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  PauseCircle,
  History,
  MapPin,
  ExternalLink,
  ShieldAlert,
  Info,
  Check,
  FileText,
} from 'lucide-react';

interface PostRevisionVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  currentDraft?: DraftVersion;
  draft?: DraftVersion;
  activeRole: UserRole;
  initialBlockId?: string;
  onLocateBlock?: (blockId: string) => void;
  onViewSnippet?: (
    snippet: EvidenceSnippet,
    fact?: Fact,
    adoptedEvidence?: AdoptedEvidenceRecord,
    freezeDraftEvidence?: boolean
  ) => void;
  onJumpToFactsStage?: () => void;
  onUpdateTask?: (updated: Partial<Task>) => void;
}

export const PostRevisionVerificationModal: React.FC<PostRevisionVerificationModalProps> = ({
  isOpen,
  onClose,
  task,
  currentDraft,
  draft,
  activeRole,
  initialBlockId,
  onLocateBlock,
  onViewSnippet,
  onJumpToFactsStage,
  onUpdateTask,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  const effectiveDraft =
    currentDraft ||
    draft ||
    task?.drafts?.find((d) => d.id === task.currentDraftId) ||
    task?.drafts?.[0];

  // Form states per block
  const [notesByBlock, setNotesByBlock] = useState<Record<string, string>>({});
  const [deferReasonByBlock, setDeferReasonByBlock] = useState<Record<string, string>>({});
  const [showDeferInputByBlock, setShowDeferInputByBlock] = useState<Record<string, boolean>>({});
  const [showRevokeInputByBlock, setShowRevokeInputByBlock] = useState<Record<string, boolean>>({});
  const [revokeReasonByBlock, setRevokeReasonByBlock] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [showHistoryByBlock, setShowHistoryByBlock] = useState<Record<string, boolean>>({});
  const [previewEvidence, setPreviewEvidence] = useState<{
    factId: string;
    type: 'before' | 'after';
    evidence: any;
  } | null>(null);

  // Reset form inputs when task, draft or role changes
  useEffect(() => {
    setNotesByBlock({});
    setDeferReasonByBlock({});
    setShowDeferInputByBlock({});
    setShowRevokeInputByBlock({});
    setRevokeReasonByBlock({});
    setActionErrors({});
    setShowHistoryByBlock({});
    setPreviewEvidence(null);
  }, [isOpen, task?.id, effectiveDraft?.id, activeRole]);

  // Focus management and keyboard navigation
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;
      const targetCard = initialBlockId
        ? modalRef.current?.querySelector<HTMLElement>(`[data-verification-block-id="${initialBlockId}"]`)
        : null;
      if (targetCard) {
        targetCard.focus();
        targetCard.scrollIntoView({ block: 'nearest' });
      } else {
        modalRef.current?.focus();
      }
    }
    return () => {
      if (isOpen && previousActiveElementRef.current?.isConnected) {
        previousActiveElementRef.current.focus({ preventScroll: true });
      }
    };
  }, [isOpen, initialBlockId]);

  // Escape key and Tab focus trap
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
        } else if (!panel.contains(active) || active === panel || (e.shiftKey ? active === first : active === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const overview = evaluatePostRevisionVerification(task, effectiveDraft);
  const isReadOnly = Boolean(effectiveDraft?.isHistoricalSnapshot || effectiveDraft?.isFinal);
  const isAuthor = activeRole === '主笔甲' || activeRole === task.primaryAuthor;

  const handleRecord = (blockId: string) => {
    const notes = notesByBlock[blockId] || '';
    if (!notes.trim()) {
      setActionErrors((prev) => ({ ...prev, [blockId]: '请填写详细核对说明后再提交' }));
      return;
    }

    const curBlock = effectiveDraft?.blocks.find((b) => b.id === blockId);
    const res = recordPostRevisionVerification({
      task,
      draftId: effectiveDraft!.id,
      operationId: overview.operationId!,
      blockId,
      activeRole,
      notes,
      baselineState: curBlock
        ? {
            paragraphContent: curBlock.content,
            revisionSeq: curBlock.revisionSeq ?? 0,
            referencedFactIds: [...curBlock.referencedFactIds],
          }
        : undefined,
    });

    if (!res.success) {
      setActionErrors((prev) => ({ ...prev, [blockId]: res.reason || '记录核对失败' }));
      return;
    }

    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setNotesByBlock((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    if (res.updatedTask && onUpdateTask) {
      onUpdateTask(res.updatedTask);
    }
  };

  const handleDefer = (blockId: string) => {
    const reason = deferReasonByBlock[blockId] || '';
    if (!reason.trim()) {
      setActionErrors((prev) => ({ ...prev, [blockId]: '请填写暂缓原因后再提交' }));
      return;
    }

    const curBlock = effectiveDraft?.blocks.find((b) => b.id === blockId);
    const res = deferPostRevisionVerification({
      task,
      draftId: effectiveDraft!.id,
      operationId: overview.operationId!,
      blockId,
      activeRole,
      reason,
      baselineState: curBlock
        ? {
            paragraphContent: curBlock.content,
            revisionSeq: curBlock.revisionSeq ?? 0,
            referencedFactIds: [...curBlock.referencedFactIds],
          }
        : undefined,
    });

    if (!res.success) {
      setActionErrors((prev) => ({ ...prev, [blockId]: res.reason || '暂缓核对失败' }));
      return;
    }

    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setShowDeferInputByBlock((prev) => ({ ...prev, [blockId]: false }));
    setDeferReasonByBlock((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    if (res.updatedTask && onUpdateTask) {
      onUpdateTask(res.updatedTask);
    }
  };

  const handleRevoke = (blockId: string) => {
    const reason = revokeReasonByBlock[blockId] || '';
    if (!reason.trim()) {
      setActionErrors((prev) => ({ ...prev, [blockId]: '请填写撤回原因后再提交' }));
      return;
    }

    const res = revokePostRevisionVerification({
      task,
      draftId: effectiveDraft!.id,
      operationId: overview.operationId!,
      blockId,
      activeRole,
      reason,
    });

    if (!res.success) {
      setActionErrors((prev) => ({ ...prev, [blockId]: res.reason || '撤回核对失败' }));
      return;
    }

    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setShowRevokeInputByBlock((prev) => ({ ...prev, [blockId]: false }));
    setRevokeReasonByBlock((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    if (res.updatedTask && onUpdateTask) {
      onUpdateTask(res.updatedTask);
    }
  };

  const handleOpenSnippet = (
    docName: string,
    location?: string,
    text?: string,
    period?: string,
    evidenceId?: string
  ) => {
    if (!onViewSnippet) return;
    const snippet: EvidenceSnippet = {
      id: evidenceId || 'EVD-FROZEN',
      sourceDocId: 'DOC-FROZEN',
      docName: docName || '已冻结出处依据',
      location: location || '出处位置',
      text: text || '（该出处依据在采纳时已存证冻结）',
      period: period || '',
    };
    onViewSnippet(snippet, undefined, undefined, true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="事实修订后逐段人工核对与留痕"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-testid="post-revision-verification-modal"
        className="bg-white rounded-xl shadow-2xl w-full max-w-5xl flex flex-col my-auto max-h-[92vh] border border-slate-200 outline-none overflow-hidden animate-in fade-in duration-150"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/90 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-teal-600 text-white flex items-center justify-center shadow-xs">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2
                  className="text-base font-bold text-slate-900"
                  data-testid="post-revision-verification-modal-title"
                >
                  事实修订后逐段核对与留痕
                </h2>
                {isReadOnly && (
                  <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded font-medium">
                    只读快照归档
                  </span>
                )}
                {!isAuthor && !isReadOnly && (
                  <span className="text-xs bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-medium">
                    非主笔身份（仅可查看）
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                对已采纳事实定向修订的目标段落进行逐段人工核对与依据复查，确保事实变更与正文表述严谨一致
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="btn-close-post-revision-verification-modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer transition-colors"
            title="关闭 (Escape)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* Missing credential notice */}
          {!overview.hasCredential ? (
            <div
              data-testid="notice-missing-credential"
              className="p-6 rounded-lg bg-slate-50 border border-slate-200 text-center space-y-3"
            >
              <Info className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-800">
                  {overview.message || '本稿未保存修订后核对清单，无法还原本次范围'}
                </p>
                <p className="text-xs text-slate-500 max-w-lg mx-auto">
                  当前稿件并非直接由事实定向修订采纳产生，或其修订核对凭据已归档在派生来源草稿中。缺失凭据不解释为已核对完成。
                </p>
              </div>
              {overview.sourceDraftId && (
                <div className="text-xs text-slate-600 bg-white p-2.5 rounded border border-slate-200 inline-block">
                  来源版本：<span className="font-mono font-medium">{overview.sourceDraftId}</span>
                  {overview.operationId && (
                    <> · 关联修订操作：<span className="font-mono font-medium">{overview.operationId}</span></>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Operation & Progress Banner */}
              <div
                data-testid="verification-modal-summary"
                className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 pb-3 border-b border-slate-200/80">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-700">本次修订操作：</span>
                    <span className="font-mono bg-white px-2 py-0.5 rounded border border-slate-200 text-slate-800">
                      {overview.operationId}
                    </span>
                    <span>· 来源版本：</span>
                    <span className="font-mono text-slate-700">{overview.sourceDraftId}</span>
                    <span>· 目标工作稿：</span>
                    <span className="font-mono text-slate-700">{overview.targetDraftId}</span>
                  </div>
                  <div>
                    <span>涉及 </span>
                    <strong className="text-slate-900 font-mono">{overview.facts.length}</strong>
                    <span> 项事实 · 去重后 </span>
                    <strong className="text-slate-900 font-mono">{overview.totalBlocks}</strong>
                    <span> 个唯一段落</span>
                  </div>
                </div>

                {/* Progress bar and status */}
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1 flex-1">
                    <div
                      className="flex items-center justify-between text-xs"
                      data-testid="post-revision-verification-progress-summary"
                    >
                      <span className="font-medium text-slate-700">
                        本次修订核对：
                        <strong className="text-teal-700 font-mono">
                          {overview.verifiedCount}/{overview.totalBlocks}
                        </strong>
                        段已记录 ·{' '}
                        <strong className="text-amber-700 font-mono">{overview.pendingCount}</strong>
                        段待处理
                        {overview.deferredCount > 0 && `（含暂缓${overview.deferredCount}段）`}
                        {overview.invalidatedCount > 0 && `（含失效${overview.invalidatedCount}段）`}
                      </span>
                      <span className="font-mono text-slate-500">
                        {overview.totalBlocks > 0
                          ? `${Math.round((overview.verifiedCount / overview.totalBlocks) * 100)}%`
                          : '0%'}
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-teal-600 h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${
                            overview.totalBlocks > 0
                              ? (overview.verifiedCount / overview.totalBlocks) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  {overview.isAllVerified && (
                    <div className="shrink-0 bg-teal-50 border border-teal-200 text-teal-800 text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 font-medium">
                      <Check className="w-4 h-4 text-teal-600" />
                      <span>本次修订涉及段落已记录人工核对</span>
                    </div>
                  )}
                </div>

                {overview.isAllVerified && (
                  <p className="text-2xs text-slate-500">
                    注：人工核对记录仅证明主笔已逐段复核本次修订，不代表审阅通过、系统核验无误或可以最终定稿；既有审阅意见及核校定稿门禁仍严格生效。
                  </p>
                )}
              </div>

              {/* Facts summary cards */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  本次定向修订涉及事实 ({overview.facts.length}项)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {overview.facts.map((f) => (
                    <div
                      key={f.factId}
                      data-testid={`verification-fact-card-${f.factId}`}
                      className="p-3.5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                            {f.factId}
                          </span>
                          <span className="text-xs font-bold text-slate-800">{f.metric}</span>
                        </div>
                        <span className="text-2xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          期间: {f.period || '2026年1至9月'}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-500">修订前冻结值:</span>
                        <span className="line-through text-slate-400 font-mono">
                          {f.fromValue}
                          {f.unit}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className="text-teal-700 font-bold font-mono">
                          {f.toValue}
                          {f.unit}
                        </span>
                      </div>

                      {/* Evidence buttons */}
                      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 text-2xs">
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewEvidence({
                              factId: f.factId,
                              type: 'before',
                              evidence: f.fromEvidence,
                            });
                            handleOpenSnippet(
                              f.fromEvidence.sourceDocName,
                              f.fromEvidence.location,
                              f.fromEvidence.snippetText,
                              f.fromEvidence.period,
                              f.fromEvidence.evidenceId
                            );
                          }}
                          data-testid={`btn-view-evidence-before-${f.factId}`}
                          className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2 py-1 rounded cursor-pointer transition-colors"
                          title="查看修订前来源版本的冻结出处"
                        >
                          <ExternalLink className="w-3 h-3 text-slate-400" />
                          <span>修订前冻结依据 ({f.fromEvidence.sourceDocName || '来源文档'})</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setPreviewEvidence({
                              factId: f.factId,
                              type: 'after',
                              evidence: f.toEvidence,
                            });
                            handleOpenSnippet(
                              f.toEvidence.sourceDocName,
                              f.toEvidence.location,
                              f.toEvidence.snippetText,
                              f.toEvidence.period,
                              f.toEvidence.evidenceId
                            );
                          }}
                          data-testid={`btn-view-evidence-after-${f.factId}`}
                          className="inline-flex items-center gap-1 text-teal-700 hover:text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-2 py-1 rounded cursor-pointer transition-colors font-medium"
                          title="查看本次采纳时绑定的冻结出处依据"
                        >
                          <ExternalLink className="w-3 h-3 text-teal-600" />
                          <span>本次采纳依据（冻结）</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {previewEvidence && (
                  <div
                    data-testid="frozen-evidence-preview-box"
                    className="p-3 bg-teal-50/80 border border-teal-300 rounded-lg text-xs space-y-1.5 shadow-2xs animate-in fade-in"
                  >
                    <div className="flex items-center justify-between font-bold text-teal-900">
                      <span>
                        {previewEvidence.type === 'before' ? '【修改前冻结出处】' : '【本次采纳依据（冻结）】'}
                        {previewEvidence.evidence.evidenceId} · {previewEvidence.evidence.sourceDocName}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPreviewEvidence(null)}
                        className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                        title="关闭预览"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-slate-800 leading-relaxed">
                      {previewEvidence.evidence.snippetText}
                    </p>
                    <div className="text-2xs text-slate-500 flex gap-2">
                      <span>出处位置：{previewEvidence.evidence.location || '正文'}</span>
                      <span>· 存证时间：{previewEvidence.evidence.capturedAt || '已存证'}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Block Cards List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    逐段核对清单 ({overview.blockEvaluations.length}个段落)
                  </h3>
                  <span className="text-2xs text-slate-500">
                    去重统计：共享段落仅收录一次；未变事实（如800人次）严格保持
                  </span>
                </div>

                <div className="space-y-4">
                  {overview.blockEvaluations.map((ev) => {
                    const blockId = ev.blockId;
                    const credBlock = ev.credBlock;
                    const curBlock = ev.currentBlock;
                    const rec = ev.record;
                    const error = actionErrors[blockId];
                    const showDefer = showDeferInputByBlock[blockId];
                    const showRevoke = showRevokeInputByBlock[blockId];
                    const showHist = showHistoryByBlock[blockId];

                    const diffWithAfter = curBlock && curBlock.content !== credBlock.afterContent
                      ? computeTextDiff(credBlock.afterContent, curBlock.content)
                      : null;

                    return (
                      <div
                        key={blockId}
                        data-testid={`verification-block-card-${blockId}`}
                        data-verification-block-id={blockId}
                        tabIndex={0}
                        className={`p-4 rounded-xl border transition-all shadow-2xs space-y-3 outline-none focus:ring-2 focus:ring-teal-500 ${
                          ev.displayStatus === 'verified'
                            ? 'bg-white border-teal-200'
                            : ev.displayStatus === 'deferred'
                            ? 'bg-amber-50/30 border-amber-200'
                            : ev.displayStatus === 'invalidated'
                            ? 'bg-rose-50/30 border-rose-200'
                            : 'bg-white border-slate-200'
                        }`}
                      >
                        {/* Block header */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-900">
                              {credBlock.sectionTitle || '正文章节'} · 第{credBlock.blockOrder}段
                            </span>
                            <span className="font-mono text-2xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                              {blockId}
                            </span>
                            {/* Associated facts tags */}
                            {ev.associatedFacts.map((af) => (
                              <span
                                key={af.factId}
                                className="text-2xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded font-medium"
                              >
                                关联事实：{af.metric} ({af.toValue}{af.unit})
                              </span>
                            ))}
                            {ev.associatedFacts.length > 1 && (
                              <span className="text-2xs bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded font-bold">
                                共享段落（多事实）
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Status badge */}
                            <span
                              data-testid={`badge-verification-status-${blockId}`}
                              className={`text-xs px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 ${
                                ev.displayStatus === 'verified'
                                  ? 'bg-teal-50 text-teal-800 border-teal-300'
                                  : ev.displayStatus === 'deferred'
                                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                                  : ev.displayStatus === 'invalidated'
                                  ? 'bg-rose-50 text-rose-800 border-rose-300'
                                  : ev.displayStatus === 'block_missing'
                                  ? 'bg-slate-200 text-slate-700 border-slate-300'
                                  : 'bg-slate-100 text-slate-700 border-slate-300'
                              }`}
                            >
                              {ev.displayStatus === 'verified' && <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" />}
                              {ev.displayStatus === 'deferred' && <PauseCircle className="w-3.5 h-3.5 text-amber-600" />}
                              {ev.displayStatus === 'invalidated' && <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />}
                              {ev.displayStatus === 'pending' && <Clock className="w-3.5 h-3.5 text-slate-400" />}
                              <span>{ev.displayStatusLabel}</span>
                            </span>

                            {/* Locate block button */}
                            {curBlock && onLocateBlock && (
                              <button
                                type="button"
                                onClick={() => onLocateBlock(blockId)}
                                data-testid={`btn-locate-block-${blockId}`}
                                className="text-2xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2 py-1 rounded cursor-pointer flex items-center gap-1 transition-colors"
                                title="定位到正文对应段落"
                              >
                                <MapPin className="w-3 h-3 text-slate-500" />
                                <span>定位正文</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Associated fact difference warning */}
                        {ev.associatedFactsHaveDifferenceOrConflict && (
                          <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="flex-1 space-y-1">
                              <p className="font-semibold">{ev.factDifferenceNotice}</p>
                              <p className="text-2xs text-amber-700">
                                关联事实存在变动或未裁决冲突时，不得将本段标为核对完成，请先处理事实差异。
                              </p>
                              {onJumpToFactsStage && (
                                <button
                                  type="button"
                                  onClick={onJumpToFactsStage}
                                  className="text-2xs font-bold text-amber-800 underline hover:text-amber-950 cursor-pointer"
                                >
                                  前往材料与事实阶段处理 →
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Invalidation reason */}
                        {ev.displayStatus === 'invalidated' && ev.invalidatedReason && (
                          <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
                            <span className="font-medium">原核对已失效：{ev.invalidatedReason}</span>
                          </div>
                        )}

                        {/* Texts display */}
                        <div className="space-y-2 text-xs">
                          {/* Before content */}
                          <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
                            <span className="text-2xs font-semibold text-slate-500 block mb-1">
                              【修订前正文（修改前）】
                            </span>
                            <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">
                              {credBlock.beforeContent}
                            </p>
                          </div>

                          {/* After content */}
                          <div className="p-2.5 rounded bg-teal-50/50 border border-teal-200">
                            <span className="text-2xs font-semibold text-teal-800 block mb-1">
                              【本次采纳后正文（修订基准）】
                            </span>
                            <p className="text-slate-800 whitespace-pre-wrap leading-relaxed">
                              {credBlock.afterContent}
                            </p>
                          </div>

                          {/* Current content if modified */}
                          {curBlock && ev.hasCurrentContentDiff && (
                            <div className="p-2.5 rounded bg-amber-50/40 border border-amber-200">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-2xs font-semibold text-amber-900">
                                  【当前正文（采纳后又经人工编辑调整）】
                                </span>
                                <span className="text-2xs text-amber-700">
                                  当前 revisionSeq: {curBlock.revisionSeq ?? 0}（采纳时为 {credBlock.appliedRevisionSeq}）
                                </span>
                              </div>
                              <p className="text-slate-800 whitespace-pre-wrap leading-relaxed">
                                {curBlock.content}
                              </p>
                              {diffWithAfter && (
                                <div className="mt-2 pt-2 border-t border-amber-200/60">
                                  <span className="text-2xs text-slate-500 block mb-1">采纳基准与当前正文差异对比：</span>
                                  <div className="p-2 bg-white rounded border border-amber-200 text-slate-700 leading-relaxed">
                                    {diffWithAfter.map((seg, i) =>
                                      seg.type === 'added' ? (
                                        <ins key={i} className="bg-emerald-100 text-emerald-900 no-underline px-0.5 rounded font-medium">
                                          {seg.text}
                                        </ins>
                                      ) : seg.type === 'removed' ? (
                                        <del key={i} className="bg-rose-100 text-rose-900 line-through px-0.5 rounded opacity-75">
                                          {seg.text}
                                        </del>
                                      ) : (
                                        <span key={i}>{seg.text}</span>
                                      )
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Existing record information (if verified or deferred) */}
                        {rec && (
                          <div className="p-2.5 rounded bg-slate-50 border border-slate-200 space-y-1.5 text-xs text-slate-700">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-slate-800">
                                {rec.status === 'verified' ? '核对说明：' : '暂缓原因：'}
                              </span>
                              <span className="text-2xs text-slate-500">
                                记录人：{rec.verifiedBy || rec.deferredBy || '主笔'} ·{' '}
                                {rec.verifiedAt || rec.deferredAt || ''}
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap">{rec.notes || rec.deferredReason}</p>

                            {/* Revocation info if present */}
                            {rec.revocation && (
                              <div className="p-1.5 rounded bg-rose-50 text-rose-800 text-2xs mt-1">
                                已于 {rec.revocation.revokedAt} 由 {rec.revocation.revokedBy} 撤回：{rec.revocation.reason}
                              </div>
                            )}

                            {/* History event toggle */}
                            {rec.history && rec.history.length > 1 && (
                              <div>
                                <button
                                  type="button"
                                  onClick={() => setShowHistoryByBlock((prev) => ({ ...prev, [blockId]: !showHist }))}
                                  className="text-2xs text-slate-500 hover:text-slate-800 flex items-center gap-1 cursor-pointer font-medium mt-1"
                                >
                                  <History className="w-3 h-3" />
                                  <span>{showHist ? '收起历史留痕' : `查看历史事件 (${rec.history.length})`}</span>
                                </button>
                                {showHist && (
                                  <div className="mt-1 space-y-1 pl-3 border-l-2 border-slate-300">
                                    {rec.history.map((h) => (
                                      <div key={h.id} className="text-2xs text-slate-600">
                                        <span className="font-mono text-slate-400">[{h.timestamp}] </span>
                                        <span className="font-semibold">
                                          {h.action === 'verify' ? '记录核对' : h.action === 'defer' ? '暂缓' : '撤回'}
                                        </span>
                                        <span> 由 {h.operator}：</span>
                                        <span>{h.notes || h.reason}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Interactive Action Forms (Only in working draft, not read-only, author role) */}
                        {!isReadOnly && isAuthor && curBlock && (
                          <div className="pt-2 border-t border-slate-100 space-y-2">
                            {/* Error display */}
                            {error && (
                              <p className="text-xs text-rose-600 font-medium flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5" />
                                <span>{error}</span>
                              </p>
                            )}

                            {/* When status is pending or invalidated or re-verifying */}
                            {(ev.displayStatus === 'pending' ||
                              ev.displayStatus === 'invalidated' ||
                              ev.displayStatus === 'deferred') &&
                              !showDefer && (
                                <div className="space-y-2">
                                  <label
                                    htmlFor={`input-verification-notes-${blockId}`}
                                    className="block text-2xs font-semibold text-slate-600"
                                  >
                                    人工核对说明 (必填)：
                                  </label>
                                  <textarea
                                    id={`input-verification-notes-${blockId}`}
                                    rows={2}
                                    value={notesByBlock[blockId] ?? ''}
                                    onChange={(e) =>
                                      setNotesByBlock((prev) => ({ ...prev, [blockId]: e.target.value }))
                                    }
                                    data-testid={`input-verification-notes-${blockId}`}
                                    placeholder="请说明已逐段核对修改前后正文与冻结出处的一致性（例如：已确认重点任务120项与专题培训18场数据真实无误，出处依据冻结正确，正文表述通顺）..."
                                    className="w-full text-xs p-2.5 rounded-lg border border-slate-300 focus:ring-2 focus:ring-teal-500 focus:outline-none"
                                  />
                                  <div className="flex items-center justify-between">
                                    <button
                                      type="button"
                                      onClick={() => setShowDeferInputByBlock((prev) => ({ ...prev, [blockId]: true }))}
                                      data-testid={`btn-defer-verification-${blockId}`}
                                      className="text-xs text-amber-700 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
                                    >
                                      暂缓核对...
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleRecord(blockId)}
                                      data-testid={`btn-record-verification-${blockId}`}
                                      disabled={ev.associatedFactsHaveDifferenceOrConflict}
                                      className={`text-xs px-4 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer ${
                                        ev.associatedFactsHaveDifferenceOrConflict
                                          ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                                          : 'bg-teal-600 hover:bg-teal-700 text-white'
                                      }`}
                                    >
                                      <Check className="w-3.5 h-3.5" />
                                      <span>记录人工核对</span>
                                    </button>
                                  </div>
                                </div>
                              )}

                            {/* Defer input panel */}
                            {showDefer && (
                              <div className="p-3 rounded-lg bg-amber-50/60 border border-amber-200 space-y-2">
                                <label
                                  htmlFor={`input-defer-reason-${blockId}`}
                                  className="block text-2xs font-semibold text-amber-900"
                                >
                                  暂缓核对原因 (必填，继续计入待处理)：
                                </label>
                                <textarea
                                  id={`input-defer-reason-${blockId}`}
                                  rows={2}
                                  value={deferReasonByBlock[blockId] ?? ''}
                                  onChange={(e) =>
                                    setDeferReasonByBlock((prev) => ({ ...prev, [blockId]: e.target.value }))
                                  }
                                  data-testid={`input-defer-reason-${blockId}`}
                                  placeholder="请填写暂缓原因（例如：需等待业务处室进一步补充书面证明材料）..."
                                  className="w-full text-xs p-2 rounded border border-amber-300 focus:ring-2 focus:ring-amber-500 focus:outline-none"
                                />
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setShowDeferInputByBlock((prev) => ({ ...prev, [blockId]: false }))}
                                    className="text-xs text-slate-600 hover:text-slate-800 px-2.5 py-1 rounded cursor-pointer"
                                  >
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDefer(blockId)}
                                    data-testid={`btn-confirm-defer-${blockId}`}
                                    className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium px-3 py-1 rounded shadow-2xs cursor-pointer"
                                  >
                                    确认暂缓
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* When status is verified: allow revoke */}
                            {ev.displayStatus === 'verified' && !showRevoke && (
                              <div className="flex items-center justify-end">
                                <button
                                  type="button"
                                  onClick={() => setShowRevokeInputByBlock((prev) => ({ ...prev, [blockId]: true }))}
                                  data-testid={`btn-revoke-verification-${blockId}`}
                                  className="text-xs text-slate-500 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 hover:border-rose-200 px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
                                >
                                  撤回核对记录...
                                </button>
                              </div>
                            )}

                            {/* Revoke input panel */}
                            {showRevoke && (
                              <div className="p-3 rounded-lg bg-rose-50/60 border border-rose-200 space-y-2">
                                <label
                                  htmlFor={`input-revoke-reason-${blockId}`}
                                  className="block text-2xs font-semibold text-rose-900"
                                >
                                  撤回核对原因 (必填)：
                                </label>
                                <textarea
                                  id={`input-revoke-reason-${blockId}`}
                                  rows={2}
                                  value={revokeReasonByBlock[blockId] ?? ''}
                                  onChange={(e) =>
                                    setRevokeReasonByBlock((prev) => ({ ...prev, [blockId]: e.target.value }))
                                  }
                                  data-testid={`input-revoke-reason-${blockId}`}
                                  placeholder="请填写撤回原因（例如：发现出处依据有异议，需重新复核）..."
                                  className="w-full text-xs p-2 rounded border border-rose-300 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                                />
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setShowRevokeInputByBlock((prev) => ({ ...prev, [blockId]: false }))}
                                    className="text-xs text-slate-600 hover:text-slate-800 px-2.5 py-1 rounded cursor-pointer"
                                  >
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRevoke(blockId)}
                                    data-testid={`btn-confirm-revoke-${blockId}`}
                                    className="text-xs bg-rose-600 hover:bg-rose-700 text-white font-medium px-3 py-1 rounded shadow-2xs cursor-pointer"
                                  >
                                    确认撤回
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="text-2xs text-slate-500">
            仅主笔有权签署核对记录 · 所有操作均保留完整留痕存证
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-medium rounded-lg cursor-pointer transition-colors"
          >
            完成并关闭
          </button>
        </div>
      </div>
    </div>
  );
};
