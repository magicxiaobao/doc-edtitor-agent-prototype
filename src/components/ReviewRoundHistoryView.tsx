import React, { useState, useEffect } from 'react';
import {
  Task,
  DraftVersion,
  UserRole,
  ReviewComment,
  ReviewCommentStatus,
  EvidenceSnippet,
  Fact,
  AdoptedEvidenceRecord,
} from '../types';
import {
  getFormalReviewBaselines,
  getRoundDisplayName,
  getBaselineAttributedComments,
  getUnattributedReviewComments,
} from '../services/reviewRoundHistoryService';
import { RevisionReviewHandoffCard } from './RevisionReviewHandoffCard';
import {
  History,
  ArrowLeft,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Info,
  MapPin,
  FileText,
  CornerDownRight,
  ShieldAlert,
} from 'lucide-react';

export interface ReviewRoundHistoryViewProps {
  task: Task;
  currentDraft?: DraftVersion;
  activeRole: UserRole;
  onExitHistory: () => void;
  onViewSnippet?: (
    snippet: EvidenceSnippet,
    fact?: Fact,
    adoptedEvidence?: AdoptedEvidenceRecord,
    freezeDraftEvidence?: boolean,
    contextDraft?: DraftVersion
  ) => void;
}

export const ReviewRoundHistoryView: React.FC<ReviewRoundHistoryViewProps> = ({
  task,
  currentDraft,
  activeRole,
  onExitHistory,
  onViewSnippet,
}) => {
  const formalBaselines = getFormalReviewBaselines(task, currentDraft);

  // Initialize selected baseline to current review baseline if available, or latest formal baseline
  const [selectedBaselineId, setSelectedBaselineId] = useState<string>(() => {
    if (task.reviewBaseDraftId && formalBaselines.some((b) => b.id === task.reviewBaseDraftId)) {
      return task.reviewBaseDraftId;
    }
    return formalBaselines[formalBaselines.length - 1]?.id || '';
  });

  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);
  const [commentFilter, setCommentFilter] = useState<'all' | ReviewCommentStatus>('all');
  const [reviewerFilter, setReviewerFilter] = useState<'all' | '审阅乙' | '审阅丁'>('all');

  // Reset highlight & ensure valid selection when task, role, currentDraft or baselines change
  useEffect(() => {
    setHighlightedBlockId(null);
    if (!formalBaselines.some((b) => b.id === selectedBaselineId)) {
      const fallbackId = formalBaselines[formalBaselines.length - 1]?.id || '';
      setSelectedBaselineId(fallbackId);
    }
  }, [task.id, task.currentDraftId, activeRole, formalBaselines.length]);

  // Keyboard Escape listener to return to the active review workspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onExitHistory();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExitHistory]);

  const selectedBaseline = formalBaselines.find((b) => b.id === selectedBaselineId) || formalBaselines[0];

  // Resolve source working draft for metadata display
  const sourceDraft = selectedBaseline?.sourceDraftId
    ? task.drafts.find((d) => d.id === selectedBaseline.sourceDraftId)
    : undefined;

  // Comments originally attributed to the selected baseline
  const baselineComments = selectedBaseline
    ? getBaselineAttributedComments(task, selectedBaseline.id)
    : [];

  // Filtered comments
  const filteredComments = baselineComments.filter((c) => {
    if (commentFilter !== 'all' && c.status !== commentFilter) return false;
    if (reviewerFilter !== 'all' && c.reviewer !== reviewerFilter) return false;
    return true;
  });

  // Unattributed / non-formal comments
  const unattributedComments = getUnattributedReviewComments(task, formalBaselines);

  // Handle locating a paragraph in the historical baseline document
  const handleLocateHistoricalBlock = (blockId: string) => {
    if (!selectedBaseline) return;
    const blockExists = selectedBaseline.blocks.some((b) => b.id === blockId);
    if (!blockExists) {
      alert(`所选送审基准【${selectedBaseline.versionNumber}】中未找到段落【${blockId}】（可能在送审前正文中已删除或不存在）`);
      return;
    }
    setHighlightedBlockId(blockId);
    const el = document.getElementById(`history-baseline-block-${blockId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => {
      setHighlightedBlockId((prev) => (prev === blockId ? null : prev));
    }, 3000);
  };

  return (
    <div data-testid="review-round-history-view" className="space-y-6">
      {/* Top Banner & Return Navigation */}
      <div className="bg-slate-900 text-white p-5 rounded-lg border border-slate-800 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-bold text-white">
              阶段05：审阅轮次回看与意见归属（只读）
            </h2>
            <span className="text-xs bg-slate-800 text-blue-300 border border-slate-700 px-2 py-0.5 rounded font-mono">
              只读回看模式
            </span>
          </div>
          <p className="text-xs text-slate-300 mt-1">
            查阅历次正式送审时冻结的文稿正文、事实依据交接摘要，以及原始归属于各轮次的审阅意见当前处理状态。此视图为纯只读，不影响当前活动审阅工作区。
          </p>
        </div>

        <div>
          <button
            type="button"
            onClick={onExitHistory}
            data-testid="btn-exit-round-history"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回当前审阅工作区</span>
          </button>
        </div>
      </div>

      {/* Empty State: No Formal Baselines */}
      {formalBaselines.length === 0 ? (
        <div
          data-testid="no-formal-baselines-notice"
          className="bg-white border border-slate-200 p-8 rounded-lg shadow-2xs text-center space-y-3"
        >
          <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-500 mx-auto flex items-center justify-center">
            <Info className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-sm text-slate-800">当前工作稿尚未产生正式送审基准快照</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            只有在正文起草阶段完成事实修订核对并正式点击“提交本轮审阅”后，系统才会生成不可篡改的送审基准快照。当前稿件尚无正式送审历史可供回看。
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onExitHistory}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded text-xs font-semibold cursor-pointer"
            >
              返回当前审阅工作区
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Baseline Tabs Selection */}
          <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-2xs space-y-2">
            <div className="text-xs font-semibold text-slate-700 flex items-center justify-between">
              <span>选择需要回看的正式送审基准：</span>
              <span className="text-2xs text-slate-400">共 {formalBaselines.length} 个正式送审轮次基准</span>
            </div>
            <div className="flex flex-wrap items-center gap-2" role="tablist">
              {formalBaselines.map((baseline) => {
                const isSelected = baseline.id === selectedBaseline?.id;
                const isCurrentLiveBase = baseline.id === task.reviewBaseDraftId;
                const roundText = getRoundDisplayName(baseline);

                return (
                  <button
                    key={baseline.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    data-testid={`round-tab-${baseline.id}`}
                    onClick={() => setSelectedBaselineId(baseline.id)}
                    className={`px-3.5 py-2 rounded-lg text-xs font-medium border flex items-center gap-2 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-700 text-white border-blue-700 shadow-xs'
                        : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    <span className="font-bold">{roundText}</span>
                    <span className={isSelected ? 'text-blue-100' : 'text-slate-500 font-mono'}>
                      {baseline.versionNumber}
                    </span>
                    {isCurrentLiveBase && (
                      <span
                        className={`text-2xs px-1.5 py-0.5 rounded ${
                          isSelected ? 'bg-blue-800 text-white' : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        当前进行中
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {selectedBaseline && (
            <>
              {/* Selected Baseline Metadata Banner */}
              <div
                data-testid="history-baseline-meta-banner"
                className="bg-white border border-slate-200 p-4 rounded-lg shadow-2xs text-xs space-y-2"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-800">
                      {getRoundDisplayName(selectedBaseline)}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono border border-slate-200">
                      基准版本：{selectedBaseline.versionNumber}
                    </span>
                    <span className="text-2xs text-slate-400 font-mono">
                      (ID: {selectedBaseline.id})
                    </span>
                  </div>
                  <div className="text-2xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-1 rounded font-medium">
                    纯只读回看 · 不提供新增意见、采纳、落实或重新送审操作
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-slate-600">
                  <div>
                    <span className="text-slate-400 block text-2xs">送审人</span>
                    <span className="font-medium text-slate-800">{selectedBaseline.author || '未知'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-2xs">送审时间</span>
                    <span className="font-mono text-slate-700">
                      {new Date(selectedBaseline.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-2xs">来源工作稿</span>
                    <span className="text-slate-800 font-medium">
                      {sourceDraft ? sourceDraft.versionNumber : selectedBaseline.sourceDraftId || '初始草稿'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-2xs">本轮原始收到意见数</span>
                    <span className="font-semibold text-slate-800">{baselineComments.length} 条</span>
                  </div>
                </div>
              </div>

              {/* Task 28 Handoff Card Reused for Selected Baseline */}
              <div data-testid="history-handoff-card-wrapper">
                <RevisionReviewHandoffCard
                  task={task}
                  reviewBaseDraft={selectedBaseline}
                  currentDraft={currentDraft}
                  activeRole={activeRole}
                  onViewSnippet={(snippet, fact, adoptedEvidence, freezeDraftEvidence) => {
                    if (onViewSnippet) {
                      onViewSnippet(snippet, fact, adoptedEvidence, freezeDraftEvidence, selectedBaseline);
                    }
                  }}
                  onLocateBlock={handleLocateHistoricalBlock}
                  onCommentOnBlock={undefined}
                />
              </div>

              {/* Two-Column Grid: Left Attributed Comments, Right Read-only Baseline Text */}
              <div className="grid grid-cols-12 gap-6">
                {/* Left: Original Attributed Comments */}
                <div className="col-span-12 lg:col-span-7 bg-white rounded-lg border border-slate-200 shadow-2xs p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-800">
                        本轮原始审阅意见清单
                      </span>
                      <span className="text-xs bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-mono">
                        {baselineComments.length}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <select
                        value={commentFilter}
                        onChange={(e) => setCommentFilter(e.target.value as any)}
                        className="border border-slate-300 rounded px-2 py-1 bg-white text-slate-700 text-xs"
                      >
                        <option value="all">全部状态 ({baselineComments.length})</option>
                        <option value="pending">待处理 ({baselineComments.filter((c) => c.status === 'pending').length})</option>
                        <option value="accepted_pending_implementation">决定采纳·待落实 ({baselineComments.filter((c) => c.status === 'accepted_pending_implementation').length})</option>
                        <option value="implemented">已修改/已落实 ({baselineComments.filter((c) => c.status === 'implemented').length})</option>
                        <option value="need_discussion">待沟通 ({baselineComments.filter((c) => c.status === 'need_discussion').length})</option>
                        <option value="rejected">拒绝采纳 ({baselineComments.filter((c) => c.status === 'rejected').length})</option>
                      </select>

                      <select
                        value={reviewerFilter}
                        onChange={(e) => setReviewerFilter(e.target.value as any)}
                        className="border border-slate-300 rounded px-2 py-1 bg-white text-slate-700 text-xs"
                      >
                        <option value="all">全部审阅人</option>
                        <option value="审阅乙">审阅乙</option>
                        <option value="审阅丁">审阅丁</option>
                      </select>
                    </div>
                  </div>

                  {/* Distinction Notice (Requirement 5.2) */}
                  <div className="bg-amber-50/80 border border-amber-200 p-2.5 rounded-lg text-xs text-amber-900 flex items-start gap-2">
                    <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">关于意见处理状态的重要说明：</div>
                      <div>
                        意见当前处理状态，不代表该轮结束时的冻结结论。后续主笔在工作稿中对该意见的答复、采纳或落实会更新当前展示，送审快照本身的正文与交接摘要保持不可篡改。
                      </div>
                    </div>
                  </div>

                  {/* Comments Feed */}
                  <div className="space-y-3">
                    {filteredComments.length === 0 ? (
                      <div
                        data-testid="round-comments-empty"
                        className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200"
                      >
                        {baselineComments.length === 0
                          ? `本轮送审基准【${selectedBaseline.versionNumber}】未收到原始审阅意见。`
                          : '没有符合筛选条件的审阅意见'}
                      </div>
                    ) : (
                      filteredComments.map((cmt) => {
                        const isRebound = Boolean(cmt.rebindRecord);

                        return (
                          <div
                            key={cmt.id}
                            data-testid={`history-comment-item-${cmt.id}`}
                            className="p-4 rounded-lg border border-slate-200 bg-white space-y-2 text-xs shadow-2xs"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-800">{cmt.reviewer}</span>
                                <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-2xs border border-slate-200">
                                  {cmt.type === 'overall' ? '全局意见' : `第 ${cmt.targetBlockOrder || '?'} 段批注`}
                                </span>
                                <span className="text-2xs text-slate-400 font-mono">{cmt.id}</span>
                              </div>

                              <div>
                                <span
                                  className={`px-2 py-0.5 rounded text-xs font-medium border ${
                                    cmt.status === 'implemented'
                                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                      : cmt.status === 'accepted_pending_implementation'
                                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                                      : cmt.status === 'rejected'
                                      ? 'bg-slate-100 text-slate-600 border-slate-200'
                                      : cmt.status === 'need_discussion'
                                      ? 'bg-purple-50 text-purple-700 border-purple-200'
                                      : 'bg-amber-50 text-amber-700 border-amber-200'
                                  }`}
                                >
                                  {cmt.status === 'implemented' && '已修改/已落实'}
                                  {cmt.status === 'accepted_pending_implementation' && '决定采纳·待落实'}
                                  {cmt.status === 'rejected' && '拒绝采纳'}
                                  {cmt.status === 'need_discussion' && '待沟通'}
                                  {cmt.status === 'pending' && '待处理'}
                                </span>
                              </div>
                            </div>

                            {/* Attribution & Rebind Provenance */}
                            <div className="p-2 bg-slate-50 rounded border border-slate-200 text-2xs text-slate-600 space-y-1">
                              <div className="flex items-center justify-between">
                                <span>
                                  原始归属基准：
                                  <strong className="text-slate-800 font-medium">
                                    {getRoundDisplayName(selectedBaseline)}
                                  </strong>{' '}
                                  ({cmt.targetVersionNumber || cmt.targetVersionId})
                                </span>
                                <span className="text-slate-400 font-mono">
                                  提出时间：{new Date(cmt.createdAt).toLocaleString('zh-CN')}
                                </span>
                              </div>

                              {isRebound && cmt.rebindRecord && (
                                <div className="text-purple-800 bg-purple-50/60 p-1.5 rounded border border-purple-200 space-y-0.5">
                                  <div className="font-semibold flex items-center gap-1">
                                    <CornerDownRight className="w-3 h-3 text-purple-600" />
                                    <span>当前处理目标已重指定：</span>
                                  </div>
                                  <div>
                                    目标草稿：{cmt.rebindRecord.targetDraftId} · 第 {cmt.rebindRecord.toBlockOrder} 段
                                    （重绑操作人：{cmt.rebindRecord.reboundBy}）
                                  </div>
                                  {cmt.rebindRecord.reason && (
                                    <div className="text-purple-700 italic">
                                      重绑原因：{cmt.rebindRecord.reason}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Comment Content */}
                            <p className="text-slate-800 leading-relaxed font-medium">{cmt.content}</p>

                            {/* Suggested Change */}
                            {cmt.suggestedChange && (
                              <div className="p-2 bg-blue-50/60 rounded border border-blue-200 text-xs text-blue-900 space-y-0.5">
                                <span className="font-semibold text-2xs text-blue-700 block">
                                  建议修改文本 / 方向：
                                </span>
                                <p>{cmt.suggestedChange}</p>
                              </div>
                            )}

                            {/* Historical Base Paragraph Text */}
                            {cmt.baseParagraphText && (
                              <div className="p-1.5 bg-slate-50 rounded border border-slate-200 text-2xs font-mono text-slate-600 italic">
                                提出时基准原句：“{cmt.baseParagraphText.slice(0, 80)}...”
                              </div>
                            )}

                            {/* Author Reply / Implementation Details */}
                            {cmt.authorReply && (
                              <div className="p-2.5 bg-emerald-50/70 border border-emerald-200 rounded text-xs text-emerald-900 space-y-1">
                                <div className="font-semibold text-xs flex items-center justify-between">
                                  <span className="flex items-center gap-1">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                    主笔处理答复记录：
                                  </span>
                                  {cmt.implementationDraftId && (
                                    <span className="text-2xs text-emerald-700 font-mono">
                                      落实版本：{cmt.implementationDraftId}
                                    </span>
                                  )}
                                </div>
                                <p>{cmt.authorReply}</p>
                              </div>
                            )}

                            {/* Locate Block Action */}
                            {cmt.type === 'paragraph' && cmt.targetBlockId && (
                              <div className="pt-1 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => handleLocateHistoricalBlock(cmt.targetBlockId!)}
                                  data-testid={`btn-locate-comment-block-${cmt.id}`}
                                  className="px-2.5 py-1 text-blue-700 hover:bg-blue-50 border border-blue-200 rounded text-xs font-semibold flex items-center gap-1 cursor-pointer"
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                  <span>在送审正文中定位</span>
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right: Read-Only Baseline Text */}
                <div className="col-span-12 lg:col-span-5 bg-white rounded-lg border border-slate-200 shadow-2xs p-5 space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-800">送审基准只读正文</span>
                      <span className="text-2xs bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded border border-slate-200 font-mono">
                        {selectedBaseline.blocks.length} 段
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 font-mono">{selectedBaseline.versionNumber}</span>
                  </div>

                  <div className="space-y-4 max-h-[650px] overflow-y-auto pr-1">
                    {selectedBaseline.blocks.map((block) => {
                      const isHighlighted = highlightedBlockId === block.id;

                      return (
                        <div
                          key={block.id}
                          id={`history-baseline-block-${block.id}`}
                          data-testid={`history-baseline-block-${block.id}`}
                          className={`p-3 rounded border text-xs space-y-1 transition-all duration-300 ${
                            isHighlighted
                              ? 'bg-blue-50/90 border-blue-500 ring-2 ring-blue-500 shadow-xs'
                              : 'bg-slate-50 border-slate-200/80'
                          }`}
                        >
                          <div className="flex justify-between text-xs text-slate-400 font-mono">
                            <span className={isHighlighted ? 'text-blue-700 font-bold' : ''}>
                              第{block.order}段 (ID: {block.id})
                            </span>
                            <span>{block.referencedFactIds.length}项事实关联</span>
                          </div>
                          <p className="text-slate-800 leading-relaxed text-justify indent-6">{block.content}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Unattributed / Non-Formal Comments Section (Requirement 4.6) */}
          {unattributedComments.length > 0 && (
            <div
              data-testid="unattributed-comments-section"
              className="bg-white border border-slate-200 rounded-lg p-5 shadow-2xs space-y-3"
            >
              <div className="flex items-center gap-2 font-bold text-xs text-slate-800">
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <span>非正式基准或来源缺失意见（共 {unattributedComments.length} 条）</span>
              </div>
              <p className="text-xs text-slate-500">
                以下意见针对未正式送审的临时草稿提出，或其来源送审基准在草稿库中缺失。为确保审阅记录完整存证，系统单独在此列出，未将其混入上述正式轮次中。
              </p>
              <div className="space-y-2">
                {unattributedComments.map(({ comment, reason }) => (
                  <div
                    key={comment.id}
                    data-testid={`unattributed-comment-${comment.id}`}
                    className="p-3 bg-slate-50 rounded border border-slate-200 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-2xs text-slate-500">
                      <span className="font-bold text-slate-700">
                        {comment.reviewer} · {comment.id}
                      </span>
                      <span className="text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                        {reason}
                      </span>
                    </div>
                    <p className="text-slate-800">{comment.content}</p>
                    <div className="text-2xs text-slate-400 font-mono">
                      原记录目标版本ID：{comment.targetVersionId} · 当前状态：{comment.status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
