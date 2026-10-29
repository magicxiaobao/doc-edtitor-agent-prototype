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
  ArrowRight,
  FileText
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

  const isCurrentDraftImmutable = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal);

  // Filter logs strictly for currentDraft to prevent showing other drafts' local records
  const currentDraftLogs: ParagraphModificationLog[] = useMemo(() => {
    if (!currentDraft) return [];
    return getRecentModificationLogs(task, currentDraft.id);
  }, [task.modificationLogs, currentDraft?.id]);

  if (!isOpen) return null;

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
                记录建议采纳、人工微调、审阅落实与事实修订；事实修订须整体恢复正文与依据。
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
              const affected = Array.isArray(log.affectedBlocks) && log.affectedBlocks.every(item => item &&
                typeof item.blockId === 'string' && typeof item.beforeContent === 'string' &&
                typeof item.afterContent === 'string' &&
                (item.sectionTitle === undefined || typeof item.sectionTitle === 'string') &&
                (item.blockOrder === undefined || typeof item.blockOrder === 'number'))
                ? log.affectedBlocks : [];
              const isGroup = affected.length > 1;
              const factsValid = Array.isArray(log.affectedFacts) && log.affectedFacts.every(fact => fact &&
                ['factId', 'metric', 'unit', 'fromValue', 'toValue'].every(key =>
                  typeof (fact as unknown as Record<string, unknown>)[key] === 'string') &&
                ['period', 'fromEvidenceId', 'fromDocName', 'fromLocation', 'toEvidenceId', 'toDocName', 'toLocation'].every(key => {
                  const value = (fact as unknown as Record<string, unknown>)[key];
                  return value === undefined || typeof value === 'string';
                }) && (fact.referencingBlockIds === undefined ||
                  (Array.isArray(fact.referencingBlockIds) && fact.referencingBlockIds.every(id => typeof id === 'string'))));
              const affectedFacts = factsValid ? log.affectedFacts! : [];
              const isMultiFactGroup = affectedFacts.length > 1;
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
                        {isMultiFactGroup
                          ? `成组修订 · ${affectedFacts.length}项事实、${affected.length || (log.affectedBlockIds || []).length}段`
                          : isGroup
                          ? `整体修订 · 共${affected.length}段`
                          : `第 ${log.blockOrder} 段`}
                      </span>
                      {log.source === 'fact_change_revision' ? (
                        <span data-testid={`badge-log-source-${log.id}`} className="bg-indigo-50 text-indigo-900 border border-indigo-200 px-1.5 rounded">
                          {isMultiFactGroup ? '两项事实成组修订' : isGroup ? '多段落事实修订' : '事实定向修订'}
                        </span>
                      ) : log.source === 'material_supplementation_fine_tuned' || (log.isMaterialSupplementation && log.isFineTuned) ? (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-teal-100 text-teal-900 border border-teal-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
                          <Sliders className="w-2.5 h-2.5 text-teal-700" />
                          材料补写微调采纳
                        </span>
                      ) : log.source === 'material_supplementation' || (log.isMaterialSupplementation && !log.isFineTuned) ? (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-teal-100 text-teal-900 border border-teal-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
                          <FileText className="w-2.5 h-2.5 text-teal-700" />
                          材料补写采纳
                        </span>
                      ) : log.source === 'reviewer_replacement' || (log.isReviewerReplacement && !log.isFineTuned) ? (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-purple-100 text-purple-900 border border-purple-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
                          <CheckCircle2 className="w-2.5 h-2.5 text-purple-700" />
                          审阅替换稿采纳
                        </span>
                      ) : log.source === 'reviewer_replacement_fine_tuned' || (log.isReviewerReplacement && log.isFineTuned) ? (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-indigo-100 text-indigo-900 border border-indigo-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
                          <Sliders className="w-2.5 h-2.5 text-indigo-700" />
                          审阅替换稿微调采纳
                        </span>
                      ) : log.source === 'review_implementation' ? (
                        <span data-testid={`badge-log-source-${log.id}`} className="text-xs bg-emerald-100 px-2 rounded">审阅意见落实</span>
                      ) : log.isFineTuned ? (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-amber-100 text-amber-900 border border-amber-300 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
                          <Sliders className="w-2.5 h-2.5 text-amber-700" />
                          人工微调采纳
                        </span>
                      ) : (
                        <span
                          data-testid={`badge-log-source-${log.id}`}
                          className="bg-blue-100 text-blue-800 text-xs px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5"
                        >
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
                  {log.source === 'fact_change_revision' && (
                    <p className="mt-2 p-2 rounded bg-indigo-50 text-indigo-950 whitespace-pre-wrap break-words">{log.sourceDescription}</p>
                  )}
                  {log.affectedFacts !== undefined && !factsValid && <p role="status" className="mt-2 text-amber-900">
                    事实留痕明细格式不完整，原数据已保留；请结合汇总和段落明细人工核实。
                  </p>}
                  {affectedFacts.length > 0 && (
                    <div className="mt-2.5 p-2.5 rounded bg-sky-50/70 border border-sky-200 text-xs space-y-2">
                      <div className="font-semibold text-sky-950 flex items-center justify-between">
                        <span>两项事实前后数值与出处留痕明细（共 {affectedFacts.length} 项事实）：</span>
                        <span className="text-2xs text-sky-700 font-normal">原子绑定最新核准快照</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {affectedFacts.map((fact) => (
                          <div
                            key={fact.factId}
                            data-testid={`log-affected-fact-${fact.factId}`}
                            className="p-2 bg-white rounded border border-sky-200 space-y-1 shadow-2xs"
                          >
                            <div className="font-bold text-slate-800 flex items-center justify-between">
                              <span>【{fact.metric}】</span>
                              <span className="text-2xs font-mono text-slate-400">[{fact.factId}]</span>
                            </div>
                            <div className="text-xs">
                              <span className="text-slate-500 line-through mr-1 font-mono">
                                {fact.fromValue}{fact.unit}
                              </span>
                              <span className="text-sky-700 font-mono font-bold">
                                → {fact.toValue}{fact.unit}
                              </span>
                              {fact.period && <span className="text-2xs text-slate-500 ml-1.5">（期间：{fact.period}）</span>}
                            </div>
                            <div className="text-2xs text-slate-600 space-y-0.5">
                              <div>
                                旧依据：{fact.fromDocName || '未记录'}（{fact.fromLocation || '未记录'}）
                              </div>
                              <div>
                                新依据：<span className="text-sky-800 font-medium">{fact.toDocName || '最新出处'}（{fact.toLocation || '最新定位'}）</span>
                              </div>
                              {fact.referencingBlockIds && fact.referencingBlockIds.length > 0 && (
                                <div className="text-slate-400">
                                  关联段落：{fact.referencingBlockIds.join(', ')}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(isGroup || (isMultiFactGroup && affected.length > 0)) && (
                    <details className="mt-2 rounded border border-indigo-200 p-2">
                      <summary className="cursor-pointer font-semibold text-indigo-900">查看全部{affected.length}段修订明细</summary>
                      {affected.map(item => (
                        <div key={item.blockId} data-testid={`log-affected-block-${item.blockId}`} className="mt-3 space-y-2 border-t border-indigo-100 pt-2">
                          <p className="font-semibold">第{item.blockOrder}段 · {item.sectionTitle} [{item.blockId}]</p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <div className="rounded bg-slate-50 p-2"><strong>修改前完整正文：</strong><p className="font-serif whitespace-pre-wrap break-words">{item.beforeContent}</p></div>
                            <div className="rounded bg-blue-50 p-2"><strong>采纳后完整正文：</strong><p className="font-serif whitespace-pre-wrap break-words">{item.afterContent}</p></div>
                          </div>
                        </div>
                      ))}
                    </details>
                  )}
                  {log.affectedBlocks !== undefined && !affected.length && (
                    <p className="mt-2 text-amber-900">部分逐段明细格式不完整，保留以下汇总供人工核实。</p>
                  )}
                  <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-slate-50 rounded border border-slate-200 text-slate-600">
                      <span className="font-bold text-slate-500 block mb-0.5">修改前：</span>
                      <p className="line-clamp-2 font-serif">{log.beforeContent}</p>
                    </div>
                    <div className="p-2 bg-blue-50/50 rounded border border-blue-200 text-slate-900">
                      <span className="font-bold text-blue-900 block mb-0.5">
                        {log.isMaterialSupplementation
                          ? log.isFineTuned
                            ? '实际采纳（材料补写微调）：'
                            : '实际采纳（材料补写）：'
                          : log.isReviewerReplacement
                          ? log.isFineTuned
                            ? '实际采纳（审阅替换稿微调）：'
                            : '实际采纳（审阅替换稿）：'
                          : log.isFineTuned
                          ? '实际采纳（人工微调）：'
                          : '实际采纳：'}
                      </span>
                      <p className="line-clamp-2 font-serif">{log.afterContent}</p>
                    </div>
                  </div>

                  {/* If reviewer replacement was fine-tuned, also preserve the reviewer's original replacement text */}
                  {log.isReviewerReplacement && log.isFineTuned && log.reviewerOriginalReplacementText && (
                    <div className="mt-1.5 p-2 bg-purple-50/60 rounded border border-purple-200 text-purple-950 text-xs">
                      <span className="font-bold text-purple-900 block mb-0.5">审阅人原始替换正文（已妥善存证）：</span>
                      <p className="line-clamp-2 font-serif text-slate-700">{log.reviewerOriginalReplacementText}</p>
                    </div>
                  )}

                  {/* If material supplementation, display adopted evidences record */}
                  {log.isMaterialSupplementation && log.adoptedEvidences && log.adoptedEvidences.length > 0 && (
                    <div className="mt-1.5 p-2 bg-teal-50/60 rounded border border-teal-200 text-teal-950 text-xs space-y-1">
                      <span className="font-bold text-teal-900 block mb-0.5">本次采纳采用的材料依据存证：</span>
                      {log.adoptedEvidences.map((ev, evIdx) => (
                        <div key={evIdx} className="text-xs text-teal-800 flex items-center justify-between gap-1">
                          <span className="truncate">【{ev.sourceDocName}】“{ev.snippetText}”</span>
                          <span className="text-teal-600 shrink-0 font-mono text-xs">{ev.period}</span>
                        </div>
                      ))}
                    </div>
                  )}

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
            局部撤销仅适用于未变动的局部采纳；事实修订请通过版本历史整体恢复正文与依据。
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
