import React from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  X,
  ExternalLink,
  Lock,
  Tag,
  MessageSquare,
  BookOpen,
} from 'lucide-react';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  ReviewComment,
  ReviewCommentStatus,
  UserRole,
  RevisionSuggestion,
  RevisionAction,
  EvidenceSnippet,
  TaskStage,
  Fact,
} from '../types';
import { getReviewCommentLocation, interpretReviewCommentSuggestion } from '../services/reviewCoordinationService';
import { ParagraphSuggestionEditor } from './ParagraphSuggestionEditor';
import { MaterialEvidenceList } from './MaterialEvidenceList';

export interface DraftingInspectorContentProps {
  task: Task;
  currentDraft: DraftVersion | undefined;
  activeRole: UserRole;
  activeBlock: ParagraphBlock | undefined;
  activeSection?: { id: string; title: string };
  inspectorTab: 'ai_suggestions' | 'review_comments' | 'material_evidence';
  onSelectInspectorTab: (tab: 'ai_suggestions' | 'review_comments' | 'material_evidence') => void;
  isCurrentDraftImmutable: boolean;
  canUserEdit: boolean;
  activeReviewComments: ReviewComment[];
  selectedCommentId: string | null;
  onSelectCommentId: (id: string | null) => void;
  commentStatusFilter: 'all' | ReviewCommentStatus;
  onChangeCommentStatusFilter: (status: 'all' | ReviewCommentStatus) => void;
  commentReviewerFilter: 'all' | '审阅乙' | '审阅丁';
  onChangeCommentReviewerFilter: (reviewer: 'all' | '审阅乙' | '审阅丁') => void;
  inspectingFactId: string | null;
  onClearInspectingFactId: () => void;
  onViewSnippet: (snippet: EvidenceSnippet, fact?: Fact) => void;
  onSelectStage?: (stage: TaskStage) => void;
  onOpenContradictionModal: () => void;
  onOpenRebindModal: (comment: ReviewComment) => void;
  onOpenDirectImplementModal: (comment: ReviewComment) => void;
  onOpenRejectModal: (comment: ReviewComment) => void;
  onOpenDiscussModal: (comment: ReviewComment) => void;
  onAcceptCommentDecisionOnly: (comment: ReviewComment) => void;
  onGenerateRevisionFromComment: (comment: ReviewComment) => void;
  onJumpToTargetBlock: (blockId: string) => void;
  // Revision suggestion
  revisionSuggestion: RevisionSuggestion | null;
  isRevisionGenerating: boolean;
  revisionError: string | null;
  revisionTargetOrder?: number | null;
  customPromptInput: string;
  onChangeCustomPromptInput: (value: string) => void;
  onRequestRevision: (action: RevisionAction) => void;
  onRequestCustomRevision: (e: React.FormEvent) => void;
  onCancelRevision: () => void;
  onRetryRevision: () => void;
  onAdoptRevision: (pendingText?: string) => void;
  onDiscardRevision: () => void;
  onRegenerateRevision: () => void;
  copyFeedback: string | null;
  activeCompletedRunId: string | null;
  // Fine tuning persistence
  pendingFineTuneText?: string;
  onPendingFineTuneTextChange?: (text: string) => void;
  // Drawer mode & close handler
  isDrawer?: boolean;
  onClose: () => void;
  // Material Supplementation
  onOpenMaterialSupplement?: () => void;
}

export const DraftingInspectorContent: React.FC<DraftingInspectorContentProps> = ({
  task,
  currentDraft,
  activeRole,
  activeBlock,
  activeSection,
  inspectorTab,
  onSelectInspectorTab,
  isCurrentDraftImmutable,
  canUserEdit,
  activeReviewComments,
  selectedCommentId,
  onSelectCommentId,
  commentStatusFilter,
  onChangeCommentStatusFilter,
  commentReviewerFilter,
  onChangeCommentReviewerFilter,
  inspectingFactId,
  onClearInspectingFactId,
  onViewSnippet,
  onSelectStage,
  onOpenContradictionModal,
  onOpenRebindModal,
  onOpenDirectImplementModal,
  onOpenRejectModal,
  onOpenDiscussModal,
  onAcceptCommentDecisionOnly,
  onGenerateRevisionFromComment,
  onJumpToTargetBlock,
  revisionSuggestion,
  isRevisionGenerating,
  revisionError,
  revisionTargetOrder,
  customPromptInput,
  onChangeCustomPromptInput,
  onRequestRevision,
  onRequestCustomRevision,
  onCancelRevision,
  onRetryRevision,
  onAdoptRevision,
  onDiscardRevision,
  onRegenerateRevision,
  copyFeedback,
  activeCompletedRunId,
  pendingFineTuneText,
  onPendingFineTuneTextChange,
  isDrawer = false,
  onClose,
  onOpenMaterialSupplement,
}) => {
  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Header with Tabs and Close / Collapse toggle */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-200">
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium flex-1 mr-2 overflow-x-auto min-w-0 no-scrollbar">
          <button
            type="button"
            onClick={() => onSelectInspectorTab('ai_suggestions')}
            className={`flex-1 shrink-0 whitespace-nowrap px-2 py-1.5 rounded-md transition-colors cursor-pointer text-center text-sm font-semibold ${
              inspectorTab === 'ai_suggestions'
                ? 'bg-white text-blue-800 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="whitespace-nowrap">AI建议</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectInspectorTab('review_comments')}
            className={`flex-1 shrink-0 whitespace-nowrap px-2 py-1.5 rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1 text-center text-sm font-semibold ${
              inspectorTab === 'review_comments'
                ? 'bg-white text-blue-800 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="whitespace-nowrap">审阅意见</span>
            {activeReviewComments.filter(
              (c) => ['pending', 'accepted_pending_implementation', 'need_discussion'].includes(c.status)
            ).length > 0 && (
              <span className="bg-amber-100 text-amber-800 px-1 py-0.2 rounded-full text-xs font-bold shrink-0">
                {
                  activeReviewComments.filter(
                    (c) => ['pending', 'accepted_pending_implementation', 'need_discussion'].includes(c.status)
                  ).length
                }
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onSelectInspectorTab('material_evidence')}
            className={`flex-1 shrink-0 whitespace-nowrap px-2 py-1.5 rounded-md transition-colors cursor-pointer text-center text-sm font-semibold ${
              inspectorTab === 'material_evidence'
                ? 'bg-white text-blue-800 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="whitespace-nowrap">材料依据</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          data-testid={isDrawer ? 'btn-close-tablet-inspector' : undefined}
          className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer shrink-0"
          title={isDrawer ? '关闭辅助面板' : '折叠辅助面板'}
          aria-label={isDrawer ? '关闭辅助面板' : '折叠辅助面板'}
        >
          {isDrawer ? <X className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </button>
      </div>

      {/* Inspector Body */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {inspectorTab === 'review_comments' ? (
          <div className="space-y-3.5">
            {/* Review Comments Header & Conflict Banner */}
            <div className="flex items-center justify-between pb-1.5 border-b border-slate-100 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-slate-800">
                  {isCurrentDraftImmutable
                    ? currentDraft?.frozenReviewComments
                      ? '冻结审阅意见记录'
                      : '审阅意见记录（未记录冻结）'
                    : '全部审阅意见'}
                </span>
                <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded font-mono font-medium">
                  {activeReviewComments.length}
                </span>
              </div>
              {isCurrentDraftImmutable && (
                <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded">
                  历史只读版本
                </span>
              )}
              {!isCurrentDraftImmutable && onSelectStage && (
                <button
                  type="button"
                  onClick={() => onSelectStage('review')}
                  className="text-xs text-blue-700 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                >
                  <span>审阅全景视图</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Notice when historical draft lacks frozenReviewComments */}
            {isCurrentDraftImmutable && !currentDraft?.frozenReviewComments && (
              <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 space-y-1">
                <div className="flex items-center gap-1 font-bold text-amber-800">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>历史审阅意见未记录</span>
                </div>
                <p className="text-xs text-amber-800 leading-normal">
                  该历史快照未记录审阅意见（无法回溯当时意见），已严格隔离最新意见，避免历史失真。
                </p>
              </div>
            )}

            {/* Contradictory comments warning banner */}
            {!isCurrentDraftImmutable &&
              activeReviewComments.some(
                (c) =>
                  (c.id === 'CMT-01' || c.id === 'CMT-02') &&
                  (['pending', 'accepted_pending_implementation', 'need_discussion'].includes(c.status))
              ) && (
                <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 space-y-2">
                  <div className="flex items-center gap-1 font-bold text-amber-800">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>检测到相互矛盾的审阅篇幅要求！</span>
                  </div>
                  <p className="text-xs text-amber-800 leading-normal">
                    审阅乙提出“压缩到2000字以内”；审阅丁提出“增加两个详细案例”。
                  </p>
                  <button
                    type="button"
                    onClick={onOpenContradictionModal}
                    className="w-full py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-md text-sm font-semibold cursor-pointer"
                  >
                    主笔协调裁决此冲突
                  </button>
                </div>
              )}

            {/* In-Flight Revision Loading State with Cancel (Visible in Review Comments Tab too) */}
            {isRevisionGenerating && (
              <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg text-sm space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-blue-900 flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-blue-600 animate-spin" />
                    正在依据意见生成修改建议...
                  </span>
                  <button
                    type="button"
                    onClick={onCancelRevision}
                    className="text-sm text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 px-3 py-1 rounded-md cursor-pointer font-semibold"
                  >
                    取消生成
                  </button>
                </div>
                <p className="text-xs text-blue-700">
                  本地模拟生成中，现有正文内容保持不变。取消后不会改写正文。
                </p>
              </div>
            )}

            {/* Revision Error Banner with Retry */}
            {revisionError && (
              <div className="p-3.5 bg-rose-50 border border-rose-300 rounded-lg text-sm space-y-2">
                <div className="font-bold text-rose-900 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                  <span>生成失败</span>
                </div>
                <p className="text-xs text-rose-800">{revisionError}</p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={onRetryRevision}
                    className="px-3 py-1.5 bg-rose-700 hover:bg-rose-800 text-white rounded-md text-sm font-semibold cursor-pointer"
                  >
                    重试生成
                  </button>
                </div>
              </div>
            )}

            {/* Filter Controls */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <select
                value={commentStatusFilter}
                onChange={(e) => onChangeCommentStatusFilter(e.target.value as any)}
                className="border border-slate-300 rounded-md px-2 py-1.5 bg-white text-slate-700 text-xs font-medium"
              >
                <option value="all">全部状态 ({activeReviewComments.length})</option>
                <option value="pending">待处理 ({activeReviewComments.filter(c => c.status === 'pending').length})</option>
                <option value="accepted_pending_implementation">
                  决定采纳·待落实 ({activeReviewComments.filter((c) => c.status === 'accepted_pending_implementation').length})
                </option>
                <option value="implemented">
                  已落实 ({activeReviewComments.filter((c) => c.status === 'implemented').length})
                </option>
                <option value="need_discussion">
                  待沟通 ({activeReviewComments.filter((c) => c.status === 'need_discussion').length})
                </option>
                <option value="rejected">
                  已拒绝 ({activeReviewComments.filter((c) => c.status === 'rejected').length})
                </option>
              </select>

              <select
                value={commentReviewerFilter}
                onChange={(e) => onChangeCommentReviewerFilter(e.target.value as any)}
                className="border border-slate-300 rounded-md px-2 py-1.5 bg-white text-slate-700 text-xs font-medium"
              >
                <option value="all">全部审阅人</option>
                <option value="审阅乙">审阅乙</option>
                <option value="审阅丁">审阅丁</option>
              </select>
            </div>

            {/* Comment Cards List */}
            <div className="space-y-3">
              {activeReviewComments.length === 0 ? (
                <div className="p-4 text-center text-sm text-slate-400 italic bg-slate-50 rounded-lg border border-dashed border-slate-200">
                  {isCurrentDraftImmutable
                    ? '该历史快照未记录审阅意见或创建时无审阅记录'
                    : '当前暂无审阅意见'}
                </div>
              ) : (
                activeReviewComments
                  .filter((c) => {
                    if (c.id === selectedCommentId) return true;
                    if (commentStatusFilter !== 'all' && c.status !== commentStatusFilter) return false;
                    if (commentReviewerFilter !== 'all' && c.reviewer !== commentReviewerFilter) return false;
                    return true;
                  })
                  .map((cmt) => {
                    const loc = currentDraft
                      ? getReviewCommentLocation(cmt, currentDraft)
                      : { isLocated: false, isOutdatedVersion: false };
                    const isLocationOutdated = cmt.type === 'paragraph' && (!loc.isLocated || !loc.targetBlock || Boolean(loc.hasTextModified));
                    const isSelectedComment = selectedCommentId === cmt.id;

                    return (
                      <div
                        key={cmt.id}
                        id={`comment-card-${cmt.id}`}
                        onClick={() => {
                          onSelectCommentId(cmt.id);
                          if (cmt.type === 'paragraph' && loc.targetBlock) {
                            onJumpToTargetBlock(loc.targetBlock.id);
                          }
                        }}
                        className={`p-3.5 rounded-lg border text-sm space-y-2.5 transition-all cursor-pointer ${
                          isSelectedComment
                            ? 'bg-blue-50/70 border-blue-500 ring-2 ring-blue-200 shadow-xs'
                            : 'bg-slate-50 border-slate-200 hover:bg-slate-100/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-slate-900 text-sm">{cmt.reviewer}</span>
                            <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-medium">
                              {cmt.type === 'overall'
                                ? '全局意见'
                                : cmt.rebindRecord
                                ? `第${cmt.currentBlockOrder || loc.targetBlock?.order || '?'}段批注（重定位）`
                                : `第${cmt.targetBlockOrder || '?'}段批注`}
                            </span>
                            {loc.isOutdatedVersion && !isLocationOutdated && (
                              <span className="text-xs text-blue-700 font-mono">
                                基准: {cmt.targetVersionNumber || cmt.targetVersionId}
                              </span>
                            )}
                          </div>

                          <span
                            className={`text-xs px-2 py-0.5 rounded font-medium ${
                              cmt.status === 'implemented'
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                : cmt.status === 'accepted_pending_implementation'
                                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                : cmt.status === 'rejected'
                                ? 'bg-slate-200 text-slate-700'
                                : cmt.status === 'need_discussion'
                                ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                : 'bg-amber-100 text-amber-800 border border-amber-300'
                            }`}
                          >
                            {cmt.status === 'implemented'
                              ? '已落实'
                              : cmt.status === 'accepted_pending_implementation'
                              ? '决定采纳·待落实'
                              : cmt.status === 'rejected'
                              ? '已拒绝'
                              : cmt.status === 'need_discussion'
                              ? '待沟通'
                              : '待处理'}
                          </span>
                        </div>

                        {/* Scope and Source Details */}
                        <div className="p-2 bg-white/90 rounded border border-slate-200 text-xs text-slate-600 space-y-1">
                          <div className="flex items-center justify-between">
                            <span>意见来源：<strong className="text-slate-800">{cmt.reviewer}</strong></span>
                            <span className="text-slate-400 font-mono">{cmt.id}</span>
                          </div>
                          <div className="text-blue-900 font-medium">
                            {cmt.type === 'overall'
                              ? '修改范围：全局审阅意见（请在正文选择要修改的段落或章节）'
                              : loc.targetBlock
                              ? `修改范围：仅限第${loc.targetBlock.order}段（局部改写，不影响其他段落）`
                              : '修改范围：目标段落已缺失/删除，需先重新指定目标段落'}
                          </div>
                        </div>

                        <p className="text-sm text-slate-800 leading-relaxed font-medium">{cmt.content}</p>

                        {cmt.suggestedChange && (
                          <div className={`p-2 bg-white rounded border text-xs ${
                            interpretReviewCommentSuggestion(cmt).isReplacement
                              ? 'border-emerald-300 text-emerald-900'
                              : 'border-blue-200 text-blue-900'
                          }`}>
                            <span className={`font-semibold block ${
                              interpretReviewCommentSuggestion(cmt).isReplacement
                                ? 'text-emerald-700'
                                : 'text-blue-600'
                            }`}>
                              【{interpretReviewCommentSuggestion(cmt).typeLabel}】：
                            </span>
                            <span>{cmt.suggestedChange}</span>
                          </div>
                        )}

                        {/* Rebind audit trail display */}
                        {cmt.rebindRecord && (
                          <div className="text-xs text-purple-700 bg-purple-50 px-2.5 py-1.5 rounded border border-purple-200 flex items-center justify-between">
                            <span>
                              重新指定记录：已重定位至第{cmt.currentBlockOrder || loc.targetBlock?.order}段（原第{cmt.rebindRecord.fromBlockOrder || cmt.targetBlockOrder}段）
                            </span>
                            {canUserEdit && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenRebindModal(cmt);
                                }}
                                className="text-purple-800 hover:underline font-bold ml-1 cursor-pointer text-xs"
                              >
                                重改
                              </button>
                            )}
                          </div>
                        )}

                        {/* Location & Warning Section */}
                        {cmt.type === 'paragraph' && (
                          <>
                            {isLocationOutdated ? (
                              <div className="p-2.5 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 space-y-1.5">
                                <div className="flex items-center gap-1 font-bold text-amber-800">
                                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                                  <span>
                                    {!loc.targetBlock
                                      ? '定位需复核：原目标段落已在正文中删除或合并'
                                      : cmt.rebindRecord
                                      ? '定位需复核：当前重定位段落正文自重新指定后已有修改'
                                      : '定位需复核：当前段落正文自意见提出后已有修改'}
                                  </span>
                                </div>
                                {cmt.rebindRecord && typeof cmt.rebindRecord.reboundParagraphText === 'string' ? (
                                  <p className="text-purple-700 italic text-xs">
                                    {cmt.rebindRecord.reboundParagraphText === ''
                                      ? '重绑时段落为空'
                                      : `重指定时基准句：“${cmt.rebindRecord.reboundParagraphText.slice(0, 45)}...”`}
                                  </p>
                                ) : cmt.baseParagraphText ? (
                                  <p className="text-slate-600 italic text-xs">
                                    提出时原句：“{cmt.baseParagraphText.slice(0, 45)}...”
                                  </p>
                                ) : null}
                                {canUserEdit && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onOpenRebindModal(cmt);
                                    }}
                                    className="px-2.5 py-1 bg-white border border-amber-300 hover:bg-amber-100 rounded text-xs font-bold text-amber-900 cursor-pointer"
                                  >
                                    重新指定目标段落
                                  </button>
                                )}
                              </div>
                            ) : loc.targetBlock ? (
                              <div className="p-2 bg-white rounded border border-slate-200 text-xs text-slate-600 flex items-center justify-between">
                                <span className="truncate pr-1">
                                  对应第{loc.targetBlock.order}段：“{loc.targetBlock.content.slice(0, 24)}...”
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onJumpToTargetBlock(loc.targetBlock!.id);
                                  }}
                                  className="text-blue-700 hover:underline font-bold shrink-0 cursor-pointer text-sm"
                                >
                                  定位段落
                                </button>
                              </div>
                            ) : null}
                          </>
                        )}

                        {/* Author reply record */}
                        {cmt.authorReply && (
                          <div className="p-2 bg-emerald-50 rounded border border-emerald-200 text-xs text-emerald-900 space-y-1">
                            <div className="font-semibold flex items-center justify-between">
                              <span>主笔处理说明：</span>
                              {cmt.implementationDraftId && (
                                <span className="font-mono text-xs text-emerald-700">
                                  {cmt.implementationDraftId}
                                </span>
                              )}
                            </div>
                            <p>{cmt.authorReply}</p>
                          </div>
                        )}

                        {/* Action Buttons for Author */}
                        {!isCurrentDraftImmutable &&
                          canUserEdit &&
                          (['pending', 'accepted_pending_implementation', 'need_discussion'].includes(cmt.status)) && (
                            <div className="pt-2 border-t border-slate-200/70 flex flex-wrap justify-end gap-1.5 text-xs">
                              {cmt.type === 'overall' ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onGenerateRevisionFromComment(cmt);
                                  }}
                                  className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-800 text-white rounded-md text-sm font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                                  title={
                                    activeBlock
                                      ? `针对正文当前选中的第${activeBlock.order}段生成修改建议`
                                      : '请先在左侧正文中点击选中目标段落'
                                  }
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                  <span>
                                    {activeBlock
                                      ? `依据此意见改写第${activeBlock.order}段`
                                      : '选择段落后生成建议'}
                                  </span>
                                </button>
                              ) : loc.targetBlock ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onGenerateRevisionFromComment(cmt);
                                  }}
                                  className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded-md text-sm font-semibold flex items-center gap-1 cursor-pointer shadow-2xs"
                                  title={`在第${loc.targetBlock.order}段定位并生成AI修改建议`}
                                >
                                  <Sparkles className="w-3.5 h-3.5" />
                                  <span>依据此意见生成修改建议</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenRebindModal(cmt);
                                  }}
                                  className="px-3 py-1.5 bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 rounded-md text-sm font-semibold flex items-center gap-1 cursor-pointer"
                                  title="原目标段落已缺失，需先重新指定目标段落"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                                  <span>重新指定目标后改写</span>
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAcceptCommentDecisionOnly(cmt);
                                }}
                                className="px-3 py-1.5 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded-md text-sm font-medium cursor-pointer"
                                title="记录处理决定为【决定采纳，待落实】（不直接改写正文）"
                              >
                                决定采纳 (待落实)
                              </button>

                              {loc.targetBlock && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenDirectImplementModal(cmt);
                                  }}
                                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-md text-sm font-semibold cursor-pointer shadow-2xs"
                                  title="直接写入正文并生成新工作稿"
                                >
                                  直接落实修改
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenRejectModal(cmt);
                                }}
                                className="px-2.5 py-1.5 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded-md text-sm font-medium cursor-pointer"
                              >
                                拒绝并说明
                              </button>

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenDiscussModal(cmt);
                                }}
                                className="px-2.5 py-1.5 text-purple-700 hover:bg-purple-50 border border-purple-200 rounded-md text-sm font-medium cursor-pointer"
                              >
                                待沟通
                              </button>
                            </div>
                          )}

                        {isCurrentDraftImmutable && (
                          <div className="pt-2 border-t border-slate-200/70 text-xs text-slate-400 italic flex items-center gap-1">
                            <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>当前处于只读快照版本，不可直接修改。请返回工作稿后再行落实。</span>
                          </div>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        ) : activeBlock ? (
          <div className="space-y-4">
            {/* Paragraph Context Card */}
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/80 text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800 text-sm">
                  章节：{activeSection?.title || '正文'}
                </span>
                <span className="font-mono text-blue-700 font-bold text-sm">
                  第{activeBlock.order}段
                </span>
              </div>
              <div className="text-xs text-slate-500 line-clamp-2">
                摘要：“{activeBlock.content.slice(0, 50)}...”
              </div>
              <div className="pt-1.5 border-t border-slate-200/50 text-xs text-slate-500 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-slate-400" />
                <span>操作范围：仅限第{activeBlock.order}段（局部改写，不影响其他段落）</span>
              </div>
            </div>

            {/* TAB 1: AI 修改建议 */}
            {inspectorTab === 'ai_suggestions' && (
              <div className="space-y-4">
                {/* Task 20: 依据材料补写专属入口 */}
                <div className="p-3 bg-teal-50/80 rounded-lg border border-teal-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-teal-900 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-teal-700" />
                      <span>指定材料驱动的段落补写</span>
                    </span>
                    <span className="text-xs text-teal-700 font-mono">
                      仅限第{activeBlock.order}段
                    </span>
                  </div>
                  <p className="text-xs text-teal-800 leading-normal">
                    明确勾选本期有效材料原文与核准事实，由主笔设定要求生成真实可溯源的段落补写候选。
                  </p>
                  <button
                    type="button"
                    data-testid="btn-open-material-supplement"
                    onClick={onOpenMaterialSupplement}
                    disabled={isRevisionGenerating || isCurrentDraftImmutable}
                    className="w-full py-2 px-3 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-md text-sm font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed shadow-2xs transition-colors"
                  >
                    <BookOpen className="w-4 h-4" />
                    <span>依据材料补写第 {activeBlock.order} 段</span>
                  </button>
                </div>

                {/* Shortcut Revision Operations */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-700 block">快捷精修操作：</span>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => onRequestRevision('compress')}
                      disabled={isRevisionGenerating}
                      className="px-3 py-2 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded-lg text-center transition-colors cursor-pointer text-sm font-semibold disabled:opacity-50"
                      title="精简文字，突出关键信息"
                    >
                      压缩精炼
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestRevision('expand')}
                      disabled={isRevisionGenerating}
                      className="px-3 py-2 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded-lg text-center transition-colors cursor-pointer text-sm font-semibold disabled:opacity-50"
                      title="丰富论据，补充细节支撑"
                    >
                      补充表达
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestRevision('formal')}
                      disabled={isRevisionGenerating}
                      className="px-3 py-2 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded-lg text-center transition-colors cursor-pointer text-sm font-semibold disabled:opacity-50"
                      title="规范公文用语，提升权威严谨度"
                    >
                      正式文风
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestRevision('highlight')}
                      disabled={isRevisionGenerating}
                      className="px-3 py-2 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded-lg text-center transition-colors cursor-pointer text-sm font-semibold disabled:opacity-50"
                      title="强化核心成效与数据指标"
                    >
                      突出重点
                    </button>
                  </div>
                </div>

                {/* Custom Revision Form */}
                <form onSubmit={onRequestCustomRevision} className="space-y-2 pt-2 border-t border-slate-100">
                  <label className="text-xs font-bold text-slate-700 block">我想怎样修改这一段：</label>
                  <textarea
                    rows={2}
                    value={customPromptInput}
                    onChange={(e) => onChangeCustomPromptInput(e.target.value)}
                    placeholder="例如：精简表达并保留数据、改成面向单位负责人的汇报口吻..."
                    className="w-full p-2.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                  />

                  {/* Example Instruction Badges */}
                  <div className="space-y-1">
                    <span className="text-xs text-slate-400">示例指令：</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => onChangeCustomPromptInput('精简表达并保留数据')}
                        className="text-xs bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2.5 py-1 rounded-md border border-slate-200 cursor-pointer transition-colors"
                      >
                        精简表达并保留数据
                      </button>
                      <button
                        type="button"
                        onClick={() => onChangeCustomPromptInput('改成面向单位负责人的汇报口吻')}
                        className="text-xs bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2.5 py-1 rounded-md border border-slate-200 cursor-pointer transition-colors"
                      >
                        改成面向单位负责人的汇报口吻
                      </button>
                      <button
                        type="button"
                        onClick={() => onChangeCustomPromptInput('突出成效并删减泛泛修饰')}
                        className="text-xs bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2.5 py-1 rounded-md border border-slate-200 cursor-pointer transition-colors"
                      >
                        突出成效并删减泛泛修饰
                      </button>
                    </div>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={isRevisionGenerating || !customPromptInput.trim()}
                      className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded-md text-sm font-semibold shadow-2xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>生成建议</span>
                    </button>
                  </div>
                </form>

                {/* Loading State with Cancel */}
                {isRevisionGenerating && (
                  <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg text-sm space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-blue-900 flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-blue-600 animate-spin" />
                        正在为第 {revisionTargetOrder || activeBlock.order} 段生成修改建议...
                      </span>
                      <button
                        type="button"
                        onClick={onCancelRevision}
                        className="text-sm text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 px-3 py-1 rounded-md cursor-pointer font-semibold"
                      >
                        取消生成
                      </button>
                    </div>
                    <p className="text-xs text-blue-700">
                      本地模拟生成中，现有正文内容保持不变。取消后不会改写正文。
                    </p>
                  </div>
                )}

                {/* Failure / Error State with Retry */}
                {revisionError && (
                  <div className="p-3.5 bg-rose-50 border border-rose-300 rounded-lg text-sm space-y-2">
                    <div className="font-bold text-rose-900 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-rose-600" />
                      <span>生成失败</span>
                    </div>
                    <p className="text-xs text-rose-800">{revisionError}</p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={onRetryRevision}
                        className="px-3 py-1.5 bg-rose-700 hover:bg-rose-800 text-white rounded-md text-sm font-semibold cursor-pointer"
                      >
                        重试生成
                      </button>
                    </div>
                  </div>
                )}

                {/* Copy toast feedback */}
                {copyFeedback && (
                  <div className="p-2.5 bg-emerald-50 border border-emerald-300 rounded-lg text-xs text-emerald-800 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>{copyFeedback}</span>
                  </div>
                )}

                {/* Revision Diff Comparison & Fine-tuning Editor */}
                {revisionSuggestion && (
                  <ParagraphSuggestionEditor
                    task={task}
                    currentDraft={currentDraft}
                    suggestion={revisionSuggestion}
                    activeRole={activeRole}
                    activeBlock={activeBlock}
                    activeCompletedRunId={activeCompletedRunId}
                    isGenerating={isRevisionGenerating}
                    onAdopt={onAdoptRevision}
                    onDiscard={onDiscardRevision}
                    onRegenerate={onRegenerateRevision}
                    onJumpToTargetBlock={onJumpToTargetBlock}
                    pendingText={pendingFineTuneText}
                    onPendingTextChange={onPendingFineTuneTextChange}
                  />
                )}
              </div>
            )}

            {/* TAB 2: 材料依据 */}
            {inspectorTab === 'material_evidence' && (
              <div className="space-y-3">
                <div className="pb-2 border-b border-slate-200 flex justify-end">
                  <button
                    type="button"
                    data-testid="btn-open-material-supplement-from-evidence"
                    onClick={onOpenMaterialSupplement}
                    disabled={isRevisionGenerating || isCurrentDraftImmutable}
                    className="w-full py-2 px-3 bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white rounded-md text-sm font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed shadow-2xs transition-colors"
                  >
                    <BookOpen className="w-4 h-4" />
                    <span>依据材料补写第 {activeBlock.order} 段</span>
                  </button>
                </div>
                <MaterialEvidenceList
                  task={task}
                  currentDraft={currentDraft}
                  activeBlock={activeBlock}
                  isCurrentDraftImmutable={isCurrentDraftImmutable}
                  inspectingFactId={inspectingFactId}
                  onClearInspectingFactId={onClearInspectingFactId}
                  onViewSnippet={onViewSnippet}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="py-12 text-center text-sm text-slate-400">
            点击正文段落查看其依据与AI建议
          </div>
        )}
      </div>
    </div>
  );
};
