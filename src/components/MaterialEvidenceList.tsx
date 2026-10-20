import React from 'react';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import { Fact, Task, DraftVersion, ParagraphBlock, EvidenceSnippet, AdoptedEvidenceRecord } from '../types';
import { resolveDraftFactEvidence, findDraftFact } from '../services/factLifecycleService';

export interface MaterialEvidenceListProps {
  task: Task;
  currentDraft: DraftVersion | undefined;
  activeBlock: ParagraphBlock | undefined;
  isCurrentDraftImmutable: boolean;
  inspectingFactId: string | null;
  onClearInspectingFactId?: () => void;
  onViewSnippet: (snippet: EvidenceSnippet, fact?: Fact, adoptedEvidence?: AdoptedEvidenceRecord) => void;
}

export const MaterialEvidenceList: React.FC<MaterialEvidenceListProps> = ({
  task,
  currentDraft,
  activeBlock,
  isCurrentDraftImmutable,
  inspectingFactId,
  onClearInspectingFactId,
  onViewSnippet,
}) => {
  if (!activeBlock) {
    return (
      <div className="py-8 text-center text-sm text-slate-400">
        请在正文中选择段落查看材料依据
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-slate-800 block">
          第 {activeBlock.order} 段关联事实与出处：
        </span>
        {inspectingFactId && onClearInspectingFactId && (
          <button
            type="button"
            onClick={onClearInspectingFactId}
            className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer font-medium"
          >
            清除聚焦
          </button>
        )}
      </div>

      {activeBlock.referencedFactIds.length > 0 ? (
        activeBlock.referencedFactIds.map((factId) => {
          const fact = findDraftFact(task, currentDraft, factId);
          if (!fact) return null;

          const resolved = resolveDraftFactEvidence(fact, currentDraft, task);
          const isFocused = inspectingFactId === fact.id;

          return (
            <div
              key={fact.id}
              className={`p-3.5 rounded-lg border text-sm space-y-2.5 transition-all ${
                isFocused
                  ? 'bg-blue-50/70 border-blue-400 ring-2 ring-blue-100 shadow-2xs'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-900 text-sm">{currentDraft?.snapshotMetadata?.factSnapshot?.items?.find(f => f.factId === factId)?.metric || fact.metric}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded font-medium ${
                    fact.status === 'confirmed'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {!task.facts.some(f => f.id === fact.id) ? '当前事实已删除' : fact.status === 'confirmed' ? '当前已核准' : '待确认'}
                </span>
              </div>

              {/* Comparison of Adopted value vs Current confirmed value */}
              <div className="grid grid-cols-2 gap-2 text-xs bg-white p-2.5 rounded border border-slate-200/80">
                <div>
                  <span className="text-xs text-slate-400 block mb-0.5">
                    {isCurrentDraftImmutable ? '稿件冻结采用值' : '当前稿采用值'}
                  </span>
                  <span
                    className={`font-bold font-mono text-sm ${
                      resolved.hasFrozenItem
                        ? 'text-slate-900'
                        : isCurrentDraftImmutable
                        ? 'text-slate-400 text-xs italic font-sans'
                        : 'text-slate-900'
                    }`}
                  >
                    {resolved.adoptedValue}
                  </span>
                  {isCurrentDraftImmutable && !resolved.hasFrozenItem && (
                    <span className="text-xs text-amber-700 block mt-0.5">快照中无此项，不可回溯当时值</span>
                  )}
                </div>
                <div>
                  <span className="text-xs text-slate-400 block mb-0.5">任务最新核准值</span>
                  <span className="font-bold text-blue-800 font-mono text-sm">
                    {resolved.currentConfirmedValue}
                  </span>
                </div>
              </div>

              {/* Version discrepancy notice */}
              {(resolved.hasSnapshotDiff || resolved.hasPeriodDiff || resolved.hasScopeDiff || resolved.hasEvidenceDiff) && (
                <div className="p-2.5 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-xs">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>版本差异提示</span>
                  </div>
                  <p className="text-xs text-amber-800 leading-normal">
                    {isCurrentDraftImmutable
                      ? `本稿属于历史只读快照，按规则优先保持当时冻结依据（采用值 ${resolved.adoptedValue}、期间 ${resolved.effectivePeriod}、口径 ${resolved.effectiveMetricScope}），任务当前最新核准信息不回填旧稿。`
                      : `当前工作稿采用值为【${resolved.adoptedValue}】（期间：${resolved.effectivePeriod}），材料库最新核准为【${resolved.currentConfirmedValue}】（期间：${resolved.currentPeriod}）。如需更新正文，可重新生成整稿候选或通过段落修改建议更新。`}
                  </p>
                </div>
              )}

              {/* Period and metric scope display */}
              {isCurrentDraftImmutable ? (
                <div className="text-xs text-slate-600 space-y-2 pt-0.5">
                  <div className="bg-slate-100/80 p-2.5 rounded space-y-1 border border-slate-200/60">
                    <span className="text-xs text-slate-500 font-semibold block">快照冻结依据元信息：</span>
                    <div>统计期间：<strong className="text-slate-800 font-medium">{resolved.effectivePeriod}</strong></div>
                    <div>统计口径：<strong className="text-slate-800 font-medium">{resolved.effectiveMetricScope}</strong></div>
                  </div>
                  <div className="bg-blue-50/60 p-2.5 rounded border border-blue-100 space-y-1">
                    <span className="text-xs text-blue-700 font-semibold block">任务当前最新核准信息：</span>
                    <div>核准期间：<strong className="text-blue-900 font-medium">{resolved.currentPeriod}</strong></div>
                    <div>核准口径：<strong className="text-blue-900 font-medium">{resolved.currentMetricScope}</strong></div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-600 space-y-1 pt-0.5">
                  <div>统计期间：<strong className="text-slate-700 font-medium">{resolved.effectivePeriod}</strong></div>
                  {resolved.effectiveMetricScope && (
                    <div>统计口径：<strong className="text-slate-700 font-medium">{resolved.effectiveMetricScope}</strong></div>
                  )}
                </div>
              )}

              {/* Snippet evidence source tracing - 3 kinds of snippet states */}
              {isCurrentDraftImmutable ? (
                resolved.effectiveSnippet ? (
                  <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-600 truncate pr-1">
                      冻结出处：{resolved.effectiveDocName} ({resolved.effectiveLocation})
                    </span>
                    <button
                      type="button"
                      onClick={() => onViewSnippet(resolved.effectiveSnippet!, fact)}
                      className="text-sm text-blue-700 hover:text-blue-900 font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <span>在抽屉中核验全文</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : resolved.isEvidencePrunedOrUnavailable ? (
                  <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between gap-2">
                    <span className="text-xs text-amber-700 italic truncate pr-1" title={`已记录证据ID: ${resolved.effectiveEvidenceId}，片段原文已清理或归档`}>
                      {`出处说明：已记录证据ID(${resolved.effectiveEvidenceId})，原文已清理`}
                    </span>
                    <button
                      type="button"
                      onClick={() => onViewSnippet(resolved.currentSnippet || { id: resolved.effectiveEvidenceId || '', docName: `历史证据【${resolved.effectiveEvidenceId}】已清理或归档`, sourceDocId: '', text: `该历史快照已完整记录原始证据ID【${resolved.effectiveEvidenceId}】，但材料库中该证据片段原文已清理或归档不可用。`, period: resolved.effectivePeriod || '', location: '原出处片段已归档' }, fact)}
                      className="text-sm text-amber-800 hover:text-amber-900 font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <span>查看说明</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : resolved.isEvidenceMissingInSnapshot ? (
                  <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between gap-2">
                    <span className="text-xs text-amber-700 italic truncate pr-1">
                      出处说明：历史快照未记录原始证据片段ID
                    </span>
                    <button
                      type="button"
                      onClick={() => onViewSnippet(resolved.currentSnippet || { id: '', docName: '历史快照未记录证据ID', sourceDocId: '', text: '该历史版本快照中未记录此事实当时的原始证据片段ID。', period: resolved.effectivePeriod || '', location: '历史快照无出处记录' }, fact)}
                      className="text-sm text-amber-800 hover:text-amber-900 font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <span>查看说明</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 italic pt-2 border-t border-slate-200/60">
                    历史快照未收录此事实依据
                  </div>
                )
              ) : resolved.effectiveSnippet ? (
                <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-600 truncate pr-1">
                    出处：{resolved.effectiveDocName} ({resolved.effectiveLocation})
                  </span>
                  <button
                    type="button"
                    onClick={() => onViewSnippet(resolved.effectiveSnippet!, fact)}
                    className="text-sm text-blue-700 hover:text-blue-900 font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    <span>在抽屉中核验全文</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="text-xs text-amber-800 italic pt-2 border-t border-slate-200/60">
                  材料库未关联特定摘录片段（出处未登记或台账录入，无纸质页码）
                </div>
              )}
            </div>
          );
        })
      ) : (
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-400 text-center italic">
          本段尚未绑定量化事实依据
        </div>
      )}

      {/* Task 20: Adopted Material Supplementation Evidences */}
      <div className="pt-3 border-t border-slate-200 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-slate-800 block">
            本段已采纳材料依据（补写存证）：
          </span>
          <span className="text-xs text-slate-500 font-mono">
            {((activeBlock.adoptedEvidences || []).filter((ev): ev is AdoptedEvidenceRecord => Boolean(ev && typeof ev === 'object' && ev.evidenceId))).length} 项
          </span>
        </div>

        {(() => {
          const safeAdoptedEvidences = (activeBlock.adoptedEvidences || []).filter(
            (ev): ev is AdoptedEvidenceRecord => Boolean(ev && typeof ev === 'object' && ev.evidenceId)
          );
          if (safeAdoptedEvidences.length === 0) {
            return (
              <div className="text-xs text-slate-400 py-2">
                本段暂未采纳材料补写存证依据
              </div>
            );
          }
          return safeAdoptedEvidences.map((ev, eIdx) => {
            const currentDoc = task.documents.find((d) => d.id === ev.sourceDocId);
            const currentSnip = task.snippets.find((s) => s.id === ev.evidenceId);

            let statusBadge = (
              <span className="bg-emerald-100 text-emerald-800 text-xs px-2 py-0.5 rounded font-medium">
                材料库当前有效
              </span>
            );
            let statusNotice: string | null = null;

            if (!currentDoc) {
              statusBadge = (
                <span className="bg-rose-100 text-rose-800 text-xs px-2 py-0.5 rounded font-medium">
                  来源文档已删除
                </span>
              );
              statusNotice = '材料库中来源文档已被删除，本段仍保留采纳时冻结依据。';
            } else if (currentDoc.excluded) {
              statusBadge = (
                <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded font-medium">
                  来源文档已排除
                </span>
              );
              statusNotice = '来源文档在当前材料库中已被排除，本段仍保留采纳时冻结依据。';
            } else if (!currentSnip) {
              statusBadge = (
                <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded font-medium">
                  材料片段已清理
                </span>
              );
              statusNotice = '材料库中对应片段已被清理，本段仍保留采纳时冻结依据。';
            } else if (currentSnip.text.trim() !== ev.snippetText.trim()) {
              statusBadge = (
                <span className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded font-medium">
                  材料库原文已更新
                </span>
              );
              statusNotice = '材料库中该片段原文后来已发生修改，本段完整保留采纳时冻结原文。';
            }

            return (
              <div
                key={eIdx}
                data-testid={`block-adopted-evidence-${ev.evidenceId}`}
                className="p-3 bg-blue-50/50 rounded-lg border border-blue-200 text-xs space-y-2"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="font-bold text-slate-900 text-sm flex items-center gap-1.5">
                    <span>{ev.sourceDocName}</span>
                    <span className="text-xs text-slate-500 font-normal">({ev.snippetLocation || '片段'})</span>
                  </div>
                  {statusBadge}
                </div>

                <div className="bg-white p-2.5 rounded border border-blue-100 space-y-1">
                  <div className="text-xs text-slate-400 font-medium">采纳时冻结原文：</div>
                  <p className="text-slate-800 text-sm font-serif leading-relaxed">
                    “{ev.snippetText}”
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 bg-white/70 p-2 rounded">
                  <div>
                    <span className="text-slate-400 block">统计期间</span>
                    <strong className="text-slate-700">{ev.period}</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">用途属性</span>
                    <strong className="text-slate-700">{ev.usage}</strong>
                  </div>
                </div>

                {statusNotice && (
                  <div className="p-2 bg-amber-50 rounded border border-amber-200 text-amber-900 text-xs">
                    {statusNotice}
                  </div>
                )}

                <div className="pt-1.5 border-t border-blue-200/60 flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-slate-400">
                    证据指纹: {ev.contentFingerprint?.slice(0, 12)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onViewSnippet(
                        {
                          id: ev.evidenceId,
                          docName: ev.sourceDocName,
                          sourceDocId: ev.sourceDocId,
                          location: ev.snippetLocation || '采纳冻结片段',
                          period: ev.period,
                          text: ev.snippetText,
                        }, undefined, ev
                      )
                    }
                    className="text-sm text-blue-700 hover:text-blue-900 font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <span>在抽屉中核验冻结片段</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
};
