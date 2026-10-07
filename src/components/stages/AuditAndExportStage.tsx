import React, { useState } from 'react';
import { 
  Task, 
  AuditIssue, 
  UserRole, 
  DraftVersion 
} from '../../types';
import { runDocumentAudit } from '../../services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from '../../services/exportService';
import { checkPermission, canFinalize as canFinalizeRole } from '../../services/permissionService';
import { 
  CheckCircle2, 
  ShieldCheck, 
  Download, 
  AlertTriangle, 
  FileText, 
  Lock, 
  RefreshCw, 
  Check, 
  Eye, 
  Sparkles, 
  Bug, 
  FileCheck,
  ShieldAlert,
  XCircle,
  HelpCircle
} from 'lucide-react';

interface AuditAndExportStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  activeRole: UserRole;
}

export const AuditAndExportStage: React.FC<AuditAndExportStageProps> = ({
  task,
  onUpdateTask,
  activeRole,
}) => {
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];

  const [activeTab, setActiveTab] = useState<'audit' | 'export'>('audit');
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [exportVersionId, setExportVersionId] = useState<string>(task.currentDraftId || task.drafts[0]?.id || '');

  // Target draft for export
  const selectedExportDraft = task.drafts.find((d) => d.id === exportVersionId) || currentDraft;

  // Run audit issues dynamically
  const auditIssues = currentDraft ? runDocumentAudit(task, currentDraft.blocks) : [];

  // Requirement 7: Finalization prerequisite checks
  const hasDraftText = !!currentDraft && currentDraft.blocks.length > 0;
  const isAuthor = activeRole === '主笔甲';
  const isUpstreamValid = task.outlineConfirmed && !!task.factSnapshot && task.styleConfirmed;
  const pendingConflictsCount = task.facts.filter((f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded').length;
  const pendingCommentsCount = task.reviewComments.filter((c) => c.status === 'pending').length;
  const criticalAuditIssuesCount = auditIssues.filter((i) => i.severity === 'error' && i.status === 'unresolved').length;

  const canFinalize =
    hasDraftText &&
    isAuthor &&
    isUpstreamValid &&
    pendingConflictsCount === 0 &&
    pendingCommentsCount === 0 &&
    criticalAuditIssuesCount === 0;

  // Inject 800人 test error button (Task 06 demonstration requirement)
  const handleInjectUnitError = () => {
    if (!currentDraft) return;
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可修改正文口径');
      return;
    }
    const updatedBlocks = currentDraft.blocks.map((b) => {
      if (b.content.includes('800人次')) {
        return {
          ...b,
          content: b.content.replace('800人次', '800人'),
          updatedAt: new Date().toISOString(),
        };
      }
      return b;
    });

    const updatedDrafts = task.drafts.map((d) => (d.id === currentDraft.id ? { ...d, blocks: updatedBlocks } : d));
    onUpdateTask({ drafts: updatedDrafts });
  };

  const handleFixUnitError = () => {
    if (!currentDraft) return;
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可修改正文口径');
      return;
    }
    const updatedBlocks = currentDraft.blocks.map((b) => {
      if (b.content.includes('800人') && !b.content.includes('800人次')) {
        return {
          ...b,
          content: b.content.replace('800人', '800人次'),
          updatedAt: new Date().toISOString(),
        };
      }
      return b;
    });

    const updatedDrafts = task.drafts.map((d) => (d.id === currentDraft.id ? { ...d, blocks: updatedBlocks } : d));
    onUpdateTask({ drafts: updatedDrafts });
  };

  const handleFinalizeDocument = () => {
    // Requirement 7: 无正文不得弹出定稿确认或抛错
    if (!hasDraftText) {
      alert('当前公文任务尚无正文草稿，无法执行定稿。请先前往阶段04“正文起草”生成初稿。');
      return;
    }

    const perm = checkPermission(activeRole, 'finalize');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可定稿公文');
      return;
    }

    if (!isUpstreamValid) {
      alert('前序事实快照失效、文风未核准或大纲批准已失效，无法定稿。请先返回前序阶段重新确认。');
      return;
    }

    if (pendingConflictsCount > 0) {
      alert('存在未裁决的同口径事实冲突（如120项 vs 128项），无法执行定稿。请先前往阶段02完成裁决或明确排除。');
      return;
    }

    if (pendingCommentsCount > 0) {
      alert(`尚有 ${pendingCommentsCount} 条待处理的重大审阅意见，需主笔逐项处理（采纳落实、拒绝说明或待沟通）后方可定稿。`);
      return;
    }

    if (criticalAuditIssuesCount > 0) {
      alert('存在阻断级正文核校偏差（如计量单位口径不符），无法执行定稿。请先纠正错误。');
      return;
    }

    if (!window.confirm('确认定稿吗？定稿后将生成不可篡改的定稿快照（定稿 v2.0）。后续编辑将自动生成新的工作草稿，旧定稿保留归档。')) {
      return;
    }

    const finalDraft: DraftVersion = {
      id: `DRAFT-FINAL-${Date.now()}`,
      versionNumber: '定稿 v2.0 (最终核定版)',
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: '经主笔核定、审阅意见全部闭环并完成事实口径核校后的正式定稿文件',
      blocks: JSON.parse(JSON.stringify(currentDraft.blocks)),
      isFinal: true,
      snapshotMetadata: currentDraft.snapshotMetadata,
    };

    onUpdateTask({
      drafts: [finalDraft, ...task.drafts],
      currentDraftId: finalDraft.id,
      isFinalized: true,
      status: '已定稿',
    });
  };

  const handleDownloadTxt = () => {
    if (!selectedExportDraft) return;
    exportDocumentAsTxt(task, selectedExportDraft, includeAnnotations);
  };

  const handleDownloadDocx = async () => {
    if (!selectedExportDraft) return;
    setIsExportingDocx(true);
    try {
      await exportDocumentAsDocx(task, selectedExportDraft, includeAnnotations);
    } catch (err) {
      console.error('Word export error:', err);
      alert('Word导出失败，请重试');
    } finally {
      setIsExportingDocx(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-700" />
              阶段06：公文严谨核校与定稿导出
            </h2>
            {task.isFinalized ? (
              <span className="text-xs bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded flex items-center gap-1 font-semibold">
                <Lock className="w-3.5 h-3.5" /> 已完成定稿归档
              </span>
            ) : (
              <span className="text-xs bg-blue-100 text-blue-800 border border-blue-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> 待核验定稿
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            自动核验正文与材料依据的统计口径（如“人次”与“人数”区分）、单位规范及遗漏缺口；提供真实 TXT 与真实 Word (.docx) 导出。
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!task.isFinalized && (
            <button
              onClick={handleFinalizeDocument}
              disabled={!canFinalize}
              className={`px-4 py-2 rounded text-xs font-bold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
                canFinalize
                  ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
              title={
                !hasDraftText
                  ? '当前任务尚无正文草稿，无法定稿'
                  : !isAuthor
                  ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可定稿`
                  : !isUpstreamValid
                  ? '前序事实快照或大纲审批已失效，无法定稿'
                  : pendingCommentsCount > 0
                  ? `尚有 ${pendingCommentsCount} 条待处理审阅意见未闭环`
                  : !canFinalize
                  ? '存在阻断性核校偏差或未裁决冲突'
                  : '确认定稿锁定公文'
              }
            >
              <Lock className="w-4 h-4" />
              <span>确认最终定稿</span>
            </button>
          )}

          <button
            onClick={() => setActiveTab('export')}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>下载导出文件</span>
          </button>
        </div>
      </div>

      {/* Requirement 7: Clear finalization gatekeeper status indicator */}
      {!task.isFinalized && (
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-slate-200">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-blue-700" />
              正式定稿前置准入核验条件 (主笔专属操作)
            </span>
            <span className="font-medium text-[11px] text-slate-500">
              当前操作身份：<strong>{activeRole}</strong>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-1 text-[11px]">
            <div className={`p-2 rounded border flex flex-col justify-between ${hasDraftText ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">1. 正文草稿</div>
              <div className="mt-1 flex items-center gap-1">
                {hasDraftText ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{hasDraftText ? `${currentDraft.blocks.length}段正文` : '无正文(阻断)'}</span>
              </div>
            </div>

            <div className={`p-2 rounded border flex flex-col justify-between ${isAuthor ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">2. 动作权限</div>
              <div className="mt-1 flex items-center gap-1">
                {isAuthor ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{isAuthor ? '主笔甲(符合)' : '非主笔(阻断)'}</span>
              </div>
            </div>

            <div className={`p-2 rounded border flex flex-col justify-between ${isUpstreamValid ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">3. 前序审批</div>
              <div className="mt-1 flex items-center gap-1">
                {isUpstreamValid ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{isUpstreamValid ? '事实大纲有效' : '审批失效(阻断)'}</span>
              </div>
            </div>

            <div className={`p-2 rounded border flex flex-col justify-between ${pendingConflictsCount === 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">4. 口径冲突</div>
              <div className="mt-1 flex items-center gap-1">
                {pendingConflictsCount === 0 ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{pendingConflictsCount === 0 ? '无待决冲突' : `${pendingConflictsCount}项未决(阻断)`}</span>
              </div>
            </div>

            <div className={`p-2 rounded border flex flex-col justify-between ${pendingCommentsCount === 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">5. 审阅意见</div>
              <div className="mt-1 flex items-center gap-1">
                {pendingCommentsCount === 0 ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{pendingCommentsCount === 0 ? '全部已研判' : `${pendingCommentsCount}条待办(阻断)`}</span>
              </div>
            </div>

            <div className={`p-2 rounded border flex flex-col justify-between ${criticalAuditIssuesCount === 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`}>
              <div className="font-semibold">6. 阻断核校</div>
              <div className="mt-1 flex items-center gap-1">
                {criticalAuditIssuesCount === 0 ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                <span>{criticalAuditIssuesCount === 0 ? '一致性核校过' : `${criticalAuditIssuesCount}项错误(阻断)`}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg px-4 pt-2">
        <button
          onClick={() => setActiveTab('audit')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'audit'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>正文事实一致性核校清单</span>
          {auditIssues.length > 0 ? (
            <span className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.2 rounded font-mono">
              发现 {auditIssues.length} 项关注
            </span>
          ) : (
            <span className="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 py-0.2 rounded font-mono">
              全部核校通过
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('export')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'export'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Download className="w-4 h-4" />
          <span>定稿文件真实导出 (TXT / DOCX)</span>
        </button>
      </div>

      {/* TAB 1: 核校中心 */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-5">
          {/* Demo Injection Box for "800人" vs "800人次" */}
          <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-1">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <Bug className="w-4 h-4 text-purple-600" />
                核校口径专项演练工具：800人次 vs 800人
              </span>
              <p className="text-slate-600">
                单位培训台账（EVD-03）严谨口径为“800人次”。点击按钮可在文稿中模拟引入口径错误，观察核校引擎的比对警示。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleInjectUnitError}
                className="px-3 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-800 border border-purple-300 rounded font-medium cursor-pointer"
              >
                模拟注入“800人”错误
              </button>
              <button
                onClick={handleFixUnitError}
                className="px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300 rounded font-medium cursor-pointer"
              >
                一键纠正为“800人次”
              </button>
            </div>
          </div>

          {/* Audit Checklist */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800">核校比对发现项</span>
              <span className="text-[11px] text-slate-400">
                针对当前版本：{currentDraft?.versionNumber || '无文稿'}
              </span>
            </div>

            {!hasDraftText ? (
              <div className="p-8 text-center bg-slate-50 border border-slate-200 rounded-lg text-slate-500 space-y-2">
                <FileText className="w-8 h-8 mx-auto text-slate-300" />
                <h4 className="font-bold text-sm">当前任务尚未生成正文草稿</h4>
                <p className="text-xs">请返回阶段04“正文起草”生成初稿后，系统将自动进行事实口径核校。</p>
              </div>
            ) : auditIssues.length === 0 ? (
              <div className="p-8 text-center bg-emerald-50/50 border border-emerald-200 rounded-lg text-emerald-800 space-y-2">
                <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-600" />
                <h4 className="font-bold text-sm">核校比对完成：未发现口径偏差与单位冲突</h4>
                <p className="text-xs text-emerald-700">
                  当前正文中的重点任务、专题培训、参训人次及调研频次均与已确认台账保持完全一致。
                </p>
              </div>
            ) : (
              auditIssues.map((issue) => (
                <div
                  key={issue.id}
                  className={`p-4 rounded-lg border text-xs space-y-2.5 ${
                    issue.severity === 'error'
                      ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                      : issue.severity === 'warning'
                      ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                      : 'bg-blue-50/70 border-blue-200 text-blue-900'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle
                        className={`w-4 h-4 ${
                          issue.severity === 'error'
                            ? 'text-rose-600'
                            : issue.severity === 'warning'
                            ? 'text-amber-600'
                            : 'text-blue-600'
                        }`}
                      />
                      <span className="font-bold">
                        [{issue.location}] {issue.type === 'metric_unit' ? '计量单位口径不符' : '依据出处待核实'}
                      </span>
                    </div>

                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        issue.severity === 'error'
                          ? 'bg-rose-200 text-rose-800'
                          : 'bg-amber-200 text-amber-800'
                      }`}
                    >
                      {issue.severity === 'error' ? '阻断级偏差' : '建议关注'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-white/80 p-2.5 rounded border border-slate-200/60">
                    <div>
                      <span className="text-slate-400 font-medium">当前正文表述：</span>
                      <p className="font-mono font-semibold text-rose-700 mt-0.5">“{issue.originalText}”</p>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium">台账原始证据依据：</span>
                      <p className="font-mono text-slate-800 mt-0.5">“{issue.evidenceText}”</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <p className="text-[11px] leading-relaxed">
                      <strong>更正建议：</strong>{issue.suggestion}
                    </p>

                    {issue.type === 'metric_unit' && (
                      <button
                        onClick={handleFixUnitError}
                        className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs cursor-pointer"
                      >
                        自动更正为规范口径
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: 定稿与真实导出 */}
      {activeTab === 'export' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Export Scope Configuration */}
            <div className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-4 text-xs">
              <h3 className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileCheck className="w-4 h-4 text-blue-700" />
                导出内容配置
              </h3>

              <div className="space-y-3">
                {/* Requirement 4: Select which version to export */}
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">选择待导出版本快照：</label>
                  <select
                    value={exportVersionId}
                    onChange={(e) => setExportVersionId(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-300 rounded text-slate-800 font-medium"
                  >
                    {task.drafts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.versionNumber} ({d.summary}) {d.isFinal ? '【定稿版】' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedExportDraft?.snapshotMetadata && (
                    <p className="text-[10px] text-blue-700">
                      ✓ 系统将锁定导出该版本当时的章节标题与事实快照依据，不受后续大纲变动影响。
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="font-semibold text-slate-700">导出内容范围</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAnnotations}
                      onChange={(e) => setIncludeAnnotations(e.target.checked)}
                      className="rounded text-blue-600"
                    />
                    <span>附加出处依据与审阅意见记录（生成单位审阅归档稿）</span>
                  </label>
                  <p className="text-[11px] text-slate-500 pl-5">
                    勾选后将在各段落末尾附上关联台账标识，并在文末附上审阅意见处理清单。
                  </p>
                </div>
              </div>
            </div>

            {/* Right: Real Download Buttons */}
            <div className="p-4 border border-slate-200 rounded-lg bg-blue-50/50 space-y-4 text-xs flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-xs text-blue-900 flex items-center gap-1.5">
                  <Download className="w-4 h-4 text-blue-700" />
                  真实本地文件生成与下载
                </h3>
                <p className="text-[11px] text-blue-800 mt-1 leading-relaxed">
                  系统采用纯本地客户端文档生成技术，不调用外部网络。生成的 Word 文档为真实 OOXML (.docx) 格式，内嵌公文规范字号与段落首行缩进，完全兼容 Word 与 WPS 软件打开编辑。
                </p>
              </div>

              <div className="space-y-2 pt-2">
                <button
                  onClick={handleDownloadDocx}
                  disabled={isExportingDocx || !selectedExportDraft}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-bold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <FileText className="w-4 h-4" />
                  <span>{isExportingDocx ? 'Word文件封装生成中...' : '下载公文 Word (.docx) 文件'}</span>
                </button>

                <button
                  onClick={handleDownloadTxt}
                  disabled={!selectedExportDraft}
                  className="w-full py-2 px-4 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span>下载纯文本 TXT 文件</span>
                </button>
              </div>
            </div>
          </div>

          {/* Document Preview Box */}
          <div className="border border-slate-200 rounded-lg p-5 bg-white space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800">
                预览版本：{selectedExportDraft?.versionNumber}
              </span>
              <span className="text-[11px] text-slate-400">
                {selectedExportDraft?.blocks.length || 0} 个结构化段落
              </span>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-4 p-4 bg-slate-50/60 rounded border border-slate-100 text-xs">
              <h2 className="text-center font-bold text-sm text-slate-900 font-serif">
                {selectedExportDraft?.snapshotMetadata?.taskTitle || task.title}
              </h2>
              {selectedExportDraft?.blocks.map((b) => (
                <div key={b.id} className="space-y-1">
                  <p className="text-slate-800 leading-relaxed indent-8 text-[13px]">{b.content}</p>
                  {includeAnnotations && b.referencedFactIds.length > 0 && (
                    <div className="text-[10px] text-blue-700 pl-8 italic">
                      📎 依据追溯：{b.referencedFactIds.map((id) => task.facts.find((f) => f.id === id)?.metric || id).join('、')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
