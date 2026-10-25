import React, { useState } from 'react';
import { EvidenceSnippet, SourceDocument, Fact, DraftVersion, Task, AdoptedEvidenceRecord } from '../types';
import { X, FileText, Calendar, MapPin, Tag, AlertTriangle, ChevronDown, CheckCircle2 } from 'lucide-react';
import { resolveDraftFactEvidence } from '../services/factLifecycleService';

interface SnippetDrawerProps {
  snippet: EvidenceSnippet | null;
  sourceOnly?: boolean;
  documents: SourceDocument[];
  onClose: () => void;
  fact?: Fact | null;
  adoptedEvidence?: AdoptedEvidenceRecord | null;
  currentDraft?: DraftVersion | null;
  task?: Task | null;
}

export const SnippetDrawer: React.FC<SnippetDrawerProps> = ({
  snippet,
  sourceOnly = false,
  documents,
  onClose,
  fact,
  adoptedEvidence,
  currentDraft,
  task,
}) => {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  if (!snippet && !fact) return null;

  const doc = snippet ? documents.find((d) => d.id === snippet.sourceDocId) : undefined;

  // Materials/RAG requests open the exact selected source, independently of
  // the fact's chosen primary source or the currently viewed draft snapshot.
  const resolvedFact =
    sourceOnly ? null :
    fact ||
    (!adoptedEvidence && doc?.usage !== 'style_ref' && snippet && task
      ? task.facts.find(
          (f) => f.primaryEvidenceId === snippet.id || f.evidenceIds.includes(snippet.id)
        )
      : null);

  // P2: Use shared evidence resolution logic
  const resolvedData =
    resolvedFact && task
      ? resolveDraftFactEvidence(resolvedFact, currentDraft || undefined, task)
      : null;

  const isHistoricalOrFinal = !sourceOnly && Boolean(
    resolvedData
      ? resolvedData.isHistoricalOrFinal
      : currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal
  );

  const snapItem = resolvedData ? resolvedData.snapItem : null;
  const hasSnapshotDiff = resolvedData ? resolvedData.hasSnapshotDiff : false;
  const hasFrozenItem = resolvedData ? resolvedData.hasFrozenItem : false;
  const isCurrentFactDeleted = resolvedData?.isCurrentFactDeleted || false;
  const adoptedValue = resolvedData
    ? resolvedData.adoptedValue
    : resolvedFact
    ? `${resolvedFact.value} ${resolvedFact.unit}`
    : '无量化值';

  const currentConfirmedValue = resolvedData
    ? resolvedData.currentConfirmedValue
    : resolvedFact
    ? `${resolvedFact.value} ${resolvedFact.unit}`
    : '未登记';

  const frozenPeriod = resolvedData?.effectivePeriod;
  const frozenMetricScope = resolvedData?.effectiveMetricScope;
  const frozenEvidenceId = resolvedData?.effectiveEvidenceId;

  // Evidence snippet resolution:
  // If viewing historical or final snapshot, STRICTLY select snippet matching frozenEvidenceId!
  // If frozenEvidenceId is not found or not recorded, DO NOT show latest snippet as frozen evidence!
  const resolvedSnippet: EvidenceSnippet | null = (() => {
    if (adoptedEvidence) return { id: adoptedEvidence.evidenceId, sourceDocId: adoptedEvidence.sourceDocId,
      docName: adoptedEvidence.sourceDocName, location: adoptedEvidence.snippetLocation || '采纳冻结片段',
      period: adoptedEvidence.period, text: adoptedEvidence.snippetText };
    if (resolvedData) {
      return resolvedData.effectiveSnippet;
    }
    if (isHistoricalOrFinal && resolvedFact) {
      return null;
    }
    return snippet || (resolvedFact && task ? task.snippets.find((s) => s.id === resolvedFact.primaryEvidenceId) : null) || null;
  })();

  const hasFrozenProvenance = Boolean(
    (isHistoricalOrFinal || isCurrentFactDeleted) &&
    resolvedData?.provenance &&
    (!resolvedData.effectiveEvidenceId || resolvedData.provenance.evidenceId === resolvedData.effectiveEvidenceId)
  );

  const liveDoc = resolvedSnippet ? documents.find((d) => d.id === resolvedSnippet.sourceDocId) : undefined;
  // Adoption and frozen provenance freeze the excerpt, not the source document's entire content.
  const resolvedDoc = (adoptedEvidence || hasFrozenProvenance) ? undefined : liveDoc;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="snippet-drawer-title"
      className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-xs flex justify-end animate-in fade-in duration-200"
    >
      <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
        {isHistoricalOrFinal && !adoptedEvidence && !hasFrozenProvenance && resolvedSnippet && <p className="p-3 text-sm bg-amber-50 text-amber-900">此版本保留了依据标识；下方为材料库现存原文，未保存原文快照时无法保证与采用当时完全一致。</p>}
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
                {!sourceOnly && currentDraft ? ` · 对照版本：${currentDraft.versionNumber}` : ''}
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
                className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  resolvedFact.status === 'confirmed'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {isCurrentFactDeleted ? '当前事实已删除' : resolvedFact.status === 'confirmed' ? '当前已核准' : '待确认'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 bg-white rounded border border-slate-200 space-y-0.5">
                <span className="text-xs text-slate-400 block">
                  {isHistoricalOrFinal ? '稿件冻结采用值（快照）' : '当前稿采用值'}
                </span>
                <span className={`font-bold font-mono text-sm ${hasFrozenItem ? 'text-slate-900' : isHistoricalOrFinal ? 'text-slate-400 text-xs italic font-sans' : 'text-slate-900'}`}>
                  {adoptedValue}
                </span>
                {snapItem ? (
                  <span className="text-xs text-slate-400 block font-normal">
                    期间：{frozenPeriod || '未记录'} · 口径：{frozenMetricScope || '无单独口径'}
                  </span>
                ) : isHistoricalOrFinal ? (
                  <span className="text-xs text-amber-600 block font-normal">
                    快照中无此事实冻结项，不可回溯当时值
                  </span>
                ) : (
                  <span className="text-xs text-slate-400 block font-normal">
                    期间：{resolvedFact.period}
                  </span>
                )}
              </div>

              <div className="p-2 bg-white rounded border border-slate-200 space-y-0.5">
                <span className="text-xs text-slate-400 block">任务最新核准值</span>
                <span className="font-bold text-blue-800 font-mono text-sm">
                  {currentConfirmedValue}
                </span>
                <span className="text-xs text-slate-400 block font-normal">
                    期间：{resolvedData?.currentPeriod || resolvedFact.period} · 口径：{resolvedData?.currentMetricScope || resolvedFact.metricScope || '标准口径'}
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
                <p className="text-xs text-amber-800 leading-normal">
                  {isHistoricalOrFinal
                    ? `本版本为【${currentDraft?.versionNumber}】只读快照，按公文严谨性规范优先保持当时冻结值（${adoptedValue}），当前核准值（${currentConfirmedValue}）不回填旧稿。`
                    : `当前工作稿生成时依据为【${adoptedValue}】，上游事实已更新核准为【${currentConfirmedValue}】。如需更新文稿，请点击“重新生成候选稿”或使用段落修改建议。`}
                </p>
              </div>
            )}

            {/* Metric Scope Comparison: Frozen vs Current */}
            <div className="text-xs text-slate-600 space-y-0.5">
              {isHistoricalOrFinal && frozenMetricScope && (
                <div>
                  冻结统计口径：<strong className="text-slate-700 font-medium">{frozenMetricScope}</strong>
                </div>
              )}
              {!isCurrentFactDeleted && resolvedFact.metricScope && (
                <div>
                  {isHistoricalOrFinal && frozenMetricScope ? '当前最新统计口径：' : '统计口径：'}
                  <strong className="text-slate-700 font-medium">{resolvedFact.metricScope}</strong>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Snippet Details */}
        {resolvedSnippet ? (
          <div className="p-4 bg-blue-50/70 border-b border-blue-100">
            <div className="text-xs font-semibold uppercase tracking-wider text-blue-800 mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Tag className="w-3.5 h-3.5" /> {adoptedEvidence ? '采纳时冻结片段' : '关联证据片段'}
              </span>
              {isHistoricalOrFinal && !adoptedEvidence && (
                <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.2 rounded font-normal font-sans">
                  基于快照冻结证据ID追溯
                </span>
              )}
            </div>
            <div className="p-3 bg-white border border-blue-200 rounded text-slate-800 text-sm font-medium leading-relaxed shadow-xs">
              {resolvedSnippet.text || (resolvedSnippet as any).content}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-3 text-xs text-slate-600">
              <span className="flex items-center gap-1">
                <FileText className="w-3.5 h-3.5 text-slate-400" />
                材料名称：<strong className="text-slate-800">{resolvedSnippet.docName}</strong>
              </span>
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                原文位置：<strong className="text-slate-800">{resolvedSnippet.location || '登记文本段落（无纸质页码）'}</strong>
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                统计期间：<strong className="text-slate-800">{resolvedSnippet.period}</strong>
              </span>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-amber-50/60 border-b border-amber-200 text-xs text-amber-900 space-y-1">
            <div className="font-semibold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>来源追溯真实限制说明</span>
            </div>
            <p className="text-xs text-amber-800">
              {isHistoricalOrFinal
                ? (frozenEvidenceId
                    ? `该历史快照已完整记录原始证据ID【${frozenEvidenceId}】，但材料库中该证据原文已清理或归档不可用。系统严格遵循存证隔离，绝不直接冒充展示最新证据材料。`
                    : '该历史版本快照中未记录此事实当时的原始证据片段ID。系统保持真实限制说明，不伪造虚假出处或直接冒充使用最新证据材料。')
                : '当前事实未关联材料库中的特定文本摘录片段（可能由主笔直接根据科室台账线下登记核准，或出处文档在当前材料库中未登记）。系统保持真实限制说明，不伪造虚假页码或出处文档。'}
            </p>
          </div>
        )}

        {/* Document Full Text Context */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">{adoptedEvidence || hasFrozenProvenance ? '采纳材料存证范围' : '材料上下文全文核验'}</h4>
            <span className="text-xs text-slate-400">
              {adoptedEvidence || hasFrozenProvenance ? '冻结存证' : resolvedDoc ? `来源：${resolvedDoc.source} (${resolvedDoc.period})` : '登记文本出处'}
            </span>
          </div>

          {adoptedEvidence || hasFrozenProvenance ? (
            <p className="p-4 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900">
              仅保存采纳时片段，未保存当时全文。上方展示采纳时冻结的原文、材料名称、位置和期间。
            </p>
          ) : resolvedDoc ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-700 leading-relaxed space-y-3 font-normal">
              {resolvedDoc.content.split('\n\n').map((paragraph, idx) => {
                const isTarget =
                  resolvedSnippet &&
                  (paragraph.includes(resolvedSnippet.text) ||
                    (resolvedSnippet.location && paragraph.startsWith(resolvedSnippet.location.slice(0, 3))));
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
          ) : resolvedSnippet ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-600">
              {resolvedSnippet.text}
            </div>
          ) : (
            <div className="p-6 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-500 text-center italic">
              {isHistoricalOrFinal ? '历史快照无对应全文文档关联记录。' : '材料库中无全文记录。可在线下业务台账核对具体数据出处。'}
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
              className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 cursor-pointer"
            >
              <ChevronDown
                className={`w-3 h-3 transition-transform ${showDiagnostics ? 'rotate-180' : ''}`}
              />
              <span>技术指纹与内部标识（演示诊断区）</span>
            </button>

            {showDiagnostics && (
              <div className="mt-2 p-2.5 bg-slate-100 rounded border border-slate-200 text-xs font-mono text-slate-500 space-y-0.5">
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

