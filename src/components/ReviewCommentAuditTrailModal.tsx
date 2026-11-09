import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  History,
  ShieldCheck,
  AlertTriangle,
  FileText,
  CornerDownRight,
  RotateCcw,
  CheckCircle2,
  Clock,
  User,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import {
  ReviewComment,
  ReviewCommentAuditEvent,
  Task,
  DraftVersion,
  UserRole,
} from '../types';
import {
  getCommentAuditTrail,
  getActionTypeLabel,
  getCommentStatusLabel,
} from '../services/reviewCommentAuditService';

export interface ReviewCommentAuditTrailModalProps {
  isOpen: boolean;
  onClose: () => void;
  comment: ReviewComment | null;
  task: Task;
  currentDraft?: DraftVersion;
  activeRole?: UserRole;
  isHistoricalContext?: boolean;
  historicalRoundNumber?: number;
}

export const ReviewCommentAuditTrailModal: React.FC<ReviewCommentAuditTrailModalProps> = ({
  isOpen,
  onClose,
  comment,
  task,
  currentDraft,
  activeRole,
  isHistoricalContext = false,
  historicalRoundNumber,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [expandedEventIds, setExpandedEventIds] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState<boolean>(true);

  // Close on Escape key press
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap / auto-focus close button on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Reset expanded state on comment change
  useEffect(() => {
    if (comment) {
      const trail = getCommentAuditTrail(comment);
      const initial: Record<string, boolean> = {};
      trail.forEach((e) => {
        initial[e.eventId] = true;
      });
      setExpandedEventIds(initial);
      setAllExpanded(true);
    }
  }, [comment?.id]);

  if (!isOpen || !comment) return null;

  const events = getCommentAuditTrail(comment);
  const hasEvents = events.length > 0;

  // Resolve target block on currentDraft
  const effectiveBlockId = comment.currentBlockId || comment.targetBlockId;
  const targetBlock = effectiveBlockId ? currentDraft?.blocks.find((b) => b.id === effectiveBlockId) : undefined;
  const isTargetBlockMissing = comment.type === 'paragraph' && effectiveBlockId && !targetBlock;

  // Check if modificationLog is still in task.modificationLogs
  const activeLogIds = new Set((task.modificationLogs || []).map((l) => l.id));

  const toggleEventExpand = (id: string) => {
    setExpandedEventIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const handleToggleAll = () => {
    const nextState = !allExpanded;
    setAllExpanded(nextState);
    const updated: Record<string, boolean> = {};
    events.forEach((e) => {
      updated[e.eventId] = nextState;
    });
    setExpandedEventIds(updated);
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return ts;
    }
  };

  return (
    <div
      data-testid="review-comment-audit-trail-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 sm:p-6 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-trail-title"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-4xl max-h-[92vh] bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden text-slate-800 animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-50 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg">
              <History className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="audit-trail-title" className="text-base font-bold text-slate-900">
                  单条审阅意见处理履历与落实凭据
                </h2>
                <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-slate-200 text-slate-700">
                  {comment.id}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    comment.type === 'overall'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}
                >
                  {comment.type === 'overall' ? '全局意见' : '段落意见'}
                </span>
                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                  提出人：{comment.reviewer}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                意见内容：“{comment.content}”
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            title="关闭弹窗 (Esc)"
            data-testid="btn-close-audit-modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-sm">
          {/* Round Review Context Notice */}
          {isHistoricalContext && (
            <div
              className="p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-start gap-2.5 text-xs text-amber-900"
              data-testid="round-review-audit-notice"
            >
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="font-semibold text-amber-800">
                  轮次回看提示（当前正在回看第 {historicalRoundNumber || 1} 轮送审基准）
                </div>
                <div>
                  展示该意见当前处理履历，可能包含本轮送审后的处理，不代表本轮结束时的冻结结论。
                </div>
              </div>
            </div>
          )}

          {/* Top Tri-Card: Original Attribution, Current Target, and Current Status */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 1. Original Attribution */}
            <div className="p-3.5 bg-slate-50/80 rounded-lg border border-slate-200 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                <span>原始提出归属</span>
              </div>
              <div className="text-xs space-y-1 text-slate-600">
                <div>
                  提出基准：<span className="font-semibold text-slate-800">【{comment.targetVersionNumber || comment.targetVersionId}】</span>
                </div>
                <div>
                  原始段落：
                  {comment.type === 'overall' ? (
                    <span className="text-purple-700 font-semibold">全局整稿意见</span>
                  ) : (
                    <span className="font-semibold text-slate-800">
                      第 {comment.targetBlockOrder || '?'} 段
                      {comment.targetBlockId && <span className="font-mono text-slate-500 ml-1">({comment.targetBlockId})</span>}
                    </span>
                  )}
                </div>
                {comment.baseParagraphText && (
                  <div className="p-1.5 bg-white rounded border border-slate-200 text-2xs font-mono text-slate-600 italic line-clamp-2">
                    提出时原句：“{comment.baseParagraphText}”
                  </div>
                )}
              </div>
            </div>

            {/* 2. Current Processing Target */}
            <div className="p-3.5 bg-slate-50/80 rounded-lg border border-slate-200 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <CornerDownRight className="w-3.5 h-3.5 text-purple-600" />
                <span>当前处理目标</span>
              </div>
              <div className="text-xs space-y-1 text-slate-600">
                <div>
                  当前工作稿：<span className="font-semibold text-slate-800">【{currentDraft?.versionNumber || currentDraft?.id || '当前稿件'}】</span>
                </div>
                <div>
                  目标段落：
                  {comment.type === 'overall' ? (
                    <span className="text-purple-700">由主笔在正文中指定或协调处理</span>
                  ) : isTargetBlockMissing ? (
                    <span className="text-amber-700 font-semibold">
                      原段落已删除或合并（定位不可用）
                    </span>
                  ) : comment.rebindRecord ? (
                    <span className="text-purple-700 font-semibold">
                      已重定位至第 {comment.currentBlockOrder || targetBlock?.order || comment.rebindRecord.toBlockOrder} 段
                    </span>
                  ) : (
                    <span className="font-semibold text-slate-800">
                      第 {targetBlock?.order || comment.targetBlockOrder || '?'} 段
                    </span>
                  )}
                </div>
                {comment.rebindRecord && (
                  <div className="p-1.5 bg-purple-50 rounded border border-purple-200 text-2xs text-purple-800">
                    重绑说明：原第{comment.rebindRecord.fromBlockOrder || comment.targetBlockOrder}段转第{comment.rebindRecord.toBlockOrder}段（操作人：{comment.rebindRecord.reboundBy}）
                  </div>
                )}
                {isTargetBlockMissing && (
                  <div className="p-1.5 bg-amber-50 rounded border border-amber-300 text-2xs text-amber-800">
                    需重新指定目标段落，系统严禁按数组下标匹配其他段落。
                  </div>
                )}
              </div>
            </div>

            {/* 3. Current Status & Reply */}
            <div className="p-3.5 bg-slate-50/80 rounded-lg border border-slate-200 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  当前处理状态
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-bold ${
                    comment.status === 'implemented'
                      ? 'bg-emerald-100 text-emerald-800'
                      : comment.status === 'accepted_pending_implementation'
                      ? 'bg-blue-100 text-blue-800'
                      : comment.status === 'rejected'
                      ? 'bg-slate-200 text-slate-700'
                      : comment.status === 'need_discussion'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                  data-testid="comment-audit-current-status"
                >
                  {getCommentStatusLabel(comment.status)}
                </span>
              </div>
              <div className="text-xs space-y-1 text-slate-600">
                {comment.implementationDraftId && (
                  <div>
                    落实版本：<span className="font-mono font-semibold text-emerald-700">{comment.implementationDraftId}</span>
                  </div>
                )}
                <div>
                  最新答复：
                  <span className="text-slate-800 font-medium">
                    {comment.authorReply || '（暂无主笔答复说明）'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Events Timeline Header */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-slate-900">处理履历事件链</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
                共 {events.length} 次操作
              </span>
            </div>
            {hasEvents && (
              <button
                type="button"
                onClick={handleToggleAll}
                className="text-xs font-medium text-blue-600 hover:text-blue-800 cursor-pointer flex items-center gap-1"
                data-testid="btn-toggle-all-events"
              >
                {allExpanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    <span>全部收起</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    <span>全部展开</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Missing / Legacy events notices */}
          {!hasEvents && (
            <div
              className="p-4 bg-slate-50 border border-dashed border-slate-300 rounded-lg text-center space-y-1 text-xs text-slate-600"
              data-testid="no-audit-events-notice"
            >
              <Info className="w-5 h-5 text-slate-400 mx-auto" />
              <div className="font-semibold text-slate-800">
                此前处理履历未完整记录
              </div>
              <p className="text-slate-500 max-w-md mx-auto">
                已完整保留已知当前状态、主笔答复与落实版本等信息。后续对本条意见的研判、重绑、落实或撤销操作将从本批开始持续按序追加记录。
              </p>
            </div>
          )}

          {/* Event List */}
          {hasEvents && (
            <div className="space-y-3" data-testid="audit-events-list">
              {events.map((ev, index) => {
                const isExpanded = expandedEventIds[ev.eventId] ?? true;
                const isImplement = ev.actionType === 'implement';
                const isUndo = ev.actionType === 'undo';
                const isRebind = ev.actionType === 'rebind';
                const isReject = ev.actionType === 'reject';
                const isAcceptPending = ev.actionType === 'accept_pending';
                const isDiscuss = ev.actionType === 'discuss';

                return (
                  <div
                    key={ev.eventId}
                    data-testid={`audit-event-${ev.eventId}`}
                    className={`rounded-lg border transition-all ${
                      isUndo
                        ? 'bg-amber-50/50 border-amber-300 border-dashed'
                        : isImplement
                        ? 'bg-emerald-50/40 border-emerald-300'
                        : isReject
                        ? 'bg-slate-50 border-slate-300'
                        : isRebind
                        ? 'bg-purple-50/40 border-purple-200'
                        : 'bg-white border-slate-200'
                    } shadow-2xs`}
                  >
                    {/* Event summary row */}
                    <div
                      onClick={() => toggleEventExpand(ev.eventId)}
                      className="p-3.5 flex items-center justify-between cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-3">
                        {/* Seq badge */}
                        <span className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 font-mono text-xs font-bold flex items-center justify-center shrink-0">
                          #{ev.seq}
                        </span>

                        {/* Action Badge */}
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-bold ${
                            isImplement
                              ? 'bg-emerald-600 text-white'
                              : isUndo
                              ? 'bg-amber-600 text-white'
                              : isReject
                              ? 'bg-slate-600 text-white'
                              : isAcceptPending
                              ? 'bg-blue-600 text-white'
                              : isDiscuss
                              ? 'bg-purple-600 text-white'
                              : 'bg-indigo-600 text-white'
                          }`}
                        >
                          {ev.actionLabel || getActionTypeLabel(ev.actionType)}
                        </span>

                        {/* Status transition */}
                        <div className="text-xs text-slate-600 flex items-center gap-1.5 font-medium">
                          <span>{getCommentStatusLabel(ev.beforeStatus)}</span>
                          <span className="text-slate-400">→</span>
                          <span className="font-bold text-slate-800">
                            {getCommentStatusLabel(ev.afterStatus)}
                          </span>
                        </div>

                        {/* Target Draft & Block */}
                        <span className="text-xs text-slate-500 font-mono hidden sm:inline">
                          稿件【{ev.draftVersionNumber || ev.draftId || '—'}】
                          {ev.targetBlockOrder ? ` · 第${ev.targetBlockOrder}段` : ''}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3 text-slate-400" />
                          <span>{ev.operatorName || ev.operatorRole}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{formatTime(ev.timestamp)}</span>
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-slate-400" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        )}
                      </div>
                    </div>

                    {/* Event Expanded Body */}
                    {isExpanded && (
                      <div className="px-3.5 pb-3.5 pt-1 border-t border-slate-100 space-y-2.5 text-xs">
                        {/* Event Notes / Author Reply */}
                        {(ev.notes || ev.authorReply || ev.decisionReason) && (
                          <div className="p-2.5 bg-white/90 rounded border border-slate-200 text-slate-700">
                            <span className="font-semibold text-slate-800">操作说明/答复理由：</span>
                            <span>{ev.notes || ev.authorReply || ev.decisionReason}</span>
                          </div>
                        )}

                        {/* Special Details for Text Implementation */}
                        {isImplement && (
                          <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200 space-y-2 text-emerald-900">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                正文实际写入存证（{ev.implementationLabel || '已写入正文'}）
                              </span>
                              <div className="flex items-center gap-2 font-mono text-2xs text-emerald-800">
                                {ev.modificationLogId && (
                                  <span>
                                    修改日志：{ev.modificationLogId}
                                    {!activeLogIds.has(ev.modificationLogId) && (
                                      <span className="text-slate-500 ml-1">（已按20条策略归档）</span>
                                    )}
                                  </span>
                                )}
                                {ev.blockId && <span>段落ID：{ev.blockId}</span>}
                              </div>
                            </div>

                            {/* Before and After Prose Diff Comparison */}
                            {(ev.beforeContent !== undefined || ev.afterContent !== undefined) && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1 font-sans text-xs">
                                <div className="p-2.5 bg-white rounded border border-rose-200 text-rose-900 space-y-1">
                                  <div className="font-bold text-rose-700 flex justify-between">
                                    <span>落实前正文</span>
                                    <span className="font-mono text-2xs text-rose-500">
                                      {ev.beforeContent?.length || 0} 字
                                    </span>
                                  </div>
                                  <p className="whitespace-pre-wrap leading-relaxed text-slate-700">
                                    {ev.beforeContent || '（空正文）'}
                                  </p>
                                </div>
                                <div className="p-2.5 bg-white rounded border border-emerald-300 text-emerald-950 space-y-1">
                                  <div className="font-bold text-emerald-700 flex justify-between">
                                    <span>实际落实正文</span>
                                    <span className="font-mono text-2xs text-emerald-600">
                                      {ev.afterContent?.length || 0} 字
                                    </span>
                                  </div>
                                  <p className="whitespace-pre-wrap leading-relaxed text-slate-800 font-medium">
                                    {ev.afterContent || '（空正文）'}
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Special Details for Safe Undo */}
                        {isUndo && (
                          <div className="p-3 bg-amber-50 rounded-lg border border-amber-300 space-y-1.5 text-amber-900">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold flex items-center gap-1 text-amber-800">
                                <RotateCcw className="w-3.5 h-3.5 text-amber-600" />
                                安全撤销凭据
                              </span>
                              {ev.undoneModificationLogId && (
                                <span className="font-mono text-2xs text-amber-800">
                                  被撤销修改日志：{ev.undoneModificationLogId}
                                </span>
                              )}
                            </div>
                            <div className="text-xs space-y-1">
                              <div>
                                关联被撤销落实事件：
                                <span className="font-mono font-semibold text-slate-800">
                                  {ev.undoneEventId ? `#${ev.undoneEventId}` : '最近落实操作'}
                                </span>
                              </div>
                              <div>
                                恢复结论：正文已精准恢复至修改前文本，意见恢复至【{getCommentStatusLabel(ev.afterStatus)}】状态。
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Special Details for Rebind */}
                        {isRebind && (
                          <div className="p-2.5 bg-purple-50 rounded border border-purple-200 text-purple-900 text-xs">
                            <span className="font-semibold">重绑目标段落：</span>
                            <span>已指定在第 {ev.targetBlockOrder || '?'} 段落实</span>
                            {ev.targetBlockId && <span className="font-mono text-purple-700 ml-1">({ev.targetBlockId})</span>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-slate-50 border-t border-slate-200 shrink-0 text-xs text-slate-500">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>只读存证：本履历用于溯源审计。状态修改与安全撤销请在正文工作区进行。</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-md text-xs font-semibold cursor-pointer transition-colors shadow-xs"
            data-testid="btn-close-audit-modal-footer"
          >
            关闭 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
