import React, { useState } from 'react';
import { EvidenceSnippet, SourceDocument, Fact, DraftVersion, Task } from '../types';
import { X, FileText, Calendar, MapPin, Tag, AlertTriangle, ChevronDown, CheckCircle2 } from 'lucide-react';

interface SnippetDrawerProps {
  snippet: EvidenceSnippet | null;
  documents: SourceDocument[];
  onClose: () => void;
  fact?: Fact | null;
  currentDraft?: DraftVersion | null;
  task?: Task | null;
}

export const SnippetDrawer: React.FC<SnippetDrawerProps> = ({
  snippet,
  documents,
  onClose,
  fact,
  currentDraft,
  task,
}) => {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  if (!snippet && !fact) return null;

  const doc = snippet ? documents.find((d) => d.id === snippet.sourceDocId) : undefined;

  // Retrieve fact object if snippet passed without fact
  const resolvedFact =
    fact ||
    (snippet && task
      ? task.facts.find(
          (f) => f.primaryEvidenceId === snippet.id || f.evidenceIds.includes(snippet.id)
        )
      : null);

  // Check frozen snapshot value in current draft vs current confirmed value in task
  const snapItem =
    resolvedFact && currentDraft?.snapshotMetadata?.factSnapshot?.items
      ? currentDraft.snapshotMetadata.factSnapshot.items.find(
          (item) => item.factId === resolvedFact.id
        )
      : null;

  const isHistoricalOrFinal = Boolean(
    currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal
  );

  const hasSnapshotDiff = Boolean(
    snapItem &&
      resolvedFact &&
      (snapItem.value !== resolvedFact.value || snapItem.unit !== resolvedFact.unit)
  );

  // Determine display values
  const hasFrozenItem = Boolean(snapItem);
  const adoptedValue = snapItem
    ? `${snapItem.value} ${snapItem.unit}`
    : isHistoricalOrFinal
    ? '历史快照未收录此事实'
    : resolvedFact
    ? `${resolvedFact.value} ${resolvedFact.unit}`
    : '无量化值';

  const currentConfirmedValue = resolvedFact
    ? `${resolvedFact.value} ${resolvedFact.unit}`
    : '未登记';

  // Snapshot specific fields
  const frozenPeriod = snapItem?.period;
  const frozenMetricScope = snapItem?.metricScope;
  const frozenEvidenceId = snapItem?.primaryEvidenceId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="snippet-drawer-title"
      className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-xs flex justify-end animate-in fade-in duration-200"
    >
      <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-blue-700 shrink-0" />
            <div>
              <h3 id="snippet-drawer-title" className="font-semibold text-slate-800 text-base">
                {resolvedFact ? `材料依据核对：${resolvedFact.metric}` : '原始材料出处追溯'}
              </h3>
              <p className="text-xs text-slate-500">
                {resolvedFact ? `事实指标：${resolvedFact.metric}` : `依据标识：${snippet?.id}`}
                {currentDraft ? ` · 对照版本：${currentDraft.versionNumber}` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
            title="关闭抽屉"
            aria-label="关闭抽屉"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Fact Comparison Banner: Adopted Value vs Current Confirmed Value */}
        {resolvedFact && (
          <div className="p-4 bg-slate-50 border-b border-slate-200 space-y-2">
            <div className="text-xs font-semibold text-slate-700 flex items-center justify-between">
              <span>事实指标与数值口径</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  resolvedFact.status === 'confirmed'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {resolvedFact.status === 'confirmed' ? '当前已核准' : '待确认'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 bg-white rounded border border-slate-200 space-y-0.5">
                <span className="text-[10px] text-slate-400 block">
                  {isHistoricalOrFinal ? '稿件冻结采用值（快照）' : '当前稿采用值'}
                </span>
                <span className={`font-bold font-mono text-sm ${hasFrozenItem ? 'text-slate-900' : isHistoricalOrFinal ? 'text-slate-400 text-xs italic font-sans' : 'text-slate-900'}`}>
                  {adoptedValue}
                </span>
                {snapItem ? (
                  <span className="text-[10px] text-slate-400 block font-normal">
                    期间：{frozenPeriod || '未记录'} · 口径：{frozenMetricScope || '无单独口径'}
                  </span>
                ) : isHistoricalOrFinal ? (
                  <span className="text-[10px] text-amber-600 block font-normal">
                    快照中无此事实冻结项，不可回溯当时值
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400 block font-normal">
                    期间：{resolvedFact.period}
                  </span>
                )}
              </div>

              <div className="p-2 bg-white rounded border border-slate-200 space-y-0.5">
                <span className="text-[10px] text-slate-400 block">任务最新核准值</span>
                <span className="font-bold text-blue-800 font-mono text-sm">
                  {currentConfirmedValue}
                </span>
                <span className="text-[10px] text-slate-400 block font-normal">
                  期间：{resolvedFact.period} · 口径：{resolvedFact.metricScope || '标准口径'}
                </span>
              </div>
            </div>

            {/* Version Discrepancy Alert */}
            {hasSnapshotDiff && (
              <div className="p-2.5 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 space-y-1">
                <div className="font-semibold flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>版本差异提示：稿件采用值与任务最新核准值不同</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-normal">
                  {isHistoricalOrFinal
                    ? `本版本为【${currentDraft?.versionNumber}】只读快照，按公文严谨性规范优先保持当时冻结值（${adoptedValue}），当前核准值（${currentConfirmedValue}）不回填旧稿。`
                    : `当前工作稿生成时依据为【${adoptedValue}】，上游事实已更新核准为【${currentConfirmedValue}】。如需更新文稿，请点击“重新生成候选稿”或使用段落修改建议。`}
                </p>
              </div>
            )}

            {/* Metric Scope Comparison: Frozen vs Current */}
            <div className="text-[11px] text-slate-600 space-y-0.5">
              {isHistoricalOrFinal && frozenMetricScope && (
                <div>
                  冻结统计口径：<strong className="text-slate-700 font-medium">{frozenMetricScope}</strong>
                </div>
              )}
              {resolvedFact.metricScope && (
                <div>
                  {isHistoricalOrFinal && frozenMetricScope ? '当前最新统计口径：' : '统计口径：'}
                  <strong className="text-slate-700 font-medium">{resolvedFact.metricScope}</strong>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Snippet Details */}
        {snippet ? (
          <div className="p-4 bg-blue-50/70 border-b border-blue-100">
            <div className="text-xs font-semibold uppercase tracking-wider text-blue-800 mb-1 flex items-center gap-1">
              <Tag className="w-3.5 h-3.5" /> 关联证据片段
            </div>
            <div className="p-3 bg-white border border-blue-200 rounded text-slate-800 text-sm font-medium leading-relaxed shadow-xs">
              {snippet.text}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-3 text-xs text-slate-600">
              <span className="flex items-center gap-1">
                <FileText className="w-3.5 h-3.5 text-slate-400" />
                材料名称：<strong className="text-slate-800">{snippet.docName}</strong>
              </span>
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                原文位置：<strong className="text-slate-800">{snippet.location || '登记文本段落（无纸质页码）'}</strong>
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                统计期间：<strong className="text-slate-800">{snippet.period}</strong>
              </span>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-amber-50/60 border-b border-amber-200 text-xs text-amber-900 space-y-1">
            <div className="font-semibold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>来源追溯真实限制说明</span>
            </div>
            <p className="text-[11px] text-amber-800">
              当前事实未关联材料库中的特定文本摘录片段（可能由主笔直接根据科室台账线下登记核准，或出处文档在当前材料库中未登记）。系统保持真实限制说明，不伪造虚假页码或出处文档。
            </p>
          </div>
        )}

        {/* Document Full Text Context */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">材料上下文全文核验</h4>
            <span className="text-xs text-slate-400">
              {doc ? `来源：${doc.source} (${doc.period})` : '登记文本出处'}
            </span>
          </div>

          {doc ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-700 leading-relaxed space-y-3 font-normal">
              {doc.content.split('\n\n').map((paragraph, idx) => {
                const isTarget =
                  snippet &&
                  (paragraph.includes(snippet.text) ||
                    (snippet.location && paragraph.startsWith(snippet.location.slice(0, 3))));
                return (
                  <p
                    key={idx}
                    className={`p-2 rounded transition-colors ${
                      isTarget
                        ? 'bg-amber-100/80 border-l-4 border-amber-500 text-slate-900 font-medium'
                        : 'text-slate-600'
                    }`}
                  >
                    {paragraph}
                  </p>
                );
              })}
            </div>
          ) : snippet ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-600">
              {snippet.text}
            </div>
          ) : (
            <div className="p-6 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-500 text-center italic">
              材料库中无全文记录。可在线下业务台账核对具体数据出处。
            </div>
          )}

          <div className="mt-4 p-3 bg-slate-100 rounded text-xs text-slate-500 space-y-1">
            <p className="font-medium text-slate-700">📌 依据核验规则说明：</p>
            <p>1. 历史稿件优先读取当时冻结的依据快照；当前确认值不回填到已归档旧稿中。</p>
            <p>2. 原型中材料均为电子登记文档，位置基于段落索引定位；没有纸质页码时不伪造虚假页码。</p>
            <p>3. 任何数字、单位、期间均来源于已核准事实或冻结依据，AI 起草不虚构数据口径。</p>
          </div>

          {/* Diagnostic Fingerprints Toggle */}
          <div className="pt-2">
            <button
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 cursor-pointer"
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${showDiagnostics ? 'rotate-180' : ''}`}
              />
              <span>技术指纹与内部标识（演示诊断区）</span>
            </button>

            {showDiagnostics && (
              <div className="mt-2 p-2.5 bg-slate-100 rounded border border-slate-200 text-[10px] font-mono text-slate-500 space-y-0.5">
                <div>FactId: {resolvedFact?.id || 'none'}</div>
                <div>SnippetId: {snippet?.id || 'none'}</div>
                <div>SourceDocId: {doc?.id || snippet?.sourceDocId || 'none'}</div>
                <div>PrimaryEvidenceId: {resolvedFact?.primaryEvidenceId || 'none'}</div>
                <div>SnapshotHash: {currentDraft?.snapshotMetadata?.factSnapshot?.hash || 'none'}</div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded transition-colors cursor-pointer"
          >
            关闭返回
          </button>
        </div>
      </div>
    </div>
  );
};

