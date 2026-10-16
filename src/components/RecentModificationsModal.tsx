import React, { useMemo } from 'react';
import { Task, DraftVersion, UserRole, ParagraphModificationLog } from '../types';
import {
  validateUndoEligibility,
  getRecentModificationLogs
} from '../services/draftLifecycleService';
import {
  History,
  RotateCcw,
  CheckCircle2,
  XCircle,
  X,
  Sparkles,
  Sliders,
  MessageSquare,
  AlertCircle,
  Clock,
  ArrowRight
} from 'lucide-react';

interface RecentModificationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  currentDraft: DraftVersion | undefined;
  activeRole: UserRole;
  onUndo: (logId: string) => void;
}

export const RecentModificationsModal: React.FC<RecentModificationsModalProps> = ({
  isOpen,
  onClose,
  task,
  currentDraft,
  activeRole,
  onUndo,
}) => {
  if (!isOpen) return null;

  const isCurrentDraftImmutable = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal);

  // Filter logs strictly for currentDraft to prevent showing other drafts' local records
  const currentDraftLogs: ParagraphModificationLog[] = useMemo(() => {
    if (!currentDraft) return [];
    return getRecentModificationLogs(task, currentDraft.id);
  }, [task.modificationLogs, currentDraft?.id]);

  return (
    <div
      data-testid="recent-modifications-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700">
              <History className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <span>最近修改记录</span>
                <span className="text-xs font-normal text-slate-500 bg-slate-200 px-2 py-0.5 rounded">
                  保留最近 {currentDraftLogs.length} 条
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                记录局部段落建议采纳、人工微调与审阅落实；支持安全局部撤销（与版本历史独立保存）
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="btn-close-modifications-modal"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-200 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Notice for Immutable/Historical drafts */}
        {isCurrentDraftImmutable && (
          <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              当前查看的是历史快照或已定稿版本，正文处于只读冻结状态，不支持写入或撤销操作。
            </span>
          </div>
        )}

        {/* Body list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {currentDraftLogs.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-xs">
              <History className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <p>当前稿件暂无局部采纳或修改记录</p>
              <p className="text-xs text-slate-400 mt-1">
                当您采纳AI修改建议或微调段落后，此处将如实记录操作存证
              </p>
            </div>
          ) : (
            currentDraftLogs.map((log) => {
              const validation = validateUndoEligibility(task, currentDraft, log.id, activeRole);
              const canUndo = validation.canUndo;
              const disabledReason = validation.reason || '';

              const timeStr = new Date(log.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <div
                  key={log.id}
                  data-testid={`modification-log-card-${log.id}`}
                  className={`p-3.5 rounded-lg border text-xs transition-colors ${
                    log.status === 'undone'
                      ? 'bg-slate-50 border-slate-200 opacity-75'
                      : 'bg-white border-blue-200 shadow-2xs hover:border-blue-300'
                  }`}
                >
                  {/* Top info row */}
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 flex items-center gap-1">
                        第 {log.blockOrder} 段
                      </span>
                      {log.isFineTuned ? (
                        <span className="bg-amber-100 text-amber-900 border border-amber-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5">
                          <Sliders className="w-2.5 h-2.5 text-amber-700" />
                          人工微调采纳
                        </span>
                      ) : (
                        <span className="bg-blue-100 text-blue-800 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5">
                          <Sparkles className="w-2.5 h-2.5 text-blue-600" />
                          AI建议采纳
                        </span>
                      )}
                      <span className="text-slate-400 text-xs flex items-center gap-0.5">
                        <Clock className="w-3 h-3 text-slate-300" />
                        {timeStr}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {log.status === 'applied' ? (
                        <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs px-2 py-0.5 rounded-full font-bold flex items-center gap-0.5">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          已应用
                        </span>
                      ) : (
                        <span className="bg-slate-100 text-slate-600 border border-slate-300 text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-0.5">
                          <RotateCcw className="w-3 h-3 text-slate-500" />
                          已撤销
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Associated comment context */}
                  {log.associatedCommentId && (
                    <div className="mt-2 text-xs text-blue-900 bg-blue-50/70 p-2 rounded border border-blue-100 flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3 text-blue-600" />
                        关联【{log.associatedCommentReviewer || '审阅人'}】意见：{log.associatedCommentId}
                      </span>
                      <span className="text-xs text-blue-700">落实闭环</span>
                    </div>
                  )}

                  {/* Snippet Before and After */}
                  <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 text-slate-600">
                      <span className="font-bold text-slate-500 block mb-0.5">修改前：</span>
                      <p className="line-clamp-2 font-serif">{log.beforeContent}</p>
                    </div>
                    <div className="p-2 bg-blue-50/50 rounded border border-blue-200 text-slate-900">
                      <span className="font-bold text-blue-900 block mb-0.5">
                        {log.isFineTuned ? '实际采纳（人工微调）：' : '实际采纳：'}
                      </span>
                      <p className="line-clamp-2 font-serif">{log.afterContent}</p>
                    </div>
                  </div>

                  {/* Undone note if undone */}
                  {log.status === 'undone' && (
                    <div className="mt-2 p-1.5 bg-slate-100 rounded text-xs text-slate-600 flex items-center justify-between">
                      <span>撤销记录：{log.undoReason || '主笔已撤销本次修改'}</span>
                      <span className="text-xs text-slate-400">
                        {log.undoneAt ? new Date(log.undoneAt).toLocaleTimeString('zh-CN') : ''}
                      </span>
                    </div>
                  )}

                  {/* Action row */}
                  {log.status === 'applied' && !isCurrentDraftImmutable && (
                    <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-xs text-slate-400 font-mono">
                        操作ID: {log.id}
                      </span>
                      <div className="flex items-center gap-2">
                        {!canUndo && (
                          <span
                            data-testid={`undo-disabled-reason-${log.id}`}
                            className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200"
                          >
                            {disabledReason}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid={`btn-undo-log-${log.id}`}
                          onClick={() => onUndo(log.id)}
                          disabled={!canUndo}
                          className={`px-3 py-1 rounded text-xs font-bold flex items-center gap-1 transition-colors ${
                            canUndo
                              ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 cursor-pointer'
                              : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                          }`}
                          title={disabledReason || '安全撤销本次修改并恢复原正文'}
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>撤销本次修改</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>
            撤销规则：仅限当前工作稿最近一次未变动的局部采纳操作；后续修改或定稿将自动保护锁定。
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-xs font-medium cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
