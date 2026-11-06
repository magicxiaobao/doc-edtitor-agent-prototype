import React, { useState, useEffect } from 'react';
import {
  Task,
  DraftVersion,
  UserRole,
  PostRevisionEvidenceInfo,
  EvidenceSnippet,
  Fact,
  AdoptedEvidenceRecord,
} from '../types';
import {
  buildRevisionReviewHandoffSummary,
} from '../services/revisionReviewHandoffService';
import {
  FileText,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MessageSquare,
  ShieldCheck,
  Eye,
  Info,
  History,
  FileCheck,
} from 'lucide-react';

interface RevisionReviewHandoffCardProps {
  task: Task;
  reviewBaseDraft: DraftVersion | undefined;
  currentDraft: DraftVersion | undefined;
  activeRole: UserRole;
  onViewSnippet?: (
    snippet: EvidenceSnippet,
    fact?: Fact,
    adoptedEvidence?: AdoptedEvidenceRecord,
    freezeDraftEvidence?: boolean
  ) => void;
  onLocateBlock?: (blockId: string) => void;
  onCommentOnBlock?: (blockId: string) => void;
}

export const RevisionReviewHandoffCard: React.FC<RevisionReviewHandoffCardProps> = ({
  task,
  reviewBaseDraft,
  currentDraft,
  activeRole,
  onViewSnippet,
  onLocateBlock,
  onCommentOnBlock,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedHistoryBlockId, setExpandedHistoryBlockId] = useState<string | null>(null);

  useEffect(() => {
    setIsExpanded(false);
    setExpandedHistoryBlockId(null);
  }, [activeRole, reviewBaseDraft?.id, task.id]);

  const summary = buildRevisionReviewHandoffSummary(task, reviewBaseDraft, currentDraft);

  const handleOpenEvidence = (evidence: PostRevisionEvidenceInfo, factId: string) => {
    if (!onViewSnippet) return;
    const snippet: EvidenceSnippet = {
      id: evidence.evidenceId || `EVD-${factId}`,
      sourceDocId: evidence.sourceDocId || '',
      docName: evidence.sourceDocName,
      location: evidence.location || '冻结依据出处',
      text: evidence.snippetText || '',
      period: evidence.period || '',
    };
    const frozen: AdoptedEvidenceRecord = {
      evidenceId: snippet.id,
      sourceDocId: snippet.sourceDocId,
      sourceDocName: snippet.docName,
      snippetLocation: snippet.location,
      snippetText: snippet.text,
      period: snippet.period,
      usage: 'current_fact',
      associatedFactId: factId,
      contentFingerprint: JSON.stringify(evidence),
      capturedAt: evidence.capturedAt || '',
    };
    onViewSnippet(snippet, undefined, frozen, true);
  };

  // 1. If not a formal review baseline (e.g. no reviewBaseDraftId or fallback only)
  if (!summary.hasFormalBaseline) {
    return (
      <div
        data-testid="revision-review-handoff-banner"
        className="bg-slate-50 border border-slate-200 p-4 rounded-lg shadow-2xs space-y-2 text-xs"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-700">
            <Info className="w-4 h-4 text-slate-500" />
            <span>本轮事实修订说明：尚未提交本轮审阅 / 当前仅为工作稿参考</span>
          </div>
          <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-mono">
            未冻结基准
          </span>
        </div>
        <p className="text-slate-600">
          当前文稿尚未正式提交审阅生成只读基准快照。在阶段04“正文起草”由主笔甲点击【提交本轮审阅】后，系统将自动生成不可篡改的送审基准快照，并冻结事实修订交接摘要与逐段核对留痕。
        </p>
      </div>
    );
  }

  // 2. Formal baseline exists
  const isReviewer = activeRole === '审阅乙' || activeRole === '审阅丁';

  return (
    <div
      data-testid="revision-review-handoff-banner"
      className="bg-white border-2 border-blue-200 rounded-lg shadow-xs overflow-hidden transition-all duration-200"
    >
      {/* Top Header */}
      <div className="p-4 bg-blue-50/60 border-b border-blue-100 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-sm text-blue-950 flex items-center gap-1.5">
              <FileCheck className="w-4 h-4 text-blue-700" />
              本轮事实修订交接说明与主笔核对情况
            </span>
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-medium">
              第 {summary.reviewRound} 轮送审基准
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
              {summary.baseDraftVersionNumber}
            </span>
            {summary.isCurrentDraftContentModified && (
              <span
                data-testid="current-draft-modified-badge"
                className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 font-medium flex items-center gap-1"
                title="主笔在送审后修改了工作稿正文。本交接卡片展示的是送审时冻结的基准快照数据"
              >
                <AlertTriangle className="w-3 h-3 text-amber-700" />
                当前工作稿已不同于本轮送审基准
              </span>
            )}
          </div>
          <div className="text-slate-500 flex flex-wrap items-center gap-3">
            <span>送审提交人：<strong className="text-slate-700 font-medium">{summary.submittedBy || '主笔甲'}</strong></span>
            <span aria-hidden="true">·</span>
            <span>送审时间：<strong className="text-slate-700 font-medium">{summary.submittedAt ? new Date(summary.submittedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</strong></span>
            {summary.hasCredential && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-blue-900 font-medium">
                  涵盖 {summary.factsCount} 项事实 · {summary.uniqueBlocksCount} 个段落
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-blue-900 font-medium">
                  送审时核对：{summary.verifiedCount}/{summary.uniqueBlocksCount}段已记录（待处理 {summary.pendingCount} 段）
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {summary.hasCredential && (
            <button
              data-testid="btn-toggle-handoff-details"
              onClick={() => setIsExpanded(!isExpanded)}
              className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-2xs flex items-center gap-1 cursor-pointer"
            >
              <span>{isExpanded ? '收起修订详情' : '展开修订详情'}</span>
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Prominent Disclaimer (醒目说明) */}
      <div className="px-4 py-2.5 bg-amber-50/90 border-b border-amber-200/80 flex items-start sm:items-center gap-2 text-xs text-amber-950">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5 sm:mt-0" />
        <span className="font-semibold leading-relaxed">
          {summary.disclaimer}
        </span>
      </div>

      {/* If no credential */}
      {!summary.hasCredential && (
        <div className="p-4 text-xs text-slate-600 space-y-1">
          <p>{summary.statusSummaryText}</p>
          {summary.degradedNotice && (
            <p className="text-amber-700 font-medium">{summary.degradedNotice}</p>
          )}
        </div>
      )}

      {/* Expanded Details View */}
      {summary.hasCredential && isExpanded && (
        <div data-testid="handoff-expanded-content" className="p-5 space-y-6 text-xs bg-slate-50/30">
          {/* Section 1: Facts Level */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
              <span className="font-bold text-xs text-slate-800 uppercase tracking-wide">
                一、本轮修订事实及前后冻结依据出处
              </span>
              <span className="text-slate-400 font-normal">
                (共 {summary.facts.length} 项变动事实，出处片段已在送审时锁定)
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {summary.facts.map((fact) => (
                <div
                  key={fact.factId}
                  data-testid={`handoff-fact-card-${fact.factId}`}
                  className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2.5 shadow-2xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-slate-800">
                      {fact.metric}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-mono text-xs border border-blue-200">
                      {fact.period}
                    </span>
                  </div>

                  {/* Value change */}
                  <div className="flex items-center gap-2 bg-slate-50 p-2 rounded border border-slate-200">
                    <span className="text-slate-500">修改前值：</span>
                    <span className="line-through text-slate-600 font-medium">
                      {fact.fromValue} {fact.unit}
                    </span>
                    <span className="text-slate-400">➔</span>
                    <span className="text-slate-500">采纳修改值：</span>
                    <span className="text-blue-800 font-bold">
                      {fact.toValue} {fact.unit}
                    </span>
                  </div>

                  {/* Evidence sources */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between gap-2 p-2 bg-slate-50 rounded border border-slate-200">
                      <div className="truncate text-slate-600">
                        <span className="font-medium text-slate-700">修订前出处：</span>
                        <span>{fact.fromEvidence.sourceDocName} ({fact.fromEvidence.location || '原始出处'})</span>
                      </div>
                      <button
                        data-testid={`btn-view-evidence-from-${fact.factId}`}
                        onClick={() => handleOpenEvidence(fact.fromEvidence, fact.factId)}
                        className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded text-xs shrink-0 flex items-center gap-1 cursor-pointer font-medium"
                      >
                        <Eye className="w-3 h-3 text-slate-500" />
                        <span>查阅旧依据 ({fact.fromValue}{fact.unit})</span>
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2 p-2 bg-blue-50/50 rounded border border-blue-200">
                      <div className="truncate text-blue-900">
                        <span className="font-medium text-blue-800">采纳新出处：</span>
                        <span>{fact.toEvidence.sourceDocName} ({fact.toEvidence.location || '核准出处'})</span>
                      </div>
                      <button
                        data-testid={`btn-view-evidence-to-${fact.factId}`}
                        onClick={() => handleOpenEvidence(fact.toEvidence, fact.factId)}
                        className="px-2 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs shrink-0 flex items-center gap-1 cursor-pointer font-medium shadow-2xs"
                      >
                        <Eye className="w-3 h-3 text-blue-200" />
                        <span>查阅新依据 ({fact.toValue}{fact.unit})</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 2: Blocks Level */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs text-slate-800 uppercase tracking-wide">
                  二、涉及段落逐段正文对比与送审时主笔核对留痕
                </span>
                <span className="text-slate-400 font-normal">
                  (按稳定 Block ID 去重，共 {summary.blocks.length} 个独立段落)
                </span>
              </div>
            </div>

            <div className="space-y-4">
              {summary.blocks.map((block) => {
                const isHistoryOpen = expandedHistoryBlockId === block.blockId;

                return (
                  <div
                    key={block.blockId}
                    data-testid={`handoff-block-card-${block.blockId}`}
                    className="bg-white border border-slate-200 rounded-lg p-4 space-y-3 shadow-2xs"
                  >
                    {/* Block header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-100">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-800">
                          第{block.blockOrder}段【{block.sectionTitle || '正文章节'}】
                        </span>
                        <span className="text-xs text-slate-400 font-mono">
                          ID: {block.blockId}
                        </span>
                        <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">
                          {block.associatedFactNames.join('、')}
                        </span>
                      </div>

                      {/* Status badge */}
                      <div className="flex items-center gap-2">
                        <span
                          data-testid={`handoff-block-status-${block.blockId}`}
                          className={`text-xs px-2.5 py-0.5 rounded font-medium ${
                            block.status === 'verified'
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                              : block.status === 'deferred'
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : block.status === 'invalidated'
                              ? 'bg-rose-100 text-rose-800 border border-rose-300'
                              : 'bg-slate-100 text-slate-700 border border-slate-300'
                          }`}
                        >
                          {block.statusLabel}
                        </span>
                      </div>
                    </div>

                    {/* Texts comparison: clearly separated */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      {/* Before Content */}
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1">
                        <span className="font-bold text-slate-600 block">
                          【修订前完整正文】：
                        </span>
                        <p className="text-slate-700 leading-relaxed text-justify font-serif">
                          {block.beforeContent}
                        </p>
                      </div>

                      {/* Adopted Content */}
                      <div className="p-3 bg-blue-50/50 border border-blue-200 rounded space-y-1">
                        <span className="font-bold text-blue-800 block">
                          【本次采纳正文】：
                        </span>
                        <p className="text-blue-950 leading-relaxed text-justify font-serif">
                          {block.afterContent}
                        </p>
                      </div>
                    </div>

                    {/* If edited after adoption */}
                    {block.status === 'block_missing' ? (
                      <div className="text-xs text-amber-900">
                        该段未包含在实际送审正文中，上方仅保留修订前及采纳时的历史正文。
                      </div>
                    ) : block.hasEditedAfterAdoption ? (
                      <div className="p-3 bg-purple-50 border border-purple-200 rounded text-xs space-y-1">
                        <span className="font-bold text-purple-900 block flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-purple-700" />
                          【实际送审正文（采纳后曾编辑，以此为准）】：
                        </span>
                        <p className="text-purple-950 leading-relaxed text-justify font-serif font-medium">
                          {block.submittedContent}
                        </p>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 italic">
                        送审正文与采纳正文完全一致
                      </div>
                    )}

                    {/* Verification Record Details */}
                    <div className="p-3 bg-slate-50/80 rounded border border-slate-200 text-xs space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-700">送审时核对留痕状态：</span>
                          {block.status === 'verified' && (
                            <span className="text-emerald-800">
                              主笔【{block.verifiedBy || '主笔甲'}】已核对 · 时间：{block.verifiedAt ? new Date(block.verifiedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                            </span>
                          )}
                          {block.status === 'deferred' && (
                            <span className="text-amber-800">
                              主笔【{block.deferredBy || '主笔甲'}】已暂缓 · 时间：{block.deferredAt ? new Date(block.deferredAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                            </span>
                          )}
                          {block.status === 'invalidated' && (
                            <span className="text-rose-800">
                              原核对已失效（原因：{block.invalidatedReason || '相关事实或正文变动'}）
                            </span>
                          )}
                          {block.status === 'pending' && (
                            <span className="text-slate-500">
                              {block.revokedReason
                                ? `原核对已撤回（待重新核对）`
                                : '送审时主笔尚未签署核对（待核对状态进入审阅阶段）'}
                            </span>
                          )}
                        </div>

                        {/* History expansion toggle */}
                        {block.events.length > 1 && (
                          <button
                            data-testid={`btn-toggle-block-history-${block.blockId}`}
                            onClick={() => setExpandedHistoryBlockId(isHistoryOpen ? null : block.blockId)}
                            className="text-xs text-blue-700 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                          >
                            <History className="w-3 h-3 text-blue-600" />
                            <span>{isHistoryOpen ? '收起历史留痕' : `查看历史事件 (${block.events.length}条)`}</span>
                          </button>
                        )}
                      </div>

                      {/* Notes / Reason / Revoked Reason */}
                      {block.status === 'verified' && block.notes && (
                        <div className="text-slate-700 pl-1 border-l-2 border-emerald-500">
                          <span className="font-medium text-slate-800">核对说明：</span>
                          {block.notes}
                        </div>
                      )}
                      {block.status === 'deferred' && block.deferredReason && (
                        <div className="text-slate-700 pl-1 border-l-2 border-amber-500">
                          <span className="font-medium text-slate-800">暂缓原因：</span>
                          {block.deferredReason}
                        </div>
                      )}
                      {block.revokedReason && (
                        <div className="text-slate-700 pl-1 border-l-2 border-rose-400">
                          <div>撤回人：{block.revokedBy} · 时间：{block.revokedAt ? new Date(block.revokedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</div>
                          <span className="font-medium text-slate-800">撤回原因：</span>
                          {block.revokedReason}
                        </div>
                      )}

                      {/* Expandable History Events */}
                      {isHistoryOpen && block.events.length > 0 && (
                        <div
                          data-testid={`block-history-list-${block.blockId}`}
                          className="mt-2 pt-2 border-t border-slate-200 space-y-1.5 pl-2"
                        >
                          <span className="text-slate-500 font-semibold block">历史操作事件序列：</span>
                          {block.events.map((evt, idx) => (
                            <div key={evt.id || idx} className="text-xs text-slate-600 flex items-start gap-2">
                              <span className="font-mono text-slate-400">{idx + 1}.</span>
                              <span className="px-1.5 py-0.2 rounded bg-slate-200 text-slate-700 font-medium">
                                {evt.action === 'verify' ? '记录核对' : evt.action === 'defer' ? '暂缓核对' : '撤回核对'}
                              </span>
                              <span className="text-slate-500">
                                {evt.operator} · {evt.timestamp ? new Date(evt.timestamp).toLocaleString('zh-CN', { hour12: false }) : '-'}
                              </span>
                              <span className="text-slate-800">
                                {evt.notes || evt.reason || '-'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions: Locate and Comment */}
                    <div className="pt-2 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100">
                      {block.status === 'block_missing' || !reviewBaseDraft?.blocks.some((b) => b.id === block.blockId) ? (
                        <span className="text-xs text-rose-600 italic">
                          该段落已在送审前正文中被删除，不可在基准中定位或提出段落意见
                        </span>
                      ) : (
                        <>
                          {onLocateBlock && (
                            <button
                              data-testid={`btn-locate-block-${block.blockId}`}
                              onClick={() => onLocateBlock(block.blockId)}
                              className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-2xs"
                              title="定位右侧送审基准预览中的真实段落并高亮"
                            >
                              <ExternalLink className="w-3.5 h-3.5 text-blue-600" />
                              <span>查看送审段落</span>
                            </button>
                          )}

                          {onCommentOnBlock && isReviewer && (
                            <button
                              data-testid={`btn-comment-block-${block.blockId}`}
                              onClick={() => onCommentOnBlock(block.blockId)}
                              className="px-3 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 shadow-2xs bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
                              title="针对本送审段落填写批注意见"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              <span>针对本段提出意见</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
