import React, { useEffect, useRef } from 'react';
import {
  FactImpactAnalysisResult,
  FactImpactItem,
} from '../services/factImpactService';
import { DraftVersion, Fact, Task } from '../types';
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
} from 'lucide-react';

interface FactImpactModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: FactImpactAnalysisResult;
  currentDraft?: DraftVersion;
  task: Task;
  onLocateBlock: (blockId: string, factId?: string) => void;
  onViewDraftEvidence: (item: FactImpactItem) => void;
  onJumpToFactsStage?: () => void;
}

export const FactImpactModal: React.FC<FactImpactModalProps> = ({
  isOpen,
  onClose,
  analysis,
  currentDraft,
  task,
  onLocateBlock,
  onViewDraftEvidence,
  onJumpToFactsStage,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Capture previous focused element and restore on close
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;
      modalRef.current?.focus();
    }
    return () => {
      if (isOpen && previousActiveElementRef.current?.isConnected) {
        previousActiveElementRef.current.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

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
        const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
          .filter(el => !el.closest('[hidden], [inert], [aria-hidden="true"]'));
        const first = controls[0], last = controls[controls.length - 1];
        const active = document.activeElement;
        if (!first) { e.preventDefault(); panel.focus(); }
        else if (!panel.contains(active) || active === panel || (e.shiftKey ? active === first : active === last)) {
          e.preventDefault(); (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isHistoricalOrFinal = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal);

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
        className="relative bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col border border-slate-200 outline-hidden"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50 rounded-t-xl shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-100 text-blue-700 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2
                  id="fact-impact-modal-title"
                  className="font-bold text-slate-800 text-base sm:text-lg"
                >
                  事实变更影响总览与逐段定位
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
            <div className="p-4 bg-amber-50/90 border border-amber-300 rounded-lg text-amber-950 space-y-2">
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
              </div>
              <p className="text-xs text-amber-800 leading-relaxed">
                主笔调整已核准事实后，当前稿件所采用的历史快照与任务最新状态不一致。本面板仅负责比对与逐段定位，不自动改写正文、不自动改数值、不自动覆盖稿件快照。
              </p>
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

          {/* Scope limitation alert for unlinked material evidence */}
          {analysis.hasDraft && !task.factSnapshot && (
            <p className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
              任务事实清单尚未重新确认，起草前置审批未就绪；本项为任务整体审批状态，不计为每条事实发生变化。
            </p>
          )}
          {analysis.missingBaselineFactIds.length > 0 && (
            <div data-testid="fact-impact-baseline-limit" className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
              <p className="font-semibold">部分引用缺少快照基准，需人工核实</p>
              {analysis.allReferencedItems.filter(item => analysis.missingBaselineFactIds.includes(item.factId)).map(item => (
                <p key={item.factId}>{item.metric}：本稿核准快照未收录；关联{item.referencingBlocks.map(b => `第${b.blockOrder}段`).join('、')}。无法确认当时采用依据，不据此推断事实发生变化。</p>
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

          {/* Changed Facts Impact List */}
          {analysis.impactItems.length > 0 && (
            <div className="space-y-4">
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
                {analysis.impactItems.map((item, itemIdx) => (
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

          {/* Newly Added Facts Not Yet Referenced */}
          {analysis.unreferencedNewFacts.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-slate-700 text-xs flex items-center gap-1.5">
                  <span>当前新增但尚未被所选正文引用的事实</span>
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
