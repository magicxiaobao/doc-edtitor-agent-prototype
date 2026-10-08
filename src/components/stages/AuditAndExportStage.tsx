import React, { useState, useEffect, useRef } from 'react';
import { 
  Task, 
  AuditIssue, 
  UserRole, 
  DraftVersion,
  ExportOptions
} from '../../types';
import { runDocumentAudit } from '../../services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from '../../services/exportService';
import { checkPermission, canFinalize as canFinalizeRole } from '../../services/permissionService';
import { 
  validateFinalizationConditions, 
  finalizeDraft, 
  applyDraftContentChange 
} from '../../services/draftLifecycleService';
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
  HelpCircle,
  X,
  FileSpreadsheet,
  CornerDownRight
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
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [exportVersionId, setExportVersionId] = useState<string>(task.currentDraftId || task.drafts[0]?.id || '');

  // Synchronize exportVersionId when task or currentDraftId changes
  useEffect(() => {
    if (task.currentDraftId) {
      setExportVersionId(task.currentDraftId);
    }
  }, [task.id, task.currentDraftId]);

  // Granular export options for both TXT and DOCX
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    includeBody: true,
    includeEvidence: true,
    includeReviewLog: true,
  });

  // Ignore Modal State
  const [ignoringIssue, setIgnoringIssue] = useState<AuditIssue | null>(null);
  const [ignoreReasonInput, setIgnoreReasonInput] = useState('');
  const [ignoreError, setIgnoreError] = useState<string | null>(null);
  const ignoreInputRef = useRef<HTMLTextAreaElement>(null);

  // Target draft for export
  const selectedExportDraft = task.drafts.find((d) => d.id === exportVersionId) || currentDraft;

  // Run dynamic audit issues using active snapshot and draft ID
  const auditIssues = currentDraft ? runDocumentAudit(task, currentDraft.blocks, currentDraft.id) : [];

  // Finalization prerequisite checks
  const validation = validateFinalizationConditions(task, currentDraft?.id, activeRole);
  const canFinalize = validation.canFinalize;
  const hasDraftText = validation.checks.hasDraftText;
  const isAuthor = validation.checks.isAuthor;
  const isUpstreamValid = validation.checks.isUpstreamValid;
  const pendingConflictsCount = task.facts.filter((f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded').length;
  const pendingCommentsCount = task.reviewComments.filter((c) => c.status === 'pending' || c.status === 'accepted_pending_implementation' || c.status === 'need_discussion').length;
  
  // Critical audit issues that are blocking and unresolved
  const criticalAuditIssuesCount = auditIssues.filter(
    (i) => i.isBlocking && i.status === 'unresolved'
  ).length;

  // Esc key listener for Ignore Modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ignoringIssue) {
        setIgnoringIssue(null);
        setIgnoreReasonInput('');
        setIgnoreError(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [ignoringIssue]);

  // Focus textarea when modal opens
  useEffect(() => {
    if (ignoringIssue && ignoreInputRef.current) {
      ignoreInputRef.current.focus();
    }
  }, [ignoringIssue]);

  // Requirement 2: Accept fix produces real draft content changes
  const handleAcceptFix = (issue: AuditIssue) => {
    if (!currentDraft) return;
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可确认并修正正文口径');
      return;
    }

    const replacement = issue.replacementText || issue.suggestion;
    if (!replacement) {
      alert('该核校项需人工进入正文起草阶段针对性润色。');
      return;
    }

    const targetBlock = currentDraft.blocks.find((b) => b.id === issue.blockId);
    if (!targetBlock) {
      alert('未找到待修正的段落目标。');
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) => {
            if (b.id === issue.blockId) {
              let updatedContent = b.content;
              if (
                issue.charIndex !== undefined &&
                b.content.slice(issue.charIndex, issue.charIndex + issue.originalText.length) === issue.originalText
              ) {
                updatedContent =
                  b.content.slice(0, issue.charIndex) +
                  replacement +
                  b.content.slice(issue.charIndex + issue.originalText.length);
              } else {
                updatedContent = b.content.replace(issue.originalText, replacement);
              }
              return { ...b, content: updatedContent, updatedAt: new Date().toISOString() };
            }
            return b;
          }),
        `接受核校更正：${issue.originalText} -> ${replacement}`,
        activeRole
      );

      // Save resolution record to draft
      const existingRecords = workingDraft.auditRecords || [];
      const updatedRecords = [
        ...existingRecords.filter((r) => r.issueId !== issue.issueId),
        {
          issueId: issue.issueId,
          status: 'accepted' as const,
          resolvedAt: new Date().toISOString(),
        },
      ];

      const finalDrafts = updatedTask.drafts.map((d) =>
        d.id === workingDraft.id ? { ...d, auditRecords: updatedRecords } : d
      );

      onUpdateTask({
        drafts: finalDrafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
    } catch (err: any) {
      alert(err.message || '接受更正失败');
    }
  };

  // Requirement 2: Open modal to record mandatory reason for non-blocking ignore
  const handleOpenIgnoreModal = (issue: AuditIssue) => {
    if (issue.isBlocking) {
      alert('重大指标不一致或阻断性错误属于公文红线，不可靠通用忽略绕过，必须更正正文或裁决事实！');
      return;
    }
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可研判核校提示');
      return;
    }
    setIgnoringIssue(issue);
    setIgnoreReasonInput('');
    setIgnoreError(null);
  };

  const handleConfirmIgnore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ignoringIssue || !currentDraft) return;

    if (!ignoreReasonInput.trim()) {
      setIgnoreError('请填写忽略此提示的具体业务理由（必填，随公文版本归档存证）。');
      return;
    }

    const existingRecords = currentDraft.auditRecords || [];
    const updatedRecords = [
      ...existingRecords.filter((r) => r.issueId !== ignoringIssue.issueId),
      {
        issueId: ignoringIssue.issueId,
        status: 'ignored' as const,
        ignoreReason: ignoreReasonInput.trim(),
        resolvedAt: new Date().toISOString(),
      },
    ];

    const updatedDrafts = task.drafts.map((d) => 
      d.id === currentDraft.id ? { ...d, auditRecords: updatedRecords } : d
    );

    onUpdateTask({ drafts: updatedDrafts });
    setIgnoringIssue(null);
    setIgnoreReasonInput('');
    setIgnoreError(null);
  };

  // Demo injection box for unit simulation
  const handleInjectUnitError = () => {
    if (!currentDraft) return;
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可修改正文口径');
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) => {
            if (b.content.includes('800人次')) {
              return {
                ...b,
                content: b.content.replace('800人次', '800人次，其中800人考核合格'),
                updatedAt: new Date().toISOString(),
              };
            }
            return b;
          }),
        '演练模拟：注入单位混淆错误',
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
    } catch (err: any) {
      alert(err.message || '注入错误失败');
    }
  };

  const handleInjectConflictError = () => {
    if (!currentDraft) return;
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可修改正文口径');
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) => {
            if (b.content.includes('128项')) {
              return {
                ...b,
                content: b.content.replace('128项', '120项'),
                updatedAt: new Date().toISOString(),
              };
            }
            return b;
          }),
        '演练模拟：注入采信冲突错误',
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
    } catch (err: any) {
      alert(err.message || '注入错误失败');
    }
  };

  const handleFinalizeDocument = () => {
    if (!canFinalize) {
      alert(validation.reasons.join('；') || '未达到定稿要求');
      return;
    }

    if (!window.confirm('确认定稿吗？定稿后将生成不可篡改的定稿快照（定稿 v2.0）。后续编辑将自动生成新的工作草稿，旧定稿保留归档。')) {
      return;
    }

    const res = finalizeDraft(task, currentDraft.id, activeRole);
    if (!res.success) {
      alert(res.error || '定稿执行失败');
      return;
    }

    onUpdateTask({
      drafts: res.updatedTask!.drafts,
      currentDraftId: res.finalDraft!.id,
      isFinalized: true,
      status: '已定稿',
    });
  };

  const handleDownloadTxt = () => {
    if (!selectedExportDraft) return;
    exportDocumentAsTxt(task, selectedExportDraft, exportOptions);
  };

  const handleDownloadDocx = async () => {
    if (!selectedExportDraft) return;
    setIsExportingDocx(true);
    try {
      await exportDocumentAsDocx(task, selectedExportDraft, exportOptions);
    } catch (err) {
      console.error('Word export error:', err);
      alert('Word导出失败，请重试');
    } finally {
      setIsExportingDocx(false);
    }
  };

  return (
    <div className="space-y-6 text-sm">
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
          <p className="text-sm text-slate-500 mt-1 leading-relaxed">
            核校引擎比对已裁决事实快照、段落引用、数值单位与期间口径；严查“128 vs 120”冲突及“人次 vs 人数”；提供真实 TXT 与真实 Word (.docx) 导出。
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!task.isFinalized && (
            <button
              onClick={handleFinalizeDocument}
              disabled={!canFinalize}
              className={`px-4 py-2 rounded text-sm font-bold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
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
                  : criticalAuditIssuesCount > 0
                  ? `存在 ${criticalAuditIssuesCount} 项阻断性核校错误未更正`
                  : '确认最终定稿并生成归档版本'
              }
            >
              <Lock className="w-4 h-4" />
              <span>确认最终定稿</span>
            </button>
          )}

          <button
            onClick={() => setActiveTab('export')}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-sm font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>下载导出文件</span>
          </button>
        </div>
      </div>

      {/* Gatekeeper Criteria Bar */}
      {!task.isFinalized && (
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-sm">
          <div className="flex items-center justify-between pb-1 border-b border-slate-200">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-blue-700" />
              正式定稿前置准入核验条件 (主笔专属业务操作)
            </span>
            <span className="text-xs text-slate-500">
              当前操作身份：<strong>{activeRole}</strong>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-1 text-xs">
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

      {/* Clearly Marked Prototype Demo Area */}
      <div className="bg-purple-50/80 border border-purple-200 p-4 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="bg-purple-700 text-white text-xs px-2 py-0.5 rounded font-bold uppercase tracking-wider">
              演练辅助专区
            </span>
            <span className="font-bold text-purple-900">
              核校红线口径演练工具（仅供原型评审验证）
            </span>
          </div>
          <p className="text-xs text-purple-800">
            可快捷注入典型公文错误，检验核校引擎对“同段人次/人数混淆”及“采信128却写120”的精确定位与定稿拦截能力。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleInjectUnitError}
            className="px-3 py-1.5 bg-white hover:bg-purple-100 text-purple-800 border border-purple-300 rounded font-medium text-xs cursor-pointer"
          >
            注入“800人次，其中800人”错误
          </button>
          <button
            onClick={handleInjectConflictError}
            className="px-3 py-1.5 bg-white hover:bg-purple-100 text-purple-800 border border-purple-300 rounded font-medium text-xs cursor-pointer"
          >
            注入“120项”冲突错误
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg px-4 pt-2">
        <button
          onClick={() => setActiveTab('audit')}
          className={`py-3 px-5 text-sm font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'audit'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>正文事实一致性核校清单</span>
          {auditIssues.length > 0 ? (
            <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded font-mono font-medium">
              发现 {auditIssues.length} 项关注
            </span>
          ) : (
            <span className="bg-emerald-100 text-emerald-800 text-xs px-2 py-0.5 rounded font-mono font-medium">
              全部核校通过
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('export')}
          className={`py-3 px-5 text-sm font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
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
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <span className="font-bold text-sm text-slate-800">
              核校引擎逐段比对结论（当前版本：{currentDraft?.versionNumber || '无文稿'}）
            </span>
            <span className="text-xs text-slate-500">
              {criticalAuditIssuesCount > 0 ? (
                <span className="text-rose-600 font-bold">
                  ● 存在 {criticalAuditIssuesCount} 项阻断性错误，无法通过定稿
                </span>
              ) : (
                <span className="text-emerald-600 font-medium">
                  ✓ 无阻断性核校错误
                </span>
              )}
            </span>
          </div>

          {!hasDraftText ? (
            <div className="p-8 text-center bg-slate-50 border border-slate-200 rounded-lg text-slate-500 space-y-2">
              <FileText className="w-8 h-8 mx-auto text-slate-300" />
              <h4 className="font-bold text-base">当前任务尚未生成正文草稿</h4>
              <p className="text-sm">请返回阶段04“正文起草”生成初稿后，系统将自动进行事实口径核校。</p>
            </div>
          ) : auditIssues.length === 0 ? (
            <div className="p-8 text-center bg-emerald-50/50 border border-emerald-200 rounded-lg text-emerald-800 space-y-2">
              <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-600" />
              <h4 className="font-bold text-base">核校比对完成：未发现口径偏差与单位冲突</h4>
              <p className="text-sm text-emerald-700 leading-relaxed">
                当前正文中的重点任务项数、专题培训场次、参训人次及调研频次均与已确认台账保持完全一致。
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {auditIssues.map((issue) => (
                <div
                  key={issue.id}
                  className={`p-4 rounded-lg border text-sm space-y-3 transition-colors ${
                    issue.status === 'ignored'
                      ? 'bg-slate-50/80 border-slate-300 opacity-75'
                      : issue.status === 'accepted'
                      ? 'bg-emerald-50/60 border-emerald-200'
                      : issue.severity === 'error'
                      ? 'bg-rose-50/80 border-rose-200'
                      : issue.severity === 'warning'
                      ? 'bg-amber-50/80 border-amber-200'
                      : 'bg-blue-50/80 border-blue-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle
                        className={`w-4 h-4 shrink-0 ${
                          issue.status === 'ignored'
                            ? 'text-slate-400'
                            : issue.severity === 'error'
                            ? 'text-rose-600'
                            : issue.severity === 'warning'
                            ? 'text-amber-600'
                            : 'text-blue-600'
                        }`}
                      />
                      <span className="font-bold text-slate-800">
                        [{issue.location}] {
                          issue.type === 'conflict_mismatch' ? '未采信冲突口径入稿' :
                          issue.type === 'metric_unit' ? '计量单位口径不符（人次/人数）' :
                          issue.type === 'historic_data_leak' ? '历史年份数据外泄' :
                          issue.type === 'gap_missing' ? '定性线索缺乏正式量化出处' :
                          '数值未登记匹配出处'
                        }
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {issue.status === 'accepted' ? (
                        <span className="text-xs px-2 py-0.5 rounded font-bold bg-emerald-200 text-emerald-800">
                          已更正正文
                        </span>
                      ) : issue.status === 'ignored' ? (
                        <span className="text-xs px-2 py-0.5 rounded font-bold bg-slate-200 text-slate-700" title={`理由: ${issue.ignoreReason}`}>
                          已记录理由忽略
                        </span>
                      ) : (
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-bold ${
                            issue.isBlocking
                              ? 'bg-rose-200 text-rose-800'
                              : 'bg-amber-200 text-amber-800'
                          }`}
                        >
                          {issue.isBlocking ? '重大错误·阻断定稿' : '关注提示'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white/90 p-3 rounded border border-slate-200/80">
                    <div>
                      <span className="text-xs text-slate-500 font-medium">当前正文表述：</span>
                      <p className="font-mono font-bold text-rose-700 mt-1">“{issue.originalText}”</p>
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 font-medium">依据台账与裁决口径：</span>
                      <p className="font-mono text-slate-800 mt-1">“{issue.evidenceText}”</p>
                    </div>
                  </div>

                  {issue.ignoreReason && (
                    <div className="p-2 bg-slate-100 rounded text-xs text-slate-600">
                      <strong>已登记忽略理由：</strong>{issue.ignoreReason}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-slate-200/60">
                    <p className="text-xs text-slate-700 leading-relaxed">
                      <strong>建议操作：</strong>{issue.suggestion}
                    </p>

                    <div className="flex items-center gap-2 shrink-0">
                      {issue.status === 'unresolved' && (
                        <>
                          {issue.replacementText && (
                            <button
                              onClick={() => handleAcceptFix(issue)}
                              className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-bold shadow-xs cursor-pointer flex items-center gap-1"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>接受更正（替换为“{issue.replacementText}”）</span>
                            </button>
                          )}

                          {!issue.isBlocking ? (
                            <button
                              onClick={() => handleOpenIgnoreModal(issue)}
                              className="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-600 border border-slate-300 rounded text-xs font-medium cursor-pointer"
                            >
                              忽略并说明理由
                            </button>
                          ) : (
                            <span 
                              className="text-xs text-rose-600 font-medium italic cursor-not-allowed"
                              title="重大事实不一致不能靠通用忽略绕过，必须更正正文或裁决事实"
                            >
                              [阻断项不可忽略]
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: 定稿与真实导出 */}
      {activeTab === 'export' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Export Scope Configuration */}
            <div className="p-5 border border-slate-200 rounded-lg bg-slate-50 space-y-4">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <FileCheck className="w-4 h-4 text-blue-700" />
                导出内容范围与版本快照配置
              </h3>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="export-version-select" className="font-semibold text-slate-700 text-xs">
                    选择待导出版本快照（历史导出固定当时状态）：
                  </label>
                  <select
                    id="export-version-select"
                    value={exportVersionId}
                    onChange={(e) => setExportVersionId(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-300 rounded text-slate-800 font-medium text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  >
                    {task.drafts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.versionNumber} ({d.summary}) {d.isFinal ? '【正式定稿版】' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedExportDraft?.snapshotMetadata && (
                    <p className="text-xs text-blue-700 pt-1">
                      ✓ 系统已冻结该版本当时的章节标题与事实快照依据，导出绝不使用后续改动后的大纲重写历史版。
                    </p>
                  )}
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-200">
                  <span className="font-semibold text-slate-700 text-xs block">
                    导出内容范围（TXT 与 DOCX 支持完全相同的三个勾选项）：
                  </span>

                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={exportOptions.includeBody}
                      onChange={(e) => setExportOptions({ ...exportOptions, includeBody: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className="font-medium text-slate-800">包含公文正文（章节标题与首行缩进段落）</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={exportOptions.includeEvidence}
                      onChange={(e) => setExportOptions({ ...exportOptions, includeEvidence: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className="font-medium text-slate-800">包含台账依据与出处追溯（段后附事实出处）</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={exportOptions.includeReviewLog}
                      onChange={(e) => setExportOptions({ ...exportOptions, includeReviewLog: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    <span className="font-medium text-slate-800">包含审阅意见与落实处理记录（附录表格归档）</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Right: Real Download Buttons */}
            <div className="p-5 border border-slate-200 rounded-lg bg-blue-50/50 space-y-4 flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-sm text-blue-900 flex items-center gap-1.5">
                  <Download className="w-4 h-4 text-blue-700" />
                  真实本地文件生成与下载
                </h3>
                <p className="text-xs text-blue-800 mt-2 leading-relaxed">
                  系统采用纯本地客户端文档生成技术，不调用任何外部网络。生成的 Word 文档为真实 OOXML (.docx) 结构，包含公文标准字号、段落缩进及审阅记录表格。
                </p>
                <div className="p-2.5 bg-white/80 rounded border border-blue-200 text-xs text-blue-900 mt-3 space-y-1">
                  <div className="font-semibold">⚠️ 真实环境兼容性说明：</div>
                  <p className="text-slate-600">
                    本原型已验证生成文件的 OOXML 标准结构（包含 word/document.xml、_rels 及关系声明）。在缺乏本地独立 Word / WPS 桌面程序打开实测证据前，客观标注软件端到端排版兼容性待进一步在目标桌面软件中实测验证。
                  </p>
                </div>
              </div>

              <div className="space-y-3 pt-3">
                <button
                  onClick={handleDownloadDocx}
                  disabled={isExportingDocx || !selectedExportDraft}
                  className="w-full py-3 px-4 bg-blue-700 hover:bg-blue-800 text-white rounded text-sm font-bold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <FileText className="w-4 h-4" />
                  <span>{isExportingDocx ? 'Word文件封装生成中...' : '下载真实 Word (.docx) 文件'}</span>
                </button>

                <button
                  onClick={handleDownloadTxt}
                  disabled={!selectedExportDraft}
                  className="w-full py-2.5 px-4 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4 text-slate-500" />
                  <span>下载纯文本 TXT 归档文件</span>
                </button>
              </div>
            </div>
          </div>

          {/* Document Preview Box */}
          <div className="border border-slate-200 rounded-lg p-5 bg-white space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-sm text-slate-800">
                实时导出预览：{selectedExportDraft?.versionNumber}
              </span>
              <span className="text-xs text-slate-400">
                {selectedExportDraft?.blocks.length || 0} 个结构化段落
              </span>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-4 p-5 bg-slate-50/70 rounded border border-slate-100 text-sm">
              <h2 className="text-center font-bold text-base text-slate-900 font-serif">
                {selectedExportDraft?.snapshotMetadata?.taskTitle || task.title}
              </h2>
              <div className="text-center text-xs text-slate-500">
                文种：{task.docType} | 统计期间：{selectedExportDraft?.snapshotMetadata?.startDate || task.startDate} 至 {selectedExportDraft?.snapshotMetadata?.endDate || task.endDate}
              </div>

              {exportOptions.includeBody && selectedExportDraft?.blocks.map((b) => (
                <div key={b.id} className="space-y-1">
                  <p className="text-slate-800 leading-relaxed indent-8 text-base font-serif">{b.content}</p>
                  {exportOptions.includeEvidence && b.referencedFactIds.length > 0 && (
                    <div className="text-xs text-blue-700 pl-8 italic">
                      📎 依据追溯：{b.referencedFactIds.map((id) => task.facts.find((f) => f.id === id)?.metric || id).join('、')}
                    </div>
                  )}
                </div>
              ))}

              {exportOptions.includeReviewLog && task.reviewComments.length > 0 && (
                <div className="pt-4 border-t border-slate-200 mt-4 space-y-2">
                  <h4 className="font-bold text-xs text-slate-700">【附：审阅意见与落实处理记录预览】</h4>
                  <div className="space-y-1.5 text-xs text-slate-600 bg-white p-3 rounded border border-slate-200">
                    {task.reviewComments.map((cmt, idx) => (
                      <div key={cmt.id} className="pb-1 border-b border-slate-100 last:border-0">
                        <span className="font-bold">{idx + 1}. [{cmt.reviewer}]</span>
                        {cmt.targetVersionId && <span className="text-slate-400 font-mono text-[10px] ml-1">[针对:{cmt.targetVersionId}]</span>}
                        <span className="ml-1">状态：</span>
                        <span className="font-semibold text-slate-800">{cmt.status}</span> | 意见：{cmt.content}
                        {cmt.authorReply && <span className="text-blue-700 ml-2">答复：{cmt.authorReply}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Ignore Reason Modal with Accessible Focus, Escape & Labels */}
      {ignoringIssue && (
        <div 
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-2xs flex items-center justify-center p-4 z-50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ignore-dialog-title"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 space-y-4 border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 id="ignore-dialog-title" className="font-bold text-base text-slate-800 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                填写忽略核校提示的业务理由
              </h3>
              <button
                onClick={() => { setIgnoringIssue(null); setIgnoreError(null); }}
                className="text-slate-400 hover:text-slate-600 cursor-pointer p-1 rounded hover:bg-slate-100"
                aria-label="关闭对话框"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 bg-amber-50 rounded border border-amber-200 text-xs text-amber-900 space-y-1">
              <p><strong>所涉段落：</strong>{ignoringIssue.location}</p>
              <p><strong>核校发现：</strong>{ignoringIssue.suggestion}</p>
            </div>

            <form onSubmit={handleConfirmIgnore} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="ignore-reason-textarea" className="block text-xs font-semibold text-slate-700">
                  业务说明与排除依据（必填，记录将随公文草稿版本持久保存）：
                </label>
                <textarea
                  id="ignore-reason-textarea"
                  ref={ignoreInputRef}
                  value={ignoreReasonInput}
                  onChange={(e) => {
                    setIgnoreReasonInput(e.target.value);
                    if (ignoreError) setIgnoreError(null);
                  }}
                  rows={3}
                  placeholder="例如：主笔已核实该满意度表述系引用年初专项通报定性评价，本期暂缺量化台账，留存备查。"
                  className="w-full p-2.5 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
                {ignoreError && (
                  <p className="text-xs text-rose-600 font-medium" role="alert">
                    {ignoreError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => { setIgnoringIssue(null); setIgnoreError(null); }}
                  className="px-4 py-2 border border-slate-300 rounded text-sm text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded text-sm font-bold shadow-xs cursor-pointer"
                >
                  确认记录并忽略
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
